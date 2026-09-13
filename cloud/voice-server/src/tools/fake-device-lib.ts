/**
 * A fake Pebble Pocket that talks to the server the way the pebble-pocket
 * firmware does, end to end, and checks what comes back.
 *
 * What it mimics (citations are firmware paths, see PROTOCOL.md):
 * - OTA: POST with the firmware's headers and a system-info body
 *   (main/ota.cc:57-74, main/ota.cc:95-97), requires exactly 200
 *   (main/ota.cc:109-112) and checks the NVS hazards (PROTOCOL.md 1.6).
 * - WebSocket: Authorization / Protocol-Version / Device-Id / Client-Id,
 *   Host without port, no subprotocol, no compression, 10 s handshake
 *   (main/protocols/websocket_protocol.cc:97-106, esp-ml307/src/web_socket.cc:127-201).
 * - Hello as built in main/protocols/websocket_protocol.cc:199-223, server
 *   hello within 10 s with transport "websocket".
 * - Device state: tts start only schedules "speaking"; audio is accepted only
 *   while speaking (main/application.cc:553-557, main/application.cc:623-627);
 *   a 20-packet decode queue that drops on overflow
 *   (main/audio/audio_service.h:43, main/audio/audio_service.cc:609-620).
 * - Hang-up by dropping TCP without a close frame (esp-ml307/src/web_socket.cc:48-51).
 *
 * Dummy "Opus" packets carry a marker and a sequence number so ordering can
 * be verified; the server never decodes Opus in echo mode.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { WebSocket } from 'ws';
import { parseUriLikeFirmware } from '../config.js';
import { decodeAudioFrame, encodeAudioFrame, framingFor } from '../protocol/binary.js';
import type { ProtocolVersion } from '../config.js';
import type { ListenMode } from '../protocol/messages.js';

export const DECODE_QUEUE_PACKETS = 20; // 1200 / 60, main/audio/audio_service.h:43
const MARK = 0x50;
const SPEECH = 0x53;
const SILENCE = 0x5a;

export interface FakeDeviceOptions {
  otaUrl: string;
  mode: ListenMode;
  /** Speech frames sent per turn. */
  frames: number;
  turns: number;
  /** Size of a speech frame. */
  frameBytes: number;
  /** Size of a silence frame (realtime/auto tail). Must be at or below the server's ENDPOINT_SILENCE_MAX_BYTES. */
  silenceBytes: number;
  /** Uplink pacing; 60 matches the device, 0 sends as fast as possible. */
  paceMs: number;
  /** Modeled delay between receiving tts start/stop and the main task switching state. */
  scheduleDelayMs: number;
  timeoutMs: number;
  deviceId: string;
  clientId: string;
  log: (line: string) => void;
}

export function defaultFakeDeviceOptions(): FakeDeviceOptions {
  const mac = randomBytes(6);
  mac[0] = (mac[0]! & 0xfe) | 0x02; // locally administered, unicast
  return {
    otaUrl: 'http://localhost:8000/ota/',
    mode: 'manual',
    frames: 40,
    turns: 1,
    frameBytes: 32,
    silenceBytes: 3,
    paceMs: 60,
    scheduleDelayMs: 30,
    timeoutMs: 30_000,
    deviceId: [...mac].map((b) => b.toString(16).padStart(2, '0')).join(':'),
    clientId: randomUUID(),
    log: (line) => process.stdout.write(line + '\n'),
  };
}

export interface OtaReport {
  status: number;
  wsUrl: string;
  tokenPresent: boolean;
  version: number;
  keys: string[];
  problems: string[];
}

export interface TurnReport {
  turn: number;
  mode: ListenMode;
  speechFramesSent: number;
  silenceFramesSent: number;
  firstSeq: number;
  echoedFrames: number;
  echoedSpeechFrames: number;
  echoedInOrder: boolean;
  echoedIsPrefixOfSent: boolean;
  ttsStartBeforeAudio: boolean;
  sentenceText: string | undefined;
  sentenceBeforeAudio: boolean;
  ttsStopAfterAudio: boolean;
  droppedNotSpeaking: number;
  queueOverflowDrops: number;
  leadGapMs: number | undefined;
  playbackSpanMs: number | undefined;
  ttsStopToEndMs: number | undefined;
  problems: string[];
}

export interface FakeDeviceReport {
  ok: boolean;
  deviceId: string;
  ota: OtaReport | undefined;
  hello:
    | { sessionId: string; transport: unknown; sampleRate: number; frameDurationMs: number; helloMs: number }
    | undefined;
  framing: ProtocolVersion;
  turns: TurnReport[];
  problems: string[];
}

interface RecordedEvent {
  t: number;
  kind: 'tts_start' | 'tts_sentence' | 'tts_stop' | 'stt' | 'llm' | 'hello' | 'other_text' | 'audio' | 'bad_text';
  text?: string;
  payload?: Buffer;
  accepted?: boolean;
}

function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)), Connection: 'close' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`OTA request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

function systemInfoBody(o: FakeDeviceOptions): string {
  // Shape from main/boards/common/board.cc:101-172; values are illustrative.
  return JSON.stringify({
    version: 2,
    language: 'en-US',
    flash_size: 33554432,
    minimum_free_heap_size: '123456',
    mac_address: o.deviceId,
    uuid: o.clientId,
    chip_model_name: 'esp32s3',
    chip_info: { model: 9, cores: 2, revision: 0, features: 0 },
    application: { name: 'xiaozhi', version: '2.5.0', compile_time: new Date().toISOString(), idf_version: 'v6.1', elf_sha256: '0'.repeat(64) },
    partition_table: [{ label: 'nvs', type: 1, subtype: 2, address: 36864, size: 16384 }],
    ota: { label: 'ota_0' },
    display: { monochrome: false, width: 410, height: 502 },
    board: { type: 'esp32-s3-touch-amoled-2.06', name: 'pebble-pocket', manufacturer: 'waveshare', ssid: 'fake', rssi: -50, channel: 6, ip: '127.0.0.1' },
  });
}

export function speechPacket(seq: number, size: number): Buffer {
  const b = Buffer.alloc(Math.max(6, size), 0xaa);
  b[0] = MARK;
  b[1] = SPEECH;
  b.writeUInt32BE(seq >>> 0, 2);
  return b;
}

export function silencePacket(seq: number, size: number): Buffer {
  const b = Buffer.alloc(Math.max(2, size), 0);
  b[0] = MARK;
  b[1] = SILENCE;
  if (b.length > 2) b[2] = seq & 0xff;
  return b;
}

export function speechSeqOf(packet: Buffer): number | undefined {
  if (packet.length >= 6 && packet[0] === MARK && packet[1] === SPEECH) return packet.readUInt32BE(2);
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A sleep that does not keep the process alive, for timeouts raced against events. */
function timeoutAfter(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

export async function runFakeDevice(partial: Partial<FakeDeviceOptions> = {}): Promise<FakeDeviceReport> {
  const o: FakeDeviceOptions = { ...defaultFakeDeviceOptions(), ...partial };
  const log = o.log;
  const report: FakeDeviceReport = {
    ok: false,
    deviceId: o.deviceId,
    ota: undefined,
    hello: undefined,
    framing: 1,
    turns: [],
    problems: [],
  };

  // ---- 1. OTA ---------------------------------------------------------------
  log(`[ota] POST ${o.otaUrl}`);
  const otaRes = await postJson(
    o.otaUrl,
    {
      'Activation-Version': '1',
      'Device-Id': o.deviceId,
      'Client-Id': o.clientId,
      'User-Agent': 'pebble-pocket/2.5.0',
      'Accept-Language': 'en-US',
      'Content-Type': 'application/json',
    },
    systemInfoBody(o),
    o.timeoutMs,
  );
  const otaProblems: string[] = [];
  if (otaRes.status !== 200) otaProblems.push(`status ${otaRes.status}, firmware requires exactly 200`);
  let root: Record<string, unknown> = {};
  try {
    root = JSON.parse(otaRes.body) as Record<string, unknown>;
  } catch {
    otaProblems.push('body is not JSON');
  }
  const wsObj = root['websocket'];
  const websocket = typeof wsObj === 'object' && wsObj !== null ? (wsObj as Record<string, unknown>) : undefined;
  if (!websocket) otaProblems.push('no "websocket" object: the device would fall back to MQTT');
  if ('mqtt' in root) otaProblems.push('"mqtt" present: the device would select MQTT');
  if ('activation' in root) otaProblems.push('"activation" present: the device would start activation');
  if ('firmware' in root) otaProblems.push('"firmware" present: may trigger an immediate upgrade');
  const keys = websocket ? Object.keys(websocket) : [];
  for (const k of keys) if (k.length > 15) otaProblems.push(`websocket key "${k}" longer than 15 chars: NVS abort`);
  const wsUrl = typeof websocket?.['url'] === 'string' ? (websocket['url'] as string) : '';
  const token = typeof websocket?.['token'] === 'string' ? (websocket['token'] as string) : '';
  const versionRaw = websocket?.['version'];
  if (websocket && versionRaw !== undefined && typeof versionRaw !== 'number') {
    otaProblems.push('websocket.version is not a JSON number: the device would silently use 1');
  }
  const version = typeof versionRaw === 'number' && versionRaw !== 0 ? Math.trunc(versionRaw) : 1;
  const parsedUrl = parseUriLikeFirmware(wsUrl);
  if (!parsedUrl) otaProblems.push(`websocket.url "${wsUrl}" has no "://"`);
  else {
    if (!parsedUrl.explicitPort) otaProblems.push('websocket.url has no explicit port');
    if (!/^\d+$/.test(parsedUrl.port)) otaProblems.push(`websocket.url port "${parsedUrl.port}" is not numeric`);
    if (parsedUrl.path.includes(':')) otaProblems.push('websocket.url has ":" in the path');
  }
  report.ota = { status: otaRes.status, wsUrl, tokenPresent: token.length > 0, version, keys, problems: otaProblems };
  log(`[ota] ${otaRes.status} websocket.url=${wsUrl} version=${version} keys=${keys.join(',')} token=${token ? 'present' : 'absent'}`);
  if (otaProblems.length > 0 || !parsedUrl) {
    report.problems.push(...otaProblems.map((p) => `ota: ${p}`));
    return report;
  }

  // ---- 2. WebSocket connect ---------------------------------------------------
  const framing = framingFor(version);
  report.framing = framing;
  const headers: Record<string, string> = {
    Host: parsedUrl.host, // sent without the port, esp-ml307/src/web_socket.cc:143-145
    'Protocol-Version': String(version),
    'Device-Id': o.deviceId,
    'Client-Id': o.clientId,
  };
  if (token) headers['Authorization'] = token.includes(' ') ? token : `Bearer ${token}`;

  const events: RecordedEvent[] = [];
  let deviceState: 'connecting' | 'idle' | 'listening' | 'speaking' = 'connecting';
  let listenMode: ListenMode = o.mode;
  let queue = 0;
  let queueTick = 0;
  let droppedNotSpeaking = 0;
  let overflow = 0;
  let serverHello: Record<string, unknown> | undefined;
  let onHello: (() => void) | undefined;
  let onStateSettled: (() => void) | undefined;
  let closedByServer = false;
  let serverCloseCode: number | undefined;
  let hungUp = false;
  let downlinkFrameMs = 60;
  const isSpeaking = (): boolean => deviceState === 'speaking';

  const drain = (now: number): void => {
    if (queue === 0) {
      queueTick = now;
      return;
    }
    const n = Math.floor((now - queueTick) / downlinkFrameMs);
    if (n > 0) {
      queue = Math.max(0, queue - n);
      queueTick += n * downlinkFrameMs;
    }
  };

  log(`[ws] connecting ${wsUrl} (framing v${framing})`);
  const connectStarted = Date.now();
  const ws = new WebSocket(wsUrl, {
    headers,
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
    followRedirects: false,
  });
  ws.binaryType = 'nodebuffer';

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    const t = Date.now();
    if (isBinary) {
      const decoded = decodeAudioFrame(data, framing);
      if (!decoded.ok) {
        report.problems.push(`downlink frame rejected: ${decoded.reason}`);
        return;
      }
      const accepted = deviceState === 'speaking';
      if (!accepted) droppedNotSpeaking++;
      else {
        drain(t);
        if (queue >= DECODE_QUEUE_PACKETS) overflow++;
        else queue++;
      }
      events.push({ t, kind: 'audio', payload: Buffer.from(decoded.audio.payload), accepted });
      return;
    }
    const text = data.toString('utf8');
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      events.push({ t, kind: 'bad_text', text });
      return;
    }
    const type = msg['type'];
    if (type === 'hello') {
      // Parsed by the protocol layer: ignored unless transport is exactly "websocket".
      if (msg['transport'] === 'websocket') {
        serverHello = msg;
        onHello?.();
      } else {
        report.problems.push(`server hello with transport ${JSON.stringify(msg['transport'])} would be ignored`);
      }
      events.push({ t, kind: 'hello' });
      return;
    }
    if (type === 'tts') {
      const state = msg['state'];
      if (state === 'start') {
        events.push({ t, kind: 'tts_start' });
        setTimeout(() => {
          deviceState = 'speaking';
          queue = 0; // entering speaking calls ResetDecoder (main/application.cc:1049)
          queueTick = Date.now();
        }, o.scheduleDelayMs);
      } else if (state === 'stop') {
        events.push({ t, kind: 'tts_stop' });
        setTimeout(() => {
          if (deviceState === 'speaking') deviceState = listenMode === 'manual' ? 'idle' : 'listening';
          onStateSettled?.();
        }, o.scheduleDelayMs);
      } else if (state === 'sentence_start') {
        events.push({ t, kind: 'tts_sentence', text: typeof msg['text'] === 'string' ? (msg['text'] as string) : undefined });
      }
      return;
    }
    if (type === 'stt') events.push({ t, kind: 'stt', text: String(msg['text']) });
    else if (type === 'llm') events.push({ t, kind: 'llm' });
    else events.push({ t, kind: 'other_text', text });
  });

  ws.on('close', (code) => {
    if (hungUp) return;
    closedByServer = true;
    serverCloseCode = code;
    log(`[ws] closed by server, code ${code}`);
    onStateSettled?.();
    onHello?.();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`handshake rejected with HTTP ${res.statusCode}`)));
    });
  } catch (err) {
    report.problems.push(`ws: ${(err as Error).message}`);
    return report;
  }
  log(`[ws] open after ${Date.now() - connectStarted} ms`);

  // ---- 3. Hello ---------------------------------------------------------------
  const helloText =
    `{"type":"hello","version":${version},"features":{"mcp":true,"glyph_push":false},` +
    `"transport":"websocket","audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}`;
  const helloSent = Date.now();
  const helloWait = new Promise<void>((resolve) => {
    onHello = resolve;
  });
  ws.send(helloText);
  await Promise.race([helloWait, timeoutAfter(10_000)]);
  onHello = undefined;
  if (!serverHello) {
    report.problems.push('no valid server hello within 10 s: the device would raise "server timeout"');
    hungUp = true;
    ws.terminate();
    return report;
  }
  const sh: Record<string, unknown> = serverHello;
  const sessionId = typeof sh['session_id'] === 'string' ? (sh['session_id'] as string) : '';
  if (/["\\]/.test(sessionId)) report.problems.push('session_id contains a quote or backslash');
  const ap = (typeof sh['audio_params'] === 'object' && sh['audio_params'] !== null ? sh['audio_params'] : {}) as Record<
    string,
    unknown
  >;
  const sampleRate = typeof ap['sample_rate'] === 'number' ? (ap['sample_rate'] as number) : 24000;
  downlinkFrameMs = typeof ap['frame_duration'] === 'number' ? (ap['frame_duration'] as number) : 60;
  report.hello = {
    sessionId,
    transport: sh['transport'],
    sampleRate,
    frameDurationMs: downlinkFrameMs,
    helloMs: Date.now() - helloSent,
  };
  deviceState = 'idle';
  log(`[hello] session_id=${sessionId} downlink ${sampleRate} Hz / ${downlinkFrameMs} ms (${report.hello.helloMs} ms)`);

  // ---- 4. Turns ----------------------------------------------------------------
  let seq = 0;
  let silenceSeq = 0;
  const sendAudio = (packet: Buffer): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeAudioFrame(packet, framing), { binary: true });
  };

  for (let turn = 1; turn <= o.turns && !closedByServer; turn++) {
    const startIndex = events.length;
    droppedNotSpeaking = 0;
    overflow = 0;
    listenMode = o.mode;
    const settled = new Promise<void>((resolve) => {
      onStateSettled = resolve;
    });

    // Listen start is sent before any audio (main/application.cc:1066-1084).
    const needListenStart = turn === 1 || o.mode !== 'realtime';
    if (needListenStart) {
      ws.send(`{"session_id":"${sessionId}","type":"listen","state":"start","mode":"${o.mode}"}`);
    }
    deviceState = 'listening';
    const firstSeq = seq;
    let silenceFrames = 0;
    const paceStart = Date.now();
    let slot = 0;
    const paced = async (): Promise<void> => {
      slot++;
      if (o.paceMs > 0) {
        const wait = paceStart + slot * o.paceMs - Date.now();
        if (wait > 0) await sleep(wait);
      }
    };

    if (o.mode !== 'manual') {
      // Leading silence. After a reply, wait out the server's post-reply guard
      // the way a person would pause before speaking again.
      const prelude = turn === 1 ? 3 : Math.ceil(1_200 / (o.paceMs > 0 ? o.paceMs : 60));
      if (turn > 1 && o.paceMs === 0) await sleep(1_200);
      for (let i = 0; i < prelude; i++) {
        sendAudio(silencePacket(silenceSeq++, o.silenceBytes));
        silenceFrames++;
        await paced();
      }
    }
    for (let i = 0; i < o.frames; i++) {
      sendAudio(speechPacket(seq++, o.frameBytes));
      await paced();
    }

    if (o.mode === 'manual') {
      ws.send(`{"session_id":"${sessionId}","type":"listen","state":"stop"}`);
      deviceState = 'idle'; // StopListening goes to idle (main/application.cc:875-890)
    } else {
      // No listen stop in realtime/auto. Keep streaming silence like the device does;
      // realtime keeps the mic on while speaking, auto stops it (main/application.cc:1041-1050).
      let stopTail = false;
      void settled.then(() => {
        stopTail = true;
      });
      const tailDeadline = Date.now() + o.timeoutMs;
      void (async () => {
        while (!stopTail && Date.now() < tailDeadline && ws.readyState === WebSocket.OPEN) {
          if (o.mode === 'realtime' || !isSpeaking()) {
            sendAudio(silencePacket(silenceSeq++, o.silenceBytes));
            silenceFrames++;
          }
          await sleep(o.paceMs > 0 ? o.paceMs : 60);
        }
      })();
    }

    const timedOut = await Promise.race([settled.then(() => false), timeoutAfter(o.timeoutMs).then(() => true)]);
    onStateSettled = undefined;
    // Let any stray frames after tts stop arrive so they are counted.
    await sleep(Math.max(100, o.scheduleDelayMs * 2));

    const turnEvents = events.slice(startIndex);
    const audio = turnEvents.filter((e) => e.kind === 'audio');
    const ttsStartIdx = turnEvents.findIndex((e) => e.kind === 'tts_start');
    const ttsStopIdx = turnEvents.findIndex((e) => e.kind === 'tts_stop');
    const firstAudioIdx = turnEvents.findIndex((e) => e.kind === 'audio');
    let lastAudioIdx = -1;
    turnEvents.forEach((e, i) => {
      if (e.kind === 'audio') lastAudioIdx = i;
    });
    const sentenceIdx = turnEvents.findIndex((e) => e.kind === 'tts_sentence');
    const speechSeqs = audio.map((e) => speechSeqOf(e.payload!)).filter((s): s is number => s !== undefined);
    const inOrder = speechSeqs.every((s, i) => i === 0 || s > speechSeqs[i - 1]!);
    const isPrefix = speechSeqs.every((s, i) => s === firstSeq + i);

    const problems: string[] = [];
    if (timedOut) problems.push(`no tts stop within ${o.timeoutMs} ms`);
    if (closedByServer) problems.push(`server closed the connection during the turn (code ${serverCloseCode})`);
    if (ttsStartIdx < 0) problems.push('no tts start');
    if (ttsStartIdx >= 0 && ttsStopIdx < 0) problems.push('no tts stop');
    if (firstAudioIdx >= 0 && (ttsStartIdx < 0 || firstAudioIdx < ttsStartIdx)) problems.push('audio before tts start');
    if (audio.length === 0) problems.push('no echoed audio');
    if (speechSeqs.length === 0 && audio.length > 0) problems.push('echoed audio has no speech frames');
    if (!inOrder) problems.push('echoed frames out of order');
    if (!isPrefix) problems.push('echoed speech frames are not a contiguous prefix of what was sent');
    else if (speechSeqs.length > 0 && speechSeqs.length < seq - firstSeq) {
      problems.push(
        `only ${speechSeqs.length} of ${seq - firstSeq} speech frames echoed (server buffer cap ECHO_MAX_BUFFER_MS, or the turn ended early)`,
      );
    }
    if (ttsStopIdx >= 0 && lastAudioIdx > ttsStopIdx) problems.push('audio after tts stop');
    if (droppedNotSpeaking > 0) problems.push(`${droppedNotSpeaking} frames arrived before the device would be speaking`);
    if (overflow > 0) problems.push(`${overflow} frames would overflow the 20-packet decode queue`);
    const sentenceText = sentenceIdx >= 0 ? turnEvents[sentenceIdx]!.text : undefined;
    if (sentenceIdx >= 0 && firstAudioIdx >= 0 && sentenceIdx > firstAudioIdx) problems.push('sentence_start after audio');

    const tr: TurnReport = {
      turn,
      mode: o.mode,
      speechFramesSent: seq - firstSeq,
      silenceFramesSent: silenceFrames,
      firstSeq,
      echoedFrames: audio.length,
      echoedSpeechFrames: speechSeqs.length,
      echoedInOrder: inOrder,
      echoedIsPrefixOfSent: isPrefix,
      ttsStartBeforeAudio: ttsStartIdx >= 0 && (firstAudioIdx < 0 || ttsStartIdx < firstAudioIdx),
      sentenceText,
      sentenceBeforeAudio: sentenceIdx >= 0 && (firstAudioIdx < 0 || sentenceIdx < firstAudioIdx),
      ttsStopAfterAudio: ttsStopIdx >= 0 && ttsStopIdx > lastAudioIdx,
      droppedNotSpeaking,
      queueOverflowDrops: overflow,
      leadGapMs:
        ttsStartIdx >= 0 && firstAudioIdx >= 0 ? turnEvents[firstAudioIdx]!.t - turnEvents[ttsStartIdx]!.t : undefined,
      playbackSpanMs: audio.length > 1 ? audio[audio.length - 1]!.t - audio[0]!.t : undefined,
      ttsStopToEndMs:
        ttsStopIdx >= 0 && lastAudioIdx >= 0 ? turnEvents[ttsStopIdx]!.t - turnEvents[lastAudioIdx]!.t : undefined,
      problems,
    };
    report.turns.push(tr);
    log(
      `[turn ${turn}] sent ${tr.speechFramesSent} speech + ${tr.silenceFramesSent} silence, ` +
        `echoed ${tr.echoedFrames} (${tr.echoedSpeechFrames} speech), in order=${tr.echoedInOrder}, ` +
        `tts start first=${tr.ttsStartBeforeAudio}, sentence=${JSON.stringify(tr.sentenceText)}, ` +
        `lead gap=${tr.leadGapMs} ms, span=${tr.playbackSpanMs} ms, dropped=${tr.droppedNotSpeaking}, overflow=${tr.queueOverflowDrops}` +
        (problems.length ? `, PROBLEMS: ${problems.join('; ')}` : ''),
    );
    report.problems.push(...problems.map((p) => `turn ${turn}: ${p}`));
  }

  // ---- 5. Hang up like the device: TCP close, no close frame ---------------------
  hungUp = true;
  ws.terminate();
  log('[ws] hung up (TCP close, no close frame)');

  report.ok = report.problems.length === 0;
  return report;
}
