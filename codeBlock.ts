import { MarkdownPostProcessorContext, MarkdownRenderChild, App, Notice, setIcon, MarkdownView, TFile } from "obsidian";
import { debug } from './logger';
import { TodoistService } from "./todoistService";
import { SyncManager } from "./syncManager";
import type { ObsidoistSettings } from "./settings";
import { Task } from '@doist/todoist-api-typescript';

export class ObsidoistTaskList extends MarkdownRenderChild {
    app: App;
    service: TodoistService;
    syncManager: SyncManager;
    source: string;
    container: HTMLElement;
    ctx: MarkdownPostProcessorContext;
	settings: ObsidoistSettings;
	private sourceFile: TFile | null = null;
    
    // DOM Elements
    private wrapper: HTMLElement | null = null;
    private header: HTMLElement | null = null;
    private refreshBtn: HTMLElement | null = null;
    private editBtn: HTMLElement | null = null; 
    private listContainer: HTMLElement | null = null;
    private footer: HTMLElement | null = null;
    private ul: HTMLElement | null = null;

    private codeBlockWrapper: HTMLElement | null = null;

    private observer: MutationObserver | null = null;
	private autoRefreshIntervalId: number | null = null;
	private lastRemoteFetchAt = 0;
	private remoteFetchInFlight = false;
	private suppressServiceRefresh = false;

    constructor(app: App, container: HTMLElement, service: TodoistService, syncManager: SyncManager, settings: ObsidoistSettings, source: string, ctx: MarkdownPostProcessorContext) {
        super(container);
        this.app = app;
        this.service = service;
        this.syncManager = syncManager;
        this.settings = settings;
        this.source = source;
        this.container = container;
        this.ctx = ctx;
    }

    onload(): void {
		const abstract = this.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		this.sourceFile = abstract instanceof TFile ? abstract : null;
        this.codeBlockWrapper = this.findCodeBlockWrapperAndTag();

        if (this.codeBlockWrapper) {
            this.hideNativeEditButtons(this.codeBlockWrapper);

            this.observer = new MutationObserver(() => {
                if (this.codeBlockWrapper) this.hideNativeEditButtons(this.codeBlockWrapper);
            });

            this.observer.observe(this.codeBlockWrapper, {
                childList: true,
                subtree: true
            });
        }

        this.buildDom();
        void this.refresh().catch((e) => {
            console.error('[Obsidoist] Initial refresh failed', e);
        });

		this.startAutoRefreshIfNeeded();
        
        // Register event listener for refresh
        this.registerEvent(this.service.on('refresh', () => {
			debug('View received refresh event. Re-rendering.');
			if (this.suppressServiceRefresh) return;
            
            // Trigger animation on auto-refresh too
            if (this.refreshBtn && !this.refreshBtn.hasClass("obsidoist-spinning")) {
                 this.refreshBtn.addClass("obsidoist-spinning");
            }
            
            void this.refresh()
                .catch((e) => {
                    console.error('[Obsidoist] Refresh failed', e);
                })
                .finally(() => {
                    setTimeout(() => this.refreshBtn?.removeClass("obsidoist-spinning"), 500);
                });

			const { filter } = this.parseSourceConfig();
			if (filter) {
				void this.maybeRefreshFilterFromRemote('event');
			}
        }));
    }

    private parseSourceConfig() {
        const lines = this.source.split('\n');
        let filter = "";
        let name = "";
		let limit: number | undefined = undefined;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('filter:')) {
                filter = trimmed.substring(7).trim();
            } else if (trimmed.startsWith('name:')) {
                name = trimmed.substring(5).trim();
			} else if (trimmed.startsWith('limit:')) {
				const raw = trimmed.substring(6).trim();
				const parsed = Number.parseInt(raw || '0', 10);
				if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
            }
        }


        return { filter, name, limit };
    }
    
    onunload() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

		if (this.autoRefreshIntervalId !== null) {
			window.clearInterval(this.autoRefreshIntervalId);
			this.autoRefreshIntervalId = null;
		}
    }

	private startAutoRefreshIfNeeded() {
		const seconds = Number(this.settings.codeblockAutoRefreshSeconds);
		if (!Number.isFinite(seconds) || seconds <= 0) return;
		this.autoRefreshIntervalId = window.setInterval(() => {
			void this.refresh();
			const { filter } = this.parseSourceConfig();
			if (filter) {
				void this.maybeRefreshFilterFromRemote('interval');
			}
		}, seconds * 1000);
	}

	private async maybeRefreshFilterFromRemote(source: 'event' | 'interval' | 'render') {
		const { filter } = this.parseSourceConfig();
		if (!filter) return;

		const now = Date.now();
		const minGapMs = 8000;
		if (this.remoteFetchInFlight) return;
		if (now - this.lastRemoteFetchAt < minGapMs) return;

		this.remoteFetchInFlight = true;
		this.lastRemoteFetchAt = now;
		try {
			if (this.refreshBtn && !this.refreshBtn.hasClass('obsidoist-spinning')) {
				this.refreshBtn.addClass('obsidoist-spinning');
			}

			this.suppressServiceRefresh = true;
			await this.service.syncFilterNow(filter);
			if (source !== 'render') {
				await this.refresh();
			}
		} catch (e) {
			console.error(`[Obsidoist] Remote filter refresh failed (${source})`, e);
		} finally {
			this.suppressServiceRefresh = false;
			this.remoteFetchInFlight = false;
			setTimeout(() => this.refreshBtn?.removeClass('obsidoist-spinning'), 500);
		}
	}

    private findCodeBlockWrapperAndTag(): HTMLElement | null {
        let current: HTMLElement | null = this.container;
        let targetWrapper: HTMLElement | null = null;

        for (let i = 0; current && i < 10; i++) {
            current.addClass('obsidoist-code-block-wrap');

            if (!targetWrapper) {
                const isLikelyWrapper =
                    current.hasClass('code-block-wrap') ||
                    current.hasClass('cm-preview-code-block') ||
                    current.querySelector('.edit-block-button');
                if (isLikelyWrapper) targetWrapper = current;
            }

            current = current.parentElement;
        }

        return targetWrapper;
    }

    private hideNativeEditButtons(wrapper: HTMLElement) {
        const nativeButtons = Array.from(wrapper.querySelectorAll('.edit-block-button'));
        for (const nativeBtn of nativeButtons) {
            if (!(nativeBtn instanceof HTMLElement)) continue;
            nativeBtn.classList.add('obsidoist-native-edit-hidden');
        }
    }
    
    // Build the static DOM structure once
    private buildDom() {
        this.container.empty();
        this.wrapper = this.container.createDiv({ cls: "obsidoist-list" });
        
        // 1. Header (Clean Flexbox Layout)
        this.header = this.wrapper.createDiv({ cls: "obsidoist-header" });
        
        const title = this.header.createDiv({ cls: "obsidoist-title" });
        const { name } = this.parseSourceConfig();
        if (name) title.setText(name);
        
        // Controls Container (Right aligned)
        const controls = this.header.createDiv({ cls: "obsidoist-controls" });

        // Refresh Button
        this.refreshBtn = controls.createEl("button", { 
            cls: "obsidoist-refresh-btn", 
            attr: { "aria-label": "Refresh tasks" } 
        });
        setIcon(this.refreshBtn, "refresh-cw");
        
        this.refreshBtn.onclick = async () => {
            if (this.refreshBtn?.hasClass("obsidoist-spinning")) return; 
            
            this.refreshBtn?.addClass("obsidoist-spinning");
			try {
				this.suppressServiceRefresh = true;
				const { filter } = this.parseSourceConfig();
				const file = this.sourceFile ?? this.app.workspace.getActiveFile();
				if (file) await this.syncManager.syncFile(file);
				await this.service.syncFilterNow(filter);
				await this.refresh();
			} finally {
				this.suppressServiceRefresh = false;
				setTimeout(() => this.refreshBtn?.removeClass("obsidoist-spinning"), 500);
			}
		};

        // Custom Edit Button
        this.editBtn = controls.createEl("button", { 
            cls: "obsidoist-edit-btn", 
            attr: { "aria-label": "Edit block" } 
        });
        setIcon(this.editBtn, "lucide-code-2"); 
        
        this.editBtn.onclick = () => {
             const view = this.app.workspace.getActiveViewOfType(MarkdownView);
             if (view) {
                 const sectionInfo = this.ctx.getSectionInfo(this.container);
                 if (sectionInfo) {
                     const line = sectionInfo.lineStart;
                     view.editor.setCursor(line, 0);
                     view.editor.focus();
                 }
             }
        };

        // 2. List Container
        this.listContainer = this.wrapper.createDiv({ cls: "obsidoist-list-container" });
        this.listContainer.createDiv({ text: "Loading tasks...", cls: "obsidoist-loading" });

        // 3. Footer
        this.footer = this.wrapper.createDiv({ cls: "obsidoist-footer" });
        this.footer.setText("Total - tasks");
    }
    
    // Ensure DOM is healthy before updates
    private ensureDom() {
        if (!this.wrapper || !this.container.contains(this.wrapper)) {
			debug('DOM missing or detached, rebuilding...');
            this.buildDom();
        }
    }

    async refresh() {
        this.ensureDom();
        
        try {
			const { filter, name, limit } = this.parseSourceConfig();
            
            // Update Title if present
            const titleEl = this.header?.querySelector('.obsidoist-title');
            if (titleEl) {
                titleEl.textContent = name; // If empty, it collapses naturally
            }

			if (filter) {
				await this.maybeRefreshFilterFromRemote('render');
			}

            const allTasks = await this.service.getTasks(filter);
			const tasks = limit ? allTasks.slice(0, limit) : allTasks;
            
			this.updateView(tasks, allTasks.length);

        } catch (e) {
            console.error("[Obsidoist] Error fetching tasks:", e);
            if (this.listContainer) {
                this.listContainer.empty();
                const errorDiv = this.listContainer.createDiv({ cls: "obsidoist-error" });
                errorDiv.setText("Error loading tasks: " + e.message);
            }
            if (this.footer) this.footer.setText("Error");
        }
    }
    
    private updateView(tasks: Task[], totalCount: number) {
        this.ensureDom();
        
        // Remove loading indicator if present
        const loading = this.listContainer?.querySelector(".obsidoist-loading");
        if (loading) loading.remove();
        
        // Update Footer
        if (this.footer) {
			if (tasks.length === totalCount) this.footer.setText(`Total ${totalCount} tasks`);
			else this.footer.setText(`Total ${totalCount} tasks (showing ${tasks.length})`);
        }
        
        if (!this.listContainer) return;
        
        // Handle empty state
        if (tasks.length === 0) {
            this.listContainer.empty();
            this.listContainer.createDiv({ text: "No tasks found.", cls: "obsidoist-empty" });
            this.ul = null;
            return;
        }
        
        // Ensure UL exists
        if (!this.ul || !this.listContainer.contains(this.ul)) {
            // Clear potential empty message
            const emptyMsg = this.listContainer.querySelector(".obsidoist-empty");
            if (emptyMsg) emptyMsg.remove();
            
            this.ul = this.listContainer.createEl("ul");
        } else {
            this.ul.empty();
        }
        
        // Render Tasks
        for (const task of tasks) {
            const li = this.ul.createEl("li");
            
            const checkbox = li.createEl("input", { type: "checkbox" });
            checkbox.checked = task.isCompleted;
            
            if (task.isCompleted) {
                li.addClass("is-checked");
            }
            
            checkbox.onchange = async () => {
                const nextCompleted = checkbox.checked;
				debug('Codeblock checkbox change', { id: task.id, nextCompleted });

                if (nextCompleted) {
                    li.addClass("is-checked");
                } else {
                    li.removeClass("is-checked");
                }

                if (this.refreshBtn && !this.refreshBtn.hasClass("obsidoist-spinning")) {
                    this.refreshBtn.addClass("obsidoist-spinning");
                }

                try {
					this.suppressServiceRefresh = true;
					debug('Codeblock enqueue op', { id: task.id, op: nextCompleted ? 'close' : 'reopen' });
                    if (nextCompleted) await this.service.closeTask(task.id);
                    else await this.service.reopenTask(task.id);
                } catch (err) {
                    new Notice(`Failed to update task: ${err instanceof Error ? err.message : String(err)}`);

                    checkbox.checked = !nextCompleted;
                    if (checkbox.checked) li.addClass("is-checked");
                    else li.removeClass("is-checked");

					this.suppressServiceRefresh = false;
                    this.refreshBtn?.removeClass("obsidoist-spinning");
                    return;
                }

				try {
					const { filter } = this.parseSourceConfig();
					debug('Codeblock sync start', { filter: filter || undefined });
					if (filter) await this.service.syncFilterNow(filter);
					else await this.service.syncNow();

					const file = this.sourceFile ?? this.app.workspace.getActiveFile();
					debug('Codeblock syncDownSafe', { activeFile: file?.path });
					if (file) {
						await this.syncManager.syncDownSafe(file);
					}

					debug('Codeblock refresh view');
					await this.refresh();
				} finally {
					debug('Codeblock done', { id: task.id });
					this.suppressServiceRefresh = false;
					setTimeout(() => this.refreshBtn?.removeClass("obsidoist-spinning"), 500);
				}
            };
            
            li.createEl("span", { text: task.content });
        }
    }
}

export class CodeBlockProcessor {
    app: App;
    service: TodoistService;
    syncManager: SyncManager;
	settings: ObsidoistSettings;

    constructor(app: App, service: TodoistService, syncManager: SyncManager, settings: ObsidoistSettings) {
        this.app = app;
        this.service = service;
        this.syncManager = syncManager;
		this.settings = settings;
    }

    process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
        // Pass ctx to the child
        const child = new ObsidoistTaskList(this.app, el, this.service, this.syncManager, this.settings, source, ctx);
        ctx.addChild(child);
    }
}
