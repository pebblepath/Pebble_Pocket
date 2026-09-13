/**
 * Composition of the three providers into a TurnResponder.
 *
 * This is the plug-in point for the cloud version: construct it with real
 * SpeechToText, ConversationModel and TextToSpeech implementations. Only fakes
 * exist today (in the tests); no provider is implemented in this repository.
 */

import type { AudioParams } from '../protocol/messages.js';
import type {
  ConversationModel,
  ReplyEvent,
  SpeechToText,
  TextToSpeech,
  TurnResponder,
  UserTurn,
} from './types.js';

/** Matches the device speaker path: 24 kHz, 60 ms (PROTOCOL.md section 7). */
export const PIPELINE_DOWNLINK: AudioParams = {
  format: 'opus',
  sampleRate: 24000,
  channels: 1,
  frameDurationMs: 60,
};

export class PipelineResponder implements TurnResponder {
  readonly name = 'pipeline';

  constructor(
    private readonly stt: SpeechToText,
    private readonly model: ConversationModel,
    private readonly tts: TextToSpeech,
    private readonly downlink: AudioParams = PIPELINE_DOWNLINK,
  ) {}

  downlinkFormat(): AudioParams {
    return this.downlink;
  }

  async *respond(turn: UserTurn, downlink: AudioParams, signal: AbortSignal): AsyncIterable<ReplyEvent> {
    if (turn.packets.length === 0) return;
    const transcript = await this.stt.transcribe(turn.packets, turn.inputFormat, signal);
    if (signal.aborted) return;
    yield { kind: 'transcript', text: transcript.text };
    if (transcript.text.trim() === '') return;
    for await (const sentence of this.model.reply({ deviceId: turn.deviceId, transcript }, signal)) {
      if (signal.aborted) return;
      yield { kind: 'sentence', text: sentence };
      for await (const packet of this.tts.synthesize(
        { text: sentence, language: transcript.language },
        downlink,
        signal,
      )) {
        if (signal.aborted) return;
        yield { kind: 'audio', packet };
      }
    }
  }
}
