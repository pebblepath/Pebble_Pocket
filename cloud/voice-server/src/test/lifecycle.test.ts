import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { describe, test } from 'node:test';
import { connect, httpRequest, isTts, seqPacket, sleep, startServer } from './helpers.js';

describe('connection lifecycle', () => {
  test('abort, listen start, audio and listen stop in one write: old tts stop comes before the new tts start', async () => {
    const s = await startServer({ playback: { ttsStartLeadMs: 20 } });
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      const begin = c.received.length;
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
      for (let i = 0; i < 60; i++) c.sendBinary(seqPacket(i));
      c.sendText('{"session_id":"","type":"listen","state":"stop"}');
      await c.waitFor((m) => m.binary && m.data!.readUInt32BE(0) === 6, 5_000, begin);

      // One corked write, so the server reads all of it at once and ws emits the
      // messages synchronously (node_modules/ws/lib/receiver.js:605-607, :632-634).
      const socket = (c.ws as unknown as { _socket: Socket })._socket;
      socket.cork();
      c.sendText('{"session_id":"","type":"abort"}');
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
      for (let i = 0; i < 30; i++) c.sendBinary(seqPacket(1000 + i));
      c.sendText('{"session_id":"","type":"listen","state":"stop"}');
      socket.uncork();

      await c.waitFor(() => c.received.slice(begin).filter((m) => isTts(m, 'stop')).length >= 2, 10_000, begin);
      await sleep(150);
      const turn = c.received.slice(begin);
      const states = turn.filter((m) => m.json?.['type'] === 'tts').map((m) => String(m.json!['state']));
      assert.deepEqual(states, ['start', 'sentence_start', 'stop', 'start', 'sentence_start', 'stop']);

      const secondStart = turn.findIndex((m, i) => isTts(m, 'start') && i > 0);
      const firstStop = turn.findIndex((m) => isTts(m, 'stop'));
      const seq = (m: (typeof turn)[number]): number => m.data!.readUInt32BE(0);
      assert.ok(firstStop < secondStart);
      assert.ok(turn.slice(firstStop).filter((m) => m.binary).every((m) => seq(m) >= 1000), 'no old audio after the old stop');
      assert.deepEqual(
        turn.slice(secondStart).filter((m) => m.binary).map(seq),
        [...Array(30).keys()].map((i) => 1000 + i),
        'the new reply plays in full between its start and stop',
      );

      // Manual mode is back to ready: a further turn works on the same socket.
      const third = c.received.length;
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
      c.sendBinary(seqPacket(2000));
      c.sendText('{"session_id":"","type":"listen","state":"stop"}');
      await c.waitFor((m) => isTts(m, 'stop'), 5_000, third);
      c.hangUp();
    } finally {
      await s.close();
    }
  });

  test('an aborted reply whose responder ignores the signal still ends promptly with tts stop', async () => {
    const s = await startServer(
      { playback: { ttsStartLeadMs: 0 } },
      {
        responderFactory: () => ({
          name: 'stubborn',
          downlinkFormat: (uplink) => ({ ...uplink }),
          async *respond() {
            yield { kind: 'sentence', text: 'thinking' };
            yield { kind: 'audio', packet: seqPacket(1) };
            await sleep(3_000); // ignores the abort signal, like an STT call that does not take one
            yield { kind: 'audio', packet: seqPacket(2) };
          },
        }),
      },
    );
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
      c.sendBinary(seqPacket(0));
      c.sendText('{"session_id":"","type":"listen","state":"stop"}');
      await c.waitFor((m) => m.binary, 3_000);
      const abortedAt = Date.now();
      c.sendText('{"session_id":"","type":"abort"}');
      await c.waitFor((m) => isTts(m, 'stop'), 1_000);
      assert.ok(Date.now() - abortedAt < 500, 'tts stop is not held up by the responder');
      c.hangUp();
    } finally {
      await s.close();
    }
  });

  test('a device hang-up (TCP close, no close frame) mid-playback is handled and the server stays up', async () => {
    const s = await startServer();
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
      for (let i = 0; i < 50; i++) c.sendBinary(seqPacket(i));
      c.sendText('{"session_id":"","type":"listen","state":"stop"}');
      await c.waitFor((m) => isTts(m, 'start'), 3_000);
      c.hangUp();
      await sleep(300);
      assert.equal(s.server.sessionCount, 0);
      const again = await connect(s.wsUrl);
      assert.equal((await again.hello())['transport'], 'websocket');
      again.hangUp();
    } finally {
      await s.close();
    }
  });

  test('graceful shutdown sends a close frame (1001) to open sessions and refuses new upgrades', async () => {
    const s = await startServer();
    const c = await connect(s.wsUrl);
    await c.hello();
    const closing = s.server.close(2_000);
    const { code } = await c.closed;
    assert.equal(code, 1001);
    await closing;
    await assert.rejects(httpRequest(s.otaUrl, 'GET'));
  });

  test('idle connections are closed after IDLE_TIMEOUT_MS', async () => {
    const s = await startServer({ idleTimeoutMs: 1_000 });
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      const started = Date.now();
      const { code } = await c.closed;
      assert.equal(code, 1000);
      assert.ok(Date.now() - started >= 800);
    } finally {
      await s.close();
    }
  });
});
