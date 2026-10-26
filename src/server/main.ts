import os from 'node:os';
import { createApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { openDatabase } from './db.js';

let config: AppConfig;
try {
  config = loadConfig();
} catch (error) {
  console.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const db = openDatabase(config.dataDir);
const { app, provider, ripper, maintenance, macReporter, autoUpdater } = createApp({ config, db });

// WHEELHOUSE_MODE=ripper: this Mac only rips and uploads to the cloud; the old
// website (and Jellyfin) aren't needed.
const ripOnly = process.env.WHEELHOUSE_MODE === 'ripper';

function startBackground() {
  maintenance?.start();
  if (autoUpdater) {
    autoUpdater.start();
    console.info('  Updates: installed automatically when nothing is ripping or playing');
  }
  if (ripper) {
    ripper.start();
    const health = ripper.health();
    console.info(`  Disc ripping: on (watching ${config.ripper.volumesDir} for discs)`);
    for (const problem of health.problems) console.warn(`    ! ${problem}`);
    for (const warning of health.warnings) console.info(`    - ${warning}`);
  }
  if (macReporter) {
    macReporter.start();
    console.info(`  Cloud: new rips upload to ${process.env.CLOUD_URL}`);
  }
}

if (ripOnly) {
  console.info(`Wheelhouse ${config.version}: rip-and-upload only (WHEELHOUSE_MODE=ripper)`);
  if (!ripper) console.warn('  RIPPER_ENABLED isn’t set: there is nothing to do.');
  if (!macReporter)
    console.warn('  The cloud isn’t set up (CLOUD_URL, CLOUD_MAC_TOKEN, R2_*, TMDB_READ_TOKEN).');
  startBackground();
}

const server = ripOnly
  ? null
  : app.listen(config.port, config.host, () => {
      const lanAddresses = Object.values(os.networkInterfaces())
        .flat()
        .filter((i) => i && i.family === 'IPv4' && !i.internal)
        .map((i) => `http://${i!.address}:${config.port}`);
      console.info(`Wheelhouse ${config.version} listening on http://localhost:${config.port}`);
      for (const url of lanAddresses) console.info(`  On your network: ${url}`);
      if (provider.kind === 'mock') {
        console.info('  Media source: built-in SAMPLE library (set JELLYFIN_URL to use Jellyfin)');
        console.info('  Sign in with any username and the MOCK_PASSWORD (default "demo").');
      } else {
        console.info(`  Media source: Jellyfin at ${provider.serverUrl}`);
      }
      console.info(`  Data directory: ${config.dataDir}`);
      startBackground();
    });

server?.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Set PORT in .env to another port.`);
  } else console.error(error);
  process.exit(1);
});

function shutdown() {
  autoUpdater?.stop();
  ripper?.stop();
  macReporter?.stop();
  maintenance?.stop();
  if (!server) {
    db.close();
    process.exit(0);
  }
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
