import { App, TFile, Notice } from 'obsidian';
import { TodoistService } from './todoistService';
import { ObsidoistSettings } from './settings';
import { Project } from '@doist/todoist-api-typescript';
import { debug } from './logger';

export class SyncManager {
    app: App;
    service: TodoistService;
    settings: ObsidoistSettings;

	private syncChain: Promise<void> = Promise.resolve();

	private lastInternalModifyAtByPath = new Map<string, number>();
    
    private sigEquals(a: { content: string; isCompleted: boolean; projectId?: string; dueDate?: string } | undefined, b: { content: string; isCompleted: boolean; projectId?: string; dueDate?: string } | undefined): boolean {
        if (!a || !b) return false;
        return a.content === b.content && a.isCompleted === b.isCompleted && (a.projectId ?? undefined) === (b.projectId ?? undefined) && (a.dueDate ?? undefined) === (b.dueDate ?? undefined);
    }
    
    // Cache for projects
    private projects: Project[] = [];
    private lastProjectFetch = 0;

    // Regex to match tasks with the sync tag (strict) - used for legacy clean parsing if needed
    // Matches: - [ ] Task content #tag [todoist_id:12345]
    private get regex() {
        // Escaping the tag for regex
        const tag = this.settings.syncTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`^\\s*-\\s\\[(.)\\]\\s+(.*?)(\\s${tag})(?:\\s\\[todoist_id:(\\d+)\\])?\\s*$`);
    }

    // Flexible regex for detecting ID only
    // Matches: [todoist_id:12345] anywhere in the line
    private get idRegex() {
        return /\[todoist_id:([\w-]+)\]/;
    }

	private get dueRegex() {
		return /(?:🗓️?|📅)\s*(\d{4}-\d{2}-\d{2})/;
	}

    constructor(app: App, service: TodoistService, settings: ObsidoistSettings) {
        this.app = app;
        this.service = service;
        this.settings = settings;
    }

	private enqueueSync(fn: () => Promise<void>): Promise<void> {
		const run = async () => {
			try {
				await fn();
			} catch (e) {
				console.error('[Obsidoist] Sync failed', e);
			}
		};
		const next = this.syncChain.then(run, run);
		this.syncChain = next;
		return next;
	}

	syncFile(file: TFile): Promise<void> {
		return this.enqueueSync(async () => {
			debug('syncFile:start', { path: file.path });
			await this.scanAndSyncFile(file);
			await this.service.syncNow();
			await this.syncDown(file);
			this.service.triggerRefresh();
			debug('syncFile:done', { path: file.path });
		});
	}

	syncAfterQueue(file: TFile): Promise<void> {
		return this.enqueueSync(async () => {
			debug('syncAfterQueue:start', { path: file.path });
			await this.service.syncNow();
			await this.syncDown(file);
			this.service.triggerRefresh();
			debug('syncAfterQueue:done', { path: file.path });
		});
	}

	syncDownSafe(file: TFile): Promise<void> {
		return this.enqueueSync(async () => {
			debug('syncDownSafe:start', { path: file.path });
			await this.syncDown(file);
			this.service.triggerRefresh();
			debug('syncDownSafe:done', { path: file.path });
		});
	}
    
	isLikelyInternalModify(file: TFile): boolean {
		const at = this.lastInternalModifyAtByPath.get(file.path);
		if (!at) return false;
		return (Date.now() - at) < 2000;
	}

    private async ensureProjects() {
        // Refresh projects every 5 minutes or if empty
        if (Date.now() - this.lastProjectFetch > 300000 || this.projects.length === 0) {
            this.projects = await this.service.getProjects();
            this.lastProjectFetch = Date.now();
        }
    }

    private findProjectByTag(content: string): string | undefined {
        const lowerContent = content.toLowerCase();
        for (const project of this.projects) {
            const normalizedProjectName = project.name.replace(/\s+/g, '');
            const tag = `#${normalizedProjectName.toLowerCase()}`;
            if (lowerContent.includes(tag)) {
                return project.id;
            }
        }
        return undefined;
    }
    
    // Helper to check if a line contains the sync tag as a proper tag
    private hasSyncTag(line: string): boolean {
        const tag = this.settings.syncTag;
        // Check if tag exists preceded by space or start of line, and followed by space or end of line
        // We can simply check for inclusion but let's be slightly safer
        // Actually, Obsidian tags are flexible. But we usually expect " #tag" or "#tag "
        return line.includes(tag);
    }

    // Helper to extract clean content
    private extractContent(line: string, stripProjectTags: boolean = false): string {
         let content = line.replace(/^(\s*)-\s\[(.)\]\s+/, '')
            .replace(this.idRegex, '')
            .replace(this.dueRegex, '')
            .replace(this.settings.syncTag, '') // Also strip the sync tag
            .trim();
            
         if (stripProjectTags) {
             // Also strip tags that match known projects
             for (const project of this.projects) {
                const normalizedProjectName = project.name.replace(/\s+/g, '');
                // Regex to replace #ProjectName case insensitive
                const tagRegex = new RegExp(`#${normalizedProjectName}`, 'gi');
                content = content.replace(tagRegex, '');
             }
             // Clean up potential double spaces left behind
             content = content.replace(/\s+/g, ' ').trim();
         }
         
         return content;
    }

    private extractDueDate(line: string): string | undefined {
        const match = line.match(this.dueRegex);
        return match?.[1];
    }

	async scanAndSyncFile(file: TFile, opts?: { primedCache?: boolean }) {
		if (!file) return;
		debug(`Scanning file: ${file.path}`);
		const content = await this.app.vault.read(file);
		const lines = content.split('\n');
		let modified = false;
		const newLines = [...lines];

		// Ensure we have projects loaded for mapping
		await this.ensureProjects();

		if (!opts?.primedCache && /\[todoist_id:/.test(content) && this.service.getLastFullSyncAt() === undefined) {
			await this.service.syncNow();
			await this.scanAndSyncFile(file, { primedCache: true });
			return;
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
            
            // Try detecting existing ID first with flexible regex
            const idMatch = line.match(this.idRegex);
            
			if (idMatch) {
				// Existing task with ID
				const rawId = idMatch[1];
				const existingId = this.service.resolveTaskId(rawId);
				const statusMatch = line.match(/^(\s*)-\s\[(.)\]/);

				if (!opts?.primedCache && /^\d+$/.test(existingId) && !this.service.getCachedTask(existingId)) {
					await this.service.syncNow();
					await this.scanAndSyncFile(file, { primedCache: true });
					return;
				}

                if (rawId !== existingId) {
                    newLines[i] = newLines[i].replace(`[todoist_id:${rawId}]`, `[todoist_id:${existingId}]`);
                    modified = true;
					this.service.moveLineShadow(rawId, existingId);
                }
                
                if (statusMatch) {
                    const status = statusMatch[2];
                    const isCompleted = status !== ' ';
                    
                    // Extract content - use consistent extraction method
					const taskContent = this.extractContent(line, true);
					const dueDate = this.extractDueDate(line);
					const rawContentWithTags = this.extractContent(line, false);
					const tagProjectId = this.findProjectByTag(rawContentWithTags);

					const cached = this.service.getCachedTask(existingId);

					const currentSig = { content: taskContent, dueDate, projectId: tagProjectId, isCompleted };
					let prevSig = this.service.getLineShadow(existingId);
					if (!prevSig && cached) {
						prevSig = { content: cached.content, dueDate: cached.dueDate, projectId: cached.projectId, isCompleted: cached.isCompleted };
					}
					if (!prevSig) {
						debug('scan:missingPrevSig', { id: existingId, hasCached: Boolean(cached), isCompleted: currentSig.isCompleted });
						this.service.setLineShadow(existingId, currentSig);
						continue;
					}
					if (this.sigEquals(prevSig, currentSig)) {
						debug('scan:noChange', { id: existingId, isCompleted: currentSig.isCompleted });
						continue;
					}

					if (prevSig.content !== currentSig.content || (prevSig.dueDate ?? undefined) !== (currentSig.dueDate ?? undefined)) {
						debug('scan:enqueue:update', { id: existingId });
						const success = await this.service.updateTask(existingId, taskContent, dueDate);
						if (success) new Notice(`Updated Todoist task: ${taskContent.substring(0, 20)}...`);
					}

					if (currentSig.projectId && (prevSig.projectId ?? undefined) !== currentSig.projectId) {
						debug('scan:enqueue:move', { id: existingId, projectId: currentSig.projectId });
						await this.service.moveTask(existingId, currentSig.projectId);
					}

					if (prevSig.isCompleted !== currentSig.isCompleted) {
						debug('scan:enqueue:toggle', { id: existingId, from: prevSig.isCompleted, to: currentSig.isCompleted });
						if (currentSig.isCompleted) await this.service.closeTask(existingId);
						else await this.service.reopenTask(existingId);
					}

					this.service.setLineShadow(existingId, currentSig);
				}
			} else {
                // No ID found, check if it is a NEW task candidate
                const taskMatch = line.match(/^(\s*)-\s\[(.)\]/);
                if (taskMatch && this.hasSyncTag(line)) {
                    const status = taskMatch[2];
                    const isCompleted = status !== ' ';
                    
                    // First extract content WITH tags to determine project
                    const rawContent = this.extractContent(line, false);
					const dueDate = this.extractDueDate(line);

                    // Determine Project ID
                    let projectId = this.settings.defaultProjectId;
                    const tagProjectId = this.findProjectByTag(rawContent);
                    if (tagProjectId) {
                        projectId = tagProjectId;
                    }
                    
                    // Now get CLEAN content for Todoist (without project tags)
                    const cleanContent = this.extractContent(line, true);

                    const apiProjectId = projectId === '' ? undefined : projectId;

					debug(`Creating task: ${cleanContent} in project ${apiProjectId || 'Inbox'}`);
					const task = await this.service.createTask(cleanContent, apiProjectId, dueDate);
					if (task) {
						newLines[i] = `${lines[i]} [todoist_id:${task.id}]`;
						modified = true;

						this.service.setLineShadow(task.id, { content: cleanContent, dueDate, projectId: apiProjectId, isCompleted });
						new Notice(`Created Todoist task: ${cleanContent.substring(0, 20)}...`);

                        if (isCompleted) {
                             await this.service.closeTask(task.id);
                        }
                    }
                }
            }
        }

        if (modified) {
			debug('Modifying file with new IDs.');
			this.lastInternalModifyAtByPath.set(file.path, Date.now());
            await this.app.vault.modify(file, newLines.join('\n'));
        }
    }

    async syncDown(file: TFile) {
		debug(`Syncing down for ${file.path}`);
        await this.ensureProjects();
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        let modified = false;
        
        const newLines = [...lines];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Flexible ID detection
            const idMatch = line.match(this.idRegex);
            
            if (idMatch) {
                const rawId = idMatch[1];
                const existingId = this.service.resolveTaskId(rawId);
                const cachedTask = this.service.getCachedTask(existingId);

                if (rawId !== existingId) {
                    newLines[i] = newLines[i].replace(`[todoist_id:${rawId}]`, `[todoist_id:${existingId}]`);
                    modified = true;
					this.service.moveLineShadow(rawId, existingId);
                }

                    if (cachedTask) {
						if (this.service.hasPendingOpsForId(existingId)) {
							debug(`syncDown skip due to pending ops for ${existingId}`);
							continue;
						}
						if (cachedTask.isDeleted) {
							const indentMatch = line.match(/^(\s*)/);
							const indent = indentMatch ? indentMatch[1] : '';
							let rest = line.slice(indent.length);
							rest = rest.replace(this.idRegex, '').replace(this.settings.syncTag, '').replace(/\s+/g, ' ').trim();
							newLines[i] = indent + rest;
							modified = true;
							continue;
						}
                        const statusMatch = line.match(/^(\s*)-\s\[(.)\]/);
                        if (statusMatch) {
                            const currentStatus = statusMatch[2];
                            const remoteStatus = cachedTask.isCompleted ? 'x' : ' ';
                            
                            // Extract local content to compare
                            const localContent = this.extractContent(line, true);
                            const remoteContent = cachedTask.content;
						const localDueDate = this.extractDueDate(line);
						const remoteDueDate = cachedTask.dueDate;

						const remoteSig = {
							content: remoteContent,
							isCompleted: cachedTask.isCompleted,
							projectId: cachedTask.projectId,
							dueDate: remoteDueDate
						};

						let localProjectId: string | undefined = undefined;
						for (const project of this.projects) {
							const normalizedProjectName = project.name.replace(/\s+/g, '');
							const tag = `#${normalizedProjectName}`;
							if (new RegExp(tag, 'i').test(line)) {
								localProjectId = project.id;
								break;
							}
						}

						const localSig = {
							content: localContent,
							isCompleted: currentStatus !== ' ',
							projectId: localProjectId,
							dueDate: localDueDate
						};

						const shadowSig = this.service.getLineShadow(existingId);
						if (shadowSig && !this.sigEquals(shadowSig, localSig)) {
							debug(`syncDown skip due to unprocessed local edits for ${existingId}`);
							continue;
						}
                            
                            let lineModified = false;
                        
                        // Check status
                        if (currentStatus !== remoteStatus) {
							debug(`Task ${existingId} status changed: ${currentStatus} -> ${remoteStatus}`);
                            lineModified = true;
                        }
                        
							// Check content
							if (localContent !== remoteContent) {
							debug(`Task ${existingId} content changed: ${localContent} -> ${remoteContent}`);
								lineModified = true;
							}

						// Check due date
						if ((localDueDate ?? undefined) !== (remoteDueDate ?? undefined)) {
							lineModified = true;
						}

						// Check project
						if ((localProjectId ?? undefined) !== (cachedTask.projectId ?? undefined)) {
							lineModified = true;
						}
                            
                            if (lineModified) {
                                const indentMatch = line.match(/^(\s*)-\s/);
                                const indent = indentMatch ? indentMatch[1] : '';

							let dueSuffix = '';
							if (remoteDueDate) {
								dueSuffix = ` 🗓 ${remoteDueDate}`;
							}

							let projectTag = '';
							if (cachedTask.projectId) {
								const p = this.projects.find(x => x.id === cachedTask.projectId);
								if (p) projectTag = ` #${p.name.replace(/\s+/g, '')}`;
							}

							newLines[i] = `${indent}- [${remoteStatus}] ${remoteContent}${dueSuffix} ${this.settings.syncTag}${projectTag} [todoist_id:${existingId}]`;
							newLines[i] = newLines[i].replace(/\s+/g, ' ');
                                
                                modified = true;
								this.service.setLineShadow(existingId, {
									content: remoteContent,
									isCompleted: cachedTask.isCompleted,
									projectId: cachedTask.projectId,
									dueDate: remoteDueDate
								});
                            }
                        }
                    }
            }
        }
        
        if (modified) {
			debug('Modifying file with updates.');
			this.lastInternalModifyAtByPath.set(file.path, Date.now());
            await this.app.vault.modify(file, newLines.join('\n'));
        } else {
			debug('No changes needed for file.');
        }
    }

	async primeFileShadows(file: TFile): Promise<void> {
		if (!file) return;
		await this.enqueueSync(async () => {
			debug('primeFileShadows:start', { path: file.path });
			await this.ensureProjects();
			const content = await this.app.vault.read(file);
			const lines = content.split('\n');
			for (const line of lines) {
				const idMatch = line.match(this.idRegex);
				if (!idMatch) continue;
				const rawId = idMatch[1];
				const existingId = this.service.resolveTaskId(rawId);
				if (this.service.getLineShadow(existingId)) continue;
				const statusMatch = line.match(/^(\s*)-\s\[(.)\]/);
				if (!statusMatch) continue;
				const isCompleted = statusMatch[2] !== ' ';
				const taskContent = this.extractContent(line, true);
				const dueDate = this.extractDueDate(line);
				const rawContentWithTags = this.extractContent(line, false);
				const tagProjectId = this.findProjectByTag(rawContentWithTags);
				this.service.setLineShadow(existingId, { content: taskContent, dueDate, projectId: tagProjectId, isCompleted });
			}
			debug('primeFileShadows:done', { path: file.path });
		});
	}

    async syncDownIfHasLocalIds(file: TFile) {
        const content = await this.app.vault.read(file);
        if (!/\[todoist_id:local-[\w-]+\]/.test(content)) return;
        await this.syncDownSafe(file);
    }
}
