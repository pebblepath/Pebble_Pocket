/**
 * CLI for the fake device. Run `npm run fake-device -- --help`.
 */

import { parseArgs } from 'node:util';
import { defaultFakeDeviceOptions, runFakeDevice } from './fake-device-lib.js';
import type { ListenMode } from '../protocol/messages.js';

const HELP = `Usage: npm run fake-device -- [options]

Mimics the pebble-pocket firmware end to end against a running voice server:
OTA request, WebSocket connect with the firmware's headers, hello, listen start,
N dummy binary frames, listen stop (manual mode), then receives and checks the echo.

Options:
  --ota-url <url>        OTA URL (default: $OTA_URL or http://localhost:$PORT/ota/, PORT defaults to 8000)
  --mode <m>             manual | realtime | auto (default: manual)
  --frames <n>           speech frames per turn (default: 40, i.e. 2.4 s)
  --turns <n>            turns on the same connection (default: 1)
  --frame-bytes <n>      size of each dummy speech packet (default: 32)
  --silence-bytes <n>    size of each dummy silence packet in realtime/auto (default: 3)
  --pace-ms <n>          uplink pacing, 0 = as fast as possible (default: 60)
  --schedule-delay-ms <n> modeled main-task delay after tts start/stop (default: 30)
  --timeout-ms <n>       per-step timeout (default: 30000)
  --json                 print the full report as JSON at the end
  -h, --help             show this help

Exit code 0 when every check passes, 1 otherwise.`;

function intArg(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    process.stderr.write(`--${name} must be a non-negative integer\n`);
    process.exit(2);
  }
  return Number(value);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'ota-url': { type: 'string' },
      mode: { type: 'string' },
      frames: { type: 'string' },
      turns: { type: 'string' },
      'frame-bytes': { type: 'string' },
      'silence-bytes': { type: 'string' },
      'pace-ms': { type: 'string' },
      'schedule-delay-ms': { type: 'string' },
      'timeout-ms': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(HELP + '\n');
    return;
  }
  const d = defaultFakeDeviceOptions();
  const mode = (values.mode ?? 'manual') as ListenMode;
  if (mode !== 'manual' && mode !== 'realtime' && mode !== 'auto') {
    process.stderr.write('--mode must be manual, realtime or auto\n');
    process.exit(2);
  }
  const otaUrl =
    values['ota-url'] ?? process.env['OTA_URL'] ?? `http://localhost:${process.env['PORT'] ?? '8000'}/ota/`;

  const report = await runFakeDevice({
    otaUrl,
    mode,
    frames: intArg(values.frames, 'frames', d.frames),
    turns: Math.max(1, intArg(values.turns, 'turns', d.turns)),
    frameBytes: intArg(values['frame-bytes'], 'frame-bytes', d.frameBytes),
    silenceBytes: intArg(values['silence-bytes'], 'silence-bytes', d.silenceBytes),
    paceMs: intArg(values['pace-ms'], 'pace-ms', d.paceMs),
    scheduleDelayMs: intArg(values['schedule-delay-ms'], 'schedule-delay-ms', d.scheduleDelayMs),
    timeoutMs: intArg(values['timeout-ms'], 'timeout-ms', d.timeoutMs),
  });

  if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.ok) {
    process.stdout.write(`RESULT: PASS (${report.turns.length} turn(s), framing v${report.framing})\n`);
  } else {
    process.stdout.write(`RESULT: FAIL\n  - ${report.problems.join('\n  - ')}\n`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stdout.write(`RESULT: FAIL\n  - ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
