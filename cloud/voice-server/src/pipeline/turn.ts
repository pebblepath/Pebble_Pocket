/**
 * Collects uplink packets into a user turn and decides when the turn ends.
 *
 * Manual mode ends only on `listen stop`. Realtime and auto modes never send
 * `listen stop` in this build (main/application.cc:1027-1039, PROTOCOL.md 4.2),
 * so the server must endpoint on its own:
 *
 * - "silence" (default): a DTX heuristic. The encoder runs with DTX and VBR on
 *   (main/audio/audio_service.h:77-79) and every encoded result is sent
 *   (main/audio/audio_service.cc:489-500), so silent stretches should arrive
 *   as very small packets. What "small" means on this board is NOT verified;
 *   tune ENDPOINT_SILENCE_MAX_BYTES from the uplink_stats logs. The turn also
 *   ends at ENDPOINT_WINDOW_MS even if silence is never detected.
 * - "window": fixed-length turns of ENDPOINT_WINDOW_MS, no heuristics.
 *
 * Every mode enforces the hard buffer cap (duration and bytes).
 */

import type { EndpointConfig } from '../config.js';
import type { ListenMode } from '../protocol/messages.js';
import type { TurnEndReason } from './types.js';

/** Silent packets kept before the first speech packet and after the last one. */
export const SILENCE_PADDING_FRAMES = 2;

export interface TurnCollectorOptions {
  mode: ListenMode;
  frameDurationMs: number;
  maxBufferMs: number;
  maxBufferBytes: number;
  endpoint: EndpointConfig;
}

export type PushResult = { ended: false } | { ended: true; reason: TurnEndReason };

export class TurnCollector {
  private packets: Buffer[] = [];
  private bytes = 0;
  private truncatedFlag = false;
  private preroll: Buffer[] = [];
  private speechFrames = 0;
  private trailingSilentFrames = 0;
  private readonly maxFrames: number;

  constructor(private readonly opts: TurnCollectorOptions) {
    this.maxFrames = Math.max(1, Math.floor(opts.maxBufferMs / opts.frameDurationMs));
  }

  get packetCount(): number {
    return this.packets.length;
  }

  get byteCount(): number {
    return this.bytes;
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  /** True when the turn holds audio worth replying to. */
  get hasAudio(): boolean {
    if (this.opts.mode === 'manual' || this.opts.endpoint.mode === 'window') return this.packets.length > 0;
    return this.speechFrames > 0;
  }

  private isSilent(packet: Buffer): boolean {
    return packet.length <= this.opts.endpoint.silenceMaxBytes;
  }

  private framesFor(ms: number): number {
    return Math.ceil(ms / this.opts.frameDurationMs);
  }

  /** Appends within the caps. Returns false when the packet was dropped for the cap. */
  private append(packet: Buffer): boolean {
    if (this.packets.length >= this.maxFrames || this.bytes + packet.length > this.opts.maxBufferBytes) {
      this.truncatedFlag = true;
      return false;
    }
    this.packets.push(packet);
    this.bytes += packet.length;
    return true;
  }

  private capReached(): boolean {
    return this.packets.length >= this.maxFrames || this.bytes >= this.opts.maxBufferBytes;
  }

  push(packet: Buffer): PushResult {
    if (this.opts.mode === 'manual') {
      // Keep the first maxBufferMs of audio, drop the rest, wait for listen stop.
      this.append(packet);
      return { ended: false };
    }

    if (this.opts.endpoint.mode === 'window') {
      if (!this.append(packet)) return this.finishWith('buffer_cap');
      if (this.packets.length >= this.framesFor(this.opts.endpoint.windowMs)) return this.finishWith('window');
      if (this.capReached()) return this.finishWith('buffer_cap');
      return { ended: false };
    }

    // Silence endpointing.
    const silent = this.isSilent(packet);
    if (this.speechFrames === 0) {
      if (silent) {
        this.preroll.push(packet);
        if (this.preroll.length > SILENCE_PADDING_FRAMES) this.preroll.shift();
        return { ended: false };
      }
      for (const p of this.preroll) this.append(p);
      this.preroll = [];
    }

    if (!this.append(packet)) return this.finishWith('buffer_cap');
    if (silent) {
      this.trailingSilentFrames++;
    } else {
      this.speechFrames++;
      this.trailingSilentFrames = 0;
    }

    const e = this.opts.endpoint;
    if (this.trailingSilentFrames >= this.framesFor(e.silenceMs)) {
      if (this.speechFrames >= this.framesFor(e.minSpeechMs)) return this.finishWith('silence');
      // Too little speech (a click or a cough): discard and keep listening.
      this.reset();
      return { ended: false };
    }
    if (this.packets.length >= this.framesFor(e.windowMs)) return this.finishWith('window');
    if (this.capReached()) return this.finishWith('buffer_cap');
    return { ended: false };
  }

  private finishWith(reason: TurnEndReason): PushResult {
    return { ended: true, reason };
  }

  /**
   * Returns the packets of the finished turn. In silence mode, trailing
   * silence beyond SILENCE_PADDING_FRAMES is trimmed.
   */
  take(): { packets: Buffer[]; truncated: boolean } {
    let packets = this.packets;
    if (this.opts.mode !== 'manual' && this.opts.endpoint.mode === 'silence' && this.speechFrames > 0) {
      let end = packets.length;
      let silentRun = 0;
      while (end > 0 && this.isSilent(packets[end - 1]!)) {
        end--;
        silentRun++;
      }
      packets = packets.slice(0, end + Math.min(silentRun, SILENCE_PADDING_FRAMES));
    }
    const truncated = this.truncatedFlag;
    this.reset();
    return { packets, truncated };
  }

  reset(): void {
    this.packets = [];
    this.bytes = 0;
    this.truncatedFlag = false;
    this.preroll = [];
    this.speechFrames = 0;
    this.trailingSilentFrames = 0;
  }
}
