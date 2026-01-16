let debugEnabled = false;

export function setDebugEnabled(enabled: boolean) {
	debugEnabled = Boolean(enabled);
}

export function debug(...args: any[]) {
	if (!debugEnabled) return;
	console.log('[Obsidoist]', ...args);
}

export function warn(...args: any[]) {
	if (!debugEnabled) return;
	console.warn('[Obsidoist]', ...args);
}

export function error(...args: any[]) {
	console.error('[Obsidoist]', ...args);
}
