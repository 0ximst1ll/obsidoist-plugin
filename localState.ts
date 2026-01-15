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
    const anyCrypto: any = (globalThis as any).crypto;
    if (anyCrypto && typeof anyCrypto.randomUUID === 'function') {
        return anyCrypto.randomUUID();
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

export function migrateLocalState(raw: any): ObsidoistLocalState {
    const base = createDefaultLocalState();
    if (!raw || typeof raw !== 'object') return base;

    const state: any = raw;
    if (state.schemaVersion === 2) {
		const s = state as ObsidoistLocalState;
		if (!s.lineShadowById || typeof s.lineShadowById !== 'object') {
			(s as any).lineShadowById = {};
		}
		return s;
	}

    const queueRaw: any[] = Array.isArray(state.queue) ? state.queue : [];
    const queue: SyncOperation[] = queueRaw
        .map((op) => {
            if (!op || typeof op !== 'object' || typeof op.type !== 'string') return null;
            const opIdRaw = typeof op.opId === 'string' ? op.opId : '';
            const opId = isUuid(opIdRaw) ? opIdRaw : createOperationId();
            const attempts = Number.isFinite(op.attempts) ? op.attempts : 0;
            const queuedAt = Number.isFinite(op.queuedAt) ? op.queuedAt : Date.now();

            if (op.type === 'create') {
                return {
                    type: 'create',
                    opId,
                    localId: String(op.localId ?? op.id ?? ''),
                    content: String(op.content ?? ''),
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
					id: String(op.id ?? ''),
					projectId: String(op.projectId ?? ''),
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
                    id: String(op.id ?? ''),
                    content: String(op.content ?? ''),
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
                    id: String(op.id ?? ''),
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
        tasksById: (state.tasksById && typeof state.tasksById === 'object') ? state.tasksById : {},
        projectsById: (state.projectsById && typeof state.projectsById === 'object') ? state.projectsById : {},
        idAliasMap: (state.idAliasMap && typeof state.idAliasMap === 'object') ? state.idAliasMap : {},
        filterResults: (state.filterResults && typeof state.filterResults === 'object') ? state.filterResults : {},
        filterLastUsedAt: (state.filterLastUsedAt && typeof state.filterLastUsedAt === 'object') ? state.filterLastUsedAt : {},
        queue,
        status: (state.status && typeof state.status === 'object') ? state.status : {},
		lineShadowById: (state.lineShadowById && typeof state.lineShadowById === 'object') ? state.lineShadowById : {},
        syncToken: typeof state.syncToken === 'string' ? state.syncToken : undefined,
        lastFullSyncAt: state.lastFullSyncAt,
        lastProjectsSyncAt: state.lastProjectsSyncAt
    };

    return merged;
}
