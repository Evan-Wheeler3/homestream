// A small in-memory ring buffer of recent client-side errors, shown in
// Settings → Diagnostics to help troubleshoot connection and playback issues.

export interface DiagnosticEntry {
  at: string;
  message: string;
}

const MAX = 30;
const entries: DiagnosticEntry[] = [];

export function recordError(message: string) {
  entries.unshift({ at: new Date().toISOString(), message: message.slice(0, 500) });
  entries.length = Math.min(entries.length, MAX);
}

export function recentErrors(): DiagnosticEntry[] {
  return [...entries];
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => recordError(`Script error: ${event.message}`));
  window.addEventListener('unhandledrejection', (event) =>
    recordError(`Unhandled: ${String(event.reason?.message ?? event.reason)}`),
  );
}
