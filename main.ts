import { Plugin, TFile } from 'obsidian';
import { ObsidoistSettings, DEFAULT_SETTINGS, ObsidoistSettingTab } from './settings';
import { TodoistService } from './todoistService';
import { SyncManager } from './syncManager';
import { CodeBlockProcessor } from './codeBlock';
import { createDefaultLocalState, migrateLocalState, ObsidoistLocalState } from './localState';
import { setDebugEnabled } from './logger';
import { debug } from './logger';

// Custom debounce implementation to ensure consistent behavior
function customDebounce<T extends (...args: unknown[]) => unknown>(func: T, wait: number): (...args: Parameters<T>) => void {
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
		this.todoistService.normalizeLineShadows();
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

		const active = this.app.workspace.getActiveFile();
		if (active) void this.syncManager.primeFileShadows(active);

		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				void this.syncManager.primeFileShadows(file);
			}
		}));

        // Shared sync function
        const performSync = async (file: TFile) => {
             debug(`Debounced sync executing for ${file.path}.`);
			await this.syncManager.syncFile(file);
        };

		const debouncedSyncByPath = new Map<string, () => void>();

		const scheduleDebouncedSync = (file: TFile) => {
			const path = file.path;
			let debounced = debouncedSyncByPath.get(path);
			if (!debounced) {
				debounced = customDebounce(() => {
					const f = this.app.vault.getAbstractFileByPath(path);
					if (f instanceof TFile) void performSync(f);
				}, 2000);
				debouncedSyncByPath.set(path, debounced);
			}
			debounced();
		};

        // Listen to Vault Modifications (external changes or autosave/flush-to-disk)
        // We intentionally trigger sync only after content has been written to the vault,
        // to avoid reading stale content during editor-change windows.
        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
				if (this.syncManager.isLikelyInternalModify(file)) return;
                // console.log(`[Obsidoist] File modification detected: ${file.path}`);
                scheduleDebouncedSync(file);
            }
        }));

        // Manual Sync Command (Sync Down)
        this.addCommand({
            id: 'sync-todoist-file',
            name: 'Sync current file from Todoist',
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (file) {
					await this.syncManager.syncFile(file);
					this.todoistService.triggerRefresh();
                }
            }
        });

	}

	onunload(): void {
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
			const file = this.app.workspace.getActiveFile();
			if (file) void this.syncManager.syncFile(file);
		}, seconds * 1000);
	}

	private async loadPluginData() {
        const raw = await this.loadData();

        if (raw && typeof raw === 'object' && (raw as { version?: unknown }).version === 2) {
            const data = raw as { version: 2; settings?: Partial<ObsidoistSettings>; local?: unknown };
            this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings ?? {});
            this.localState = migrateLocalState(data.local);
            return;
        }

        const settings = raw && typeof raw === 'object' ? (raw as Partial<ObsidoistSettings>) : {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
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
