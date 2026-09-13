/**
 * HTTP server: the OTA/config endpoint, a health check, and the WebSocket upgrade.
 *
 * No framework: Node's http module plus `ws`. Frameworks that add trailing
 * slashes or redirects would break the device, which does not follow
 * redirects (PROTOCOL.md 1.3).
 */

import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { DEFAULT_WS_PATH, HEALTH_PATH, OTA_PATHS, type ServerConfig, parseUriLikeFirmware } from './config.js';
import { type Logger, clip } from './log.js';
import { framingFor } from './protocol/binary.js';
import { EchoResponder } from './pipeline/echo.js';
import type { TurnResponder } from './pipeline/types.js';
import { CLOSE, DeviceSession } from './session.js';

/** Largest OTA request body accepted. The device's system-info JSON is a few KB. */
const MAX_OTA_BODY_BYTES = 64 * 1024;
/** Above the device's own 65535-byte frame limit (esp-ml307/src/web_socket.cc:210-213). */
const WS_MAX_PAYLOAD_BYTES = 256 * 1024;

export interface VoiceServerOptions {
  logger: Logger;
  /** Builds the responder for each connection. Defaults to echo. */
  responderFactory?: (config: ServerConfig) => TurnResponder;
}

export interface ListenInfo {
  port: number;
  address: string;
  publicWsUrl: string;
}

export interface VoiceServer {
  listen(): Promise<ListenInfo>;
  /** Stops accepting, closes sessions, waits up to graceMs, then force-closes. */
  close(graceMs?: number): Promise<void>;
  readonly sessionCount: number;
  readonly httpServer: http.Server;
}

export function defaultResponderFactory(config: ServerConfig): TurnResponder {
  return new EchoResponder({ downlinkSampleRate: config.echo.downlinkSampleRate });
}

export function otaResponse(publicWsUrl: string, config: ServerConfig, now = Date.now()): object {
  // Only url, token and version inside "websocket": every member is written to
  // NVS and keys over 15 characters abort the device (PROTOCOL.md 1.6).
  // No "mqtt" (selects MQTT), no "activation", no "firmware" (PROTOCOL.md 1.4, 1.7).
  return {
    websocket: {
      url: publicWsUrl,
      token: config.token,
      version: config.protocolVersion,
    },
    // timestamp in ms. The firmware adds timezone_offset (minutes, times 60 000)
    // to the epoch before settimeofday (main/ota.cc:193-211), so without it the
    // idle status-bar clock shows UTC.
    server_time:
      config.timezoneOffsetMinutes === undefined
        ? { timestamp: now }
        : { timestamp: now, timezone_offset: config.timezoneOffsetMinutes },
  };
}

/**
 * Path of a request target, or undefined when WHATWG URL cannot parse it
 * (for example "http://999.999.999.999/" or "//["). Never throws: an uncaught
 * throw here used to crash the process for every open session.
 */
export function requestPath(target: string | undefined): string | undefined {
  try {
    return new URL(target ?? '/', 'http://placeholder').pathname;
  } catch {
    return undefined;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host.startsWith('127.') || host === '::1' || host === '[::1]';
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

function headerString(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Rejects an upgrade with a plain HTTP response (anything but "HTTP/1.1 101" fails the device handshake). */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = message + '\n';
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  );
  socket.once('finish', () => socket.destroy());
}

export function createVoiceServer(config: ServerConfig, options: VoiceServerOptions): VoiceServer {
  const log = options.logger;
  const responderFactory = options.responderFactory ?? defaultResponderFactory;
  const sessions = new Set<DeviceSession>();
  let shuttingDown = false;
  let publicWsUrl = config.publicWsUrl ?? `ws://localhost:${config.port}${DEFAULT_WS_PATH}`;

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
  });

  const httpServer = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      log.error('http_handler_error', { error: err, target: clip(req.url) });
      req.resume();
      if (!res.headersSent) res.writeHead(500, { 'Content-Length': 0, Connection: 'close' });
      res.end();
    }
  });

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = requestPath(req.url);
    if (path === undefined) {
      log.warn('http_bad_request_target', { target: clip(req.url), remote: req.socket.remoteAddress });
      req.resume();
      const body = 'bad request\n';
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Content-Length': body.length, Connection: 'close' });
      res.end(body);
      return;
    }

    // Not "/healthz": Cloud Run reserves some paths ending in "z".
    if (path === HEALTH_PATH) {
      const body = JSON.stringify({ status: shuttingDown ? 'shutting_down' : 'ok', sessions: sessions.size });
      res.writeHead(shuttingDown ? 503 : 200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (OTA_PATHS.includes(path)) {
      handleOta(req, res, path);
      return;
    }

    if (path === '/ota/activate' || path === '/ota/activate/') {
      // Never reached while "activation" is omitted; 200 means "done" (main/ota.cc:527-533).
      log.warn('ota_activate_unexpected', { deviceId: clip(headerString(req, 'Device-Id')) });
      req.resume();
      const body = '{}';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      res.end(body);
      return;
    }

    req.resume();
    const body = 'not found\n';
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
    res.end(body);
  }

  function handleOta(req: http.IncomingMessage, res: http.ServerResponse, path: string): void {
    const method = req.method ?? 'GET';
    if (method !== 'POST' && method !== 'GET') {
      req.resume();
      res.writeHead(405, { Allow: 'GET, POST', 'Content-Length': 0 });
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OTA_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => log.warn('ota_request_error', { error: err }));
    req.on('end', () => {
      const deviceId = clip(headerString(req, 'Device-Id'));
      const remote = req.socket.remoteAddress;
      if (tooLarge) {
        log.warn('ota_body_too_large', { deviceId, bytes: size });
        res.writeHead(413, { 'Content-Length': 0, Connection: 'close' });
        res.end();
        return;
      }
      let board: Record<string, unknown> | undefined;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length > 0) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const app = parsed['application'] as Record<string, unknown> | undefined;
          const b = parsed['board'] as Record<string, unknown> | undefined;
          // Body fields are client-supplied: truncate before logging.
          board = {
            appVersion: clip(app?.['version']),
            boardName: clip(b?.['name']),
            boardType: clip(b?.['type']),
            ip: clip(b?.['ip']),
            rssi: clip(b?.['rssi']),
            channel: clip(b?.['channel']),
          };
        } catch {
          log.warn('ota_body_not_json', { deviceId, bytes: size });
        }
      }
      const payload = JSON.stringify(otaResponse(publicWsUrl, config));
      const wsHost = parseUriLikeFirmware(publicWsUrl)?.host ?? '';
      if (isLoopbackHost(wsHost) && !isLoopbackAddress(remote)) {
        log.warn('ota_public_ws_url_is_loopback', {
          deviceId,
          remote,
          publicWsUrl,
          hint: 'A device cannot reach localhost on this machine. Set PUBLIC_WS_URL to ws://<LAN IP>:<port>/ws and reboot the device.',
        });
      }
      log.info('ota_request', {
        method,
        path,
        remote,
        deviceId,
        clientId: clip(headerString(req, 'Client-Id')),
        userAgent: clip(headerString(req, 'User-Agent')),
        activationVersion: clip(headerString(req, 'Activation-Version')),
        serialNumberPresent: headerString(req, 'Serial-Number') !== undefined,
        bodyBytes: size,
        board,
        wsUrl: publicWsUrl,
        wsVersion: config.protocolVersion,
      });
      // Exactly 200, directly on this path (main/ota.cc:109-112).
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
      });
      res.end(payload);
    });
  }

  httpServer.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', (err) => log.debug('upgrade_socket_error', { error: err }));
    try {
      handleUpgrade(req, socket, head);
    } catch (err) {
      // The 101 may already be on the wire, so drop the socket rather than write a response.
      log.error('upgrade_handler_error', { error: err, target: clip(req.url) });
      socket.destroy();
    }
  });

  function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    // Truncated because these values reach every session log line.
    const deviceId = clip(headerString(req, 'Device-Id') ?? '') as string;
    const clientId = clip(headerString(req, 'Client-Id') ?? '') as string;
    const remote = req.socket.remoteAddress ?? '';

    if (shuttingDown) {
      rejectUpgrade(socket, 503, 'shutting down');
      return;
    }
    const path = requestPath(req.url);
    if (path === undefined) {
      log.warn('ws_rejected', { reason: 'bad request target', target: clip(req.url), deviceId, remote });
      rejectUpgrade(socket, 400, 'bad request');
      return;
    }
    if (path !== config.wsPath) {
      log.warn('ws_rejected', { reason: 'unknown path', path: clip(path), deviceId, remote });
      rejectUpgrade(socket, 404, 'not found');
      return;
    }

    // The device sends "Bearer <token>" when the token has no space
    // (main/protocols/websocket_protocol.cc:97-103). POCKET_DEV_TOKEN is printable
    // ASCII with no space (validateToken), so the latin1 decoding Node applies to
    // header values leaves it byte-identical.
    const auth = headerString(req, 'Authorization');
    const match = auth ? /^Bearer (\S+)$/.exec(auth) : null;
    if (!match || !tokensMatch(match[1]!, config.token)) {
      log.warn('ws_rejected', {
        reason: auth ? 'bad token' : 'missing Authorization',
        deviceId,
        clientId,
        remote,
      });
      rejectUpgrade(socket, 401, 'unauthorized');
      return;
    }

    const versionHeader = headerString(req, 'Protocol-Version');
    const headerVersion = versionHeader !== undefined && /^\d+$/.test(versionHeader) ? Number(versionHeader) : undefined;
    if (headerVersion !== undefined && headerVersion !== config.protocolVersion) {
      log.warn('protocol_version_mismatch', {
        deviceId,
        headerVersion,
        configuredVersion: config.protocolVersion,
        hint: 'The device frames audio by its NVS version; using the header value.',
      });
    }
    const framing = framingFor(headerVersion ?? config.protocolVersion);

    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new DeviceSession(ws, {
        config,
        logger: log,
        responder: responderFactory(config),
        deviceId,
        clientId,
        framing,
        remoteAddress: remote,
      });
      sessions.add(session);
      void session.closed.then(() => sessions.delete(session));
      session.start();
    });
  }

  httpServer.on('clientError', (err, socket) => {
    log.debug('http_client_error', { error: err });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    httpServer,
    get sessionCount() {
      return sessions.size;
    },
    listen() {
      return new Promise<ListenInfo>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        httpServer.once('error', onError);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', onError);
          const addr = httpServer.address() as AddressInfo;
          if (!config.publicWsUrl) publicWsUrl = `ws://localhost:${addr.port}${DEFAULT_WS_PATH}`;
          resolve({ port: addr.port, address: addr.address, publicWsUrl });
        });
      });
    },
    async close(graceMs = config.shutdownGraceMs) {
      if (shuttingDown) return;
      shuttingDown = true;
      const serverClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeIdleConnections();
      const pending = [...sessions].map((s) => {
        s.close(CLOSE.goingAway, 'server shutting down');
        return s.closed;
      });
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), graceMs);
      });
      const outcome = await Promise.race([Promise.all(pending).then(() => 'done' as const), timeout]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        log.warn('shutdown_grace_expired', { openSessions: sessions.size });
        httpServer.closeAllConnections();
      }
      wss.close();
      await Promise.race([serverClosed, new Promise((r) => setTimeout(r, 1000))]);
    },
  };
}
