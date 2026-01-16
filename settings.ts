import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type ObsidoistPlugin from './main';

export interface ObsidoistSettings {
	todoistToken: string;
	syncTag: string;
    defaultProjectId: string;
	autoSyncIntervalSeconds: number;
	completedRetentionDays: number;
	maxFilterCacheEntries: number;
	useSyncApi: boolean;
	codeblockAutoRefreshSeconds: number;
	debugLogging: boolean;
}

export const DEFAULT_SETTINGS: ObsidoistSettings = {
	todoistToken: '',
	syncTag: '#todoist',
	defaultProjectId: '',
	autoSyncIntervalSeconds: 60,
	completedRetentionDays: 30,
	maxFilterCacheEntries: 50,
	useSyncApi: true,
	codeblockAutoRefreshSeconds: 60,
	debugLogging: false
}

export class ObsidoistSettingTab extends PluginSettingTab {
	plugin: ObsidoistPlugin;

	constructor(app: App, plugin: ObsidoistPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

		display(): void {
			const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Obsidoist Settings' });

		containerEl.createEl('h3', { text: 'Basic' });

		new Setting(containerEl)
			.setName('Todoist API Token')
			.setDesc('Your Todoist API token. You can find it in Todoist Settings > Integrations.')
			.addText(text => text
				.setPlaceholder('Enter your token')
				.setValue(this.plugin.settings.todoistToken)
				.onChange(async (value) => {
					this.plugin.settings.todoistToken = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		const projectSetting = new Setting(containerEl)
			.setName('Default Project')
			.setDesc('New tasks will be created in this project by default. Leave empty for Inbox.');

		if (this.plugin.settings.todoistToken) {
			this.plugin.todoistService.getProjects().then(projects => {
				projectSetting.addDropdown(dropdown => {
					dropdown.addOption('', 'Inbox');
					projects.forEach(project => {
						if (project.name !== 'Inbox') dropdown.addOption(project.id, project.name);
					});
					dropdown.setValue(this.plugin.settings.defaultProjectId);
					dropdown.onChange(async (value) => {
						this.plugin.settings.defaultProjectId = value;
						await this.plugin.saveSettings();
					});
				});
			}).catch(() => {
				projectSetting.setDesc('Failed to load projects. Check your API token.');
				projectSetting.addText(text => text
					.setPlaceholder('Project ID')
					.setValue(this.plugin.settings.defaultProjectId)
					.onChange(async (value) => {
						this.plugin.settings.defaultProjectId = value;
						await this.plugin.saveSettings();
					}));
			});
		} else {
			projectSetting.setDesc('Enter API token to select project.');
		}

		new Setting(containerEl)
			.setName('Sync Tag')
			.setDesc('The tag used to identify tasks that should be synced with Todoist.')
			.addText(text => text
				.setPlaceholder('#todoist')
				.setValue(this.plugin.settings.syncTag)
				.onChange(async (value) => {
					this.plugin.settings.syncTag = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Sync' });

		new Setting(containerEl)
			.setName('Codeblock auto refresh (seconds)')
			.setDesc('How often obsidoist code blocks refresh themselves. Set 0 to disable.')
			.addText(text => text
				.setPlaceholder('60')
				.setValue(String(this.plugin.settings.codeblockAutoRefreshSeconds ?? 60))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value.trim() || '0', 10);
					const seconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
					this.plugin.settings.codeblockAutoRefreshSeconds = seconds;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync interval (seconds)')
			.setDesc('How often to sync in background. Set 0 to disable.')
			.addText(text => text
				.setPlaceholder('60')
				.setValue(String(this.plugin.settings.autoSyncIntervalSeconds ?? 60))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value.trim() || '0', 10);
					const intervalSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
					this.plugin.settings.autoSyncIntervalSeconds = intervalSeconds;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync now')
			.setDesc('Flush pending local changes and refresh tasks.')
			.addButton(btn => btn
				.setButtonText('Sync')
				.onClick(async () => {
					try {
						await this.plugin.todoistService.syncNow();
						const file = this.plugin.app.workspace.getActiveFile();
						if (file) {
							await this.plugin.syncManager.syncDown(file);
						}
						this.plugin.todoistService.triggerRefresh();
						new Notice('Obsidoist: sync completed');
						this.display();
					} catch (e) {
						new Notice(`Obsidoist: sync failed: ${e?.message ?? e}`);
					}
				}));

		const status = this.plugin.todoistService.getSyncStatus();
		const cache = this.plugin.todoistService.getCacheStats();
		const queueLength = this.plugin.todoistService.getQueueLength();

		new Setting(containerEl)
			.setName('Sync status')
			.setDesc(
				`Queue: ${queueLength} | Tasks: ${cache.tasks} | Filters: ${cache.filters} | Last success: ${status.lastSuccessfulSyncAt ? new Date(status.lastSuccessfulSyncAt).toLocaleString() : 'Never'}${status.lastErrorMessage ? ` | Last error: ${status.lastErrorMessage}` : ''}`
			);

		new Setting(containerEl)
			.setName('Todoist Sync API')
			.setDesc('Test whether Todoist Sync API is reachable from your current Obsidian environment.')
			.addButton(btn => btn
				.setButtonText('Test')
				.onClick(async () => {
					const result = await this.plugin.todoistService.testSyncApiConnectivity();
					new Notice(result.message);
					this.display();
				}));

		new Setting(containerEl)
			.setName('Use Sync API')
			.setDesc('Recommended for local-first clients. Uses Todoist Sync API for incremental sync.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useSyncApi ?? true)
				.onChange(async (value) => {
					this.plugin.settings.useSyncApi = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Cache' });

		new Setting(containerEl)
			.setName('Filter cache retention (days)')
			.setDesc('Only affects cached filter results; does not delete Todoist tasks. Set to 0 to disable age-based pruning.')
			.addText(text => text
				.setPlaceholder('30')
				.setValue(String(this.plugin.settings.completedRetentionDays ?? 30))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value.trim() || '0', 10);
					const days = Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
					this.plugin.settings.completedRetentionDays = days;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Max cached filters')
			.setDesc('Maximum number of cached filter result sets to keep (LRU).')
			.addText(text => text
				.setPlaceholder('50')
				.setValue(String(this.plugin.settings.maxFilterCacheEntries ?? 50))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value.trim() || '0', 10);
					const max = Number.isFinite(parsed) && parsed >= 0 ? parsed : 50;
					this.plugin.settings.maxFilterCacheEntries = max;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Maintenance (advanced)')
			.setDesc('Utilities for troubleshooting or reducing local data size. Most users do not need these.')
			.addButton(btn => btn
				.setButtonText('Prune filter cache')
				.onClick(async () => {
					this.plugin.todoistService.pruneCache({
						completedRetentionDays: this.plugin.settings.completedRetentionDays,
						maxFilterCacheEntries: this.plugin.settings.maxFilterCacheEntries
					});
					new Notice('Obsidoist: filter cache pruned');
					this.display();
				}))
			.addButton(btn => btn
				.setButtonText('Prune local id mappings')
				.onClick(async () => {
					const ok = window.confirm(
						'Prune local id mappings (local-...) that are no longer referenced in your vault?\n\nThis scans markdown files and may take a while on large vaults.'
					);
					if (!ok) return;

					const aliasKeys = this.plugin.todoistService.getIdAliasMapKeys().filter(x => x.startsWith('local-'));
					if (aliasKeys.length === 0) {
						new Notice('Obsidoist: no local id mappings to prune');
						return;
					}

					new Notice('Obsidoist: scanning vault for local ids…');

					const aliasKeySet = new Set(aliasKeys);
					const keep = new Set<string>();
					for (const id of this.plugin.todoistService.getLocalIdsReferencedInState()) {
						if (aliasKeySet.has(id)) keep.add(id);
					}

					const re = /\[todoist_id:(local-[\w-]+)\]/g;
					const files = (this.app.vault as any).getMarkdownFiles ? (this.app.vault as any).getMarkdownFiles() : this.app.vault.getFiles();
					for (const f of files) {
						if ((f as any).extension && (f as any).extension !== 'md') continue;
						let text = '';
						try {
							text = await (this.app.vault as any).cachedRead ? (this.app.vault as any).cachedRead(f) : this.app.vault.read(f);
						} catch {
							continue;
						}
						let m: RegExpExecArray | null;
						while ((m = re.exec(text)) !== null) {
							const id = m[1];
							if (aliasKeySet.has(id)) keep.add(id);
						}
					}

					const keepSet = new Set(this.plugin.todoistService.getIdAliasMapKeys().filter(x => keep.has(x)));
					const removed = this.plugin.todoistService.pruneIdAliasMap(keepSet);
					new Notice(`Obsidoist: pruned ${removed} id mappings`);
					this.display();
				}))
			.addButton(btn => btn
				.setButtonText('Clear sync queue')
				.onClick(async () => {
					const ok = window.confirm('Clear all pending sync operations?\n\nThis will not delete tasks on Todoist, but may lose unsynced local changes.');
					if (!ok) return;
					this.plugin.todoistService.clearQueue();
					new Notice('Obsidoist: sync queue cleared');
					this.display();
				}));

		containerEl.createEl('h3', { text: 'Developer' });

		new Setting(containerEl)
			.setName('Debug logging')
			.setDesc('Enable verbose logs in the developer console.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugLogging ?? false)
				.onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				}));
	}
}
