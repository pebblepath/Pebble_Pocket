/**
 * Echo mode: replays the user's own Opus packets as the "TTS" reply.
 *
 * The downlink is announced at the uplink format (16 kHz, 60 ms in this build)
 * so each packet is replayed unchanged. The firmware's own audio-testing
 * loopback plays packets stamped 16000 Hz through the same decoder path
 * (main/audio/audio_service.cc:474, main/audio/audio_service.cc:409,
 * main/audio/audio_service.cc:532-566), and the device resamples to its
 * 24 kHz speaker rate. ECHO_DOWNLINK_SAMPLE_RATE can override the announced
 * rate for experiments.
 */

import type { AudioParams } from '../protocol/messages.js';
import type { ReplyEvent, TurnResponder, UserTurn } from './types.js';

export const ECHO_SENTENCE_TEXT = '(echo)';

export interface EchoOptions {
  downlinkSampleRate?: number | undefined;
}

export class EchoResponder implements TurnResponder {
  readonly name = 'echo';
  private readonly downlinkSampleRate: number | undefined;

  constructor(options: EchoOptions = {}) {
    this.downlinkSampleRate = options.downlinkSampleRate;
  }

  downlinkFormat(uplink: AudioParams): AudioParams {
    return {
      format: 'opus',
      channels: 1,
      sampleRate: this.downlinkSampleRate ?? uplink.sampleRate,
      // Packets are replayed as-is, so the duration must equal the uplink's.
      frameDurationMs: uplink.frameDurationMs,
    };
  }

  async *respond(turn: UserTurn, _downlink: AudioParams, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    if (turn.packets.length === 0) return;
    yield { kind: 'sentence', text: ECHO_SENTENCE_TEXT };
    for (const packet of turn.packets) {
      if (signal.aborted) return;
      yield { kind: 'audio', packet };
    }
  }
}
