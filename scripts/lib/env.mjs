// Reading and updating .env files while keeping their comments and order.
import fs from 'node:fs';

export function readEnv(file) {
  if (!fs.existsSync(file)) return { lines: [], values: {} };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const values = {};
  for (const line of lines) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return { lines, values };
}

export function writeEnv(file, baseLines, updates) {
  const seen = new Set();
  const lines = baseLines.map((line) => {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (match && match[1] in updates) {
      seen.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates))
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'));
}
