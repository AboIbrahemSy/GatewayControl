import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PgStore } from './postgres-store.js';

const config = loadConfig();
const store = new PgStore(config.databaseUrl);
const app = await buildApp({
  store,
  masterKey: config.masterKey,
  secureCookie: config.secureCookie,
  sessionTtlHours: config.sessionTtlHours,
  trustProxy: config.trustProxy,
  defaultAgentImage: config.agentImage,
  traefikDynamicVolume: config.traefikDynamicVolume,
  ...(config.webRoot ? { webRoot: config.webRoot } : {}),
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down.');
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'Server startup failed.');
  await app.close();
  process.exit(1);
}
