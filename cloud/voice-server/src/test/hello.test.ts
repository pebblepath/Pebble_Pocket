import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isSafeSessionId } from '../protocol/messages.js';
import { type TestServer, connect, sleep, startServer } from './helpers.js';

describe('hello exchange', () => {
  let s: TestServer;
  before(async () => {
    s = await startServer();
  });
  after(async () => {
    await s.close();
  });

  test('server hello has transport websocket, a safe session_id and full audio_params', async () => {
    const c = await connect(s.wsUrl);
    const started = Date.now();
    const hello = await c.hello();
    assert.ok(Date.now() - started < 10_000, 'must arrive within the 10 s device timeout');
    assert.equal(hello['type'], 'hello');
    assert.equal(hello['transport'], 'websocket');
    assert.equal(typeof hello['session_id'], 'string');
    assert.ok(isSafeSessionId(hello['session_id'] as string));
    assert.doesNotMatch(hello['session_id'] as string, /["\\]/);
    const ap = hello['audio_params'] as Record<string, unknown>;
    assert.equal(ap['format'], 'opus');
    assert.equal(ap['channels'], 1);
    // Echo replays uplink packets unchanged, so it announces the uplink format.
    assert.equal(ap['sample_rate'], 16000);
    assert.equal(ap['frame_duration'], 60);
    c.hangUp();
  });

  test('each connection gets a new session id', async () => {
    const a = await connect(s.wsUrl);
    const b = await connect(s.wsUrl);
    const [ha, hb] = [await a.hello(), await b.hello()];
    assert.notEqual(ha['session_id'], hb['session_id']);
    a.hangUp();
    b.hangUp();
  });

  test('a device hello with the wrong transport gets no reply', async () => {
    const c = await connect(s.wsUrl);
    c.sendJson({ type: 'hello', version: 1, transport: 'mqtt', audio_params: { format: 'opus' } });
    await sleep(250);
    assert.equal(c.received.length, 0);
    const hello = await c.hello(); // a valid hello afterwards still works
    assert.equal(hello['transport'], 'websocket');
    c.hangUp();
  });

  test('a second hello on the same connection is not answered', async () => {
    const c = await connect(s.wsUrl);
    await c.hello();
    const count = c.received.length;
    c.sendText('{"type":"hello","version":1,"transport":"websocket"}');
    await sleep(250);
    assert.equal(c.received.length, count);
    c.hangUp();
  });

  test('ECHO_DOWNLINK_SAMPLE_RATE overrides the announced rate', async () => {
    const custom = await startServer({ echo: { downlinkSampleRate: 24000 } });
    try {
      const c = await connect(custom.wsUrl);
      const hello = await c.hello();
      assert.equal((hello['audio_params'] as Record<string, unknown>)['sample_rate'], 24000);
      c.hangUp();
    } finally {
      await custom.close();
    }
  });

  test('a connection that never sends hello is closed after the hello timeout', async () => {
    const custom = await startServer({ helloTimeoutMs: 200 });
    try {
      const c = await connect(custom.wsUrl);
      const { code } = await c.closed;
      assert.equal(code, 1002);
    } finally {
      await custom.close();
    }
  });
});
