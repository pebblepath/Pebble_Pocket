/**
 * Test helpers: an in-process server on an ephemeral port and a scripted
 * WebSocket client that records everything it receives.
 */

import http from 'node:http';
import { WebSocket } from 'ws';
import { type ServerConfig, defaultConfig } from '../config.js';
import { silentLogger, type Logger } from '../log.js';
import { type VoiceServer, type VoiceServerOptions, createVoiceServer } from '../server.js';

export const TEST_TOKEN = 'test-token-123';

export const DEVICE_HELLO =
  '{"type":"hello","version":1,"features":{"mcp":true,"glyph_push":false},"transport":"websocket",' +
  '"audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

export interface TestServer {
  server: VoiceServer;
  config: ServerConfig;
  port: number;
  otaUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

export async function startServer(
  overrides: DeepPartial<ServerConfig> = {},
  options: Partial<VoiceServerOptions> & { logger?: Logger } = {},
): Promise<TestServer> {
  const d = defaultConfig();
  const config: ServerConfig = {
    ...d,
    port: 0,
    host: '127.0.0.1',
    token: TEST_TOKEN,
    pingIntervalMs: 0,
    shutdownGraceMs: 2_000,
    ...overrides,
    echo: { ...d.echo, ...overrides.echo },
    playback: { ...d.playback, ...overrides.playback },
    endpoint: { ...d.endpoint, ...overrides.endpoint },
  } as ServerConfig;
  const server = createVoiceServer(config, { logger: options.logger ?? silentLogger, ...options });
  const info = await server.listen();
  return {
    server,
    config,
    port: info.port,
    otaUrl: `http://127.0.0.1:${info.port}/ota/`,
    wsUrl: info.publicWsUrl.replace('localhost', '127.0.0.1'),
    close: () => server.close(1_000),
  };
}

export interface Received {
  t: number;
  binary: boolean;
  text?: string;
  json?: Record<string, unknown>;
  data?: Buffer;
}

export interface TestClient {
  ws: WebSocket;
  received: Received[];
  closed: Promise<{ code: number; reason: string }>;
  sendJson(obj: unknown): void;
  sendText(text: string): void;
  sendBinary(buf: Buffer): void;
  waitFor(pred: (r: Received) => boolean, timeoutMs?: number, startIndex?: number): Promise<Received>;
  hello(): Promise<Record<string, unknown>>;
  hangUp(): void;
}

/** `token: null` sends no Authorization header. */
export function deviceHeaders(token: string | null = TEST_TOKEN, version = 1): Record<string, string> {
  const h: Record<string, string> = {
    'Protocol-Version': String(version),
    'Device-Id': 'aa:bb:cc:dd:ee:ff',
    'Client-Id': '11111111-2222-4333-8444-555555555555',
  };
  if (token !== null) h['Authorization'] = `Bearer ${token}`;
  return h;
}

/** Opens a connection; rejects with the HTTP status when the upgrade is refused. */
export function connect(url: string, headers: Record<string, string> = deviceHeaders()): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 5_000 });
    const received: Received[] = [];
    const listeners = new Set<() => void>();
    let resolveClosed!: (v: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((r) => {
      resolveClosed = r;
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const r: Received = { t: Date.now(), binary: isBinary };
      if (isBinary) r.data = Buffer.from(data);
      else {
        r.text = data.toString('utf8');
        try {
          r.json = JSON.parse(r.text) as Record<string, unknown>;
        } catch {
          // leave json undefined
        }
      }
      received.push(r);
      for (const l of [...listeners]) l();
    });
    ws.on('close', (code, reason) => {
      resolveClosed({ code, reason: reason.toString() });
      for (const l of [...listeners]) l();
    });
    ws.once('unexpected-response', (_req, res: http.IncomingMessage) => {
      const err = new Error(`HTTP ${res.statusCode}`) as Error & { status?: number };
      err.status = res.statusCode;
      res.resume();
      reject(err);
    });
    ws.once('error', (err) => reject(err));
    ws.once('open', () => {
      const client: TestClient = {
        ws,
        received,
        closed,
        sendJson: (obj) => ws.send(JSON.stringify(obj)),
        sendText: (text) => ws.send(text),
        sendBinary: (buf) => ws.send(buf, { binary: true }),
        waitFor(pred, timeoutMs = 5_000, startIndex = 0) {
          return new Promise((res, rej) => {
            const check = (): boolean => {
              for (let i = startIndex; i < received.length; i++) {
                if (pred(received[i]!)) {
                  res(received[i]!);
                  return true;
                }
              }
              return false;
            };
            if (check()) return;
            const listener = (): void => {
              if (check()) {
                listeners.delete(listener);
                clearTimeout(timer);
              } else if (ws.readyState === WebSocket.CLOSED) {
                listeners.delete(listener);
                clearTimeout(timer);
                rej(new Error('socket closed while waiting'));
              }
            };
            const timer = setTimeout(() => {
              listeners.delete(listener);
              rej(new Error(`timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            listeners.add(listener);
          });
        },
        async hello() {
          ws.send(DEVICE_HELLO);
          const r = await client.waitFor((m) => m.json?.['type'] === 'hello');
          return r.json!;
        },
        hangUp: () => ws.terminate(),
      };
      resolve(client);
    });
  });
}

export function httpRequest(
  url: string,
  method: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function seqPacket(seq: number, size = 24): Buffer {
  const b = Buffer.alloc(size, 0x11);
  b.writeUInt32BE(seq, 0);
  return b;
}

export function isTts(r: Received, state: string): boolean {
  return r.json?.['type'] === 'tts' && r.json?.['state'] === state;
}
