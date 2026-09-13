import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TEST_TOKEN, type TestServer, connect, deviceHeaders, startServer } from './helpers.js';

async function expectStatus(p: Promise<unknown>, status: number): Promise<void> {
  await assert.rejects(p, (err: Error & { status?: number }) => {
    assert.equal(err.status, status);
    return true;
  });
}

describe('WebSocket auth', () => {
  let s: TestServer;
  before(async () => {
    s = await startServer();
  });
  after(async () => {
    await s.close();
  });

  test('missing Authorization is rejected with 401', async () => {
    await expectStatus(connect(s.wsUrl, deviceHeaders(null)), 401);
  });

  test('wrong token is rejected with 401', async () => {
    await expectStatus(connect(s.wsUrl, deviceHeaders('wrong-token')), 401);
  });

  test('a token of the right length but different content is rejected', async () => {
    const same = 'x'.repeat(TEST_TOKEN.length);
    await expectStatus(connect(s.wsUrl, deviceHeaders(same)), 401);
  });

  test('the raw token without the Bearer prefix is rejected', async () => {
    const h = deviceHeaders(null);
    h['Authorization'] = TEST_TOKEN;
    await expectStatus(connect(s.wsUrl, h), 401);
  });

  test('an unknown path is rejected with 404 even with a valid token', async () => {
    await expectStatus(connect(s.wsUrl.replace('/ws', '/other')), 404);
  });

  test('the correct Bearer token connects (101) without a subprotocol', async () => {
    const c = await connect(s.wsUrl);
    assert.equal(c.ws.protocol, '');
    c.hangUp();
  });

  test('Host without a port, as the firmware sends it, is accepted', async () => {
    const h = deviceHeaders();
    h['Host'] = '127.0.0.1';
    const c = await connect(s.wsUrl, h);
    const hello = await c.hello();
    assert.equal(hello['transport'], 'websocket');
    c.hangUp();
  });
});
