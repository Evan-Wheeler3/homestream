// Creates a consistent backup of the app's own data (database + uploaded
// collection artwork). Safe to run while the app is running.
// Usage: npm run backup [-- --out /path/to/backups]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const outIndex = process.argv.indexOf('--out');
const outRoot = path.resolve(
  outIndex > -1 ? process.argv[outIndex + 1] : path.join(dataDir, 'backups'),
);
const dbFile = path.join(dataDir, 'private-cinema.db');

if (!fs.existsSync(dbFile)) {
  console.error(`No database found at ${dbFile}. Is DATA_DIR correct?`);
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const target = path.join(outRoot, `private-cinema-${stamp}`);
fs.mkdirSync(target, { recursive: true });

// VACUUM INTO writes a transactionally consistent copy even while the app is writing.
const db = new DatabaseSync(dbFile);
db.exec(`VACUUM INTO '${path.join(target, 'private-cinema.db').replace(/'/g, "''")}'`);
db.close();

const artwork = path.join(dataDir, 'artwork');
if (fs.existsSync(artwork)) fs.cpSync(artwork, path.join(target, 'artwork'), { recursive: true });

console.log(`Backup written to ${target}`);
console.log(
  'To restore: stop the app, copy private-cinema.db and artwork/ into your DATA_DIR, start the app.',
);
