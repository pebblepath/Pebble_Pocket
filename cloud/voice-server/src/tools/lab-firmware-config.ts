/**
 * Writes a gitignored lab copy of the board's config.json whose pebble-pocket
 * build points CONFIG_OTA_URL at this Mac. Nothing tracked is modified.
 *
 *   npm run lab-config -- --ota-url http://192.168.1.50:8000/ota/
 *   npm run lab-config -- --ota-url http://192.168.1.50:8000/ota/ --print
 *
 * The output file is config.lab.local next to config.json. `*.local` is
 * ignored by pebble-pocket/.gitignore, and scripts/build.py accepts another
 * config filename with -c/--config (`python scripts/build.py --help`).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const BOARD_DIR_FROM_REPO = 'firmware/xiaozhi/main/boards/waveshare/esp32-s3-touch-amoled-2.06';
const BUILD_NAME = 'pebble-pocket';
export const LAB_CONFIG_FILENAME = 'config.lab.local';

interface BoardConfig {
  builds: Array<{ name: string; sdkconfig_append: string[] }>;
  [key: string]: unknown;
}

export function validateOtaUrl(url: string): string[] {
  const problems: string[] = [];
  if (url.length < 10) problems.push('shorter than 10 characters (main/ota.cc:87-91)');
  if (!/^https?:\/\//i.test(url)) problems.push('must start with http:// or https://');
  if (/["\\\s]/.test(url)) problems.push('must not contain quotes, backslashes or spaces (it becomes an sdkconfig string)');
  if (/^https:/i.test(url)) {
    problems.push('https needs a certificate that chains to the IDF bundle; use plain http:// on the LAN (PROTOCOL.md section 9)');
  }
  return problems;
}

export function makeLabConfig(original: BoardConfig, otaUrl: string): BoardConfig {
  const build = original.builds.find((b) => b.name === BUILD_NAME);
  if (!build) throw new Error(`build "${BUILD_NAME}" not found in config.json`);
  const append = build.sdkconfig_append.filter((line) => !line.startsWith('CONFIG_OTA_URL='));
  append.push(`CONFIG_OTA_URL="${otaUrl}"`);
  return { ...original, builds: [{ ...build, sdkconfig_append: append }] };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      'ota-url': { type: 'string' },
      print: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || !values['ota-url']) {
    process.stdout.write(
      'Usage: npm run lab-config -- --ota-url http://<mac-lan-ip>:<port>/ota/ [--print]\n' +
        `Writes ${BOARD_DIR_FROM_REPO}/${LAB_CONFIG_FILENAME} (gitignored).\n`,
    );
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  const otaUrl = values['ota-url'];
  const problems = validateOtaUrl(otaUrl);
  if (problems.length > 0) {
    process.stderr.write(`Invalid --ota-url:\n  - ${problems.join('\n  - ')}\n`);
    process.exitCode = 2;
    return;
  }
  if (!otaUrl.endsWith('/')) {
    process.stderr.write('Note: the URL does not end with "/". It still works, but "/ota/" is the convention here.\n');
  }
  // dist/tools/lab-firmware-config.js -> package root is ../.., repo root is ../../../..
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..', '..', '..');
  const boardDir = join(repoRoot, BOARD_DIR_FROM_REPO);
  const original = JSON.parse(readFileSync(join(boardDir, 'config.json'), 'utf8')) as BoardConfig;
  const lab = makeLabConfig(original, otaUrl);
  const text = JSON.stringify(lab, null, 4) + '\n';
  if (values.print) {
    process.stdout.write(text);
    return;
  }
  const out = join(boardDir, LAB_CONFIG_FILENAME);
  writeFileSync(out, text);
  process.stdout.write(`Wrote ${out}\n`);
}

main();
