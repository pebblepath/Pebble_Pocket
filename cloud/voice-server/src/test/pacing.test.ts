import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import type { AudioParams } from '../protocol/messages.js';
import type { ReplyEvent, TurnResponder, UserTurn } from '../pipeline/types.js';
import { connect, isTts, seqPacket, startServer } from './helpers.js';

const FRAME_MS = 60;

/**
 * The fake device's decode-queue model (src/tools/fake-device-lib.ts:300-310 and
 * :333-335), after main/audio/audio_service.h:43 and audio_service.cc:609-620:
 * 20 packets, one played per frame duration, overflow dropped.
 */
function decodeQueueDrops(arrivals: number[], frameMs = FRAME_MS, capacity = 20): number {
  let queue = 0;
  let tick = 0;
  let drops = 0;
  for (const t of arrivals) {
    if (queue === 0) tick = t;
    else {
      const n = Math.floor((t - tick) / frameMs);
      if (n > 0) {
        queue = Math.max(0, queue - n);
        tick += n * frameMs;
      }
    }
    if (queue >= capacity) drops++;
    else queue++;
  }
  return drops;
}

/** A responder whose second sentence arrives long after the first finished playing. */
class StallingResponder implements TurnResponder {
  readonly name = 'stalling';
  constructor(
    private readonly first: number,
    private readonly stallMs: number,
    private readonly second: number,
  ) {}

  downlinkFormat(uplink: AudioParams): AudioParams {
    return { ...uplink };
  }

  async *respond(_turn: UserTurn, _downlink: AudioParams, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    yield { kind: 'sentence', text: 'one' };
    for (let i = 0; i < this.first; i++) yield { kind: 'audio', packet: seqPacket(i) };
    await delay(this.stallMs, undefined, { signal });
    yield { kind: 'sentence', text: 'two' };
    for (let i = 0; i < this.second; i++) yield { kind: 'audio', packet: seqPacket(100 + i) };
  }
}

describe('reply pacing', () => {
  test('a responder that stalls between sentences gets a fresh prebuffer, not a burst the device would drop', async () => {
    const first = 6;
    const second = 30;
    const stallMs = 2_000;
    const s = await startServer(
      { playback: { ttsStartLeadMs: 0, prebufferFrames: 3 } },
      { responderFactory: () => new StallingResponder(first, stallMs, second) },
    );
    try {
      const c = await connect(s.wsUrl);
      await c.hello();
      c.sendText('{"session_id":"","type":"listen","state":"start","mode":"manual"}');
      c.sendBinary(seqPacket(0));
      c.sendText('{"session_id":"","type":"listen","state":"stop"}');
      const stop = await c.waitFor((m) => isTts(m, 'stop'), 15_000);

      const frames = c.received.filter((r) => r.binary && r.t <= stop.t);
      assert.deepEqual(
        frames.map((f) => f.data!.readUInt32BE(0)),
        [...[...Array(first).keys()], ...[...Array(second).keys()].map((i) => 100 + i)],
        'every frame arrives, in order, before tts stop',
      );

      const drops = decodeQueueDrops(frames.map((f) => f.t));
      assert.equal(drops, 0, 'a 20-packet decode queue must not overflow');

      const secondStart = frames[first]!.t;
      const burst = frames.slice(first).filter((f) => f.t - secondStart < FRAME_MS / 2).length;
      assert.ok(burst <= 3 + 2, `after the stall only a prebuffer goes out at once (got ${burst} frames)`);
      const span = frames[frames.length - 1]!.t - secondStart;
      assert.ok(span >= (second - 1 - 3) * FRAME_MS - 100, `second sentence is paced in real time (span ${span} ms)`);
      c.hangUp();
    } finally {
      await s.close();
    }
  });
});
