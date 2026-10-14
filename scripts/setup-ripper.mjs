// Interactive setup for automatic disc ripping: checks the tools, asks for the
// folders, a Jellyfin API key and a phone-notification topic, then updates .env.
// Usage: npm run setup:ripper
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv, writeEnv } from './lib/env.mjs';
import { createPrompt } from './lib/prompt.mjs';

const envPath = path.resolve('.env');
const existing = readEnv(envPath);
const env = { ...existing.values };
const { ask, exhausted, close } = createPrompt();

const yes = (answer) => answer.toLowerCase().startsWith('y');
const step = (n, title) => console.log(`\n${n}. ${title}\n${'-'.repeat(title.length + 3)}`);

function works(file, args) {
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
    });
    return { ok: true, out };
  } catch (error) {
    // Some tools print their version and exit non-zero; any output means it ran.
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (out.trim() && error.code !== 'ENOENT' && error.code !== 'EACCES') return { ok: true, out };
    return { ok: false, out: error.code ?? error.message };
  }
}

async function findTool(label, candidates, versionArgs, installHelp) {
  for (;;) {
    const found = candidates.find((p) => p && fs.existsSync(p));
    if (found) {
      const check = works(found, versionArgs);
      if (check.ok) {
        console.log(`✓ ${label}: ${found}`);
        return found;
      }
      console.log(
        `✗ ${label} is at ${found} but would not run (${check.out.trim().slice(0, 120)}).`,
      );
      console.log(
        `  If macOS blocked it, run:  sudo xattr -dr com.apple.quarantine "${found}"   and try again.`,
      );
    } else {
      console.log(`✗ ${label} was not found.`);
      console.log(installHelp);
    }
    const answer = await ask(`Press Enter to check again, type its full path, or type "skip"`, '');
    if (answer.toLowerCase() === 'skip' || exhausted()) return candidates.find(Boolean);
    if (answer) candidates.unshift(answer.replace(/^['"]|['"]$/g, ''));
  }
}

console.log('\nWheelhouse disc ripping setup');
console.log('=============================');
console.log('After this, inserting a DVD is all it takes: Wheelhouse rips it, compresses it,');
console.log('files it in your Movies folder, adds it to Jellyfin and notifies your phone.');
console.log('Press Enter to accept the value in [brackets].');

// 1. Tools --------------------------------------------------------------------
step(1, 'Ripping and compression tools');
const makemkvcon = await findTool(
  'MakeMKV (command-line part)',
  [
    env.MAKEMKVCON,
    '/Applications/MakeMKV.app/Contents/MacOS/makemkvcon',
    '/usr/bin/makemkvcon',
    '/usr/local/bin/makemkvcon',
  ],
  ['--version'],
  '  It comes with the MakeMKV app: install MakeMKV from https://www.makemkv.com into Applications.',
);
const handbrake = await findTool(
  'HandBrakeCLI',
  [
    env.HANDBRAKE_CLI,
    '/usr/local/bin/HandBrakeCLI',
    '/opt/homebrew/bin/HandBrakeCLI',
    path.join(os.homedir(), 'Downloads', 'HandBrakeCLI'),
    '/Applications/HandBrakeCLI',
  ],
  ['--version'],
  [
    '  HandBrakeCLI is the command-line version of HandBrake (free, separate download):',
    '    1. Open https://handbrake.fr/downloads2.php and download "HandBrakeCLI" for macOS.',
    '    2. Open the downloaded .dmg.',
    '    3. In Terminal run:  sudo cp /Volumes/HandBrakeCLI*/HandBrakeCLI /usr/local/bin/',
    '       (it asks for your Mac password; nothing shows while you type).',
  ].join('\n'),
);

// 2. Folders ------------------------------------------------------------------
step(2, 'Folders');
async function folder(label, key, fallback) {
  for (;;) {
    const dir = path.resolve(await ask(`${label} folder`, env[key] || fallback));
    if (fs.existsSync(dir)) return dir;
    const create = await ask(`  ${dir} doesn't exist. Create it? (y/n)`, 'y');
    if (yes(create)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      } catch (error) {
        console.log(`  Couldn't create it: ${error.message}. Is the drive plugged in?`);
      }
    }
    if (exhausted()) return dir;
  }
}
const moviesDir = await folder(
  'Movies (your Jellyfin library)',
  'MOVIES_DIR',
  '/Volumes/LaCie/Movies',
);
const ripsDir = await folder(
  'Rips (temporary files while working)',
  'RIPS_DIR',
  '/Volumes/LaCie/Rips',
);

// 3. Jellyfin API key -----------------------------------------------------------
step(3, 'Jellyfin API key');
console.log('This lets Wheelhouse look movies up by name and add them to Jellyfin right away.');
console.log(
  'Create one in Jellyfin: profile icon → Dashboard → API Keys → + → name it "Wheelhouse".',
);
const jellyfinUrl = (env.JELLYFIN_URL || 'http://127.0.0.1:8096').replace(/\/+$/, '');
let apiKey = env.JELLYFIN_API_KEY || '';
for (;;) {
  const answer = await ask('Paste the API key (or type "skip")', apiKey ? 'keep current' : '');
  if (answer.toLowerCase() === 'skip') {
    apiKey = '';
    break;
  }
  const candidate = answer === 'keep current' ? apiKey : answer.trim();
  if (!candidate) {
    if (exhausted()) break;
    continue;
  }
  try {
    const res = await fetch(`${jellyfinUrl}/System/Info`, {
      headers: { Authorization: `MediaBrowser Client="Wheelhouse", Token="${candidate}"` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      apiKey = candidate;
      console.log('✓ Jellyfin accepted the key.');
      break;
    }
    console.log(
      `✗ Jellyfin rejected that key (HTTP ${res.status}). Copy it again from the API Keys page.`,
    );
  } catch (error) {
    console.log(
      `✗ Couldn't reach Jellyfin at ${jellyfinUrl} (${error.cause?.code ?? error.message}).`,
    );
    if (yes(await ask('  Save the key anyway? (y/n)', 'n'))) {
      apiKey = candidate;
      break;
    }
  }
  if (exhausted()) break;
}

// 4. Phone notifications -------------------------------------------------------------
step(4, 'Phone notifications (ntfy, free)');
let hostname = 'wheelhouse';
try {
  hostname =
    execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim() || hostname;
} catch {
  hostname = os.hostname().replace(/\.local$/, '');
}
const publicUrl = (
  await ask(
    'Wheelhouse address to open from notifications',
    env.WHEELHOUSE_PUBLIC_URL || `http://${hostname}.local:${env.PORT || 8787}`,
  )
).replace(/\/+$/, '');

let topic = env.NTFY_TOPIC || `wheelhouse-${randomBytes(6).toString('hex')}`;
const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
console.log('\nOn your phone:');
console.log('  1. Install the free "ntfy" app (App Store or Google Play).');
console.log('  2. Tap + (Subscribe to topic) and enter exactly:');
console.log(`\n         ${topic}\n`);
console.log('     Anyone who knows this name could read your notifications, so it is random.');
const want = await ask('Set up phone notifications now? (y/n)', 'y');
if (yes(want)) {
  for (;;) {
    await ask('Press Enter once you have subscribed in the app', '');
    try {
      const res = await fetch(server, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          title: '🎬 Wheelhouse is connected',
          message: 'You will get a notification here whenever a new movie is ready.',
          tags: ['white_check_mark'],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log('✓ Test notification sent.');
    } catch (error) {
      console.log(
        `✗ Couldn't send it (${error.cause?.code ?? error.message}). Check the internet connection.`,
      );
    }
    if (exhausted() || yes(await ask('Did it arrive on your phone? (y/n)', 'y'))) break;
    console.log(`Check the topic in the app is exactly: ${topic}`);
  }
} else {
  topic = '';
  console.log('Skipped. You can run npm run setup:ripper again any time.');
}

// 5. Save ----------------------------------------------------------------------------
close();
const template = readEnv(path.resolve('.env.example'));
writeEnv(envPath, existing.lines.length ? existing.lines : template.lines, {
  RIPPER_ENABLED: 'true',
  MOVIES_DIR: moviesDir,
  RIPS_DIR: ripsDir,
  MAKEMKVCON: makemkvcon,
  HANDBRAKE_CLI: handbrake,
  JELLYFIN_API_KEY: apiKey,
  NTFY_TOPIC: topic,
  WHEELHOUSE_PUBLIC_URL: publicUrl,
});
console.log(`\nSaved ${envPath}`);

const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.wheelhouse.app.plist');
console.log('\nLast step: restart Wheelhouse so it starts watching for discs:');
if (fs.existsSync(plist)) {
  console.log(`  launchctl unload ${plist}`);
  console.log(`  launchctl load ${plist}`);
} else {
  console.log('  Stop it (Control + C in its Terminal window), then run: npm start');
}
console.log('\nThen open the Discs page in Wheelhouse and insert a DVD.');
console.log('Tip: keep the MakeMKV app closed (it locks the drive). If macOS asks whether "node"');
console.log('may access files on a removable volume, click Allow.\n');
