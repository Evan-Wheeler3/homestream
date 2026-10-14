// Line-by-line questions in the terminal. Answers can also be piped in (scripted installs).
import readline from 'node:readline';

export function createPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  const queued = [];
  let waiting = null;
  let inputClosed = false;
  rl.on('line', (line) => (waiting ? (waiting(line), (waiting = null)) : queued.push(line)));
  rl.on('close', () => {
    inputClosed = true;
    if (waiting) waiting('');
  });
  const ask = async (question, fallback) => {
    process.stdout.write(`${question}${fallback ? ` [${fallback}]` : ''}: `);
    const line = queued.length
      ? queued.shift()
      : inputClosed
        ? ''
        : await new Promise((resolve) => (waiting = resolve));
    if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
    return line.trim() || fallback || '';
  };
  /** True once piped-in answers have run out (never true while typing). */
  const exhausted = () => inputClosed && queued.length === 0;
  return { ask, exhausted, close: () => rl.close() };
}
