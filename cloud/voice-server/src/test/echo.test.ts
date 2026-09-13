import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeAudioFrame, encodeAudioFrame } from '../protocol/binary.js';
import { runFakeDevice } from '../tools/fake-device-lib.js';
import { TEST_TOKEN, type Received, connect, deviceHeaders, isTts, seqPacket, sleep, startServer } from './helpers.js';

function audioSeqs(received: Received[], version: 1 | 2 | 3 = 1): number[] {
  return received
    .filter((r) => r.binary)
    .map((r) => {
      const d = decodeAudioFrame(r.data!, version);
      assert.ok(d.ok, 'downlink frame must decode');
      return d.audio.payload.readUInt32BE(0);
    });
}

async function manualTurn(
  wsUrl: string,
  frames: number,
  opts: { version?: 1 | 2 | 3; paceMs?: number } = {},
): Promise<{ received: Received[]; sessionId: string }> {
  const version = opts.version ?? 1;
  const c = await connect(wsUrl, deviceHeaders(TEST_TOKEN, version));
  c.sendText(
    `{"type":"hello","version":${version},"features":{"mcp":true,"glyph_push":false},"transport":"websocket",` +
      '"audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}',
  );
  const h = (await c.waitFor((m) => m.json?.['type'] === 'hello')).json!;
  const sessionId = h['session_id'] as string;
  const start = c.received.length;
  c.sendText(`{"session_id":"${sessionId}","type":"listen","state":"start","mode":"manual"}`);
  for (let i = 0; i < frames; i++) {
    c.sendBinary(encodeAudioFrame(seqPacket(i), version));
    if (opts.paceMs) await sleep(opts.paceMs);
  }
  c.sendText(`{"session_id":"${sessionId}","type":"listen","state":"stop"}`);
  await c.waitFor((m) => isTts(m, 'stop'), 15_000, start);
  await sleep(100); // anything after tts stop would show up here
  const received = c.received.slice(start);
  c.hangUp();
  return { received, sessionId };
}

describe('echo mode', () => {
  test('manual turn: tts start, sentence_start "(echo)", frames in order, tts stop', async () => {
    const s = await startServer();
    try {
      const { received, sessionId } = await manualTurn(s.wsUrl, 12);
      const kinds = received.map((r) => (r.binary ? 'audio' : `${r.json?.['type']}:${r.json?.['state']}`));
      const firstAudio = kinds.indexOf('audio');
      const lastAudio = kinds.lastIndexOf('audio');
      assert.equal(kinds[0], 'tts:start', `first message must be tts start, got ${kinds.join(',')}`);
      assert.ok(firstAudio > 0, 'audio after tts start');
      assert.equal(kinds.indexOf('tts:sentence_start') < firstAudio, true, 'sentence_start before audio');
      assert.equal(received.find((r) => isTts(r, 'sentence_start'))!.json!['text'], '(echo)');
      assert.equal(kinds[kinds.length - 1], 'tts:stop');
      assert.ok(lastAudio < kinds.length - 1, 'tts stop after the last frame');
      assert.deepEqual(audioSeqs(received), [...Array(12).keys()]);
      for (const r of received.filter((x) => !x.binary)) assert.equal(r.json!['session_id'], sessionId);

      // Lead gap between tts start and the first frame (PROTOCOL.md section 6, rule 2).
      const gap = received[firstAudio]!.t - received[0]!.t;
      assert.ok(gap >= 90, `lead gap ${gap} ms should be about 100 ms`);
      // Real-time pacing: 12 frames, 3 prebuffered, so the span is about (12 - 1 - 3) * 60 = 480 ms.
      const span = received[lastAudio]!.t - received[firstAudio]!.t;
      assert.ok(span >= 400, `playback span ${span} ms is too short for real-time pacing`);
      assert.ok(span < 1_500, `playback span ${span} ms is too long`);
    } finally {
      await s.close();
    }
  });

  test('frames are paced one per frame duration after the prebuffer', async () => {
    const s = await startServer({ playback: { prebufferFrames: 0, ttsStartLeadMs: 0 } });
    try {
      const { received } = await manualTurn(s.wsUrl, 6);
      const times = received.filter((r) => r.binary).map((r) => r.t);
      for (let i = 1; i < times.length; i++) {
        const d = times[i]! - times[i - 1]!;
        assert.ok(d >= 40 && d <= 120, `inter-frame gap ${d} ms not near 60 ms`);
      }
    } finally {
      await s.close();
    }
  });

  test('buffer cap: only the first ECHO_MAX_BUFFER_MS of audio is replayed', async () => {
    const s = await startServer({ echo: { maxBufferMs: 300 } }); // 5 frames of 60 ms
    try {
      const { received } = await manualTurn(s.wsUrl, 25);
      assert.deepEqual(audioSeqs(received), [0, 1, 2, 3, 4]);
    } finally {
      await s.close();
    }
  });

  test('byte cap also bounds the buffer', async () => {
    const s = await startServer({ echo: { maxBufferBytes: 1024 } }); // 1024 / 200 = 5 frames
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
      for (let i = 0; i < 20; i++) c.sendBinary(seqPacket(i, 200));
      c.sendText('{"session_id":"","type":"listen","state":"stop"}');
      await c.waitFor((m) => isTts(m, 'stop'), 10_000);
      assert.deepEqual(audioSeqs(c.received), [0, 1, 2, 3, 4]);
      c.hangUp();
    } finally {
      await s.close();
    }
  });

  for (const version of [2, 3] as const) {
    test(`binary protocol v${version}: headers are parsed on the way in and written on the way out`, async () => {
      const s = await startServer({ protocolVersion: version });
      try {
        const { received } = await manualTurn(s.wsUrl, 5, { version });
        const frames = received.filter((r) => r.binary);
        assert.equal(frames.length, 5);
        for (const f of frames) {
          if (version === 2) {
            assert.equal(f.data!.readUInt16BE(0), 2);
            assert.equal(f.data!.readUInt32BE(12), f.data!.length - 16);
          } else {
            assert.equal(f.data!.readUInt16BE(2), f.data!.length - 4);
          }
        }
        assert.deepEqual(audioSeqs(received, version), [0, 1, 2, 3, 4]);
      } finally {
        await s.close();
      }
    });
  }

  test('listen stop with no audio produces no tts at all', async () => {
    const s = await startServer();
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      const start = c.received.length;
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
      c.sendText('{"session_id":"","type":"listen","state":"stop"}');
      await sleep(300);
      assert.equal(c.received.length, start);
      c.hangUp();
    } finally {
      await s.close();
    }
  });

  test('abort during playback stops audio and still sends tts stop', async () => {
    const s = await startServer();
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
      for (let i = 0; i < 100; i++) c.sendBinary(seqPacket(i));
      c.sendText('{"session_id":"","type":"listen","state":"stop"}');
      await c.waitFor((m) => m.binary && m.data!.readUInt32BE(0) === 5, 5_000);
      c.sendText('{"session_id":"","type":"abort"}');
      const stop = await c.waitFor((m) => isTts(m, 'stop'), 2_000);
      const framesBeforeStop = c.received.filter((r) => r.binary && r.t <= stop.t).length;
      assert.ok(framesBeforeStop < 100, `abort should cut playback short (${framesBeforeStop} frames)`);
      await sleep(200);
      assert.equal(c.received.filter((r) => r.binary).length, framesBeforeStop, 'no audio after tts stop');
      c.hangUp();
    } finally {
      await s.close();
    }
  });

  test('two manual turns on one socket, the second press sends only listen start', async () => {
    const s = await startServer({ playback: { ttsStartLeadMs: 20 } });
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      for (const base of [0, 100]) {
        const start = c.received.length;
        c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
        for (let i = 0; i < 4; i++) c.sendBinary(seqPacket(base + i));
        c.sendText('{"session_id":"","type":"listen","state":"stop"}');
        await c.waitFor((m) => isTts(m, 'stop'), 5_000, start);
        assert.deepEqual(audioSeqs(c.received.slice(start)), [base, base + 1, base + 2, base + 3]);
      }
      c.hangUp();
    } finally {
      await s.close();
    }
  });

  test('realtime: turn ends on trailing silence without listen stop, echo ignores mic during playback', async () => {
    const s = await startServer({ endpoint: { silenceMs: 300, minSpeechMs: 120, guardMs: 200 } });
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"realtime"}');
      const silence = (): Buffer => Buffer.from([0x01, 0x02]);
      for (let i = 0; i < 4; i++) c.sendBinary(silence());
      for (let i = 0; i < 8; i++) c.sendBinary(seqPacket(i, 40));
      let streaming = true;
      const pump = (async () => {
        while (streaming) {
          c.sendBinary(silence()); // realtime keeps streaming, including while speaking
          await sleep(20);
        }
      })();
      await c.waitFor((m) => isTts(m, 'stop'), 8_000);
      streaming = false;
      await pump;
      const payloads = c.received.filter((r) => r.binary).map((r) => r.data!);
      const speech = payloads.filter((p) => p.length === 40).map((p) => p.readUInt32BE(0));
      assert.deepEqual(speech, [0, 1, 2, 3, 4, 5, 6, 7]);
      // 2 frames of pre-roll and at most 2 of trailing silence are kept.
      assert.ok(payloads.length <= 12, `echo should be trimmed, got ${payloads.length} frames`);
      assert.ok(c.received.findIndex((r) => isTts(r, 'start')) < c.received.findIndex((r) => r.binary));
      c.hangUp();
    } finally {
      await s.close();
    }
  });

  test('realtime window mode ends a turn after ENDPOINT_WINDOW_MS of audio', async () => {
    const s = await startServer({ endpoint: { mode: 'window', windowMs: 300 } });
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"realtime"}');
      for (let i = 0; i < 12; i++) c.sendBinary(seqPacket(i));
      await c.waitFor((m) => isTts(m, 'stop'), 5_000);
      assert.deepEqual(audioSeqs(c.received), [0, 1, 2, 3, 4]);
      c.hangUp();
    } finally {
      await s.close();
    }
  });

  test('fake device end to end, manual mode, v1', async () => {
    const s = await startServer();
    try {
      const report = await runFakeDevice({ otaUrl: s.otaUrl, frames: 15, paceMs: 10, log: () => {} });
      assert.equal(report.ok, true, report.problems.join('; '));
      assert.equal(report.turns[0]!.echoedSpeechFrames, 15);
    } finally {
      await s.close();
    }
  });

  test('fake device reports a truncated echo and a server close as failures', async () => {
    const capped = await startServer({ echo: { maxBufferMs: 300 } });
    try {
      const report = await runFakeDevice({ otaUrl: capped.otaUrl, frames: 10, paceMs: 0, log: () => {} });
      assert.equal(report.ok, false);
      assert.match(report.problems.join('; '), /only 5 of 10 speech frames echoed/);
    } finally {
      await capped.close();
    }
    const s = await startServer();
    const run = runFakeDevice({ otaUrl: s.otaUrl, frames: 100, paceMs: 0, log: () => {} });
    await sleep(400);
    await s.close();
    const report = await run;
    assert.equal(report.ok, false);
    assert.match(report.problems.join('; '), /server closed the connection during the turn \(code 1001\)/);
  });

  test('fake device end to end, realtime mode, two turns', async () => {
    const s = await startServer({ publicWsUrl: undefined });
    try {
      const report = await runFakeDevice({ otaUrl: s.otaUrl, mode: 'realtime', frames: 8, turns: 2, log: () => {} });
      assert.equal(report.ok, true, report.problems.join('; '));
      assert.equal(report.turns.length, 2);
      for (const t of report.turns) assert.equal(t.echoedSpeechFrames, 8);
    } finally {
      await s.close();
    }
  });
});
