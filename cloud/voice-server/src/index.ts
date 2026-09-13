/**
 * Entry point. Reads the environment, listens on PORT, logs JSON to stdout,
 * and shuts down gracefully on SIGTERM or SIGINT.
 */

import os from 'node:os';
import { ConfigError, HEALTH_PATH, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createVoiceServer } from './server.js';

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(`${info.address} (${name})`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stdout.write(
        JSON.stringify({ severity: 'ERROR', message: 'config_error', error: err.message, time: new Date().toISOString() }) +
          '\n',
      );
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel, { service: 'pebble-pocket-voice-server' });
  const server = createVoiceServer(config, { logger });

  process.on('uncaughtException', (err) => {
    logger.error('uncaught_exception', { error: err, stack: err.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { error: reason instanceof Error ? reason : String(reason) });
  });

  const info = await server.listen();
  const lan = lanAddresses();
  logger.info('listening', {
    address: info.address,
    port: info.port,
    otaPaths: ['/ota/', '/ota'],
    wsPath: config.wsPath,
    publicWsUrl: info.publicWsUrl,
    protocolVersion: config.protocolVersion,
    responder: config.responder,
    endpointMode: config.endpoint.mode,
    maxBufferMs: config.echo.maxBufferMs,
    healthPath: HEALTH_PATH,
    timezoneOffsetMinutes: config.timezoneOffsetMinutes ?? null,
    lanAddresses: lan,
  });
  if (config.tokenGenerated) {
    logger.warn('token_generated', {
      hint:
        'POCKET_DEV_TOKEN is not set, so a random token was generated for this process. ' +
        'A device fetches the token only at boot, so after restarting this server it must reboot. ' +
        'Set POCKET_DEV_TOKEN to keep it stable.',
    });
  }
  if (!config.publicWsUrl) {
    const first = lan[0]?.split(' ')[0];
    logger.warn('public_ws_url_default', {
      publicWsUrl: info.publicWsUrl,
      hint: first
        ? `A real device cannot use localhost. For the LAN use PUBLIC_WS_URL=ws://${first}:${info.port}/ws and OTA URL http://${first}:${info.port}/ota/`
        : 'A real device cannot use localhost. Set PUBLIC_WS_URL to ws://<LAN IP>:<port>/ws',
    });
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      logger.warn('second_signal_exiting_now', { signal });
      process.exit(1);
    }
    stopping = true;
    logger.info('shutdown_started', { signal, openSessions: server.sessionCount, graceMs: config.shutdownGraceMs });
    server
      .close(config.shutdownGraceMs)
      .then(() => {
        logger.info('shutdown_complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error('shutdown_failed', { error: err instanceof Error ? err : String(err) });
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stdout.write(
    JSON.stringify({
      severity: 'ERROR',
      message: 'startup_failed',
      error: err instanceof Error ? err.message : String(err),
      time: new Date().toISOString(),
    }) + '\n',
  );
  process.exit(1);
});
