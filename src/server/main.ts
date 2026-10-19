import os from 'node:os';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const db = openDatabase(config.dataDir);
const { app, provider, ripper, maintenance, macReporter } = createApp({ config, db });

const server = app.listen(config.port, config.host, () => {
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
  maintenance?.start();
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
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Set PORT in .env to another port.`);
  } else console.error(error);
  process.exit(1);
});

function shutdown() {
  ripper?.stop();
  macReporter?.stop();
  maintenance?.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
