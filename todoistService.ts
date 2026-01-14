import { TodoistApi, Task, Project } from '@doist/todoist-api-typescript';
import { Events, requestUrl } from 'obsidian';
import { createLocalId, createOperationId, LocalProjectRecord, LocalTaskRecord, ObsidoistLocalState, SyncOperation, TaskId } from './localState';

export class TodoistService extends Events {
    private api: TodoistApi | null = null;

    private token: string = '';

    private useSyncApi = true;

    private localState: ObsidoistLocalState;
    private requestPersist: () => void;

    private isSyncRunning = false;

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

    async testSyncApiConnectivity(): Promise<{ ok: boolean; status?: number; message: string; details?: any }>{
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
            let details: any = undefined;
            try {
                const json = (res.json ?? (res.text ? JSON.parse(res.text) : undefined)) as any;
                details = json;
                if (!ok && json?.error) message += ` ${json.error}`;
            } catch {
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

    clearQueue() {
        this.localState.queue = [];
        this.requestPersist();
        this.triggerRefresh();
    }

    pruneCache(opts: { completedRetentionDays: number; maxFilterCacheEntries: number }) {
        const now = this.now();
        const cutoff = now - Math.max(0, opts.completedRetentionDays) * 24 * 60 * 60 * 1000;

        const pinnedIds = new Set<TaskId>();
        for (const ids of Object.values(this.localState.filterResults)) {
            for (const id of ids) pinnedIds.add(this.resolveId(id));
        }
        for (const op of this.localState.queue) {
            if (op.type === 'create') pinnedIds.add(op.localId);
            else pinnedIds.add(this.resolveId(op.id));
        }
        for (const [localId, remoteId] of Object.entries(this.localState.idAliasMap)) {
            pinnedIds.add(localId);
            pinnedIds.add(remoteId);
        }

        for (const [id, task] of Object.entries(this.localState.tasksById)) {
            if (pinnedIds.has(id)) continue;
            if (!task.isCompleted) continue;
            if (task.updatedAt >= cutoff) continue;
            delete this.localState.tasksById[id];
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

    getCachedTask(id: TaskId): { id: string; content: string; isCompleted: boolean; projectId?: string; dueDate?: string } | null {
        const canonical = this.resolveId(id);
        const t = this.localState.tasksById[canonical];
        if (!t) return null;
        return { id: t.id, content: t.content, isCompleted: t.isCompleted, projectId: t.projectId, dueDate: t.dueDate };
    }

    getLastFullSyncAt(): number | undefined {
        return this.localState.lastFullSyncAt;
    }

    private hasPendingOpsForId(id: TaskId): boolean {
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

        if (this.useSyncApi) {
            const tooOld = !this.localState.lastProjectsSyncAt || (this.now() - this.localState.lastProjectsSyncAt) > 300000;
            if (cached.length === 0 || tooOld) {
                await this.refreshProjectsViaSyncApi();
                const refreshed = Object.values(this.localState.projectsById)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(p => ({ id: p.id, name: p.name }) as unknown as Project);
                return refreshed;
            }
            return cached;
        }

        const tooOld = !this.localState.lastProjectsSyncAt || (this.now() - this.localState.lastProjectsSyncAt) > 300000;
        if (cached.length > 0 && !tooOld) return cached;

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

    async getTasks(filter?: string): Promise<Task[]> {
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
            if (ids) return fromIds(ids);

            return [];
        }

        const cachedActive = Object.values(tasksById)
            .filter(t => !t.isCompleted)
            .sort((a, b) => (b.updatedAt ?? now) - (a.updatedAt ?? now))
            .map(t => ({ id: t.id, content: t.content, isCompleted: t.isCompleted, projectId: t.projectId } as unknown as Task));

        return cachedActive;
    }

    async createTask(content: string, projectId?: string, dueDate?: string): Promise<Task | null> {
        const localId = createLocalId();
        const now = this.now();
        const rec: LocalTaskRecord = {
            id: localId,
            content,
            isCompleted: false,
            projectId,
            dueDate,
            source: 'local',
            updatedAt: now
        };
        this.localState.tasksById[localId] = rec;
        this.enqueue({ type: 'create', opId: createOperationId(), localId, content, projectId, dueDate, queuedAt: now, attempts: 0 });
        this.requestPersist();
        this.triggerRefresh();
        return { id: localId, content, isCompleted: false, projectId } as unknown as Task;
    }

    async closeTask(id: string): Promise<boolean> {
        const canonical = this.resolveId(id);
        const task = this.localState.tasksById[canonical];
        if (task) {
            task.isCompleted = true;
            task.updatedAt = this.now();
            this.writeTask(task);
        }
        this.enqueue({ type: 'close', opId: createOperationId(), id: canonical, queuedAt: this.now(), attempts: 0 });
        return true;
    }

    async reopenTask(id: string): Promise<boolean> {
        const canonical = this.resolveId(id);
        const task = this.localState.tasksById[canonical];
        if (task) {
            task.isCompleted = false;
            task.updatedAt = this.now();
            this.writeTask(task);
        }
        this.enqueue({ type: 'reopen', opId: createOperationId(), id: canonical, queuedAt: this.now(), attempts: 0 });
        return true;
    }

    async setTaskCompletionRemoteNow(id: string, isCompleted: boolean): Promise<void> {
        if (!this.api) throw new Error('Todoist is not configured.');
        const canonical = this.resolveId(id);
        if (canonical.startsWith('local-') && !this.localState.idAliasMap[canonical]) {
            throw new Error('Task is not synced yet.');
        }

		if (!/^\d+$/.test(canonical)) {
			throw new Error(`Invalid task id: ${canonical}`);
		}

		if (isCompleted) await this.api.closeTask(canonical);
		else await this.api.reopenTask(canonical);

		const t = this.localState.tasksById[canonical];
		if (t) {
			t.isCompleted = isCompleted;
			t.updatedAt = this.now();
			this.writeTask(t);
		}
    }

    async updateTask(id: string, content: string, dueDate?: string): Promise<boolean> {
        const canonical = this.resolveId(id);
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
                source: 'local',
                updatedAt: now
            };
            this.requestPersist();
        }
        this.enqueue({ type: 'update', opId: createOperationId(), id: canonical, content, dueDate, queuedAt: this.now(), attempts: 0 });
        return true;
    }

    async syncNow(): Promise<void> {
        if (!this.api) return;
        if (this.isSyncRunning) return;
        this.isSyncRunning = true;

        this.localState.status.lastSyncStartedAt = this.now();
        this.localState.status.lastErrorMessage = undefined;
        this.localState.status.lastErrorAt = undefined;
        this.requestPersist();
        try {
            await this.getProjects();
            await this.flushQueueToRemote();
            await this.refreshFromRemote({});

            this.localState.status.lastSuccessfulSyncAt = this.now();

            this.maybePruneCache();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.localState.status.lastErrorMessage = msg;
            this.localState.status.lastErrorAt = this.now();
            this.requestPersist();
        } finally {
            this.localState.status.lastSyncFinishedAt = this.now();
            this.isSyncRunning = false;
            this.requestPersist();
        }
    }

    async syncFilterNow(filter: string): Promise<void> {
        const normalized = (filter ?? '').trim();
        if (!normalized) {
            await this.syncNow();
            return;
        }
        if (!this.api) return;
        if (this.isSyncRunning) return;
        this.isSyncRunning = true;

        this.localState.status.lastSyncStartedAt = this.now();
        this.localState.status.lastErrorMessage = undefined;
        this.localState.status.lastErrorAt = undefined;
        this.requestPersist();
        try {
            await this.getProjects();
            await this.flushQueueToRemote();
            await this.refreshFromRemote({ filter: normalized });

            this.localState.status.lastSuccessfulSyncAt = this.now();

            this.maybePruneCache();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.localState.status.lastErrorMessage = msg;
            this.localState.status.lastErrorAt = this.now();
            this.requestPersist();
        } finally {
            this.localState.status.lastSyncFinishedAt = this.now();
            this.isSyncRunning = false;
            this.requestPersist();
        }
    }

    private async syncApiRequest(params: { syncToken: string; resourceTypes: string[]; commands?: any[] }) {
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

        return (res.json ?? JSON.parse(res.text ?? '{}')) as any;
    }

    private getSyncTokenForRequest(): string {
        return this.localState.syncToken ? this.localState.syncToken : '*';
    }

    private applySyncApiProjects(projects: any[] | undefined) {
        if (!projects) return;
        const now = this.now();
        for (const p of projects) {
            if (!p || typeof p !== 'object') continue;
            if (p.is_deleted) {
                delete this.localState.projectsById[String(p.id)];
                continue;
            }
            this.localState.projectsById[String(p.id)] = { id: String(p.id), name: String(p.name ?? ''), updatedAt: now };
        }
        this.localState.lastProjectsSyncAt = now;
    }

    private applySyncApiItems(items: any[] | undefined) {
        if (!items) return;
        const now = this.now();
        for (const it of items) {
            if (!it || typeof it !== 'object') continue;
            const id = String(it.id);
            const hasPending = this.hasPendingOpsForId(id);

            if (it.is_deleted) {
                if (!hasPending) {
                    const existing = this.localState.tasksById[id];
                    if (existing) {
                        existing.isCompleted = true;
                        existing.source = 'remote';
                        existing.updatedAt = now;
                        existing.lastRemoteSeenAt = now;
                    }
                }
                continue;
            }

            const dueObj = (it as any).due;
            const dueDate = dueObj?.date ?? (dueObj?.datetime ? String(dueObj.datetime).slice(0, 10) : undefined);
            const isCompleted = Boolean(it.checked) || Boolean(it.is_archived);

            const local = this.localState.tasksById[id];
            if (!local) {
                this.localState.tasksById[id] = {
                    id,
                    content: String(it.content ?? ''),
                    isCompleted,
                    projectId: it.project_id ? String(it.project_id) : undefined,
                    dueDate,
                    source: 'remote',
                    updatedAt: now,
                    lastRemoteSeenAt: now
                };
                continue;
            }

            local.lastRemoteSeenAt = now;
            if (hasPending) continue;

            local.content = String(it.content ?? '');
            local.isCompleted = isCompleted;
            local.projectId = it.project_id ? String(it.project_id) : undefined;
            local.dueDate = dueDate;
            local.source = 'remote';
            local.updatedAt = now;
        }

        this.localState.lastFullSyncAt = now;
    }

    private applySyncApiTempIdMapping(tempIdMapping: Record<string, string> | undefined) {
        if (!tempIdMapping) return;
        let didChange = false;
        for (const [tempId, newId] of Object.entries(tempIdMapping)) {
            const localId = tempId;
            this.localState.idAliasMap[localId] = newId;
            didChange = true;

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

    private async refreshFromRemoteViaSyncApi() {
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
            this.triggerRefresh();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.localState.status.lastErrorMessage = msg;
            this.localState.status.lastErrorAt = now;
            this.requestPersist();
        }
    }

    private async flushQueueToRemoteViaSyncApi() {
        const queue = this.localState.queue;
        if (queue.length === 0) return;

        const now = this.now();
		const syncToken = await this.ensureSyncToken();

        const commands: any[] = [];
        const createdToComplete: { localId: string }[] = [];

        for (const op of queue) {
            if (op.nextRetryAt && op.nextRetryAt > now) continue;
			if (!this.isUuid(op.opId)) {
				op.opId = createOperationId();
			}

            if (op.type === 'create') {
                const args: any = { content: op.content };
                if (op.projectId) args.project_id = op.projectId;
                if (op.dueDate) args.due = { date: op.dueDate };
                commands.push({ type: 'item_add', temp_id: op.localId, uuid: op.opId, args });
                if (op.isCompleted) createdToComplete.push({ localId: op.localId });
            } else if (op.type === 'update') {
                const id = this.resolveId(op.id);
                if (id.startsWith('local-') && !this.localState.idAliasMap[id]) continue;
                const args: any = { id, content: op.content };
                if (op.dueDate) args.due = { date: op.dueDate };
                commands.push({ type: 'item_update', uuid: op.opId, args });
            } else if (op.type === 'close') {
                const id = this.resolveId(op.id);
                if (id.startsWith('local-') && !this.localState.idAliasMap[id]) continue;
                commands.push({ type: 'item_complete', uuid: op.opId, args: { ids: [id] } });
            } else if (op.type === 'reopen') {
                const id = this.resolveId(op.id);
                if (id.startsWith('local-') && !this.localState.idAliasMap[id]) continue;
                commands.push({ type: 'item_uncomplete', uuid: op.opId, args: { ids: [id] } });
            }
        }

        if (commands.length === 0) return;

        const json = await this.syncApiRequest({
            syncToken,
            resourceTypes: ['projects', 'items'],
            commands
        });

        if (typeof json.sync_token === 'string') this.localState.syncToken = json.sync_token;
        this.applySyncApiTempIdMapping(json.temp_id_mapping);
        this.applySyncApiProjects(json.projects);
        this.applySyncApiItems(json.items);

        const syncStatus: Record<string, any> = (json.sync_status && typeof json.sync_status === 'object') ? json.sync_status : {};

        for (let i = 0; i < queue.length; ) {
            const op = queue[i];
            const status = syncStatus[op.opId];
            if (status === undefined) {
                i++;
                continue;
            }

            if (status === 'ok') {
                queue.splice(i, 1);
                continue;
            }

            op.attempts += 1;
            const msg = status?.error ? String(status.error) : 'Sync API command failed.';
            op.lastError = msg;
            const delay = Math.min(30 * 60 * 1000, 2000 * Math.pow(2, Math.max(0, op.attempts - 1)));
            op.nextRetryAt = this.now() + delay;
            this.localState.status.lastErrorMessage = msg;
            this.localState.status.lastErrorAt = this.now();
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
                    type: 'item_complete',
                    uuid: createOperationId(),
                    args: { ids: [id] }
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
        this.triggerRefresh();
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
                this.localState.tasksById[task.id] = {
                    id: task.id,
                    content: task.content,
                    isCompleted: task.isCompleted ?? false,
                    projectId: (task as any).projectId ?? (task as any).project_id,
                    dueDate: (task as any).due?.date ?? ((task as any).due?.datetime ? String((task as any).due.datetime).slice(0, 10) : undefined),
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
            local.projectId = (task as any).projectId ?? (task as any).project_id;
            local.dueDate = (task as any).due?.date ?? ((task as any).due?.datetime ? String((task as any).due.datetime).slice(0, 10) : undefined);
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

    private async refreshFromRemoteFilterViaRest(filter: string) {
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
            const hasPending = this.hasPendingOpsForId(task.id);

            if (!local) {
                this.localState.tasksById[task.id] = {
                    id: task.id,
                    content: task.content,
                    isCompleted: task.isCompleted ?? false,
                    projectId: (task as any).projectId ?? (task as any).project_id,
                    dueDate: (task as any).due?.date ?? ((task as any).due?.datetime ? String((task as any).due.datetime).slice(0, 10) : undefined),
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
            local.projectId = (task as any).projectId ?? (task as any).project_id;
            local.dueDate = (task as any).due?.date ?? ((task as any).due?.datetime ? String((task as any).due.datetime).slice(0, 10) : undefined);
            local.source = 'remote';
            local.updatedAt = now;
        }

        this.localState.filterResults[filter] = filterIds;
        this.localState.filterLastUsedAt[filter] = now;
        this.requestPersist();
        this.triggerRefresh();
    }

    private async flushQueueToRemote() {
        if (!this.api) return;

        if (this.useSyncApi) {
            await this.flushQueueToRemoteViaSyncApi();
            return;
        }

        const queue = this.localState.queue;
        if (queue.length === 0) return;

        let didChangeLocalState = false;

        const now = this.now();

        for (let i = 0; i < queue.length; ) {
            const op = queue[i];

            if (op.nextRetryAt && op.nextRetryAt > now) {
                i++;
                continue;
            }

            try {
                if (op.type === 'create') {
                    const args: any = { content: op.content };
                    if (op.projectId) args.projectId = op.projectId;
                    if (op.dueDate) args.dueDate = op.dueDate;
                    const created = await this.api.addTask(args);

                    const now = this.now();
                    this.localState.idAliasMap[op.localId] = created.id;

                    const existing = this.localState.tasksById[op.localId];
                    delete this.localState.tasksById[op.localId];

                    this.localState.tasksById[created.id] = {
                        id: created.id,
                        content: created.content,
                        isCompleted: created.isCompleted ?? false,
                        projectId: (created as any).projectId,
                        dueDate: (created as any).due?.date ?? ((created as any).due?.datetime ? String((created as any).due.datetime).slice(0, 10) : undefined),
                        source: 'remote',
                        updatedAt: now,
                        lastRemoteSeenAt: now
                    };

                    for (const [filter, ids] of Object.entries(this.localState.filterResults)) {
                        const replaced = ids.map(x => (x === op.localId ? created.id : x));
                        this.localState.filterResults[filter] = replaced;
                    }

                    if (existing?.isCompleted || op.isCompleted) {
                        await this.api.closeTask(created.id);
                        const t = this.localState.tasksById[created.id];
                        if (t) {
                            t.isCompleted = true;
                            t.updatedAt = now;
                        }
                    }

                    queue.splice(i, 1);
                    this.requestPersist();
                    didChangeLocalState = true;
                    continue;
                }

                const canonical = this.resolveId(op.id);
                if (canonical.startsWith('local-') && !this.localState.idAliasMap[canonical]) {
                    i++;
                    continue;
                }

                if (op.type === 'update') {
                    const args: any = { content: op.content };
                    if (op.dueDate) args.dueDate = op.dueDate;
                    await this.api.updateTask(canonical, args);
                    const t = this.localState.tasksById[canonical];
                    if (t) {
                        t.content = op.content;
                        t.dueDate = op.dueDate;
                        t.source = 'remote';
                        t.updatedAt = this.now();
                    }
                } else if (op.type === 'close') {
                    await this.api.closeTask(canonical);
                    const t = this.localState.tasksById[canonical];
                    if (t) {
                        t.isCompleted = true;
                        t.source = 'remote';
                        t.updatedAt = this.now();
                    }
                } else if (op.type === 'reopen') {
                    await this.api.reopenTask(canonical);
                    const t = this.localState.tasksById[canonical];
                    if (t) {
                        t.isCompleted = false;
                        t.source = 'remote';
                        t.updatedAt = this.now();
                    }
                }

                queue.splice(i, 1);
                this.requestPersist();
                didChangeLocalState = true;
                continue;
            } catch (error) {
                op.attempts += 1;

                const msg = error instanceof Error ? error.message : String(error);
                op.lastError = msg;

                const delay = Math.min(30 * 60 * 1000, 2000 * Math.pow(2, Math.max(0, op.attempts - 1)));
                op.nextRetryAt = this.now() + delay;

                this.localState.status.lastErrorMessage = msg;
                this.localState.status.lastErrorAt = this.now();

                console.error('[Obsidoist] Sync op failed, will retry later', op, error);
                this.requestPersist();
                i++;
            }
        }

        if (didChangeLocalState) this.triggerRefresh();
    }

    private async refreshFromRemote(opts: { filter?: string }) {
        if (!this.api) return;

        if (opts.filter) {
            await this.refreshFromRemoteFilterViaRest(opts.filter);
            return;
        }

        if (this.useSyncApi) {
            await this.refreshFromRemoteViaSyncApi();
            return;
        }

        await this.refreshFromRemoteViaRest();
    }

    triggerRefresh() {
        this.trigger('refresh');
    }
}
