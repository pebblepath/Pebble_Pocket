/**
 * One WebSocket connection from one device: hello, listening, turns and replies.
 *
 * Stateless beyond the connection: nothing is shared between sessions, so the
 * process can be replicated behind a load balancer later.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { ProtocolVersion, ServerConfig } from './config.js';
import { type Logger, clip, clipObject } from './log.js';
import { decodeAudioFrame, encodeAudioFrame } from './protocol/binary.js';
import {
  type AudioParams,
  type ListenMode,
  llmEmotion,
  newSessionId,
  parseDeviceMessage,
  resolveUplinkFormat,
  serverHello,
  sttMessage,
  ttsSentenceStart,
  ttsStart,
  ttsStop,
} from './protocol/messages.js';
import { TurnCollector } from './pipeline/turn.js';
import type { TurnEndReason, TurnResponder, UserTurn } from './pipeline/types.js';

export type SessionState = 'awaiting_hello' | 'ready' | 'listening' | 'responding' | 'closed';

export interface SessionContext {
  config: ServerConfig;
  logger: Logger;
  responder: TurnResponder;
  deviceId: string;
  clientId: string;
  framing: ProtocolVersion;
  remoteAddress: string;
}

interface ActiveReply {
  controller: AbortController;
  done: Promise<void>;
}

/** Close codes used by the server. The device treats any close as "back to idle". */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  policy: 1008,
} as const;

const UPLINK_STATS_INTERVAL_MS = 5_000;
/** Packet sizes kept per stats window. 5 s of 60 ms frames is 84; the cap only bounds a flooding peer. */
const MAX_STATS_SAMPLES = 1_000;
const TERMINATE_AFTER_CLOSE_MS = 1_000;

export class DeviceSession {
  readonly sessionId = newSessionId();
  private state: SessionState = 'awaiting_hello';
  private readonly log: Logger;
  private uplink: AudioParams | undefined;
  private downlink: AudioParams | undefined;
  private mode: ListenMode = 'manual';
  private collector: TurnCollector | undefined;
  private reply: ActiveReply | undefined;
  private guardUntil = 0;
  private protocolErrors = 0;
  private helloTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private statsTimer: NodeJS.Timeout | undefined;
  private awaitingPong = false;
  private closeRequested = false;
  private readonly openedAt = Date.now();
  private turnCount = 0;
  private readonly stats = { framesIn: 0, framesIgnored: 0, framesOut: 0, textIn: 0 };
  private windowSizes: number[] = [];
  private windowUnsampled = 0;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(
    private readonly ws: WebSocket,
    private readonly ctx: SessionContext,
  ) {
    this.log = ctx.logger.child({
      sessionId: this.sessionId,
      deviceId: ctx.deviceId,
    });
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get currentState(): SessionState {
    return this.state;
  }

  /** Resolves once the socket is closed and all timers are cleared. */
  get closed(): Promise<void> {
    return this.closedPromise;
  }

  start(): void {
    const { config } = this.ctx;
    this.log.info('ws_connected', {
      clientId: this.ctx.clientId,
      framing: this.ctx.framing,
      remote: this.ctx.remoteAddress,
      responder: this.ctx.responder.name,
    });
    this.ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    this.ws.on('pong', () => {
      this.awaitingPong = false;
    });
    this.ws.on('error', (err) => this.log.warn('ws_error', { error: err }));
    this.ws.on('close', (code, reason) => this.onClose(code, reason.toString('utf8')));

    this.helloTimer = setTimeout(() => {
      if (this.state === 'awaiting_hello') {
        this.log.warn('hello_timeout', { afterMs: config.helloTimeoutMs });
        this.close(CLOSE.protocolError, 'hello timeout');
      }
    }, config.helloTimeoutMs);
    this.touchIdle();

    if (config.pingIntervalMs > 0) {
      // The device answers pings inside its WebSocket layer
      // (esp-ml307/src/web_socket.cc:392-394). Pings do not refresh the
      // device's own 120 s channel timer (main/protocols/protocol.cc:108-117).
      this.pingTimer = setInterval(() => {
        if (this.ws.readyState !== WebSocket.OPEN) return;
        if (this.awaitingPong) {
          this.log.warn('ping_timeout_terminating');
          this.ws.terminate();
          return;
        }
        this.awaitingPong = true;
        this.ws.ping();
      }, config.pingIntervalMs);
    }
  }

  /**
   * Server-initiated close. Sends a close frame, then drops TCP shortly after,
   * because the device never answers a close frame (esp-ml307/src/web_socket.cc:386-391).
   */
  close(code: number, reason: string): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.reply?.controller.abort();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try {
        this.ws.close(code, reason);
      } catch {
        this.ws.terminate();
      }
      setTimeout(() => this.ws.terminate(), TERMINATE_AFTER_CLOSE_MS).unref();
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  private onMessage(data: RawData, isBinary: boolean): void {
    this.touchIdle();
    const buf = toBuffer(data);
    if (isBinary) {
      this.onBinary(buf);
    } else {
      this.onText(buf.toString('utf8'));
    }
  }

  private protocolError(reason: string, fields: Record<string, unknown> = {}): void {
    this.protocolErrors++;
    this.log.warn('protocol_error', { reason, count: this.protocolErrors, state: this.state, ...fields });
    if (this.protocolErrors >= this.ctx.config.maxProtocolErrors) {
      this.log.warn('too_many_protocol_errors_closing', { count: this.protocolErrors });
      this.close(CLOSE.policy, 'too many protocol errors');
    }
  }

  private onText(text: string): void {
    this.stats.textIn++;
    const parsed = parseDeviceMessage(text);
    if (!parsed.ok) {
      this.protocolError(parsed.reason, { preview: text.slice(0, 120) });
      return;
    }
    const msg = parsed.message;
    this.log.debug('text_in', { kind: msg.kind });

    if (msg.kind === 'hello') {
      this.onHello(msg.transport, msg.version, msg.features, msg.audioParams);
      return;
    }
    if (this.state === 'awaiting_hello') {
      this.protocolError('message before hello', { kind: msg.kind });
      return;
    }

    switch (msg.kind) {
      case 'listen_start':
        this.onListenStart(msg.mode);
        return;
      case 'listen_stop':
        this.onListenStop();
        return;
      case 'listen_detect':
        this.log.info('listen_detect_ignored', { text: clip(msg.text) });
        return;
      case 'abort':
        this.onAbort(clip(msg.reason) as string | undefined);
        return;
      case 'mcp':
        // Device-side MCP replies; this server sends no MCP requests yet.
        this.log.debug('mcp_ignored');
        return;
      case 'unknown':
        this.log.info('unknown_message_type_ignored', { type: clip(msg.type) });
        return;
    }
  }

  private onHello(
    transport: string | undefined,
    version: number | undefined,
    features: Record<string, unknown>,
    audioParams: Parameters<typeof resolveUplinkFormat>[0],
  ): void {
    if (this.state !== 'awaiting_hello') {
      // A second hello would make the device re-read session fields; never answer it.
      this.protocolError('duplicate hello');
      return;
    }
    if (transport !== 'websocket') {
      this.protocolError('hello transport is not "websocket"', { transport: clip(transport) });
      return;
    }
    if (version !== undefined && version !== this.ctx.framing) {
      this.log.warn('hello_version_mismatch', { helloVersion: version, headerVersion: this.ctx.framing });
    }
    const { format, warnings } = resolveUplinkFormat(audioParams);
    for (const w of warnings) this.log.warn('hello_audio_params', { warning: clip(w) });
    this.uplink = format;
    this.downlink = this.ctx.responder.downlinkFormat(format);
    clearTimeout(this.helloTimer);
    this.helloTimer = undefined;
    this.state = 'ready';
    this.send(serverHello(this.sessionId, this.downlink));
    this.log.info('hello', {
      uplink: this.uplink,
      downlink: this.downlink,
      features: clipObject(features),
    });
  }

  private newCollector(): TurnCollector {
    const { config } = this.ctx;
    return new TurnCollector({
      mode: this.mode,
      frameDurationMs: this.uplink!.frameDurationMs,
      maxBufferMs: config.echo.maxBufferMs,
      maxBufferBytes: config.echo.maxBufferBytes,
      endpoint: config.endpoint,
    });
  }

  private onListenStart(mode: ListenMode): void {
    if (this.reply) {
      // A new listen start during a reply means the user took the turn back
      // (manual press while speaking sends abort then listen start,
      // main/application.cc:839-873).
      this.log.info('listen_start_during_reply_aborting');
      this.reply.controller.abort();
    }
    this.mode = mode;
    this.collector = this.newCollector();
    this.guardUntil = 0;
    this.state = 'listening';
    this.resetStatsWindow();
    this.startStatsTimer();
    this.log.info('listen_start', { mode });
  }

  private onListenStop(): void {
    if (this.state !== 'listening' || !this.collector) {
      this.log.info('listen_stop_ignored', { state: this.state });
      return;
    }
    this.log.info('listen_stop', { mode: this.mode, packets: this.collector.packetCount });
    this.finishTurn('listen_stop');
  }

  private onAbort(reason: string | undefined): void {
    if (!this.reply) {
      this.log.info('abort_without_reply', { reason });
      return;
    }
    // The device stays in speaking until it gets tts stop
    // (main/application.cc:1170-1176, PROTOCOL.md 4.2). The reply loop sends it.
    this.log.info('abort', { reason });
    this.reply.controller.abort();
  }

  private onBinary(frame: Buffer): void {
    this.stats.framesIn++;
    if (this.state === 'awaiting_hello') {
      this.protocolError('binary frame before hello', { bytes: frame.length });
      return;
    }
    const decoded = decodeAudioFrame(frame, this.ctx.framing);
    if (!decoded.ok) {
      this.protocolError(decoded.reason, { bytes: frame.length });
      return;
    }
    const packet = Buffer.from(decoded.audio.payload); // own the bytes
    // Sizes are only ever summarized by the stats timer (realtime and auto while
    // listening). Recording them at any other time, for example in manual mode,
    // grew the array without bound.
    if (this.statsTimer) {
      if (this.windowSizes.length < MAX_STATS_SAMPLES) this.windowSizes.push(packet.length);
      else this.windowUnsampled++;
    }

    if (this.state !== 'listening' || !this.collector) {
      // Realtime keeps streaming while speaking (main/application.cc:1041-1050): ignore our own echo.
      this.stats.framesIgnored++;
      return;
    }
    if (Date.now() < this.guardUntil) {
      this.stats.framesIgnored++;
      return;
    }
    const result = this.collector.push(packet);
    if (result.ended) this.finishTurn(result.reason);
  }

  // ---------------------------------------------------------------------------
  // Turns and replies
  // ---------------------------------------------------------------------------

  private finishTurn(reason: TurnEndReason): void {
    const collector = this.collector;
    if (!collector || !this.uplink || !this.downlink) return;
    const hasAudio = collector.hasAudio;
    const { packets, truncated } = collector.take();
    this.stopStatsTimer();
    this.resetStatsWindow();

    if (!hasAudio || packets.length === 0) {
      this.log.info('turn_empty', { reason, mode: this.mode });
      if (this.mode === 'manual') {
        this.state = 'ready';
        this.collector = undefined;
      } else {
        this.startStatsTimer(); // keep listening with the (now empty) collector
      }
      return;
    }

    this.turnCount++;
    const turn: UserTurn = {
      sessionId: this.sessionId,
      deviceId: this.ctx.deviceId,
      mode: this.mode,
      inputFormat: this.uplink,
      packets,
      endReason: reason,
      truncated,
    };
    const sizes = packets.map((p) => p.length);
    this.log.info('turn_end', {
      turn: this.turnCount,
      reason,
      mode: this.mode,
      packets: packets.length,
      audioMs: packets.length * this.uplink.frameDurationMs,
      bytes: sizes.reduce((a, b) => a + b, 0),
      truncated,
      packetBytes: summarize(sizes),
    });
    if (truncated) {
      this.log.warn('turn_truncated_at_buffer_cap', {
        maxBufferMs: this.ctx.config.echo.maxBufferMs,
        maxBufferBytes: this.ctx.config.echo.maxBufferBytes,
      });
    }

    this.state = 'responding';
    this.collector = undefined;
    const downlink = this.downlink;
    const previous = this.reply;
    const controller = new AbortController();
    const run = async (): Promise<void> => {
      if (previous) {
        // A listen start aborted the previous reply, but its loop may still be
        // unwinding. Wait for it, so its tts stop reaches the device before this
        // reply's tts start. The other order would take the device out of
        // speaking (main/application.cc:628-637) and it would then drop this
        // reply's audio (main/application.cc:552-556).
        previous.controller.abort();
        this.log.info('reply_waiting_for_previous', { turn: this.turnCount });
        await previous.done;
      }
      if (controller.signal.aborted || this.closeRequested) return;
      await this.runReply(turn, downlink, controller.signal);
    };
    const done = run().finally(() => {
      // Only the newest reply may clear the slot and move the state on. A
      // superseded reply finishing late must not reset a turn that is already
      // in progress.
      if (this.reply?.controller !== controller) return;
      this.reply = undefined;
      if (!this.closeRequested) this.afterReply();
    });
    this.reply = { controller, done };
  }

  /** Where the device goes after tts stop (main/application.cc:628-637). */
  private afterReply(): void {
    if (this.state === 'closed') return;
    if (this.state === 'listening' && this.collector) return; // a listen start already re-armed us
    if (this.mode === 'manual') {
      this.state = 'ready';
      this.collector = undefined;
      return;
    }
    // Realtime and auto return to listening. Realtime sends no new listen start
    // (main/application.cc:1027-1039); auto sends one, which re-arms the collector.
    this.state = 'listening';
    this.collector = this.newCollector();
    if (this.mode === 'realtime') this.guardUntil = Date.now() + this.ctx.config.endpoint.guardMs;
    this.resetStatsWindow();
    this.startStatsTimer();
  }

  private async runReply(turn: UserTurn, downlink: AudioParams, signal: AbortSignal): Promise<void> {
    const { playback } = this.ctx.config;
    const frameMs = downlink.frameDurationMs;
    let ttsStarted = false;
    let framesSent = 0;
    let silentSlots = 0;
    let underruns = 0;
    // Model of the device's playback: the time at which it would have played
    // every slot sent so far, assuming it plays one frame per frameMs from the
    // moment a frame reaches an empty queue. (playheadEnd - now) / frameMs is
    // then the number of frames still queued on the device.
    let playheadEnd = 0;
    const startedAt = Date.now();

    const beginTts = async (): Promise<void> => {
      if (ttsStarted) return;
      ttsStarted = true;
      this.send(ttsStart(this.sessionId));
      // tts start only schedules the switch to speaking; audio sent right away
      // is dropped or wiped by ResetDecoder (main/application.cc:553-557,
      // main/application.cc:1049). PROTOCOL.md section 6, rule 2.
      if (playback.ttsStartLeadMs > 0) await sleep(playback.ttsStartLeadMs, undefined, { signal });
    };

    // Resolves when the reply is aborted. Racing each step against it means a
    // responder that is slow to honour the signal (for example an STT call that
    // ignores it) cannot delay tts stop or the next reply.
    const abortedStep = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted');
      else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    const iterator = this.ctx.responder.respond(turn, downlink, signal)[Symbol.asyncIterator]();

    try {
      for (;;) {
        const next = iterator.next();
        const step = await Promise.race([next, abortedStep]);
        if (step === 'aborted') {
          next.catch(() => undefined); // settles later; nothing is waiting for it
          break;
        }
        if (step.done) break;
        const event = step.value;
        if (signal.aborted || this.ws.readyState !== WebSocket.OPEN) break;
        switch (event.kind) {
          case 'transcript':
            this.send(sttMessage(this.sessionId, event.text));
            break;
          case 'emotion':
            this.send(llmEmotion(this.sessionId, event.emotion));
            break;
          case 'sentence':
            await beginTts();
            this.send(ttsSentenceStart(this.sessionId, event.text));
            break;
          case 'audio': {
            await beginTts();
            // Real-time pacing: the decode queue holds 20 packets and drops on
            // overflow (main/audio/audio_service.h:43, main/audio/audio_service.cc:609-620).
            // Send a slot once at most prebufferFrames frames are still queued ahead of it.
            const wait = playheadEnd - playback.prebufferFrames * frameMs - Date.now();
            if (wait > 0) await sleep(wait, undefined, { signal });
            if (signal.aborted) break;
            const now = Date.now();
            const slot = framesSent + silentSlots;
            if (now - playheadEnd > frameMs) {
              // The device queue has been empty for more than a frame: the
              // responder fell behind real time (for example TTS for the next
              // sentence arrived late). Re-anchor at now, so the late frames go
              // out as a fresh prebuffer instead of one burst the queue drops.
              // Lateness up to one frame is timer jitter and keeps the schedule.
              if (slot > 0) underruns++;
              playheadEnd = now;
            }
            playheadEnd += frameMs;
            if (event.packet.length === 0) {
              silentSlots++; // keep timing, never send an empty Opus packet
              break;
            }
            if (!this.sendBinary(encodeAudioFrame(event.packet, this.ctx.framing))) break;
            framesSent++;
            break;
          }
        }
      }
    } catch (err) {
      if (!signal.aborted) this.log.error('reply_failed', { error: err });
    } finally {
      if (ttsStarted && this.ws.readyState === WebSocket.OPEN && !this.closeRequested) {
        // Always end with tts stop, including after abort (PROTOCOL.md section 6, rule 5).
        this.send(ttsStop(this.sessionId));
      }
      // Let the responder clean up without waiting for it.
      Promise.resolve()
        .then(() => iterator.return?.())
        .catch((err: unknown) => {
          if (!signal.aborted) this.log.warn('responder_cleanup_failed', { error: err });
        });
      this.stats.framesOut += framesSent;
      this.log.info('reply_end', {
        turn: this.turnCount,
        aborted: signal.aborted,
        framesSent,
        emptyPacketsSkipped: silentSlots,
        underruns,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------

  private send(text: string): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(text);
    return true;
  }

  private sendBinary(frame: Buffer): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(frame, { binary: true });
    return true;
  }

  private touchIdle(): void {
    if (this.idleTimer) {
      this.idleTimer.refresh();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.log.info('idle_timeout_closing', { afterMs: this.ctx.config.idleTimeoutMs });
      this.close(CLOSE.normal, 'idle timeout');
    }, this.ctx.config.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private startStatsTimer(): void {
    if (this.mode === 'manual' || this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      if (this.windowSizes.length === 0) return;
      this.log.info('uplink_stats', {
        mode: this.mode,
        state: this.state,
        windowMs: UPLINK_STATS_INTERVAL_MS,
        silenceMaxBytes: this.ctx.config.endpoint.silenceMaxBytes,
        packetBytes: summarize(this.windowSizes),
        ...(this.windowUnsampled > 0 ? { packetsNotSampled: this.windowUnsampled } : {}),
      });
      this.resetStatsWindow();
    }, UPLINK_STATS_INTERVAL_MS);
    this.statsTimer.unref();
  }

  private resetStatsWindow(): void {
    this.windowSizes = [];
    this.windowUnsampled = 0;
  }

  private stopStatsTimer(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = undefined;
  }

  private onClose(code: number, reason: string): void {
    const previous = this.state;
    this.state = 'closed';
    clearTimeout(this.helloTimer);
    clearTimeout(this.idleTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.stopStatsTimer();
    this.reply?.controller.abort();
    // The device hangs up by dropping TCP with no close frame
    // (main/protocols/websocket_protocol.cc:74-77), which ws reports as 1006.
    this.log.info('ws_closed', {
      code,
      reason,
      closeFrame: code !== 1006,
      byServer: this.closeRequested,
      previousState: previous,
      durationMs: Date.now() - this.openedAt,
      turns: this.turnCount,
      ...this.stats,
      protocolErrors: this.protocolErrors,
    });
    const pending = this.reply?.done ?? Promise.resolve();
    void pending.finally(() => this.resolveClosed());
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function summarize(values: number[]): { n: number; min: number; p50: number; p90: number; max: number } {
  if (values.length === 0) return { n: 0, min: 0, p50: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { n: sorted.length, min: sorted[0]!, p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1]! };
}
