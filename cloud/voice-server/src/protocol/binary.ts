/**
 * Binary audio framing, PROTOCOL.md section 5.
 *
 * v1: the frame is one raw Opus packet.
 * v2: 16-byte big-endian header {u16 version, u16 type, u32 reserved, u32 timestamp, u32 payload_size}
 *     (main/protocols/protocol.h:19-26, main/protocols/websocket_protocol.cc:24-40).
 * v3: 4-byte header {u8 type, u8 reserved, u16 BE payload_size}
 *     (main/protocols/protocol.h:28-33, main/protocols/websocket_protocol.cc:41-50).
 *
 * The device trusts payload_size on inbound v2/v3 frames without a length
 * check (websocket_protocol.cc:108-132), so encode() never produces a frame
 * whose header disagrees with its length.
 */

import type { ProtocolVersion } from '../config.js';

export const V2_HEADER_BYTES = 16;
export const V3_HEADER_BYTES = 4;
/** The device refuses to send frames over 65535 bytes (esp-ml307/src/web_socket.cc:210-213). */
export const MAX_DEVICE_FRAME_BYTES = 65535;

export interface DecodedAudio {
  payload: Buffer;
  /** v2 only: the header timestamp, otherwise 0. */
  timestamp: number;
}

export type DecodeResult = { ok: true; audio: DecodedAudio } | { ok: false; reason: string };

/** Versions other than 2 and 3 are treated as raw by the firmware (PROTOCOL.md section 5). */
export function framingFor(version: number): ProtocolVersion {
  return version === 2 ? 2 : version === 3 ? 3 : 1;
}

export function decodeAudioFrame(frame: Buffer, version: ProtocolVersion): DecodeResult {
  if (version === 1) {
    return { ok: true, audio: { payload: frame, timestamp: 0 } };
  }
  if (version === 2) {
    if (frame.length < V2_HEADER_BYTES) {
      return { ok: false, reason: `v2 frame shorter than header (${frame.length} bytes)` };
    }
    const payloadSize = frame.readUInt32BE(12);
    const available = frame.length - V2_HEADER_BYTES;
    if (payloadSize > available) {
      return { ok: false, reason: `v2 payload_size ${payloadSize} exceeds ${available} available bytes` };
    }
    return {
      ok: true,
      audio: {
        payload: frame.subarray(V2_HEADER_BYTES, V2_HEADER_BYTES + payloadSize),
        timestamp: frame.readUInt32BE(8),
      },
    };
  }
  if (frame.length < V3_HEADER_BYTES) {
    return { ok: false, reason: `v3 frame shorter than header (${frame.length} bytes)` };
  }
  const payloadSize = frame.readUInt16BE(2);
  const available = frame.length - V3_HEADER_BYTES;
  if (payloadSize > available) {
    return { ok: false, reason: `v3 payload_size ${payloadSize} exceeds ${available} available bytes` };
  }
  return {
    ok: true,
    audio: { payload: frame.subarray(V3_HEADER_BYTES, V3_HEADER_BYTES + payloadSize), timestamp: 0 },
  };
}

export function encodeAudioFrame(payload: Buffer, version: ProtocolVersion, timestamp = 0): Buffer {
  if (version === 1) return payload;
  if (version === 2) {
    const out = Buffer.alloc(V2_HEADER_BYTES + payload.length);
    out.writeUInt16BE(2, 0);
    out.writeUInt16BE(0, 2);
    out.writeUInt32BE(0, 4);
    out.writeUInt32BE(timestamp >>> 0, 8);
    out.writeUInt32BE(payload.length, 12);
    payload.copy(out, V2_HEADER_BYTES);
    return out;
  }
  if (payload.length > 0xffff) {
    throw new RangeError(`v3 payload of ${payload.length} bytes does not fit a u16 payload_size`);
  }
  const out = Buffer.alloc(V3_HEADER_BYTES + payload.length);
  out.writeUInt8(0, 0);
  out.writeUInt8(0, 1);
  out.writeUInt16BE(payload.length, 2);
  payload.copy(out, V3_HEADER_BYTES);
  return out;
}
