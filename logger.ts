let debugEnabled = false;

export function setDebugEnabled(enabled: boolean) {
	debugEnabled = Boolean(enabled);
}

export function debug(...args: unknown[]) {
	if (!debugEnabled) return;
	console.debug('[Obsidoist]', ...args);
}

export function warn(...args: unknown[]) {
	if (!debugEnabled) return;
	console.warn('[Obsidoist]', ...args);
}

export function error(...args: unknown[]) {
	console.error('[Obsidoist]', ...args);
}
