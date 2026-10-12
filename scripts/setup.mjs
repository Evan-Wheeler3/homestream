// Interactive first-time setup: writes .env and checks that Jellyfin is reachable.
// Usage: npm run setup            (interactive)
//        npm run setup -- --check (only test the configured connection)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const envPath = path.resolve('.env');
const examplePath = path.resolve('.env.example');

function readEnv(file) {
  if (!fs.existsSync(file)) return { lines: [], values: {} };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const values = {};
  for (const line of lines) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return { lines, values };
}

function writeEnv(file, baseLines, updates) {
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

async function checkJellyfin(url) {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/System/Info/Public`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ok: false, message: `Jellyfin answered with HTTP ${res.status}.` };
    const info = await res.json();
    const name = info.ServerName ?? info.serverName ?? 'Jellyfin';
    const version = info.Version ?? info.version ?? 'unknown version';
    const wizardDone = info.StartupWizardCompleted ?? info.startupWizardCompleted;
    return {
      ok: true,
      message: `Connected to “${name}” (Jellyfin ${version}).`,
      warning:
        wizardDone === false
          ? 'Jellyfin’s first-run wizard is not finished yet — open Jellyfin in a browser and complete it.'
          : null,
    };
  } catch (error) {
    const code = error.cause?.code ?? error.cause?.errors?.[0]?.code;
    return {
      ok: false,
      message: `Could not reach ${url}: ${code ?? error.cause?.message ?? error.message}`,
    };
  }
}

const existing = readEnv(envPath);
const template = readEnv(examplePath);

if (process.argv.includes('--check')) {
  const url = process.env.JELLYFIN_URL || existing.values.JELLYFIN_URL;
  if (!url) {
    console.log('JELLYFIN_URL is not set — the app will use the built-in sample library.');
    process.exit(0);
  }
  const result = await checkJellyfin(url);
  console.log(result.message);
  if (result.warning) console.log(result.warning);
  process.exit(result.ok ? 0 : 1);
}

// Queue input lines so answers can also be piped in (scripted installs).
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

console.log('\nWheelhouse setup\n--------------------');
console.log('Press Enter to accept the value in [brackets].\n');

let url;
for (;;) {
  url = await ask(
    'Jellyfin address (type - to use the built-in sample library)',
    existing.values.JELLYFIN_URL || 'http://127.0.0.1:8096',
  );
  if (!url || url === '-') {
    url = '';
    break;
  }
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  process.stdout.write('Checking… ');
  const result = await checkJellyfin(url);
  console.log(result.message);
  if (result.warning) console.log(result.warning);
  if (result.ok) break;
  const keep = await ask('Keep this address anyway? (y/n)', 'n');
  if (keep.toLowerCase().startsWith('y')) break;
}

const port = await ask('Port for Wheelhouse', existing.values.PORT || '8787');
const lan = await ask(
  'Allow phones, TVs and other computers on your home network to connect? (y/n)',
  (existing.values.HOST ?? '0.0.0.0') === '127.0.0.1' ? 'n' : 'y',
);
rl.close();

const base = existing.lines.length ? existing.lines : template.lines;
writeEnv(envPath, base, {
  JELLYFIN_URL: url,
  MEDIA_SOURCE: 'auto',
  PORT: port,
  HOST: lan.toLowerCase().startsWith('n') ? '127.0.0.1' : '0.0.0.0',
});

console.log(`\nSaved ${envPath}`);
console.log(url ? `Media source: Jellyfin at ${url}` : 'Media source: built-in sample library');
console.log('\nNext:');
console.log('  npm run build   (first time and after updates)');
console.log('  npm start');
console.log(`  then open http://localhost:${port} and sign in with your Jellyfin account.\n`);
