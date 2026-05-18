let debugEnabled = false;

export function setDebugEnabled(enabled: boolean) {
	debugEnabled = Boolean(enabled);
}

export function debug(...args: unknown[]) {
	if (!debugEnabled) return;
	console.debug('[Markdoist]', ...args);
}

export function warn(...args: unknown[]) {
	if (!debugEnabled) return;
	console.warn('[Markdoist]', ...args);
}

export function error(...args: unknown[]) {
	console.error('[Markdoist]', ...args);
}
