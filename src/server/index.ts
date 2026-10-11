// Entry point. node:sqlite prints an ExperimentalWarning on Node 22; silence just
// that one before loading the app so logs stay readable.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  if (message.includes('SQLite is an experimental feature')) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

await import('./main.js');
