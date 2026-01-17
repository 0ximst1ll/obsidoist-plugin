export type TaskId = string;

export interface SyncStatus {
    lastSyncStartedAt?: number;
    lastSyncFinishedAt?: number;
    lastSuccessfulSyncAt?: number;
    lastErrorMessage?: string;
    lastErrorAt?: number;
    lastPruneAt?: number;

    lastSyncApiTestAt?: number;
    lastSyncApiTestResult?: 'ok' | 'error';
    lastSyncApiTestMessage?: string;
}

export type SyncOperation =
    | {
          type: 'create';
          opId: string;
          localId: TaskId;
          content: string;
          projectId?: string;
          dueDate?: string;
          isCompleted?: boolean;
          queuedAt: number;
          attempts: number;
          nextRetryAt?: number;
          lastError?: string;
      }
    | {
          type: 'update';
          opId: string;
          id: TaskId;
          content: string;
          dueDate?: string;
          queuedAt: number;
          attempts: number;
          nextRetryAt?: number;
          lastError?: string;
      }
    | {
          type: 'move';
          opId: string;
          id: TaskId;
          projectId: string;
          queuedAt: number;
          attempts: number;
          nextRetryAt?: number;
          lastError?: string;
      }
    | { type: 'close'; opId: string; id: TaskId; queuedAt: number; attempts: number; nextRetryAt?: number; lastError?: string }
    | { type: 'reopen'; opId: string; id: TaskId; queuedAt: number; attempts: number; nextRetryAt?: number; lastError?: string };

export interface LocalTaskRecord {
    id: TaskId;
    content: string;
    isCompleted: boolean;
    projectId?: string;
    dueDate?: string;
	isRecurring?: boolean;
	isDeleted?: boolean;
    source: 'remote' | 'local';
    updatedAt: number;
    lastRemoteSeenAt?: number;
}

export interface LocalProjectRecord {
    id: string;
    name: string;
    updatedAt: number;
}

export interface ObsidoistLocalState {
    schemaVersion: 2;
    tasksById: Record<TaskId, LocalTaskRecord>;
    projectsById: Record<string, LocalProjectRecord>;
    idAliasMap: Record<TaskId, TaskId>;
    filterResults: Record<string, TaskId[]>;
    filterLastUsedAt: Record<string, number>;
    queue: SyncOperation[];
    status: SyncStatus;
	lineShadowById: Record<TaskId, { content: string; isCompleted: boolean; projectId?: string; dueDate?: string }>;

    syncToken?: string;
    lastFullSyncAt?: number;
    lastProjectsSyncAt?: number;
}

export function createDefaultLocalState(): ObsidoistLocalState {
    return {
        schemaVersion: 2,
        tasksById: {},
        projectsById: {},
        idAliasMap: {},
        filterResults: {},
        filterLastUsedAt: {},
        queue: [],
        status: {},
		lineShadowById: {}
    };
}

export function createLocalId(): TaskId {
    const rand = Math.random().toString(16).slice(2);
    return `local-${Date.now().toString(16)}-${rand}`;
}

export function createOperationId(): string {
    const cryptoValue: unknown = (globalThis as { crypto?: unknown }).crypto;
    if (cryptoValue && typeof cryptoValue === 'object') {
        const randomUUID = (cryptoValue as { randomUUID?: unknown }).randomUUID;
        if (typeof randomUUID === 'function') {
            return (randomUUID as (...args: unknown[]) => string).call(cryptoValue);
        }
    }

    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function migrateLocalState(raw: unknown): ObsidoistLocalState {
    const base = createDefaultLocalState();
    if (!isRecord(raw)) return base;

    const state = raw;
    if (state.schemaVersion === 2) {
        const s = state as unknown as ObsidoistLocalState;
        const shadow = (s as unknown as { lineShadowById?: unknown }).lineShadowById;
        if (!isRecord(shadow)) {
            (s as unknown as { lineShadowById: ObsidoistLocalState['lineShadowById'] }).lineShadowById = {};
        }
        return s;
    }

    const queueRaw: unknown[] = Array.isArray(state.queue) ? state.queue : [];
    const queue: SyncOperation[] = queueRaw
        .map((op) => {
            if (!isRecord(op) || typeof op.type !== 'string') return null;
            const opIdRaw = typeof op.opId === 'string' ? op.opId : '';
            const opId = isUuid(opIdRaw) ? opIdRaw : createOperationId();
            const attempts = Number.isFinite(op.attempts) ? op.attempts : 0;
            const queuedAt = Number.isFinite(op.queuedAt) ? op.queuedAt : Date.now();

            if (op.type === 'create') {
                return {
                    type: 'create',
                    opId,
                    localId: typeof op.localId === 'string' ? op.localId : (typeof op.id === 'string' ? op.id : ''),
                    content: typeof op.content === 'string' ? op.content : '',
                    projectId: typeof op.projectId === 'string' ? op.projectId : undefined,
                    dueDate: typeof op.dueDate === 'string' ? op.dueDate : undefined,
                    isCompleted: typeof op.isCompleted === 'boolean' ? op.isCompleted : undefined,
                    queuedAt,
                    attempts,
                    nextRetryAt: Number.isFinite(op.nextRetryAt) ? op.nextRetryAt : undefined,
                    lastError: typeof op.lastError === 'string' ? op.lastError : undefined
                } as SyncOperation;
            }

			if (op.type === 'move') {
				return {
					type: 'move',
					opId,
					id: typeof op.id === 'string' ? op.id : '',
					projectId: typeof op.projectId === 'string' ? op.projectId : '',
					queuedAt,
					attempts,
					nextRetryAt: Number.isFinite(op.nextRetryAt) ? op.nextRetryAt : undefined,
					lastError: typeof op.lastError === 'string' ? op.lastError : undefined
				} as SyncOperation;
			}

            if (op.type === 'update') {
                return {
                    type: 'update',
                    opId,
                    id: typeof op.id === 'string' ? op.id : '',
                    content: typeof op.content === 'string' ? op.content : '',
                    dueDate: typeof op.dueDate === 'string' ? op.dueDate : undefined,
                    queuedAt,
                    attempts,
                    nextRetryAt: Number.isFinite(op.nextRetryAt) ? op.nextRetryAt : undefined,
                    lastError: typeof op.lastError === 'string' ? op.lastError : undefined
                } as SyncOperation;
            }

            if (op.type === 'close' || op.type === 'reopen') {
                return {
                    type: op.type,
                    opId,
                    id: typeof op.id === 'string' ? op.id : '',
                    queuedAt,
                    attempts,
                    nextRetryAt: Number.isFinite(op.nextRetryAt) ? op.nextRetryAt : undefined,
                    lastError: typeof op.lastError === 'string' ? op.lastError : undefined
                } as SyncOperation;
            }

            return null;
        })
        .filter((x): x is SyncOperation => Boolean(x));

    const merged: ObsidoistLocalState = {
        schemaVersion: 2,
        tasksById: (isRecord(state.tasksById)) ? (state.tasksById as unknown as ObsidoistLocalState['tasksById']) : {},
        projectsById: (isRecord(state.projectsById)) ? (state.projectsById as unknown as ObsidoistLocalState['projectsById']) : {},
        idAliasMap: (isRecord(state.idAliasMap)) ? (state.idAliasMap as unknown as ObsidoistLocalState['idAliasMap']) : {},
        filterResults: (isRecord(state.filterResults)) ? (state.filterResults as unknown as ObsidoistLocalState['filterResults']) : {},
        filterLastUsedAt: (isRecord(state.filterLastUsedAt)) ? (state.filterLastUsedAt as unknown as ObsidoistLocalState['filterLastUsedAt']) : {},
        queue,
        status: (isRecord(state.status)) ? (state.status as unknown as ObsidoistLocalState['status']) : {},
		lineShadowById: (isRecord(state.lineShadowById)) ? (state.lineShadowById as unknown as ObsidoistLocalState['lineShadowById']) : {},
        syncToken: typeof state.syncToken === 'string' ? state.syncToken : undefined,
        lastFullSyncAt: typeof state.lastFullSyncAt === 'number' ? state.lastFullSyncAt : undefined,
        lastProjectsSyncAt: typeof state.lastProjectsSyncAt === 'number' ? state.lastProjectsSyncAt : undefined
    };

    return merged;
}
