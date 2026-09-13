import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, test } from 'node:test';
import { TEST_TOKEN, connect, deviceHeaders, httpRequest, isTts, seqPacket, sleep, startServer } from './helpers.js';

/** Sends raw bytes and returns whatever comes back before the server closes (or 3 s pass). */
function rawHttp(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    const done = (): void => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('latin1'));
    };
    const timer = setTimeout(() => {
      sock.destroy();
      done();
    }, 3_000);
    sock.on('data', (d: Buffer) => chunks.push(d));
    sock.on('end', done);
    sock.on('close', done);
    sock.on('error', (err) => {
      clearTimeout(timer);
      if (chunks.length > 0) done();
      else reject(err);
    });
    sock.write(request);
  });
}

describe('malformed HTTP request targets', () => {
  // Both targets made `new URL(req.url, base)` throw and crashed the process.
  const targets = ['http://999.999.999.999/', '//['];

  for (const target of targets) {
    test(`plain request to "${target}" gets 400 and the server keeps running`, async () => {
      const s = await startServer();
      try {
        const res = await rawHttp(s.port, `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
        assert.match(res, /^HTTP\/1\.1 400 /);
        assert.equal((await httpRequest(`http://127.0.0.1:${s.port}/health`, 'GET')).status, 200);
      } finally {
        await s.close();
      }
    });

    test(`WebSocket upgrade to "${target}" gets 400 and the server keeps running`, async () => {
      const s = await startServer();
      try {
        const res = await rawHttp(
          s.port,
          `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            `Authorization: Bearer ${TEST_TOKEN}\r\n\r\n`,
        );
        assert.match(res, /^HTTP\/1\.1 400 /);
        assert.equal((await httpRequest(`http://127.0.0.1:${s.port}/health`, 'GET')).status, 200);
        const c = await connect(s.wsUrl);
        assert.equal((await c.hello())['transport'], 'websocket');
        c.hangUp();
      } finally {
        await s.close();
      }
    });
  }
});

describe('malformed input', () => {
  test('garbage text, bad JSON and bad fields are ignored and the session keeps working', async () => {
    const s = await startServer();
    try {
      const c = await connect(s.wsUrl);
      c.sendText('not json at all');
      c.sendText('[1,2,3]');
      c.sendText('{}');
      c.sendText('{"type":5}');
      c.sendBinary(Buffer.from([1, 2, 3])); // binary before hello
      c.sendText('{"type":"listen","state":"start","mode":"manual"}'); // before hello
      await sleep(150);
      assert.equal(c.received.length, 0, 'nothing is sent back for malformed input');

      const hello = await c.hello();
      assert.equal(hello['transport'], 'websocket');

      c.sendText('{"type":"listen","state":"bogus"}');
      c.sendText('{"type":"listen","state":"start","mode":"shouting"}');
      c.sendText('{"type":"listen"}');
      c.sendText('{"type":"somethingNew","x":1}'); // unknown types are ignored, not errors
      c.sendText('{"type":"mcp","payload":{"jsonrpc":"2.0","id":1,"result":{}}}');
      c.sendText('{"type":"listen","state":"detect","text":"hi"}');
      c.sendText('{"type":"abort"}'); // abort with nothing playing
      c.sendText('{"type":"listen","state":"stop"}'); // stop while not listening
      await sleep(150);
      const afterHello = c.received.length;
      assert.equal(afterHello, 1, 'still only the hello');

      // A normal turn still works.
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
      for (let i = 0; i < 3; i++) c.sendBinary(seqPacket(i));
      c.sendText('{"session_id":"","type":"listen","state":"stop"}');
      await c.waitFor((m) => isTts(m, 'stop'), 5_000);
      assert.equal(c.received.filter((r) => r.binary).length, 3);
      c.hangUp();
    } finally {
      await s.close();
    }
  });

  test('v2 frames shorter than the header or with an oversized payload_size are dropped', async () => {
    const s = await startServer({ protocolVersion: 2 });
    try {
      const c = await connect(s.wsUrl, deviceHeaders(TEST_TOKEN, 2));
      await c.hello();
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
      c.sendBinary(Buffer.alloc(8)); // shorter than the 16-byte header
      const lying = Buffer.alloc(20);
      lying.writeUInt16BE(2, 0);
      lying.writeUInt32BE(1000, 12); // claims 1000 bytes, has 4
      c.sendBinary(lying);
      const good = Buffer.alloc(16 + 4);
      good.writeUInt16BE(2, 0);
      good.writeUInt32BE(4, 12);
      good.writeUInt32BE(42, 16);
      c.sendBinary(good);
      c.sendText('{"session_id":"","type":"listen","state":"stop"}');
      await c.waitFor((m) => isTts(m, 'stop'), 5_000);
      const frames = c.received.filter((r) => r.binary);
      assert.equal(frames.length, 1);
      assert.equal(frames[0]!.data!.readUInt32BE(12), 4);
      assert.equal(frames[0]!.data!.readUInt32BE(16), 42);
      c.hangUp();
    } finally {
      await s.close();
    }
  });

  test('too many protocol errors close the connection with 1008', async () => {
    const s = await startServer({ maxProtocolErrors: 5 });
    try {
      const c = await connect(s.wsUrl);
      for (let i = 0; i < 6; i++) c.sendText('{nope');
      const { code } = await c.closed;
      assert.equal(code, 1008);
    } finally {
      await s.close();
    }
  });

  test('an oversized message is refused by the WebSocket layer without crashing the server', async () => {
    const s = await startServer();
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      c.sendBinary(Buffer.alloc(300 * 1024));
      const { code } = await c.closed;
      assert.equal(code, 1009);
      const again = await connect(s.wsUrl);
      assert.equal((await again.hello())['transport'], 'websocket');
      again.hangUp();
    } finally {
      await s.close();
    }
  });
});
