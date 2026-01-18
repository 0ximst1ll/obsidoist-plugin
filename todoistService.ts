import { TodoistApi, Task, Project } from '@doist/todoist-api-typescript';
import { Events, Notice, requestUrl } from 'obsidian';
import { createLocalId, createOperationId, LocalProjectRecord, LocalTaskRecord, ObsidoistLocalState, SyncOperation, TaskId } from './localState';
import { debug } from './logger';

type SyncApiResponse = {
    sync_token?: unknown;
    projects?: unknown[];
    items?: unknown[];
    temp_id_mapping?: Record<string, string>;
    sync_status?: unknown;
};

type SyncApiCommand = {
    type: string;
    uuid: string;
    temp_id?: string;
    args: Record<string, unknown>;
};

export class TodoistService extends Events {
    private api: TodoistApi | null = null;

    private token: string = '';

    private useSyncApi = true;

    private localState: ObsidoistLocalState;
    private requestPersist: () => void;

    private isSyncRunning = false;
    private syncInFlight: Promise<void> | null = null;
    private pendingFilterSync: string | null = null;
	private notifiedOpIds = new Set<string>();
	private toText(value: unknown): string {
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return String(value);
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	hasAnyPendingOps(): boolean {
		return this.localState.queue.length > 0;
	}

	normalizeLineShadows(): void {
		let didChange = false;
		for (const [localId, remoteId] of Object.entries(this.localState.idAliasMap ?? {})) {
			const localShadow = this.localState.lineShadowById[localId];
			const remoteShadow = this.localState.lineShadowById[remoteId];

			if (localShadow && remoteShadow) {
				if (localShadow.content === remoteShadow.content) {
					const merged = {
						content: remoteShadow.content,
						isCompleted: localShadow.isCompleted === false ? false : remoteShadow.isCompleted,
						projectId: remoteShadow.projectId ?? localShadow.projectId,
						dueDate: remoteShadow.dueDate ?? localShadow.dueDate
					};
					this.localState.lineShadowById[remoteId] = merged;
				}
				delete this.localState.lineShadowById[localId];
				didChange = true;
				continue;
			}

			if (localShadow && !remoteShadow) {
				this.localState.lineShadowById[remoteId] = localShadow;
				delete this.localState.lineShadowById[localId];
				didChange = true;
				continue;
			}

			if (!localShadow && remoteShadow) continue;
		}

		if (didChange) this.requestPersist();
	}

    private cachePolicy = { completedRetentionDays: 30, maxFilterCacheEntries: 50 };

    constructor(token: string, localState: ObsidoistLocalState, requestPersist: () => void) {
        super();
        this.localState = localState;
        this.requestPersist = requestPersist;
        this.token = token ?? '';
        if (token) {
            this.api = new TodoistApi(token);
        }
    }

    updateToken(token: string) {
        this.token = token ?? '';
        if (token) {
            this.api = new TodoistApi(token);
        } else {
            this.api = null;
        }
    }

    setUseSyncApi(enabled: boolean) {
        this.useSyncApi = enabled;
    }

    async testSyncApiConnectivity(): Promise<{ ok: boolean; status?: number; message: string; details?: unknown }>{
        const token = (this.token ?? '').trim();
        const url = 'https://api.todoist.com/sync/v9/sync';
        if (!token) {
            const msg = 'Todoist API Token is empty.';
            this.localState.status.lastSyncApiTestAt = this.now();
            this.localState.status.lastSyncApiTestResult = 'error';
            this.localState.status.lastSyncApiTestMessage = msg;
            this.requestPersist();
            return { ok: false, message: msg };
        }

        const body = new URLSearchParams({
            sync_token: '*',
            resource_types: JSON.stringify(['projects'])
        }).toString();

        try {
            const res = await requestUrl({
                url,
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body
            });

            const ok = res.status >= 200 && res.status < 300;
            let message = ok ? `Sync API reachable (HTTP ${res.status}).` : `Sync API failed (HTTP ${res.status}).`;
            let details: unknown = undefined;
            try {
                const json: unknown = res.json ?? (res.text ? JSON.parse(res.text) : undefined);
                details = json;
                if (!ok && this.isRecord(json) && typeof json.error === 'string') {
                    message += ` ${json.error}`;
                }
            } catch {
                details = undefined;
            }

            this.localState.status.lastSyncApiTestAt = this.now();
            this.localState.status.lastSyncApiTestResult = ok ? 'ok' : 'error';
            this.localState.status.lastSyncApiTestMessage = message;
            this.requestPersist();

            return { ok, status: res.status, message, details };
        } catch (e) {
            const msg = `Sync API request failed: ${e instanceof Error ? e.message : String(e)}`;
            this.localState.status.lastSyncApiTestAt = this.now();
            this.localState.status.lastSyncApiTestResult = 'error';
            this.localState.status.lastSyncApiTestMessage = msg;
            this.requestPersist();
            return { ok: false, message: msg };
        }
    }

    private now() {
        return Date.now();
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null;
    }

    private isUuid(value: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    }

    private async ensureSyncToken(): Promise<string> {
        if (this.localState.syncToken) return this.localState.syncToken;
        const json = await this.syncApiRequest({ syncToken: '*', resourceTypes: ['user'] });
        if (typeof json.sync_token === 'string') {
            this.localState.syncToken = json.sync_token;
            this.requestPersist();
            return json.sync_token;
        }
        return '*';
    }

	private shorten(value: string, head = 4, tail = 4): string {
		if (!value) return '';
		if (value.length <= head + tail + 3) return value;
		return `${value.slice(0, head)}...${value.slice(-tail)}`;
	}

    updateCachePolicy(policy: { completedRetentionDays: number; maxFilterCacheEntries: number }) {
        this.cachePolicy = {
            completedRetentionDays: Number.isFinite(policy.completedRetentionDays) ? policy.completedRetentionDays : 30,
            maxFilterCacheEntries: Number.isFinite(policy.maxFilterCacheEntries) ? policy.maxFilterCacheEntries : 50
        };
    }

    getQueueLength(): number {
        return this.localState.queue.length;
    }

    getSyncStatus() {
        return this.localState.status;
    }

    getCacheStats() {
        const tasks = Object.keys(this.localState.tasksById).length;
        const filters = Object.keys(this.localState.filterResults).length;
        const projects = Object.keys(this.localState.projectsById).length;
        return { tasks, filters, projects };
    }

	getIdAliasMapKeys(): TaskId[] {
		return Object.keys(this.localState.idAliasMap ?? {});
	}

	getLocalIdsReferencedInState(): Set<TaskId> {
		const referenced = new Set<TaskId>();
		for (const id of Object.keys(this.localState.tasksById ?? {})) referenced.add(id);
		for (const op of this.localState.queue ?? []) {
			if (op.type === 'create') referenced.add(op.localId);
			else referenced.add(this.resolveId(op.id));
		}
		for (const ids of Object.values(this.localState.filterResults ?? {})) {
			for (const id of ids) referenced.add(this.resolveId(id));
		}
		for (const id of Object.keys(this.localState.lineShadowById ?? {})) referenced.add(id);
		return referenced;
	}

	pruneIdAliasMap(keepLocalIds: Set<TaskId>): number {
		const before = Object.keys(this.localState.idAliasMap ?? {}).length;
		for (const localId of Object.keys(this.localState.idAliasMap ?? {})) {
			if (keepLocalIds.has(localId)) continue;
			delete this.localState.idAliasMap[localId];
		}
		const after = Object.keys(this.localState.idAliasMap ?? {}).length;
		if (after !== before) {
			this.requestPersist();
		}
		return before - after;
	}

    clearQueue() {
        this.localState.queue = [];
        this.requestPersist();
        this.triggerRefresh();
    }

    pruneCache(opts: { completedRetentionDays: number; maxFilterCacheEntries: number }) {
        const now = this.now();
        const cutoff = now - Math.max(0, opts.completedRetentionDays) * 24 * 60 * 60 * 1000;

		for (const [filter, lastUsedAt] of Object.entries(this.localState.filterLastUsedAt)) {
			if (lastUsedAt >= cutoff) continue;
			delete this.localState.filterResults[filter];
			delete this.localState.filterLastUsedAt[filter];
		}

        const filterEntries = Object.entries(this.localState.filterLastUsedAt);
        filterEntries.sort((a, b) => b[1] - a[1]);
        const keep = Math.max(0, opts.maxFilterCacheEntries);
        const allowed = new Set(filterEntries.slice(0, keep).map(([k]) => k));
        for (const key of Object.keys(this.localState.filterResults)) {
            if (allowed.has(key)) continue;
            delete this.localState.filterResults[key];
            delete this.localState.filterLastUsedAt[key];
        }

        this.localState.status.lastPruneAt = now;
        this.requestPersist();
        this.triggerRefresh();
    }

    maybePruneCache() {
        const now = this.now();
        const last = this.localState.status.lastPruneAt;
        const twelveHours = 12 * 60 * 60 * 1000;
        if (last && (now - last) < twelveHours) return;
        this.pruneCache(this.cachePolicy);
    }

    exportDiagnostics(): string {
        const status = this.localState.status;
        const cache = this.getCacheStats();
        const queue = this.localState.queue;

        const counts = queue.reduce(
            (acc, op) => {
                acc.total += 1;
                acc[op.type] = (acc[op.type] ?? 0) + 1;
                return acc;
            },
            { total: 0 } as Record<string, number>
        );

        const oldestQueuedAt = queue.reduce((min, op) => (min === undefined ? op.queuedAt : Math.min(min, op.queuedAt)), undefined as number | undefined);
        const nextRetryAt = queue.reduce((min, op) => {
            if (!op.nextRetryAt) return min;
            return min === undefined ? op.nextRetryAt : Math.min(min, op.nextRetryAt);
        }, undefined as number | undefined);

        const lines = [
            `Obsidoist diagnostics`,
            `Time: ${new Date().toISOString()}`,
            `Sync API enabled: ${this.useSyncApi}`,
            `Sync token present: ${Boolean(this.localState.syncToken)}`,
            `Queue: total=${counts.total}, create=${counts.create ?? 0}, update=${counts.update ?? 0}, close=${counts.close ?? 0}, reopen=${counts.reopen ?? 0}`,
            `Queue oldest queuedAt: ${oldestQueuedAt ? new Date(oldestQueuedAt).toISOString() : 'N/A'}`,
            `Queue nextRetryAt: ${nextRetryAt ? new Date(nextRetryAt).toISOString() : 'N/A'}`,
            `Cache: tasks=${cache.tasks}, filters=${cache.filters}, projects=${cache.projects}`,
            `Last sync started: ${status.lastSyncStartedAt ? new Date(status.lastSyncStartedAt).toISOString() : 'N/A'}`,
            `Last sync finished: ${status.lastSyncFinishedAt ? new Date(status.lastSyncFinishedAt).toISOString() : 'N/A'}`,
            `Last sync success: ${status.lastSuccessfulSyncAt ? new Date(status.lastSuccessfulSyncAt).toISOString() : 'N/A'}`,
            `Last error: ${status.lastErrorMessage ?? 'N/A'}`,
            `Last error at: ${status.lastErrorAt ? new Date(status.lastErrorAt).toISOString() : 'N/A'}`,
            `Last full refresh: ${this.localState.lastFullSyncAt ? new Date(this.localState.lastFullSyncAt).toISOString() : 'N/A'}`,
            `Last projects refresh: ${this.localState.lastProjectsSyncAt ? new Date(this.localState.lastProjectsSyncAt).toISOString() : 'N/A'}`,
            `Last prune: ${status.lastPruneAt ? new Date(status.lastPruneAt).toISOString() : 'N/A'}`
        ];

        return lines.join('\n');
    }

    private resolveId(id: TaskId): TaskId {
        return this.localState.idAliasMap[id] ?? id;
    }

    resolveTaskId(id: TaskId): TaskId {
        return this.resolveId(id);
    }

    getCachedTask(id: TaskId): { id: string; content: string; isCompleted: boolean; projectId?: string; dueDate?: string; isDeleted?: boolean } | null {
        const canonical = this.resolveId(id);
        const t = this.localState.tasksById[canonical];
        if (!t) return null;
        return { id: t.id, content: t.content, isCompleted: t.isCompleted, projectId: t.projectId, dueDate: t.dueDate, isDeleted: t.isDeleted };
    }

    getLastFullSyncAt(): number | undefined {
        return this.localState.lastFullSyncAt;
    }

	getLineShadow(id: TaskId): { content: string; isCompleted: boolean; projectId?: string; dueDate?: string } | undefined {
		const canonical = this.resolveId(id);
		return this.localState.lineShadowById[canonical];
	}

	setLineShadow(id: TaskId, shadow: { content: string; isCompleted: boolean; projectId?: string; dueDate?: string }) {
		const canonical = this.resolveId(id);
		this.localState.lineShadowById[canonical] = shadow;
		if (typeof id === 'string' && id.startsWith('local-') && this.localState.idAliasMap[id]) {
			delete this.localState.lineShadowById[id];
		}
		this.requestPersist();
	}

	moveLineShadow(fromId: TaskId, toId: TaskId) {
		const fromKey = String(fromId);
		const toKey = String(toId);
		if (fromKey === toKey) return;

		const candidates = [fromKey];
		const resolvedFrom = this.resolveId(fromId);
		if (String(resolvedFrom) !== fromKey) candidates.push(String(resolvedFrom));

		let val: ObsidoistLocalState['lineShadowById'][string] | undefined = undefined;
		for (const k of candidates) {
			const v = this.localState.lineShadowById[k];
			if (v) {
				val = v;
				break;
			}
		}
		if (!val) return;

		for (const k of candidates) {
			if (k !== toKey) delete this.localState.lineShadowById[k];
		}
		this.localState.lineShadowById[toKey] = val;
		this.requestPersist();
	}

    hasPendingOpsForId(id: TaskId): boolean {
        const canonical = this.resolveId(id);
        return this.localState.queue.some(op => {
            if (op.type === 'create') return op.localId === canonical || op.localId === id;
            return this.resolveId(op.id) === canonical;
        });
    }

    private writeTask(task: LocalTaskRecord) {
        this.localState.tasksById[task.id] = task;
        this.requestPersist();
        this.triggerRefresh();
    }

    private enqueue(op: SyncOperation) {
        const queue = this.localState.queue;

        if (op.type !== 'create') {
            const canonicalId = this.resolveId(op.id);
            if (canonicalId.startsWith('local-')) {
                for (const existing of queue) {
                    if (existing.type === 'create' && existing.localId === canonicalId) {
                        if (op.type === 'update') {
                            existing.content = op.content;
                            existing.dueDate = op.dueDate;
                        } else if (op.type === 'move') {
                            existing.projectId = op.projectId;
                        } else if (op.type === 'close') {
                            existing.isCompleted = true;
                        } else if (op.type === 'reopen') {
                            existing.isCompleted = false;
                        }
                        this.requestPersist();
                        return;
                    }
                }
            }
        }

        if (op.type === 'update') {
            for (let i = queue.length - 1; i >= 0; i--) {
                const prev = queue[i];
                if (prev.type === 'update' && this.resolveId(prev.id) === this.resolveId(op.id)) {
                    queue[i] = op;
                    this.requestPersist();
                    return;
                }
            }
        }

        if (op.type === 'move') {
            for (let i = queue.length - 1; i >= 0; i--) {
                const prev = queue[i];
                if (prev.type === 'move' && this.resolveId(prev.id) === this.resolveId(op.id)) {
                    queue[i] = op;
                    this.requestPersist();
                    return;
                }
            }
        }

        if (op.type === 'close' || op.type === 'reopen') {
            for (let i = queue.length - 1; i >= 0; i--) {
                const prev = queue[i];
                if ((prev.type === 'close' || prev.type === 'reopen') && this.resolveId(prev.id) === this.resolveId(op.id)) {
                    queue[i] = op;
                    this.requestPersist();
                    return;
                }
            }
        }

        queue.push(op);
        this.requestPersist();
    }

    async getProjects(): Promise<Project[]> {
        const cached = Object.values(this.localState.projectsById)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(p => ({ id: p.id, name: p.name }) as unknown as Project);

        if (!this.api) return cached;

        const tooOld = !this.localState.lastProjectsSyncAt || (this.now() - this.localState.lastProjectsSyncAt) > 300000;
        if (cached.length > 0 && !tooOld) return cached;

		try {
			await this.refreshProjectsViaSyncApi();
			const refreshed = Object.values(this.localState.projectsById)
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(p => ({ id: p.id, name: p.name }) as unknown as Project);
			return refreshed;
		} catch (error) {
			console.error("Failed to get projects via Sync API, falling back to REST", error);
		}

		try {
			const projects = await this.api.getProjects();
			const updatedAt = this.now();
			for (const project of projects) {
				const rec: LocalProjectRecord = { id: project.id, name: project.name, updatedAt };
				this.localState.projectsById[project.id] = rec;
			}
			this.localState.lastProjectsSyncAt = updatedAt;
			this.requestPersist();
			return projects;
		} catch (error) {
			console.error("Failed to get projects from Todoist", error);
			return cached;
		}
    }

    getTasks(filter?: string): Promise<Task[]> {
        const now = this.now();
        const tasksById = this.localState.tasksById;

        const fromIds = (ids: TaskId[]) => {
            const result: Task[] = [];
            for (const id of ids) {
                const canonical = this.resolveId(id);
                const t = tasksById[canonical];
                if (t) result.push({ id: t.id, content: t.content, isCompleted: t.isCompleted, projectId: t.projectId } as unknown as Task);
            }
            return result;
        };

        const normalizedFilter = (filter ?? '').trim();

        if (normalizedFilter.length > 0) {
            this.localState.filterLastUsedAt[normalizedFilter] = now;
            this.requestPersist();
            const ids = this.localState.filterResults[normalizedFilter];
            if (ids) return Promise.resolve(fromIds(ids));

            return Promise.resolve([]);
        }

        const cachedActive = Object.values(tasksById)
            .filter(t => !t.isCompleted)
            .sort((a, b) => (b.updatedAt ?? now) - (a.updatedAt ?? now))
            .map(t => ({ id: t.id, content: t.content, isCompleted: t.isCompleted, projectId: t.projectId } as unknown as Task));

        return Promise.resolve(cachedActive);
    }

    createTask(content: string, projectId?: string, dueDate?: string): Promise<Task | null> {
        const localId = createLocalId();
        const now = this.now();
		debug('enqueue:create', { localId, projectId: projectId || undefined });
        const rec: LocalTaskRecord = {
            id: localId,
            content,
            isCompleted: false,
            projectId,
            dueDate,
            isRecurring: false,
			isDeleted: false,
            source: 'local',
            updatedAt: now
        };
        this.localState.tasksById[localId] = rec;
        this.enqueue({ type: 'create', opId: createOperationId(), localId, content, projectId, dueDate, queuedAt: now, attempts: 0 });
        this.requestPersist();
        this.triggerRefresh();
        return Promise.resolve({ id: localId, content, isCompleted: false, projectId } as unknown as Task);
    }

    closeTask(id: string): Promise<boolean> {
        const canonical = this.resolveId(id);
		debug('enqueue:close', { id, canonical });
        const task = this.localState.tasksById[canonical];
        if (task) {
            task.isCompleted = true;
            task.updatedAt = this.now();
            this.writeTask(task);
        }
        this.enqueue({ type: 'close', opId: createOperationId(), id: canonical, queuedAt: this.now(), attempts: 0 });
        return Promise.resolve(true);
    }

    reopenTask(id: string): Promise<boolean> {
        const canonical = this.resolveId(id);
		debug('enqueue:reopen', { id, canonical });
        const task = this.localState.tasksById[canonical];
        if (task) {
            task.isCompleted = false;
            task.updatedAt = this.now();
            this.writeTask(task);
        }
        this.enqueue({ type: 'reopen', opId: createOperationId(), id: canonical, queuedAt: this.now(), attempts: 0 });
        return Promise.resolve(true);
    }

    updateTask(id: string, content: string, dueDate?: string): Promise<boolean> {
        const canonical = this.resolveId(id);
		debug('enqueue:update', { id, canonical });
        const task = this.localState.tasksById[canonical];
        if (task) {
            task.content = content;
            task.dueDate = dueDate;
            task.updatedAt = this.now();
            this.writeTask(task);
        } else {
            const now = this.now();
            this.localState.tasksById[canonical] = {
                id: canonical,
                content,
                isCompleted: false,
                dueDate,
				isDeleted: false,
                source: 'local',
                updatedAt: now
            };
            this.requestPersist();
        }
        this.enqueue({ type: 'update', opId: createOperationId(), id: canonical, content, dueDate, queuedAt: this.now(), attempts: 0 });
        return Promise.resolve(true);
    }

    moveTask(id: string, projectId: string): Promise<boolean> {
        const canonical = this.resolveId(id);
		debug('enqueue:move', { id, canonical, projectId });
        const task = this.localState.tasksById[canonical];
        if (task) {
            task.projectId = projectId;
            task.updatedAt = this.now();
            this.writeTask(task);
        }
        this.enqueue({ type: 'move', opId: createOperationId(), id: canonical, projectId, queuedAt: this.now(), attempts: 0 });
        return Promise.resolve(true);
    }

    async syncNow(): Promise<void> {
        if (!this.api) return;
        if (this.syncInFlight !== null) return this.syncInFlight;
        this.isSyncRunning = true;

        this.syncInFlight = (async () => {
			debug('syncNow:start', { queue: this.localState.queue.length });
            this.localState.status.lastSyncStartedAt = this.now();
            this.localState.status.lastErrorMessage = undefined;
            this.localState.status.lastErrorAt = undefined;
            this.requestPersist();
            try {
                await this.getProjects();
                await this.flushQueueToRemote({ triggerRefresh: false });
                await this.refreshFromRemote({ triggerRefresh: false });
				this.triggerRefresh();

                this.localState.status.lastSuccessfulSyncAt = this.now();

                this.maybePruneCache();
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                this.localState.status.lastErrorMessage = msg;
                this.localState.status.lastErrorAt = this.now();
                this.requestPersist();
            } finally {
				debug('syncNow:finish', { queue: this.localState.queue.length, lastError: this.localState.status.lastErrorMessage });
                this.localState.status.lastSyncFinishedAt = this.now();
                this.isSyncRunning = false;
                this.requestPersist();
            }
        })()
            .finally(() => {
                this.syncInFlight = null;
                const pending = this.pendingFilterSync;
                this.pendingFilterSync = null;
                if (pending) {
                    void this.syncFilterNow(pending).catch((e) => {
                        console.error('[Obsidoist] Filter sync failed', e);
                    });
                }
            });

        return this.syncInFlight;
    }

    async syncFilterNow(filter: string): Promise<void> {
        const normalized = (filter ?? '').trim();
        if (!normalized) {
            return this.syncNow();
        }
        if (!this.api) return;
        if (this.syncInFlight !== null) {
            this.pendingFilterSync = normalized;
            return this.syncInFlight;
        }
        this.isSyncRunning = true;

        this.syncInFlight = (async () => {
			debug('syncFilterNow:start', { filter: normalized, queue: this.localState.queue.length });
            this.localState.status.lastSyncStartedAt = this.now();
            this.localState.status.lastErrorMessage = undefined;
            this.localState.status.lastErrorAt = undefined;
            this.requestPersist();
            try {
                await this.getProjects();
                await this.flushQueueToRemote({ triggerRefresh: false });
				await this.refreshFromRemote({ triggerRefresh: false });
                await this.refreshFilterIdsViaRest(normalized, { triggerRefresh: false });
				this.triggerRefresh();

                this.localState.status.lastSuccessfulSyncAt = this.now();

                this.maybePruneCache();
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                this.localState.status.lastErrorMessage = msg;
                this.localState.status.lastErrorAt = this.now();
                this.requestPersist();
            } finally {
				debug('syncFilterNow:finish', { filter: normalized, queue: this.localState.queue.length, lastError: this.localState.status.lastErrorMessage });
                this.localState.status.lastSyncFinishedAt = this.now();
                this.isSyncRunning = false;
                this.requestPersist();
            }
        })()
            .finally(() => {
                this.syncInFlight = null;
                const pending = this.pendingFilterSync;
                this.pendingFilterSync = null;
                if (pending && pending !== normalized) {
                    void this.syncFilterNow(pending).catch((e) => {
                        console.error('[Obsidoist] Filter sync failed', e);
                    });
                }
            });

        return this.syncInFlight;
    }

    private async syncApiRequest(params: { syncToken: string; resourceTypes: string[]; commands?: unknown[] }): Promise<SyncApiResponse> {
        const token = (this.token ?? '').trim();
        if (!token) throw new Error('Todoist API Token is empty.');

        const url = 'https://api.todoist.com/sync/v9/sync';
        const body = new URLSearchParams({
            sync_token: params.syncToken,
            resource_types: JSON.stringify(params.resourceTypes)
        });
        if (params.commands && params.commands.length > 0) {
            body.set('commands', JSON.stringify(params.commands));
        }

        const res = await requestUrl({
            url,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: body.toString()
        });

        if (res.status < 200 || res.status >= 300) {
            const text = res.text ?? '';
            throw new Error(`Sync API failed (HTTP ${res.status}) ${text}`);
        }

        const json: unknown = res.json ?? (res.text ? JSON.parse(res.text) : {});
        if (this.isRecord(json)) return json as SyncApiResponse;
        return {};
    }


    private getSyncTokenForRequest(): string {
        return this.localState.syncToken ? this.localState.syncToken : '*';
    }

    private applySyncApiProjects(projects: unknown[] | undefined) {
        if (!projects) return;
        const now = this.now();
        for (const p of projects) {
            if (!this.isRecord(p)) continue;
            const id = typeof p.id === 'string' || typeof p.id === 'number' ? String(p.id) : '';
            if (!id) continue;

            if (p.is_deleted === true) {
                delete this.localState.projectsById[id];
                continue;
            }
            this.localState.projectsById[id] = { id, name: typeof p.name === 'string' ? p.name : '', updatedAt: now };
        }
        this.localState.lastProjectsSyncAt = now;
    }

    private applySyncApiItems(items: unknown[] | undefined) {
        if (!items) return;
        const now = this.now();
        for (const it of items) {
            if (!this.isRecord(it)) continue;
            const id = typeof it.id === 'string' || typeof it.id === 'number' ? String(it.id) : '';
            if (!id) continue;
            const hasPending = this.hasPendingOpsForId(id);

            if (it.is_deleted === true) {
                const existing = this.localState.tasksById[id];
                if (existing) {
                    existing.isDeleted = true;
                    existing.isCompleted = true;
                    existing.source = 'remote';
                    existing.updatedAt = now;
                    existing.lastRemoteSeenAt = now;

					const before = this.localState.queue.length;
					this.localState.queue = this.localState.queue.filter(op => {
						if (op.type === 'create') return op.localId !== id;
						return this.resolveId(op.id) !== id;
					});
					if (this.localState.queue.length !== before) this.requestPersist();
                }
                continue;
            }

            const dueObj = it.due;
            const due = this.extractDueFromUnknown(dueObj);
            const isCompleted = it.checked === true || it.is_archived === true;

            const local = this.localState.tasksById[id];
            if (!local) {
                this.localState.tasksById[id] = {
                    id,
                    content: typeof it.content === 'string' ? it.content : '',
                    isCompleted,
                    projectId: typeof it.project_id === 'string' || typeof it.project_id === 'number' ? String(it.project_id) : undefined,
                    dueDate: due.dueDate,
                    isRecurring: due.isRecurring,
					isDeleted: false,
                    source: 'remote',
                    updatedAt: now,
                    lastRemoteSeenAt: now
                };
                continue;
            }

            local.lastRemoteSeenAt = now;
            if (hasPending) continue;

            local.content = typeof it.content === 'string' ? it.content : '';
            local.isCompleted = isCompleted;
            local.projectId = typeof it.project_id === 'string' || typeof it.project_id === 'number' ? String(it.project_id) : undefined;
            local.dueDate = due.dueDate;
            local.isRecurring = due.isRecurring;
			local.isDeleted = false;
            local.source = 'remote';
            local.updatedAt = now;
        }

        this.localState.lastFullSyncAt = now;
    }

    private extractDueFromUnknown(value: unknown): { dueDate?: string; isRecurring?: boolean } {
        if (!this.isRecord(value)) return {};
        const dueDate =
            typeof value.date === 'string'
                ? value.date
                : typeof value.datetime === 'string'
                    ? value.datetime.slice(0, 10)
                    : undefined;
        const isRecurring = value.is_recurring === true || value.isRecurring === true;
        return { dueDate, isRecurring };
    }

    private extractProjectIdFromTask(task: Task): string | undefined {
        const t: unknown = task;
        if (!this.isRecord(t)) return undefined;
        const candidate = t.projectId ?? t.project_id;
        if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate);
        return undefined;
    }

    private extractDueFromTask(task: Task): { dueDate?: string; isRecurring?: boolean } {
        const t: unknown = task;
        if (!this.isRecord(t)) return {};
        return this.extractDueFromUnknown(t.due);
    }

    private applySyncApiTempIdMapping(tempIdMapping: Record<string, string> | undefined) {
        if (!tempIdMapping) return;
        let didChange = false;
        for (const [tempId, newId] of Object.entries(tempIdMapping)) {
            const localId = tempId;
            this.localState.idAliasMap[localId] = newId;
            didChange = true;

			this.moveLineShadow(localId, newId);

            const existing = this.localState.tasksById[localId];
            if (existing && !this.localState.tasksById[newId]) {
                delete this.localState.tasksById[localId];
                existing.id = newId;
                this.localState.tasksById[newId] = existing;
            }

            for (const [filter, ids] of Object.entries(this.localState.filterResults)) {
                this.localState.filterResults[filter] = ids.map(x => (x === localId ? newId : x));
            }
        }

        if (didChange) this.trigger('id-mapping-updated');
    }

    private async refreshProjectsViaSyncApi() {
        try {
            const json = await this.syncApiRequest({
                syncToken: this.getSyncTokenForRequest(),
                resourceTypes: ['projects']
            });
            if (typeof json.sync_token === 'string') this.localState.syncToken = json.sync_token;
            this.applySyncApiProjects(json.projects);
            this.requestPersist();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.localState.status.lastErrorMessage = msg;
            this.localState.status.lastErrorAt = this.now();
            this.requestPersist();
        }
    }

    private async refreshFromRemoteViaSyncApi(opts?: { triggerRefresh?: boolean }) {
        const now = this.now();
        try {
            const json = await this.syncApiRequest({
                syncToken: this.getSyncTokenForRequest(),
                resourceTypes: ['projects', 'items']
            });

            if (typeof json.sync_token === 'string') this.localState.syncToken = json.sync_token;
            this.applySyncApiTempIdMapping(json.temp_id_mapping);
            this.applySyncApiProjects(json.projects);
            this.applySyncApiItems(json.items);

            this.localState.status.lastSuccessfulSyncAt = now;
            this.requestPersist();
			if (opts?.triggerRefresh !== false) this.triggerRefresh();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.localState.status.lastErrorMessage = msg;
            this.localState.status.lastErrorAt = now;
            this.requestPersist();
        }
    }

    private async flushQueueToRemoteViaSyncApi(opts?: { triggerRefresh?: boolean }) {
        const queue = this.localState.queue;
        if (queue.length === 0) return;

        const now = this.now();
		const syncToken = await this.ensureSyncToken();
		debug('syncApi:flush:start', { queue: queue.length, syncToken: this.shorten(syncToken) });

        const commands: SyncApiCommand[] = [];
        const createdToComplete: { localId: string }[] = [];

        for (const op of queue) {
            if (op.nextRetryAt && op.nextRetryAt > now) continue;
			if (!this.isUuid(op.opId)) {
				op.opId = createOperationId();
			}

            if (op.type === 'create') {
                const args: Record<string, unknown> = { content: op.content };
                if (op.projectId) args.project_id = op.projectId;
                if (op.dueDate) args.due = { date: op.dueDate };
                commands.push({ type: 'item_add', temp_id: op.localId, uuid: op.opId, args });
                if (op.isCompleted) createdToComplete.push({ localId: op.localId });
            } else if (op.type === 'update') {
                const id = this.resolveId(op.id);
                if (id.startsWith('local-') && !this.localState.idAliasMap[id]) continue;
                const args: Record<string, unknown> = { id, content: op.content };
                if (op.dueDate) args.due = { date: op.dueDate };
                commands.push({ type: 'item_update', uuid: op.opId, args });
			} else if (op.type === 'move') {
				const id = this.resolveId(op.id);
				if (id.startsWith('local-') && !this.localState.idAliasMap[id]) continue;
				if (op.projectId) {
					commands.push({ type: 'item_move', uuid: op.opId, args: { id, project_id: op.projectId } });
				}
            } else if (op.type === 'close') {
                const id = this.resolveId(op.id);
                if (id.startsWith('local-') && !this.localState.idAliasMap[id]) continue;
                commands.push({ type: 'item_close', uuid: op.opId, args: { id } });
            } else if (op.type === 'reopen') {
                const id = this.resolveId(op.id);
                if (id.startsWith('local-') && !this.localState.idAliasMap[id]) continue;
                commands.push({ type: 'item_uncomplete', uuid: op.opId, args: { id } });
            }
        }

        if (commands.length === 0) return;
		debug('syncApi:flush:commands', { count: commands.length, types: commands.map(c => c.type) });

        const json = await this.syncApiRequest({
            syncToken,
            resourceTypes: ['projects', 'items'],
            commands
        });
		debug('syncApi:flush:response', { hasSyncStatus: Boolean(json.sync_status), items: Array.isArray(json.items) ? json.items.length : 0 });

		const itemsById: Record<string, Record<string, unknown>> = {};
		if (Array.isArray(json.items)) {
			for (const it of json.items) {
				if (!this.isRecord(it)) continue;
				const id = typeof it.id === 'string' || typeof it.id === 'number' ? String(it.id) : '';
				if (!id) continue;
				itemsById[id] = it;
			}
		}

        if (typeof json.sync_token === 'string') this.localState.syncToken = json.sync_token;
        this.applySyncApiTempIdMapping(json.temp_id_mapping);
        this.applySyncApiProjects(json.projects);
        this.applySyncApiItems(json.items);

        const syncStatus: Record<string, unknown> = this.isRecord(json.sync_status) ? json.sync_status : {};

        const cmdByUuid: Record<string, SyncApiCommand> = {};
        for (const c of commands) {
            cmdByUuid[c.uuid] = c;
        }

        for (let i = 0; i < queue.length; ) {
            const op = queue[i];
            const status = syncStatus[op.opId];
            if (status === undefined) {
                i++;
                continue;
            }

            if (status === 'ok') {
				if (op.type === 'close' || op.type === 'reopen') {
					const id = this.resolveId(op.id);
					const item = itemsById[id];
					const confirmed = this.isRecord(item)
						? ((item.checked === true || item.is_archived === true) === (op.type === 'close'))
						: false;
					if (!confirmed) {
						debug('syncApi:op:notConfirmed', { type: op.type, id, opId: op.opId });
						op.attempts += 1;
						op.lastError = `Sync API ok but status not confirmed in response items. id=${id}`;
						const delay = Math.min(30 * 60 * 1000, 2000 * Math.pow(2, Math.max(0, op.attempts - 1)));
						op.nextRetryAt = this.now() + delay;
						const msg = `Todoist ${op.type === 'close' ? 'complete' : 'reopen'} not confirmed yet; will retry.`;
						this.localState.status.lastErrorMessage = msg;
						this.localState.status.lastErrorAt = this.now();
						if (!this.notifiedOpIds.has(op.opId)) {
							this.notifiedOpIds.add(op.opId);
							new Notice(`Obsidoist: ${msg}`);
						}
						i++;
						continue;
					}
				}
				debug('syncApi:op:ok', { type: op.type, opId: op.opId });
                queue.splice(i, 1);
                continue;
            }

            op.attempts += 1;
            const msg = this.isRecord(status) && status.error !== undefined ? this.toText(status.error) : 'Sync API command failed.';
			debug('syncApi:op:error', { type: op.type, opId: op.opId, msg });
            const statusDetails = this.toText(status);
            const cmd = cmdByUuid[op.opId];
            const cmdDetails = cmd ? JSON.stringify({ type: cmd.type, args: cmd.args }) : '';
            op.lastError = `${msg}${statusDetails ? ` details=${statusDetails}` : ''}${cmdDetails ? ` cmd=${cmdDetails}` : ''}`;
            const delay = Math.min(30 * 60 * 1000, 2000 * Math.pow(2, Math.max(0, op.attempts - 1)));
            op.nextRetryAt = this.now() + delay;
            this.localState.status.lastErrorMessage = msg;
            this.localState.status.lastErrorAt = this.now();
			if ((op.type === 'close' || op.type === 'reopen') && !this.notifiedOpIds.has(op.opId)) {
				this.notifiedOpIds.add(op.opId);
				new Notice(`Obsidoist: ${op.type === 'close' ? 'complete' : 'reopen'} failed; will retry. ${msg}`);
			}
            i++;
        }

        if (createdToComplete.length > 0) {
            const ids: string[] = [];
            for (const x of createdToComplete) {
                const mapped = this.localState.idAliasMap[x.localId];
                if (mapped) ids.push(mapped);
            }
            if (ids.length > 0) {
                const completeCmds = ids.map((id) => ({
                    type: 'item_close',
                    uuid: createOperationId(),
                    args: { id }
                }));
                const json2 = await this.syncApiRequest({
                    syncToken: await this.ensureSyncToken(),
                    resourceTypes: ['items'],
                    commands: completeCmds
                });
                if (typeof json2.sync_token === 'string') this.localState.syncToken = json2.sync_token;
                this.applySyncApiItems(json2.items);
            }
        }

        this.requestPersist();
		if (opts?.triggerRefresh !== false) this.triggerRefresh();
    }

    private async refreshFromRemoteViaRest() {
        const now = this.now();
        let tasks: Task[];
        try {
            tasks = await this.api!.getTasks();
        } catch (error) {
            console.error('Failed to get tasks from Todoist', error);
            return;
        }

        const seenRemoteIds = new Set<string>();
        for (const task of tasks) {
            seenRemoteIds.add(task.id);
            const local = this.localState.tasksById[task.id];
            const hasPending = this.hasPendingOpsForId(task.id);

            if (!local) {
                const due = this.extractDueFromTask(task);
                this.localState.tasksById[task.id] = {
                    id: task.id,
                    content: task.content,
                    isCompleted: task.isCompleted ?? false,
                    projectId: this.extractProjectIdFromTask(task),
                    dueDate: due.dueDate,
                    isRecurring: due.isRecurring,
					isDeleted: false,
                    source: 'remote',
                    updatedAt: now,
                    lastRemoteSeenAt: now
                };
                continue;
            }

            local.lastRemoteSeenAt = now;
            if (hasPending) continue;

            local.content = task.content;
            local.isCompleted = task.isCompleted ?? false;
            const due = this.extractDueFromTask(task);
            local.projectId = this.extractProjectIdFromTask(task);
            local.dueDate = due.dueDate;
            local.isRecurring = due.isRecurring;
            local.source = 'remote';
            local.updatedAt = now;
        }

        for (const rec of Object.values(this.localState.tasksById)) {
            if (rec.source !== 'remote') continue;
            if (seenRemoteIds.has(rec.id)) continue;
            if (this.hasPendingOpsForId(rec.id)) continue;
            if (rec.lastRemoteSeenAt && (now - rec.lastRemoteSeenAt) < 30000) continue;
            rec.isCompleted = true;
            rec.updatedAt = now;
        }

        this.localState.lastFullSyncAt = now;
        this.requestPersist();
        this.triggerRefresh();
    }

    private async refreshFilterIdsViaRest(filter: string, opts?: { triggerRefresh?: boolean }) {
        const now = this.now();
        let tasks: Task[];
        try {
            tasks = await this.api!.getTasks({ filter });
        } catch (error) {
            console.error('Failed to get tasks from Todoist', error);
            return;
        }

        const filterIds: string[] = [];
        for (const task of tasks) {
            filterIds.push(task.id);
            const local = this.localState.tasksById[task.id];

            if (!local) {
                const due = this.extractDueFromTask(task);
                this.localState.tasksById[task.id] = {
                    id: task.id,
                    content: task.content,
                    isCompleted: false,
                    projectId: this.extractProjectIdFromTask(task),
                    dueDate: due.dueDate,
                    isRecurring: due.isRecurring,
					isDeleted: false,
                    source: 'remote',
                    updatedAt: now,
                    lastRemoteSeenAt: now
                };
                continue;
            }

            local.lastRemoteSeenAt = now;
            if (this.hasPendingOpsForId(task.id)) continue;

            local.content = task.content;
            const due = this.extractDueFromTask(task);
            local.projectId = this.extractProjectIdFromTask(task);
            local.dueDate = due.dueDate;
            local.isRecurring = due.isRecurring;
            local.source = 'remote';
            local.updatedAt = now;
        }

        this.localState.filterResults[filter] = filterIds;
        this.localState.filterLastUsedAt[filter] = now;
        this.requestPersist();
		if (opts?.triggerRefresh !== false) this.triggerRefresh();
    }

    private async flushQueueToRemote(opts?: { triggerRefresh?: boolean }) {
        if (!this.api) return;

		await this.flushQueueToRemoteViaSyncApi(opts);
    }

    private async refreshFromRemote(opts?: { triggerRefresh?: boolean }) {
        if (!this.api) return;
		await this.refreshFromRemoteViaSyncApi(opts);
    }

    triggerRefresh() {
        this.trigger('refresh');
    }
}
