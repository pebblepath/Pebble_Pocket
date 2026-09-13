import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TEST_TOKEN, type TestServer, httpRequest, startServer } from './helpers.js';

describe('OTA endpoint', () => {
  let s: TestServer;
  before(async () => {
    s = await startServer();
  });
  after(async () => {
    await s.close();
  });

  const deviceHeaders = {
    'Activation-Version': '1',
    'Device-Id': 'aa:bb:cc:dd:ee:ff',
    'Client-Id': '11111111-2222-4333-8444-555555555555',
    'User-Agent': 'pebble-pocket/2.5.0',
    'Accept-Language': 'en-US',
    'Content-Type': 'application/json',
  };

  test('POST /ota/ returns exactly 200 with websocket url, token and numeric version only', async () => {
    const res = await httpRequest(s.otaUrl, 'POST', JSON.stringify({ version: 2, board: { name: 'pebble-pocket' } }), deviceHeaders);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    const ws = body['websocket'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(ws).sort(), ['token', 'url', 'version']);
    for (const k of Object.keys(ws)) assert.ok(k.length <= 15, `NVS key ${k} too long`);
    assert.equal(ws['url'], `ws://localhost:${s.port}/ws`);
    assert.equal(ws['token'], TEST_TOKEN);
    assert.equal(typeof ws['version'], 'number');
    assert.equal(ws['version'], 1);
    assert.equal('mqtt' in body, false);
    assert.equal('activation' in body, false);
    assert.equal('firmware' in body, false);
    const st = body['server_time'] as Record<string, unknown>;
    assert.equal(typeof st['timestamp'], 'number');
    assert.equal('timezone_offset' in st, false, 'no offset unless TIMEZONE_OFFSET_MINUTES is set');
  });

  test('TIMEZONE_OFFSET_MINUTES is sent as server_time.timezone_offset', async () => {
    const tz = await startServer({ timezoneOffsetMinutes: -300 });
    try {
      const before = Date.now();
      const res = await httpRequest(tz.otaUrl, 'POST', '{}', deviceHeaders);
      const st = (JSON.parse(res.body) as { server_time: { timestamp: number; timezone_offset: number } }).server_time;
      assert.equal(st.timezone_offset, -300);
      assert.ok(Math.abs(st.timestamp - before) < 5_000, 'timestamp stays true UTC milliseconds');
      // The firmware's own arithmetic (main/ota.cc:204-206): the clock is shifted 5 hours back.
      const deviceEpochMs = st.timestamp + st.timezone_offset * 60 * 1000;
      assert.equal(st.timestamp - deviceEpochMs, 5 * 3_600_000);
    } finally {
      await tz.close();
    }
  });

  test('GET and the no-slash path also return 200 without redirects', async () => {
    const get = await httpRequest(s.otaUrl, 'GET');
    assert.equal(get.status, 200);
    const noSlash = await httpRequest(`http://127.0.0.1:${s.port}/ota`, 'POST', '{}', deviceHeaders);
    assert.equal(noSlash.status, 200);
    assert.equal(noSlash.headers.location, undefined);
  });

  test('a non-JSON body still gets the config', async () => {
    const res = await httpRequest(s.otaUrl, 'POST', 'not json', deviceHeaders);
    assert.equal(res.status, 200);
    assert.ok((JSON.parse(res.body) as Record<string, unknown>)['websocket']);
  });

  test('PUBLIC_WS_URL is returned verbatim when configured', async () => {
    const custom = await startServer({ publicWsUrl: 'ws://192.168.1.50:8000/pocket', wsPath: '/pocket', protocolVersion: 3 });
    try {
      const res = await httpRequest(custom.otaUrl, 'POST', '{}', deviceHeaders);
      const ws = (JSON.parse(res.body) as { websocket: Record<string, unknown> }).websocket;
      assert.equal(ws['url'], 'ws://192.168.1.50:8000/pocket');
      assert.equal(ws['version'], 3);
    } finally {
      await custom.close();
    }
  });

  test('health check and unknown paths', async () => {
    assert.equal((await httpRequest(`http://127.0.0.1:${s.port}/health`, 'GET')).status, 200);
    // Cloud Run reserves some paths ending in "z", so the old name is gone.
    assert.equal((await httpRequest(`http://127.0.0.1:${s.port}/healthz`, 'GET')).status, 404);
    assert.equal((await httpRequest(`http://127.0.0.1:${s.port}/nope`, 'GET')).status, 404);
    assert.equal((await httpRequest(s.otaUrl, 'PUT', '{}')).status, 405);
  });
});
