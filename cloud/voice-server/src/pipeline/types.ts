/**
 * The seam between the WebSocket protocol layer and whatever produces a reply.
 *
 * The session (src/session.ts) owns everything wire-related: framing, the
 * hello, `tts start` / `sentence_start` / `tts stop`, the lead gap and
 * real-time pacing. A TurnResponder only turns one user turn into a stream of
 * ReplyEvents. Today the only responder is EchoResponder. The planned cloud
 * pipeline plugs Speech-to-Text (Google Chirp 3), a conversation model
 * (Claude with the Pebble prompt) and Text-to-Speech (Google Chirp 3 HD) into
 * PipelineResponder through the three provider interfaces below. None of those
 * providers is implemented here.
 */

import type { AudioParams, ListenMode } from '../protocol/messages.js';

/** One Opus packet at a known format. */
export type OpusPacket = Buffer;

export type TurnEndReason =
  | 'listen_stop' // manual (or any) mode: the device sent listen stop
  | 'silence' // realtime/auto: trailing-silence heuristic fired
  | 'window' // realtime/auto: fixed window or longest-turn limit reached
  | 'buffer_cap'; // the hard buffer cap was reached

export interface UserTurn {
  sessionId: string;
  deviceId: string;
  mode: ListenMode;
  /** Format of `packets` (the device uplink format). */
  inputFormat: AudioParams;
  /** Uplink Opus packets in arrival order. */
  packets: OpusPacket[];
  endReason: TurnEndReason;
  /** True when audio was dropped because a buffer cap was hit. */
  truncated: boolean;
}

/**
 * What a responder emits. The session maps these to the wire:
 * - transcript -> {"type":"stt","text":...} (display only, sent before tts start)
 * - emotion -> {"type":"llm","emotion":...} (display only)
 * - sentence -> {"type":"tts","state":"sentence_start","text":...}, before that sentence's audio
 * - audio -> one binary frame, paced in real time at the announced frame duration
 * The session sends tts start before the first sentence or audio event, and
 * tts stop after the stream ends (or is aborted).
 */
export type ReplyEvent =
  | { kind: 'transcript'; text: string }
  | { kind: 'emotion'; emotion: string }
  | { kind: 'sentence'; text: string }
  | { kind: 'audio'; packet: OpusPacket };

export interface TurnResponder {
  readonly name: string;
  /**
   * The downlink format for a session, announced in the server hello before
   * any turn. Every audio packet the responder emits must match it exactly
   * (sample rate and frame duration), PROTOCOL.md section 7.
   */
  downlinkFormat(uplink: AudioParams): AudioParams;
  /** Produce the reply. Must stop promptly when `signal` aborts. */
  respond(turn: UserTurn, downlink: AudioParams, signal: AbortSignal): AsyncIterable<ReplyEvent>;
}

// ---------------------------------------------------------------------------
// Provider interfaces for the later cloud pipeline. Not implemented here.
// ---------------------------------------------------------------------------

export type LanguageCode = 'en-US' | 'fr-FR';

export interface Transcript {
  text: string;
  /** Detected language, when the provider reports one. */
  language: LanguageCode | undefined;
}

/** Speech-to-Text, planned: Google Cloud Speech-to-Text v2, Chirp 3. */
export interface SpeechToText {
  transcribe(packets: OpusPacket[], format: AudioParams, signal: AbortSignal): Promise<Transcript>;
}

export interface ConversationInput {
  deviceId: string;
  transcript: Transcript;
}

/** Conversation model, planned: Claude with the Pebble system prompt. Yields whole sentences. */
export interface ConversationModel {
  reply(input: ConversationInput, signal: AbortSignal): AsyncIterable<string>;
}

export interface SpeechRequest {
  text: string;
  language: LanguageCode | undefined;
}

/**
 * Text-to-Speech, planned: Google Cloud Text-to-Speech, Chirp 3 HD.
 * Must yield raw Opus packets at exactly `format` (the device plays at
 * 24 kHz, main/boards/waveshare/esp32-s3-touch-amoled-2.06/config.h:7), one
 * packet per frame duration, not an Ogg container.
 */
export interface TextToSpeech {
  synthesize(request: SpeechRequest, format: AudioParams, signal: AbortSignal): AsyncIterable<OpusPacket>;
}
