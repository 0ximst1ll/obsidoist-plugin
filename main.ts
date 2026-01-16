import { Plugin, TFile, Editor, MarkdownView, MarkdownFileInfo, WorkspaceLeaf } from 'obsidian';
import { ObsidoistSettings, DEFAULT_SETTINGS, ObsidoistSettingTab } from './settings';
import { TodoistService } from './todoistService';
import { SyncManager } from './syncManager';
import { CodeBlockProcessor } from './codeBlock';
import { createDefaultLocalState, migrateLocalState, ObsidoistLocalState } from './localState';
import { setDebugEnabled } from './logger';
import { debug } from './logger';

// Custom debounce implementation to ensure consistent behavior
function customDebounce<T extends (...args: any[]) => any>(func: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout | null = null;
    return function(...args: Parameters<T>) {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => {
            timeout = null;
            func(...args);
        }, wait);
    };
}

export default class ObsidoistPlugin extends Plugin {
	settings: ObsidoistSettings;
	todoistService: TodoistService;
    syncManager: SyncManager;
    codeBlockProcessor: CodeBlockProcessor;

    localState: ObsidoistLocalState;

    private requestPersist: (() => void) | null = null;

	private autoSyncIntervalId: number | null = null;


    // Flag to ignore modify events triggered by internal sync
    private isInternalSync = false;

	async onload() {
		await this.loadPluginData();
		setDebugEnabled(this.settings.debugLogging ?? false);

        this.requestPersist = customDebounce(() => {
            void this.savePluginData();
        }, 1000);

        // Load styles explicitly if needed?
        // Obsidian automatically loads styles.css if it exists in the plugin folder.
        // But maybe I need to force reload or something?
        // Usually creating the file is enough.
        
		this.todoistService = new TodoistService(this.settings.todoistToken, this.localState, () => this.requestPersist?.());
		this.todoistService.setUseSyncApi(this.settings.useSyncApi ?? true);
		this.todoistService.updateCachePolicy({
			completedRetentionDays: this.settings.completedRetentionDays,
			maxFilterCacheEntries: this.settings.maxFilterCacheEntries
		});
        this.syncManager = new SyncManager(this.app, this.todoistService, this.settings);
		this.codeBlockProcessor = new CodeBlockProcessor(this.app, this.todoistService, this.syncManager, this.settings);

		this.registerEvent(this.todoistService.on('id-mapping-updated', () => {
			const file = this.app.workspace.getActiveFile();
			if (file) void this.syncManager.syncDownIfHasLocalIds(file);
		}));

		this.configureAutoSync();

		// Add settings tab
		this.addSettingTab(new ObsidoistSettingTab(this.app, this));

		// Register code block processor
		this.registerMarkdownCodeBlockProcessor("obsidoist", (source, el, ctx) => {
            this.codeBlockProcessor.process(source, el, ctx);
		});

        // Shared sync function
        const performSync = async (file: TFile) => {
             debug(`Debounced sync executing for ${file.path}. Internal sync flag: ${this.isInternalSync}`);
             // Skip if we are currently internally syncing
             if (this.isInternalSync) {
                 debug('Skipping sync due to internal flag.');
                 return;
             }

             await this.syncManager.scanAndSyncFile(file);
             this.todoistService.triggerRefresh();
        };

        // Create a debounced version of the sync function
        // We need a map of debounced functions per file path to avoid conflicts?
        // Or just one global debounce?
        // If user edits file A, then file B quickly.
        // Global debounce is fine for single user.
        // But if we switch files, we might sync the WRONG file if we capture `file` in closure?
        // My previous code: `debounce(async (file) => ...)` passed file as arg.
        // So the LATEST call's file wins.
        const debouncedSync = customDebounce(performSync, 2000);

        // 1. Listen to Editor Changes (Keystrokes)
        // This resets the debounce timer on every key press.
		this.registerEvent(this.app.workspace.on('editor-change', (editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
            if (this.isInternalSync) return;
            
            // Check if it's a TFile
            if (info.file instanceof TFile && info.file.extension === 'md') {
                // console.log(`[Obsidoist] Editor change detected: ${info.file.path}`);
				debouncedSync(info.file);
			}
		}));

        // 2. Listen to Vault Modifications (External changes or Autosave)
        // This catches changes not made via active editor (e.g. other plugins)
        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (this.isInternalSync) return;

            if (file instanceof TFile && file.extension === 'md') {
                // console.log(`[Obsidoist] File modification detected: ${file.path}`);
                debouncedSync(file);
            }
        }));
        
        // Wrap SyncManager modification methods to manage isInternalSync flag
        this.syncManager.setInternalSyncCallback((isSyncing) => {
            debug(`Setting internal sync flag to: ${isSyncing}`);
            this.isInternalSync = isSyncing;
        });

        // Manual Sync Command (Sync Down)
        this.addCommand({
            id: 'sync-todoist-file',
            name: 'Sync current file from Todoist',
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (file) {
                    await this.todoistService.syncNow();
                    await this.syncManager.syncDown(file);
                    // Also scan up just in case
                    await this.syncManager.scanAndSyncFile(file);
                    
                    // Trigger refresh of views after manual sync
                    this.todoistService.triggerRefresh();
                }
            }
        });

	}

	async onunload() {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}

	private configureAutoSync() {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}

		const seconds = Number(this.settings.autoSyncIntervalSeconds);
		if (!Number.isFinite(seconds) || seconds <= 0) return;

		this.autoSyncIntervalId = window.setInterval(() => {
			void (async () => {
				await this.todoistService.syncNow();
				const file = this.app.workspace.getActiveFile();
				if (file) await this.syncManager.syncDown(file);
			})();
		}, seconds * 1000);
	}

	private async loadPluginData() {
        const raw = await this.loadData();

        if (raw && typeof raw === 'object' && (raw as any).version === 2) {
            const data = raw as any;
            this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings ?? {});
            this.localState = migrateLocalState(data.local);
            return;
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
        this.localState = createDefaultLocalState();
    }

    private async savePluginData() {
        await this.saveData({
            version: 2,
            settings: this.settings,
            local: this.localState
        });
    }

	async saveSettings() {
        await this.savePluginData();
		setDebugEnabled(this.settings.debugLogging ?? false);
        if (this.todoistService) {
            this.todoistService.updateToken(this.settings.todoistToken);
			this.todoistService.setUseSyncApi(this.settings.useSyncApi ?? true);
			this.todoistService.updateCachePolicy({
				completedRetentionDays: this.settings.completedRetentionDays,
				maxFilterCacheEntries: this.settings.maxFilterCacheEntries
			});
            void this.todoistService.syncNow();
        }
		this.configureAutoSync();
	}
}
