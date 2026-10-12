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
const { app, provider } = createApp({ config, db });

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
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Set PORT in .env to another port.`);
  } else console.error(error);
  process.exit(1);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
