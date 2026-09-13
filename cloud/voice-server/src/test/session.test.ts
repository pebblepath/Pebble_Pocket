/**
 * DeviceSession driven through an in-memory socket, so state and internal
 * buffers can be checked deterministically.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { type ServerConfig, defaultConfig } from '../config.js';
import { createLogger, silentLogger, type Logger } from '../log.js';
import { EchoResponder } from '../pipeline/echo.js';
import { DeviceSession } from '../session.js';
import { DEVICE_HELLO, seqPacket, sleep } from './helpers.js';

class MemorySocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: { t: number; text?: string; binary?: Buffer }[] = [];

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    if (options?.binary) this.sent.push({ t: Date.now(), binary: Buffer.from(data) });
    else this.sent.push({ t: Date.now(), text: String(data) });
  }
  ping(): void {}
  close(code: number, reason: string): void {
    this.finish(code, reason);
  }
  terminate(): void {
    this.finish(1006, '');
  }
  private finish(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }

  text(s: string): void {
    this.emit('message', Buffer.from(s), false);
  }
  bin(b: Buffer): void {
    this.emit('message', b, true);
  }
  ttsStates(from = 0): string[] {
    return this.sent
      .slice(from)
      .filter((m) => m.text)
      .map((m) => JSON.parse(m.text!) as Record<string, unknown>)
      .filter((j) => j['type'] === 'tts')
      .map((j) => String(j['state']));
  }
}

function openSession(overrides: Partial<ServerConfig> = {}, logger: Logger = silentLogger) {
  const d = defaultConfig();
  const config: ServerConfig = { ...d, pingIntervalMs: 0, ...overrides };
  const ws = new MemorySocket();
  const session = new DeviceSession(ws as unknown as WebSocket, {
    config,
    logger,
    responder: new EchoResponder(),
    deviceId: 'aa:bb:cc:dd:ee:ff',
    clientId: 'c',
    framing: 1,
    remoteAddress: '127.0.0.1',
  });
  session.start();
  return { ws, session, internals: session as unknown as { windowSizes: number[]; windowUnsampled: number } };
}

const START_MANUAL = '{"session_id":"","type":"listen","state":"start","mode":"manual"}';
const STOP = '{"session_id":"","type":"listen","state":"stop"}';

async function waitUntil(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

describe('session internals', () => {
  test('uplink packet sizes are not accumulated outside the realtime/auto stats window', async () => {
    const { ws, session, internals } = openSession();
    try {
      ws.text(DEVICE_HELLO);
      for (let i = 0; i < 5_000; i++) ws.bin(Buffer.from([1]));
      assert.equal(session.currentState, 'ready');
      assert.equal(internals.windowSizes.length, 0, 'ready state (manual) records nothing');

      ws.text(START_MANUAL);
      for (let i = 0; i < 5_000; i++) ws.bin(Buffer.from([1]));
      assert.equal(internals.windowSizes.length, 0, 'manual listening has no stats timer, so records nothing');
      ws.text(STOP);
    } finally {
      ws.terminate();
      await session.closed;
    }
  });

  test('the realtime stats window is capped', async () => {
    const d = defaultConfig();
    const { ws, session, internals } = openSession({
      echo: { ...d.echo, maxBufferMs: 120_000 },
      endpoint: { ...d.endpoint, windowMs: 120_000 },
    });
    try {
      ws.text(DEVICE_HELLO);
      ws.text('{"session_id":"","type":"listen","state":"start","mode":"realtime"}');
      for (let i = 0; i < 1_500; i++) ws.bin(seqPacket(i, 20));
      assert.equal(session.currentState, 'listening');
      assert.equal(internals.windowSizes.length, 1_000);
      assert.equal(internals.windowUnsampled, 500);
    } finally {
      ws.terminate();
      await session.closed;
    }
  });

  test('a turn that ends while the aborted reply is unwinding: old tts stop first, state stays responding', async () => {
    const { ws, session } = openSession({ playback: { ttsStartLeadMs: 0, prebufferFrames: 3 } });
    try {
      ws.text(DEVICE_HELLO);
      ws.text(START_MANUAL);
      for (let i = 0; i < 20; i++) ws.bin(seqPacket(i));
      ws.text(STOP);
      await waitUntil(() => ws.sent.filter((m) => m.binary).length >= 5);

      const mark = ws.sent.length;
      // What ws does when these arrive in one socket read: all emitted synchronously
      // (node_modules/ws/lib/receiver.js:605-607, :632-634).
      ws.text('{"session_id":"","type":"abort"}');
      ws.text(START_MANUAL);
      for (let i = 0; i < 5; i++) ws.bin(seqPacket(1000 + i));
      ws.text(STOP);

      await sleep(50);
      assert.equal(session.currentState, 'responding', 'the superseded reply must not reset the state');
      assert.deepEqual(ws.ttsStates(mark).slice(0, 2), ['stop', 'start'], 'old stop before new start');

      await waitUntil(() => ws.ttsStates(mark).filter((st) => st === 'stop').length >= 2);
      await sleep(50);
      assert.deepEqual(ws.ttsStates(mark), ['stop', 'start', 'sentence_start', 'stop']);
      assert.equal(session.currentState, 'ready');
      const afterNewStart = ws.sent.slice(mark).findIndex((m) => m.text?.includes('"state":"start"'));
      const newFrames = ws.sent
        .slice(mark + afterNewStart)
        .filter((m) => m.binary)
        .map((m) => m.binary!.readUInt32BE(0));
      assert.deepEqual(newFrames, [1000, 1001, 1002, 1003, 1004]);
    } finally {
      ws.terminate();
      await session.closed;
    }
  });

  test('device-supplied strings are truncated in log lines', async () => {
    const lines: string[] = [];
    const logger = createLogger('debug', {}, (l) => lines.push(l));
    const { ws, session } = openSession({}, logger);
    const big = 'x'.repeat(200_000);
    try {
      ws.text(JSON.stringify({ type: 'hello', transport: big }));
      ws.text(
        JSON.stringify({
          type: 'hello',
          transport: 'websocket',
          features: { mcp: true, note: big },
          audio_params: { format: big, sample_rate: 16000, channels: 1, frame_duration: 60 },
        }),
      );
      ws.text(JSON.stringify({ type: 'listen', state: 'detect', text: big }));
      ws.text(JSON.stringify({ type: big }));
      ws.text(JSON.stringify({ type: 'abort', reason: big }));
      const largest = Math.max(...lines.map((l) => Buffer.byteLength(l)));
      assert.ok(largest < 2_000, `largest log line is ${largest} bytes`);
      for (const m of ['protocol_error', 'hello', 'hello_audio_params', 'listen_detect_ignored', 'unknown_message_type_ignored', 'abort_without_reply']) {
        assert.ok(lines.some((l) => l.includes(`"message":"${m}"`)), `expected a ${m} line`);
      }
    } finally {
      ws.terminate();
      await session.closed;
    }
  });
});
