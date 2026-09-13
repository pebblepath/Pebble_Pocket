/**
 * Environment configuration and the device-safety checks on it.
 *
 * Several values end up in the device's NVS through the OTA response, where
 * a bad value can brick the boot loop or silently break the session, so they
 * are validated here and the server refuses to start instead.
 * Citations refer to PROTOCOL.md sections and the firmware source.
 */

import { randomBytes } from 'node:crypto';
import type { LogLevel } from './log.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type ProtocolVersion = 1 | 2 | 3;
export type EndpointMode = 'silence' | 'window';

export interface EchoConfig {
  /** Hard cap on buffered uplink audio per turn, in milliseconds. */
  maxBufferMs: number;
  /** Hard cap on buffered uplink audio per turn, in bytes (defends against huge frames). */
  maxBufferBytes: number;
  /**
   * Sample rate announced in the server hello for echo. Undefined means "the
   * device's own uplink rate" (16000 in this build), which replays through the
   * same decode path the firmware uses for its own audio-testing loopback
   * (main/audio/audio_service.cc:474, main/audio/audio_service.cc:409).
   */
  downlinkSampleRate: number | undefined;
}

export interface PlaybackConfig {
  /** Pause between `tts start` and the first audio frame (PROTOCOL.md section 6, rule 2). */
  ttsStartLeadMs: number;
  /** Frames sent back to back before real-time pacing starts. */
  prebufferFrames: number;
}

export interface EndpointConfig {
  /** How a turn ends in realtime and auto modes, which never send `listen stop`. */
  mode: EndpointMode;
  /** Window mode: turn length. Silence mode: longest turn before a forced end. */
  windowMs: number;
  /** Silence mode: trailing silence that ends a turn. */
  silenceMs: number;
  /** Silence mode: packets at or below this size count as silence (DTX heuristic, unverified). */
  silenceMaxBytes: number;
  /** Silence mode: speech needed before silence can end the turn. */
  minSpeechMs: number;
  /** Ignore uplink for this long after `tts stop` (queued audio still plays, PROTOCOL.md section 6). */
  guardMs: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  /** Undefined means ws://localhost:<bound port>/ws, resolved at listen time. */
  publicWsUrl: string | undefined;
  /** Path the WebSocket upgrade is accepted on (path of publicWsUrl, default /ws). */
  wsPath: string;
  token: string;
  tokenGenerated: boolean;
  protocolVersion: ProtocolVersion;
  responder: 'echo';
  echo: EchoConfig;
  playback: PlaybackConfig;
  endpoint: EndpointConfig;
  helloTimeoutMs: number;
  idleTimeoutMs: number;
  pingIntervalMs: number;
  shutdownGraceMs: number;
  maxProtocolErrors: number;
  logLevel: LogLevel;
  /**
   * Minutes east of UTC sent as server_time.timezone_offset, or undefined to
   * omit it (device clock then shows UTC). A fixed offset: it does not follow
   * daylight saving changes.
   */
  timezoneOffsetMinutes: number | undefined;
}

export const DEFAULT_PORT = 8000;
export const DEFAULT_WS_PATH = '/ws';
/** Health check path. Not "/healthz": Cloud Run reserves some paths ending in "z". */
export const HEALTH_PATH = '/health';
/** Offsets in use worldwide run from UTC-12:00 to UTC+14:00. */
const MIN_TZ_OFFSET_MINUTES = -12 * 60;
const MAX_TZ_OFFSET_MINUTES = 14 * 60;
/** Paths the OTA handler answers with 200. `/ota/` is what a URL ending in /ota/ produces. */
export const OTA_PATHS: readonly string[] = ['/ota/', '/ota'];

/** NVS string values are limited to 4000 bytes including the terminator (PROTOCOL.md 1.6). */
const NVS_MAX_STRING_BYTES = 3999;

export function defaultConfig(): ServerConfig {
  return {
    port: DEFAULT_PORT,
    host: '0.0.0.0',
    publicWsUrl: undefined,
    wsPath: DEFAULT_WS_PATH,
    token: 'test-token',
    tokenGenerated: false,
    protocolVersion: 1,
    responder: 'echo',
    echo: { maxBufferMs: 20_000, maxBufferBytes: 1024 * 1024, downlinkSampleRate: undefined },
    playback: { ttsStartLeadMs: 100, prebufferFrames: 3 },
    endpoint: {
      mode: 'silence',
      windowMs: 6_000,
      silenceMs: 720,
      silenceMaxBytes: 10,
      minSpeechMs: 240,
      guardMs: 600,
    },
    helloTimeoutMs: 10_000,
    idleTimeoutMs: 10 * 60_000,
    pingIntervalMs: 30_000,
    shutdownGraceMs: 8_000,
    maxProtocolErrors: 50,
    logLevel: 'info',
    timezoneOffsetMinutes: undefined,
  };
}

export interface FirmwareWsUri {
  protocol: string;
  host: string;
  port: string;
  path: string;
  explicitPort: boolean;
}

/**
 * Splits a WebSocket URI exactly the way the firmware does
 * (esp-ml307/src/web_socket.cc:69-109): the first ':' after "://" starts the
 * port, even if it sits in the path.
 */
export function parseUriLikeFirmware(uri: string): FirmwareWsUri | undefined {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd < 0) return undefined;
  const protocol = uri.slice(0, schemeEnd);
  const pos = schemeEnd + 3;
  const colon = uri.indexOf(':', pos);
  if (colon < 0) {
    const slash = uri.indexOf('/', pos);
    const host = slash < 0 ? uri.slice(pos) : uri.slice(pos, slash);
    const path = slash < 0 ? '/' : uri.slice(slash);
    return { protocol, host, port: protocol === 'wss' ? '443' : '80', path, explicitPort: false };
  }
  const host = uri.slice(pos, colon);
  const slash = uri.indexOf('/', colon + 1);
  const port = slash < 0 ? uri.slice(colon + 1) : uri.slice(colon + 1, slash);
  const path = slash < 0 ? '/' : uri.slice(slash);
  return { protocol, host, port, path, explicitPort: true };
}

/**
 * Rejects WebSocket URLs the firmware would mis-parse or abort on.
 * Returns the request path (without query) the server must listen on.
 */
export function validatePublicWsUrl(url: string): string {
  const parsed = parseUriLikeFirmware(url);
  if (!parsed) throw new ConfigError(`PUBLIC_WS_URL "${url}" has no "://"`);
  if (parsed.protocol !== 'ws' && parsed.protocol !== 'wss') {
    throw new ConfigError(`PUBLIC_WS_URL must start with ws:// or wss:// (got "${parsed.protocol}")`);
  }
  if (!parsed.explicitPort) {
    throw new ConfigError(
      'PUBLIC_WS_URL needs an explicit numeric port, for example ws://192.168.1.50:8000/ws ' +
        '(the firmware passes the port to std::stoi with exceptions disabled, PROTOCOL.md section 2)',
    );
  }
  if (parsed.host.length === 0 || /[\s\[\]@]/.test(parsed.host)) {
    throw new ConfigError(`PUBLIC_WS_URL host "${parsed.host}" is not a plain IPv4 address or hostname`);
  }
  if (!/^\d{1,5}$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535) {
    throw new ConfigError(
      `PUBLIC_WS_URL port "${parsed.port}" is not a number from 1 to 65535. ` +
        'A ":" in the path is read as the port separator by the firmware.',
    );
  }
  if (!parsed.path.startsWith('/')) {
    throw new ConfigError('PUBLIC_WS_URL path must start with "/"');
  }
  if (parsed.path.includes(':')) {
    throw new ConfigError('PUBLIC_WS_URL must not contain ":" in the path or query (PROTOCOL.md section 2)');
  }
  if (Buffer.byteLength(url) > NVS_MAX_STRING_BYTES) {
    throw new ConfigError('PUBLIC_WS_URL is longer than the NVS string limit (PROTOCOL.md 1.6)');
  }
  const q = parsed.path.search(/[?#]/);
  return q < 0 ? parsed.path : parsed.path.slice(0, q);
}

export function validateToken(token: string): void {
  if (token.length === 0) throw new ConfigError('POCKET_DEV_TOKEN must not be empty');
  if (/\s/.test(token)) {
    // A token with a space is sent verbatim without "Bearer " (websocket_protocol.cc:97-103).
    throw new ConfigError('POCKET_DEV_TOKEN must not contain whitespace');
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    // The device sends the token's raw bytes in the Authorization header
    // (websocket_protocol.cc:97-103), and Node decodes header values as latin1,
    // so a non-ASCII token passes the OTA step but fails every upgrade with 401.
    throw new ConfigError('POCKET_DEV_TOKEN must be printable ASCII (characters ! to ~)');
  }
  if (Buffer.byteLength(token) > NVS_MAX_STRING_BYTES) {
    throw new ConfigError('POCKET_DEV_TOKEN is longer than the NVS string limit (PROTOCOL.md 1.6)');
  }
}

type Env = Record<string, string | undefined>;

function intFromEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) throw new ConfigError(`${name} must be an integer (got "${raw}")`);
  const n = Number(raw.trim());
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

/**
 * TIMEZONE_OFFSET_MINUTES: whole minutes east of UTC (Chicago in September is
 * -300). The firmware reads it with cJSON's valueint and multiplies by
 * 60 * 1000 in int arithmetic (main/ota.cc:204-206); the accepted range stays
 * far below int overflow.
 */
function timezoneOffsetFromEnv(env: Env): number | undefined {
  const raw = env['TIMEZONE_OFFSET_MINUTES'];
  if (raw === undefined || raw.trim() === '') return undefined;
  return intFromEnv(env, 'TIMEZONE_OFFSET_MINUTES', 0, MIN_TZ_OFFSET_MINUTES, MAX_TZ_OFFSET_MINUTES);
}

const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];

export function loadConfig(env: Env = process.env): ServerConfig {
  const d = defaultConfig();
  const port = intFromEnv(env, 'PORT', d.port, 0, 65535);

  const publicWsUrl = env['PUBLIC_WS_URL']?.trim() || undefined;
  const wsPath = publicWsUrl ? validatePublicWsUrl(publicWsUrl) : DEFAULT_WS_PATH;

  let token = env['POCKET_DEV_TOKEN'];
  let tokenGenerated = false;
  if (token === undefined || token === '') {
    token = 'dev-' + randomBytes(12).toString('hex');
    tokenGenerated = true;
  }
  validateToken(token);

  const versionRaw = intFromEnv(env, 'WS_PROTOCOL_VERSION', 1, 1, 3);
  const protocolVersion = versionRaw as ProtocolVersion;

  const responder = (env['RESPONDER'] ?? 'echo').trim();
  if (responder !== 'echo') {
    throw new ConfigError(`RESPONDER "${responder}" is not implemented; only "echo" exists today`);
  }

  const downlinkRateRaw = env['ECHO_DOWNLINK_SAMPLE_RATE'];
  let downlinkSampleRate: number | undefined;
  if (downlinkRateRaw !== undefined && downlinkRateRaw.trim() !== '') {
    downlinkSampleRate = intFromEnv(env, 'ECHO_DOWNLINK_SAMPLE_RATE', 16000, 8000, 48000);
    if (!OPUS_RATES.includes(downlinkSampleRate)) {
      throw new ConfigError(`ECHO_DOWNLINK_SAMPLE_RATE must be one of ${OPUS_RATES.join(', ')}`);
    }
  }

  const modeRaw = (env['ENDPOINT_MODE'] ?? d.endpoint.mode).trim();
  if (modeRaw !== 'silence' && modeRaw !== 'window') {
    throw new ConfigError(`ENDPOINT_MODE must be "silence" or "window" (got "${modeRaw}")`);
  }

  const logLevelRaw = (env['LOG_LEVEL'] ?? 'info').trim().toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelRaw)) {
    throw new ConfigError(`LOG_LEVEL must be debug, info, warn or error (got "${logLevelRaw}")`);
  }

  return {
    port,
    host: env['HOST']?.trim() || d.host,
    publicWsUrl,
    wsPath,
    token,
    tokenGenerated,
    protocolVersion,
    responder: 'echo',
    echo: {
      maxBufferMs: intFromEnv(env, 'ECHO_MAX_BUFFER_MS', d.echo.maxBufferMs, 60, 120_000),
      maxBufferBytes: intFromEnv(env, 'ECHO_MAX_BUFFER_BYTES', d.echo.maxBufferBytes, 1024, 16 * 1024 * 1024),
      downlinkSampleRate,
    },
    playback: {
      ttsStartLeadMs: intFromEnv(env, 'TTS_START_LEAD_MS', d.playback.ttsStartLeadMs, 0, 2_000),
      prebufferFrames: intFromEnv(env, 'PREBUFFER_FRAMES', d.playback.prebufferFrames, 0, 15),
    },
    endpoint: {
      mode: modeRaw,
      windowMs: intFromEnv(env, 'ENDPOINT_WINDOW_MS', d.endpoint.windowMs, 300, 120_000),
      silenceMs: intFromEnv(env, 'ENDPOINT_SILENCE_MS', d.endpoint.silenceMs, 60, 10_000),
      silenceMaxBytes: intFromEnv(env, 'ENDPOINT_SILENCE_MAX_BYTES', d.endpoint.silenceMaxBytes, 0, 1_000),
      minSpeechMs: intFromEnv(env, 'ENDPOINT_MIN_SPEECH_MS', d.endpoint.minSpeechMs, 0, 10_000),
      guardMs: intFromEnv(env, 'ENDPOINT_GUARD_MS', d.endpoint.guardMs, 0, 10_000),
    },
    helloTimeoutMs: intFromEnv(env, 'HELLO_TIMEOUT_MS', d.helloTimeoutMs, 100, 120_000),
    idleTimeoutMs: intFromEnv(env, 'IDLE_TIMEOUT_MS', d.idleTimeoutMs, 1_000, 24 * 3_600_000),
    pingIntervalMs: intFromEnv(env, 'PING_INTERVAL_MS', d.pingIntervalMs, 0, 3_600_000),
    shutdownGraceMs: intFromEnv(env, 'SHUTDOWN_GRACE_MS', d.shutdownGraceMs, 0, 60_000),
    maxProtocolErrors: intFromEnv(env, 'MAX_PROTOCOL_ERRORS', d.maxProtocolErrors, 1, 100_000),
    logLevel: logLevelRaw as LogLevel,
    timezoneOffsetMinutes: timezoneOffsetFromEnv(env),
  };
}
