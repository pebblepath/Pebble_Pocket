# Pebble Pocket voice server (local, echo mode)

A small Node 24 + TypeScript server that the `pebble-pocket` firmware can talk to: the OTA/config endpoint and the WebSocket voice session described in [`PROTOCOL.md`](PROTOCOL.md). Today it runs in **echo mode**: whatever the Pocket records in a turn is played back to it as the "reply", so the whole audio path (mic, Opus up, WebSocket, Opus down, speaker) can be proven on the bench before any speech-to-text, Claude or text-to-speech exists.

Status on 2026-09-12: built and tested only against the fake device in this folder. **Nothing has run against the real board yet** (it arrives 2026-09-14).

- Runtime dependency: `ws` only. No framework, no cloud SDKs, no API keys, nothing that calls the internet.
- Cloud Run shaped: listens on `PORT`, one independent session per connection (no shared state), one JSON log line per event on stdout, graceful shutdown on `SIGTERM`. It has not been deployed anywhere.

## Contents

- [Run it locally](#run-it-locally)
- [Environment variables](#environment-variables)
- [What the server does](#what-the-server-does)
- [Monday echo test (pointing a real Pocket at the Mac)](#monday-echo-test-pointing-a-real-pocket-at-the-mac)
- [Where STT, Claude and TTS plug in](#where-stt-claude-and-tts-plug-in)
- [Known gaps](#known-gaps)

## Run it locally

```bash
cd ~/Desktop/PebblePath/pebble-pocket/cloud/voice-server
npm install            # installs ws, plus typescript and type packages for the build
npm run build          # cleans dist/ and compiles src/ with tsc
npm start              # node dist/index.js, listens on 0.0.0.0:8000 by default
```

In a second terminal:

```bash
npm test               # builds, then runs every node:test file in dist/test (about 30 s)
npm run fake-device    # mimics the firmware against http://localhost:8000/ota/
```

`npm run fake-device -- --help` lists its options. Useful ones:

```bash
npm run fake-device -- --mode realtime --frames 20 --turns 2   # what today's firmware build actually does
npm run fake-device -- --ota-url http://192.168.1.50:8000/ota/ # go through the LAN address, like the board
npm run fake-device -- --json                                  # full report
```

The fake device does what the firmware does, step by step: POSTs the OTA request with the firmware's headers, checks the response for the device-bricking hazards (exact 200, only `url`/`token`/`version` keys, numeric `version`, no `mqtt`/`activation`/`firmware`, explicit port), connects with `Authorization`, `Protocol-Version`, `Device-Id`, `Client-Id` and a `Host` header without the port, sends the firmware's hello byte for byte, sends `listen start`, streams numbered dummy frames every 60 ms, sends `listen stop` (manual mode), then models the device: audio counts only after `tts start` has been "scheduled" (30 ms by default), a 20-packet decode queue that drops on overflow, and a hang-up by TCP close without a close frame. It exits 0 only when the echo comes back complete, in order, after `tts start`, before `tts stop`, with no frame the real device would have dropped.

Other scripts: `npm run lab-config` (see the Monday section) and `npm run clean`.

## Environment variables

All optional. Invalid values stop the server at startup with a `config_error` log line, because several of them are written into the device's NVS through the OTA response.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8000` | Listen port. Cloud Run sets it. |
| `HOST` | `0.0.0.0` | Bind address. `0.0.0.0` so devices on the LAN can reach it. |
| `PUBLIC_WS_URL` | `ws://localhost:<PORT>/ws` | The WebSocket URL handed to the device in the OTA response. **The default only works for the fake device on the same Mac**; set it to the Mac's LAN address for a real board. Must be `ws://` or `wss://`, have an explicit numeric port, and have no `:` in the path or query, because the firmware takes the first `:` after `://` as the port separator and passes it to `std::stoi` (`esp-ml307/src/web_socket.cc:69-109`, `:135`). The server accepts the WebSocket upgrade on this URL's path. |
| `POCKET_DEV_TOKEN` | random per process | Token returned in the OTA response and required as `Authorization: Bearer <token>` on the upgrade. **Not a secret:** `/ota/` hands it to any client that asks (see [Known gaps](#known-gaps)). Printable ASCII only (`!` to `~`), checked at startup: a token with a space is sent without `Bearer` (`main/protocols/websocket_protocol.cc:97-103`), and a non-ASCII token is sent as raw UTF-8 bytes, which Node reads back as latin1, so it would fail every upgrade with 401. If unset, a random token is generated at each start, and a device that booted earlier will be rejected until it reboots (it fetches the token once per boot, `main/application.cc:288-308`). **Set it for bench work.** |
| `WS_PROTOCOL_VERSION` | `1` | Binary framing version returned as `websocket.version`: 1 raw Opus, 2 or 3 with headers (PROTOCOL.md section 5). The server frames audio by the device's `Protocol-Version` header and logs a warning if the two differ. |
| `RESPONDER` | `echo` | Only `echo` exists. |
| `ECHO_MAX_BUFFER_MS` | `20000` | Hard cap on audio buffered per turn. Manual mode keeps the first 20 s and drops the rest; realtime and auto modes end the turn when the cap is reached. |
| `ECHO_MAX_BUFFER_BYTES` | `1048576` | Byte cap per turn, in case of oversized frames. |
| `ECHO_DOWNLINK_SAMPLE_RATE` | uplink rate (16000) | Sample rate announced in the server hello. See the Monday tuning notes. |
| `TTS_START_LEAD_MS` | `100` | Pause between `tts start` and the first audio frame. PROTOCOL.md section 6 rule 2 calls 100 ms a margin, not a measurement. |
| `PREBUFFER_FRAMES` | `3` | Frames sent back to back before strict one-per-60 ms pacing. Also used again after the reply source falls behind real time (see step 4 below). |
| `TIMEZONE_OFFSET_MINUTES` | unset | Whole minutes east of UTC, from `-720` to `840`, sent as `server_time.timezone_offset`. The firmware adds it to the clock before `settimeofday` (`main/ota.cc:193-211`), and the idle status bar shows that clock as HH:MM (`main/display/lvgl_display/lvgl_display.cc:218-228`). Unset means the Pocket shows UTC. It is a fixed offset: it does not follow daylight saving changes. Takes effect at the next board boot. |
| `ENDPOINT_MODE` | `silence` | How a turn ends in realtime and auto modes, which never send `listen stop`: `silence` or `window`. |
| `ENDPOINT_SILENCE_MAX_BYTES` | `10` | Silence mode: Opus packets this small or smaller count as silence (an unverified DTX heuristic, tune it from the logs). |
| `ENDPOINT_SILENCE_MS` | `720` | Silence mode: trailing silence that ends a turn. |
| `ENDPOINT_MIN_SPEECH_MS` | `240` | Silence mode: less speech than this is discarded as a click. |
| `ENDPOINT_WINDOW_MS` | `6000` | Window mode: turn length. Silence mode: longest turn if silence is never detected. |
| `ENDPOINT_GUARD_MS` | `600` | Realtime mode: uplink ignored for this long after `tts stop`, because queued audio keeps playing and the mic stays on. |
| `HELLO_TIMEOUT_MS` | `10000` | Close a connection that never sends a hello. |
| `IDLE_TIMEOUT_MS` | `600000` | Close a connection with no inbound frames for this long. |
| `PING_INTERVAL_MS` | `30000` | WebSocket ping cadence; a missed pong terminates the socket. `0` disables. |
| `SHUTDOWN_GRACE_MS` | `8000` | On `SIGTERM`/`SIGINT`, how long to wait for sessions to close before forcing. |
| `MAX_PROTOCOL_ERRORS` | `50` | Malformed messages tolerated per connection before closing with 1008. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

## What the server does

### Endpoints

| Path | Behaviour |
|---|---|
| `POST` or `GET /ota/` and `/ota` | `200` with `{"websocket":{"url","token","version"},"server_time":{"timestamp"}}`, plus `server_time.timezone_offset` when `TIMEZONE_OFFSET_MINUTES` is set. No credentials are checked, so anyone who can reach the port gets the token. Never a redirect (the firmware does not follow them, PROTOCOL.md 1.3). No `mqtt`, `activation` or `firmware`. The request body is only logged (app version, board name, IP, RSSI). |
| `POST /ota/activate` | `200 {}` with a warning log. Never expected, since activation is omitted. |
| `GET /health` | `200 {"status":"ok"}`, `503` while shutting down. Not `/healthz`: Cloud Run reserves some paths ending in `z`. |
| A request target Node accepts but WHATWG URL cannot parse (for example `GET http://999.999.999.999/`) | `400`, on plain requests and upgrades alike. |
| WebSocket upgrade on the `PUBLIC_WS_URL` path (`/ws`) | `401` without the right Bearer token, `404` on other paths, otherwise `HTTP/1.1 101 Switching Protocols` from `ws` (`node_modules/ws/lib/websocket-server.js:392`), which contains the literal `HTTP/1.1 101` the firmware looks for (`esp-ml307/src/web_socket.cc:295-309`). No subprotocol is required. |

### Session

1. **Hello.** On the device hello (transport must be `websocket`), the server replies with `transport: "websocket"`, a UUID `session_id` (no quotes or backslashes, PROTOCOL.md 3.2) and all of `audio_params`. In echo mode the downlink is announced at the uplink format, 16000 Hz and 60 ms, so packets are replayed unchanged. That is the same decode path the firmware uses for its own audio-testing loopback, which stamps recorded packets as 16000 Hz (`main/audio/audio_service.cc:474`) and decodes them with a resampler to the 24 kHz speaker (`main/audio/audio_service.cc:409`, `:532-566`).
2. **Listening.** `listen start` arms a turn buffer in the announced mode. Binary frames before the hello, malformed JSON, bad states and bad v2/v3 headers are logged as protocol errors and dropped; unknown message types, `mcp` and `detect` are logged and ignored.
3. **End of turn.**
   - `manual`: `listen stop` ends the turn.
   - `realtime` and `auto` (today's firmware never sends `listen stop`, PROTOCOL.md 4.2): the silence heuristic, the window, or the buffer cap ends the turn. Leading and trailing silence are trimmed to two frames each.
4. **Reply.** `tts start`, a 100 ms pause, `tts` `sentence_start` with text `(echo)`, then the buffered packets in arrival order, the first three back to back and then one every 60 ms (the device decode queue holds 20 packets and drops when full, `main/audio/audio_service.h:43`, `main/audio/audio_service.cc:609-620`), then `tts stop`. The schedule tracks how many frames the device should still have queued. Lateness of up to one frame is absorbed. If the reply source falls further behind (a future TTS that is slow on a sentence), the device queue has run dry, so the server starts a fresh three-frame lead from the current time instead of sending every overdue frame at once. `reply_end` counts these as `underruns`. Uplink that arrives while replying is ignored, because realtime mode keeps the mic on (`main/application.cc:1041-1050`).
5. **Abort.** `abort` stops the reply and still sends `tts stop`, since the device otherwise stays in speaking (`main/application.cc:1170-1176`). The server stops waiting on the responder as soon as the abort arrives, so a responder that is slow to notice cannot delay `tts stop`. If a new turn ends before the aborted reply has finished unwinding, the new reply waits for it, so the old `tts stop` always goes out before the new `tts start` (PROTOCOL.md section 6, rule 7).
6. **After the reply.** Manual returns to "ready" and waits for the next `listen start` on the same socket; realtime and auto keep listening.
7. **Hang-up.** A TCP close without a close frame (how the device hangs up, `main/protocols/websocket_protocol.cc:74-77`) is logged as `ws_closed` with `closeFrame: false` and is normal. When the server closes, it sends a close frame and drops TCP one second later, because the device never answers a close frame (`esp-ml307/src/web_socket.cc:386-391`).

### Logs

One JSON object per line: `severity`, `message`, `time`, plus fields. The useful ones on the bench: `listening` (including `lanAddresses`), `ota_request`, `ws_rejected`, `ws_connected`, `hello`, `listen_start`, `uplink_stats` (packet sizes every 5 s in realtime/auto), `turn_end` (reason, packet count and sizes), `reply_end` (including `underruns`), `protocol_error`, `ws_closed`. Tokens and audio are never logged. Strings that come from the device or an HTTP client (detect text, unknown message types, abort reasons, headers, OTA body fields) are cut to 120 characters, and the hello `features` object to a 256-character preview, so one message cannot produce a huge log line.

## Monday echo test (pointing a real Pocket at the Mac)

The flashed build's OTA URL is `https://pocket-ota.invalid/ota/` (`firmware/xiaozhi/sdkconfig:970`), which never resolves. Plain `http://` and `ws://` are accepted by the firmware on a LAN: TLS is used only for `https` and `wss` (`esp-ml307/src/http_client.cc:200-204`, `esp-ml307/src/web_socket.cc:127-131`). Token and audio then travel unencrypted, which is fine for a bench test only.

### 1. Put the Mac and the Pocket on the same network

- The board has 2.4 GHz Wi-Fi only (HANDOFF.md section 2), so the network must offer 2.4 GHz.
- HANDOFF.md section 11: the firmware joins a phone hotspot or a guest network during bench work, and home Wi-Fi only once it talks to nothing but PebblePath's own server.
- **Phone hotspot** (recommended): join the Mac to the same hotspot. Not verified: whether your phone's hotspot lets two clients reach each other. If the fake-device check in step 4 passes from the Mac but the board never shows up in the server logs, that is the first suspect.
- **Guest network**: many guest networks isolate clients from each other, which would block the Pocket from reaching the Mac (not verified for yours).
- **Home network**: works the same way, if you decide the bench build qualifies.
- The Mac's address changes when you switch networks, and the address is baked into the OTA URL on the device. Redo steps 2 to 5 after switching.

### 2. Find the Mac's LAN IP

```bash
ipconfig getifaddr en0
```

On 2026-09-12 this printed `192.168.68.60` on the home network; it will be different on a hotspot. The server also prints every IPv4 address in its `listening` log line (`lanAddresses`) and suggests the exact URLs in `public_ws_url_default` when `PUBLIC_WS_URL` is not set. Below, `<ip>` means this address.

### 3. Start the server with the LAN URL and a fixed token

```bash
cd ~/Desktop/PebblePath/pebble-pocket/cloud/voice-server
npm install && npm run build
PORT=8000 POCKET_DEV_TOKEN=pocket-bench-1 PUBLIC_WS_URL=ws://<ip>:8000/ws TIMEZONE_OFFSET_MINUTES=-300 npm start
```

`TIMEZONE_OFFSET_MINUTES=-300` makes the Pocket's idle clock show Chicago time in September (CDT, UTC-5). Without it the clock shows UTC. To print the Mac's current offset in minutes:

```bash
node -e "console.log(-new Date().getTimezoneOffset())"
```

On 2026-09-12 this printed `-300`. The offset is fixed, so after daylight saving ends (CST, UTC-6) it has to change to `-360`.

### 4. Check the path from the Mac, through the LAN address

```bash
npm run fake-device -- --ota-url http://<ip>:8000/ota/ --mode realtime --frames 20
```

It must print `RESULT: PASS`.

**macOS firewall.** Check it with:

```bash
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
```

On 2026-09-12 it printed `Firewall is disabled. (State = 0)`, so nothing blocks the port. If it says enabled, macOS may ask whether `node` should accept incoming network connections when the server starts: choose Allow. `socketfilterfw --getappblocked "$(which node)"` shows whether node is blocked. The fake device on the same Mac does not prove the firewall is open to other machines; only the board (or another device) reaching `http://<ip>:8000/health` does.

### 5. Point the Pocket at the Mac

Pick one option. **Do not commit anything** for either.

**Option A: no rebuild (the setup hotspot).** The firmware's Wi-Fi setup page has a Custom OTA URL field for Wi-Fi boards (`main/boards/common/wifi_board.cc:59`, `managed_components/78__esp-wifi-connect/assets/wifi_configuration.html:551-553`) that saves NVS `wifi/ota_url` (`managed_components/78__esp-wifi-connect/wifi_configuration_ap.cc:596-612`), and that value wins over the built-in URL (`main/ota.cc:48-55`).

1. Get the board into setup mode. It enters it on its own when no Wi-Fi is saved (`main/boards/common/wifi_board.cc:101-114`) or after 60 s of failing to connect (`main/boards/common/wifi_board.cc:27`, `:162-168`). A BOOT click while the board is still starting also enters it (`main/boards/waveshare/esp32-s3-touch-amoled-2.06/esp32-s3-touch-amoled-2.06.cc:204-208`).
2. On the phone, join the Wi-Fi network named `Xiaozhi-XXXX` (prefix from `wifi_board.cc:57`, last two MAC bytes appended in `wifi_configuration_ap.cc:115-125`).
3. Open `http://192.168.4.1` (`wifi_configuration_ap.cc:131-145`).
4. Open the **Advanced** tab, enter `http://<ip>:8000/ota/` in **Custom OTA URL**, tap **Save** (`wifi_configuration.html:511`, `:546-597`).
5. Back on the main tab, pick the hotspot or home network, enter its password, **Connect**.

**Option B: a local lab build.** `scripts/build.py` accepts another config filename with `-c/--config` (`python scripts/build.py --help`), and `*.local` files are ignored by `pebble-pocket/.gitignore:5`.

```bash
cd ~/Desktop/PebblePath/pebble-pocket/cloud/voice-server
npm run lab-config -- --ota-url http://<ip>:8000/ota/
# writes firmware/xiaozhi/main/boards/waveshare/esp32-s3-touch-amoled-2.06/config.lab.local

export PATH=/opt/homebrew/bin:$PATH; . ~/esp/esp-idf/export.sh
cd ~/Desktop/PebblePath/pebble-pocket/firmware/xiaozhi
python scripts/build.py waveshare/esp32-s3-touch-amoled-2.06 --config config.lab.local \
  --name pebble-pocket --language en-US --wake-word disabled
idf.py -p /dev/cu.<port> flash monitor
```

Notes for option B:

- `npm run lab-config -- --ota-url ... --print` shows the file without writing it. It copies the `pebble-pocket` build from `config.json` and replaces only `CONFIG_OTA_URL`.
- On 2026-09-12, `python scripts/build.py --list-boards --config config.lab.local --json` found the lab variant (`waveshare-pebble-pocket`) and `git check-ignore` confirmed the file is ignored; the lab build itself has not been run.
- A Custom OTA URL saved earlier through option A still wins over the built-in URL (`main/ota.cc:48-55`). Clear the field in the setup page if you switch to option B.
- The build regenerates `firmware/xiaozhi/sdkconfig` and `build/` (both gitignored, `firmware/xiaozhi/.gitignore`). PROTOCOL.md cites line numbers in `sdkconfig`, so rebuild the normal `pebble-pocket` variant afterwards. `git status` should show no new tracked changes.

### 6. Boot and watch both logs

- Server: an `ota_request` line with `userAgent: "pebble-pocket/2.5.0"`, the board's IP and RSSI, and `wsUrl` equal to your LAN URL. A `ota_public_ws_url_is_loopback` warning means `PUBLIC_WS_URL` was not set: fix it, restart the server, **reboot the board** (the OTA check runs once per boot, `main/application.cc:288-308`).
- If the OTA request fails on every retry, the device falls back to MQTT for the whole boot (`main/ota.cc:99-112`, `main/application.cc:372-375`). Fix the server, then reboot the board.
- Serial monitor lines worth knowing: `Failed to check version, status code: N` (`main/ota.cc:110`), `No websocket section found!` (`main/ota.cc:190`), `Connecting to websocket server: ws://... with version: 1` (`main/protocols/websocket_protocol.cc:168`, printed on the BOOT click, since the socket opens only when a session starts), `Session ID: ...` (`:239`), `Failed to receive server hello` (`:187`).
- A `ws_rejected` line with `bad token` means the server's token changed since the board booted. Use a fixed `POCKET_DEV_TOKEN` and reboot the board.

### 7. The test

1. Press **BOOT** once. This build has no push-to-talk: the click toggles the chat (`esp32-s3-touch-amoled-2.06.cc:203-211`) and the session runs in **realtime** mode because `CONFIG_USE_DEVICE_AEC=y` (`main/application.cc:26-34`, `:1183-1185`). The server logs `ws_connected`, `hello`, `listen_start` with `mode: "realtime"`.
2. Say a short sentence, then pause for about a second. The server logs `turn_end` with `reason: "silence"` (or `"window"` after 6 s if silence was not detected), and the Pocket should play your voice back and show `(echo)`.
3. Repeat as often as you like; the device keeps listening between turns.
4. To hang up, press **BOOT** while the Pocket is **listening**. The server logs `ws_closed` with `closeFrame: false` (`main/application.cc:812-813`). A press **while the echo is playing** only interrupts it: the device sends `abort` and stays connected (`main/application.cc:810-811`), the server logs `abort` then `reply_end` with `aborted: true` and sends `tts stop`, and the device goes back to listening (`main/application.cc:628-637`), so your next sentence is echoed again. Press BOOT a second time, once it is listening, to hang up.
5. Optional: double-click BOOT while idle to switch the next session to **auto** mode (`esp32-s3-touch-amoled-2.06.cc:224-231`); the device then resends `listen start` after each reply. Manual mode (`listen stop`) is not wired to a button in today's build (PROTOCOL.md 4.2), so only the fake device exercises it.

### 8. If something sounds wrong

| Symptom | Try |
|---|---|
| Every `turn_end` says `window`, never `silence` | Look at `uplink_stats` while you are quiet: set `ENDPOINT_SILENCE_MAX_BYTES` a little above the silent packet size, or give up on the heuristic with `ENDPOINT_MODE=window ENDPOINT_WINDOW_MS=4000`. |
| Echo starts before you finished talking | Raise `ENDPOINT_SILENCE_MS` (for example `1200`). |
| First syllable of the echo is missing | Raise `TTS_START_LEAD_MS` (for example `250`). |
| Echo stutters or has gaps | Raise `PREBUFFER_FRAMES` (for example `6`, still well under the 20-packet queue). |
| Echo is distorted | Try `ECHO_DOWNLINK_SAMPLE_RATE=24000`: the device then skips resampling (`main/audio/audio_service.cc:553`) and decodes the 16 kHz packets at 24 kHz. Whether the device's Opus decoder handles that is **not verified**: its implementation is a binary library, and its header does not say. |
| Echo triggers itself in a loop | Raise `ENDPOINT_GUARD_MS`; the device's echo cancellation should normally remove its own playback. |
| Nothing plays but logs look right | Check the serial monitor for `Failed to create audio decoder` (`main/audio/audio_service.cc:543-547`). |

After changing server variables, restart the server. Only `PUBLIC_WS_URL`, `POCKET_DEV_TOKEN`, `WS_PROTOCOL_VERSION` and `TIMEZONE_OFFSET_MINUTES` need a board reboot, because they travel in the OTA response; the rest apply to the next BOOT click.

## Where STT, Claude and TTS plug in

- `src/pipeline/types.ts` defines `TurnResponder` (turn in, `ReplyEvent`s out: `transcript`, `emotion`, `sentence`, `audio`) and three provider interfaces, `SpeechToText`, `ConversationModel` and `TextToSpeech`.
- `src/pipeline/echo.ts` is the only responder in use.
- `src/pipeline/pipeline.ts` composes the three providers into a responder (transcript to `stt`, each sentence to `sentence_start` followed by its audio). It is exercised only with fakes in `src/test/units.test.ts`. **No provider is implemented.**
- `src/session.ts` owns everything on the wire (framing, hello, `tts start`/`stop`, the lead gap, pacing, abort), so a provider never has to know the protocol. A real TTS must yield raw Opus packets at exactly the announced rate and 60 ms frame duration (the pipeline announces 24000 Hz to match the speaker, `main/boards/waveshare/esp32-s3-touch-amoled-2.06/config.h:7`).

Source layout:

```
src/
  index.ts                 entry: env, listen, LAN hints, SIGTERM
  config.ts                env parsing and device-safety validation
  log.ts                   JSON logger
  server.ts                HTTP (OTA, health) and WebSocket upgrade with auth
  session.ts               per-connection protocol state machine and paced replies
  protocol/messages.ts     device message parsing, server message builders
  protocol/binary.ts       v1/v2/v3 audio framing
  pipeline/types.ts        responder and provider interfaces (the seam)
  pipeline/echo.ts         echo responder
  pipeline/pipeline.ts     STT -> model -> TTS composition (no providers)
  pipeline/turn.ts         turn buffering, caps and endpointing
  tools/fake-device*.ts    firmware mimic (CLI and library)
  tools/lab-firmware-config.ts  writes the gitignored lab board config
  test/*.test.ts           node:test suites (compiled to dist/test)
```

## Known gaps

- Nothing has been tried on the real board. The fake device models the firmware from source reading, including a guessed 30 ms scheduling delay.
- The silence heuristic assumes silent stretches arrive as tiny DTX packets. Their real size on this board is unknown (PROTOCOL.md section 12).
- The echo is replayed at the uplink's 16 kHz, which makes the device resample to 24 kHz and log a distortion warning (`main/application.cc:559-567`). Real TTS will use 24 kHz.
- The server never sends JSON traffic during long silent realtime sessions, so after 120 s without server messages the device treats the channel as timed out for its next session (`main/protocols/protocol.cc:108-117`). Harmless for echo, since realtime sessions stay on one socket.
- No barge-in: speech during a reply is ignored, not treated as an interruption.
- **The token does not authenticate anything.** `/ota/` accepts GET or POST with no credentials, no Device-Id check and no rate limit, and returns the token to anyone who asks, so the Bearer check on the upgrade only stops clients that skip `/ota/`. There is also no cap on concurrent sessions, and each session can buffer up to `ECHO_MAX_BUFFER_BYTES` per turn. Acceptable on a trusted LAN bench only. Before any deployment beyond one: gate `/ota/` on a per-device credential (for example an allowlist of Device-Id plus Serial-Number, or a provisioning secret), issue short-lived per-device tokens, refuse GET, and add a concurrent-session cap and a per-IP rate limit.
- Tokens are compared per server instance and never expire.
- Binary frames refresh the idle timer in any state, so a client holding the token can keep a session open by streaming frames that are never used.
- `TIMEZONE_OFFSET_MINUTES` is a fixed offset. The firmware applies it by shifting the system clock rather than setting a time zone (`main/ota.cc:204-211`), so anything on the device that reads absolute time sees local time as if it were UTC.
- Cloud Run, not tried: (1) Cloud Run applies its request timeout to WebSocket connections, 5 minutes by default and 60 at most (docs.cloud.google.com/run/docs/triggering/websockets). A realtime session stays on one socket for its whole life, so a deploy must raise the request timeout (up to 3600 s), and sessions longer than that timeout will still be cut. The device does not reconnect on its own (PROTOCOL.md section 8); the user would have to press BOOT again. (2) The health check moved to `/health` because Cloud Run reserves some paths ending in `z` (docs.cloud.google.com/run/docs/known-issues). (3) `wss://` has not been tried; whether Cloud Run's certificate chains to the firmware's CA bundle is an open question in PROTOCOL.md section 9.
