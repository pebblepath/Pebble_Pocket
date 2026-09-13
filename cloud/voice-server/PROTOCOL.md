# Pebble Pocket voice server: the wire contract (WebSocket transport)

This is the exact contract a server must implement so that the Pebble Pocket firmware, as it is built today, can fetch its configuration, open a voice session, stream microphone audio up and play speech back. It was written on 2026-09-12 by reading the firmware source, not only the upstream docs. Nothing here has been tested on hardware yet (the board arrives 2026-09-14).

**Source snapshot.** `firmware/xiaozhi` in this repo: the xiaozhi-esp32 subtree imported at upstream `563a4f0`, plus local commits `e51d318` (pebble-pocket variant) and `dadd3a0` (haptics). Build variant `pebble-pocket` for board `waveshare/esp32-s3-touch-amoled-2.06`, as configured in `build/xiaozhi-build.sdkconfig.defaults` and the generated `sdkconfig` of the last build.

**How to read the citations.**

- Plain paths such as `main/ota.cc:109` are relative to `firmware/xiaozhi/`.
- `esp-ml307/...` means `firmware/xiaozhi/managed_components/78__esp-ml307/` (version 3.7.2, `idf_component.yml:22`). This is the component that implements the HTTP client, TCP, TLS and WebSocket code. It is downloaded at build time and is gitignored (`firmware/xiaozhi/.gitignore:3`), so the line numbers refer to the copy on disk today.
- `wifi-connect/...` means `firmware/xiaozhi/managed_components/78__esp-wifi-connect/` (3.3.1). `audio-codec/...` means `firmware/xiaozhi/managed_components/espressif__esp_audio_codec/` (2.5.0).
- `IDF:...` means `~/esp/esp-idf/components/...` (ESP-IDF v6.1).
- Statements marked **Recommendation** are my advice for the server, not firmware behaviour.

---

## 0. Build facts that shape the protocol

| Setting (from `sdkconfig`) | Value | Protocol consequence |
|---|---|---|
| `CONFIG_OTA_URL` (line 970) | `https://pocket-ota.invalid/ota/` | The config endpoint. Placeholder that never resolves, so today the device reaches no server (section 9 explains how to point it at a LAN server). |
| `CONFIG_USE_DEVICE_AEC=y` (1144) | on | Default listening mode is **realtime**, not manual (section 4). |
| `CONFIG_USE_SERVER_AEC` (1146) | not set | Hello does not advertise `"aec"`; uplink v2 timestamps stay 0 unless the server sends timestamps. |
| `CONFIG_WAKE_WORD_DISABLED=y` (1139) | on | `listen` with `state:"detect"` is never sent. |
| `CONFIG_RECEIVE_CUSTOM_MESSAGE` (1160) | not set | `type:"custom"` messages are ignored. |
| `CONFIG_USE_HOTSPOT_WIFI_PROVISIONING=y` (1154) | on | The Wi-Fi setup page can override the OTA URL (section 9). |
| `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_FULL=y` (3477), `CONFIG_MBEDTLS_SSL_PROTO_TLS1_2=y` (3502), TLS 1.3 not set (3504) | | `https://` and `wss://` need a certificate that chains to the bundle; TLS 1.2 only. |
| `PROJECT_VER` | `2.5.0` (`CMakeLists.txt:12`) | Firmware version the device reports. |
| `BOARD_NAME` | `pebble-pocket` (`build/compile_commands.json`) | Prefix of `User-Agent`. |

Audio constants: uplink Opus 16 kHz mono, 60 ms frames (`main/audio/audio_service.h:40`, `main/audio/audio_service.h:67-80`); the I2S codec runs at 24 kHz in and out (`main/boards/waveshare/esp32-s3-touch-amoled-2.06/config.h:6-7`).

### Session at a glance

```
boot, Wi-Fi up
  POST {OTA_URL}                         -> 200 JSON with "websocket" {url, token, version}
  (optional) POST {OTA_URL}activate      -> 202 pending / 200 done
idle
BOOT click
  WebSocket connect (headers: Authorization, Protocol-Version, Device-Id, Client-Id)
  device: {"type":"hello",...}
  server: {"type":"hello","transport":"websocket",...}          (within 10 s)
  device: {"type":"listen","state":"start","mode":"realtime"}
  device: binary Opus frames, every 60 ms, continuously
  server: {"type":"stt","text":"..."}                           (optional, display only)
  server: {"type":"tts","state":"start"}
  server: {"type":"tts","state":"sentence_start","text":"..."}  (optional, display only)
  server: binary Opus frames, paced in real time
  server: {"type":"tts","state":"stop"}
  ... device keeps streaming, next turn ...
BOOT click while listening -> device closes the TCP socket (no close frame, no "stop")
```

---

## 1. The OTA / config HTTP request

### 1.1 URL

- The URL is NVS key `wifi/ota_url` if set, otherwise `CONFIG_OTA_URL` (`main/ota.cc:48-55`).
- If the URL is shorter than 10 characters the check fails with "not properly set" (`main/ota.cc:87-91`).
- The HTTP client parses `scheme://host[:port]/path`. The default port is 443 for `https`, 80 otherwise, and the path defaults to `/` (`esp-ml307/src/http_client.cc:58-116`).
- For the pebble build the request line is `POST /ota/ HTTP/1.1`.

### 1.2 Request

**Method.** `POST` when the system-info JSON is non-empty, otherwise `GET` (`main/ota.cc:95-97`). The body is always non-empty in practice (`main/boards/common/board.cc:61-173`), so expect **POST**.

**Headers**, set in `main/ota.cc:57-74` plus the ones the HTTP client adds (`esp-ml307/src/http_client.cc:119-170`):

| Header | Value | Source |
|---|---|---|
| `Host` | `host` (plus `:port` when non-default) | `http_client.cc:126-130` |
| `Activation-Version` | `"2"` if eFuse `USER_DATA` holds a serial number, else `"1"` | `ota.cc:31-42`, `ota.cc:62` |
| `Device-Id` | Wi-Fi STA MAC, lowercase, colon separated, for example `aa:bb:cc:dd:ee:ff` | `ota.cc:63`, `main/system_info.cc:35-47` |
| `Client-Id` | UUID v4 generated once and stored in NVS `board/uuid`; it changes if NVS is erased | `ota.cc:64`, `main/boards/common/board.cc:14-43` |
| `Serial-Number` | only sent when a serial number exists in eFuse | `ota.cc:65-68` |
| `User-Agent` | `pebble-pocket/2.5.0` (`BOARD_NAME "/" version`) | `ota.cc:69`, `system_info.cc:53-57` |
| `Accept-Language` | `en-US` (`Lang::CODE`) | `ota.cc:70` |
| `Content-Type` | `application/json` | `ota.cc:71` |
| `Content-Length` | body length | `http_client.cc:141-142` |
| `Connection` | `close` (keep-alive is off by default) | `http_client.cc:152-158`, `esp-ml307/include/http_client.h:122` |

A fresh Waveshare board almost certainly has an empty `USER_DATA` eFuse, so expect `Activation-Version: 1` and no `Serial-Number`. This is not verified on the unit.

**Body** (`main/boards/common/board.cc:101-172`, board part in `main/boards/common/wifi_board.cc:265-277`). The shape:

```json
{
  "version": 2,
  "language": "en-US",
  "flash_size": 33554432,
  "minimum_free_heap_size": "123456",
  "mac_address": "aa:bb:cc:dd:ee:ff",
  "uuid": "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx",
  "chip_model_name": "esp32s3",
  "chip_info": {"model": 9, "cores": 2, "revision": 0, "features": 0},
  "application": {"name": "xiaozhi", "version": "2.5.0", "compile_time": "...T...Z",
                  "idf_version": "...", "elf_sha256": "..."},
  "partition_table": [{"label": "nvs", "type": 1, "subtype": 2, "address": 36864, "size": 16384}],
  "ota": {"label": "ota_0"},
  "display": {"monochrome": false, "width": 410, "height": 502},
  "board": {"type": "esp32-s3-touch-amoled-2.06", "name": "pebble-pocket",
            "manufacturer": "waveshare", "ssid": "...", "rssi": -50, "channel": 6, "ip": "..."}
}
```

The values shown are illustrative. Note that `minimum_free_heap_size` is a **string** (`board.cc:103-104`). The server does not need any of the body; it can ignore it.

**Timeout.** 30 s per wait for headers or body data (`esp-ml307/include/http_client.h:100`, `http_client.cc:613-619`, `http_client.cc:687-693`).

### 1.3 Response rules

- **The status must be exactly 200**, otherwise the check fails (`main/ota.cc:109-112`).
- **Redirects are not followed.** The HTTP client has no `Location` handling (a search of `esp-ml307/src/http_client.cc` for "location" or "redirect" finds nothing). So a 301/302 (for example a framework adding a trailing slash) counts as a failure. Serve 200 directly on the exact path.
- The body is parsed with `cJSON_Parse`. Invalid JSON is a protocol error (`ota.cc:121-125`).
- The body may be delimited by `Content-Length`, chunked encoding, or connection close (`http_client.cc:346-379`, `http_client.cc:771-785`).
- The status line must be `<version> <3-digit code> ...` (`http_client.cc:458-482`).

### 1.4 Response JSON fields the firmware reads

Every top-level section is optional as far as parsing goes (each is checked with `cJSON_IsObject`). **But without `websocket` the device will not use WebSocket** (section 1.5).

| Field | Type | Used for | Required? | Source |
|---|---|---|---|---|
| `websocket` | object | Every string or number member is copied into NVS namespace `websocket` under its own key. The firmware reads `url` (string), `token` (string) and `version` (number). | **Yes, for WebSocket** | `ota.cc:172-191`, `websocket_protocol.cc:80-86` |
| `websocket.url` | string, `ws://` or `wss://` | WebSocket endpoint | yes | `websocket_protocol.cc:81` |
| `websocket.token` | string | Sent as `Authorization`. If it contains no space, `Bearer ` is prefixed; if it contains a space it is sent verbatim. Empty or absent means no header. | no | `websocket_protocol.cc:82`, `websocket_protocol.cc:97-103` |
| `websocket.version` | **number**: 1, 2 or 3 | Binary framing version (section 5). 0 or absent means 1. | no | `websocket_protocol.cc:83-86`, `websocket_protocol.h:27` |
| `mqtt` | object | Copied into NVS `mqtt`; **its presence selects MQTT instead of WebSocket** | **must be absent** | `ota.cc:151-170`, `application.cc:537-544` |
| `activation` | object: `message` (string), `code` (string), `challenge` (string), `timeout_ms` (number) | Activation flow (section 1.7). `timeout_ms` is parsed but never used. | no, omit to skip | `ota.cc:127-149`; a search for `activation_timeout_ms_` finds only `ota.cc:147` and `ota.h:52` |
| `server_time` | object: `timestamp` (number, **milliseconds** since epoch), `timezone_offset` (number, **minutes**) | `settimeofday`. The offset is added to the timestamp, so the RTC holds local time. | no | `ota.cc:193-216` |
| `firmware` | object: `version` (string), `url` (string), `force` (number) | OTA upgrade when `version` is numerically newer than `2.5.0`, or when `force == 1`. The upgrade happens immediately (`GET url`) and the device reboots. | no, **omit for now** | `ota.cc:218-246`, `application.cc:492-497`, `ota.cc:272-398` |

Missing `firmware` or `server_time` only logs a warning (`ota.cc:214-216`, `ota.cc:244-246`).

**Minimal valid response for a LAN test:**

```json
{
  "websocket": {
    "url": "ws://192.168.1.50:8000/pocket",
    "token": "dev-token",
    "version": 1
  }
}
```

### 1.5 Protocol selection

In `InitializeProtocol`, a `mqtt` object selects MQTT; otherwise a `websocket` object selects WebSocket; otherwise the device logs "No protocol specified in the OTA config, using MQTT" and uses MQTT (`main/application.cc:537-544`). The two flags are cleared at the start of each successful parse (`ota.cc:151`, `ota.cc:172`), and they start false (`main/ota.h:41-42`).

Consequences:

- Never send `mqtt`.
- **If the OTA request fails on every retry, the device falls back to MQTT for the whole boot**, even though NVS still holds an old `websocket` URL. This is because `CheckVersion` returns before the websocket flag is set (`ota.cc:99-112`), and `InitializeProtocol` runs anyway (`application.cc:372-375`). The OTA endpoint must therefore be reachable at every boot.

### 1.6 NVS persistence hazards (server must respect these)

- **Keys longer than 15 characters crash the device.** Each member of `websocket` (and `mqtt`) is written with `Settings::SetString`/`SetInt`, which wrap the NVS call in `ESP_ERROR_CHECK` (`main/settings.cc:40-47`, `main/settings.cc:61-68`). NVS rejects keys over 15 characters with `ESP_ERR_NVS_KEY_TOO_LONG` (`IDF:nvs_flash/include/nvs.h:60`, `IDF:nvs_flash/src/nvs_page.cpp:171-174`), so `ESP_ERROR_CHECK` aborts. Because the OTA check runs at every boot, this becomes a reboot loop. Only send `url`, `token`, `version`.
- **String values are limited to 4000 bytes including the null terminator**, less if flash is fragmented (`IDF:nvs_flash/include/nvs.h:323-325`). Keep tokens small (a JWT of about 1 KB is fine).
- **Stale keys persist.** Only the keys present in the response are written; nothing is erased (`ota.cc:175-187`). To clear a token, send `"token": ""`, which yields no `Authorization` header (`websocket_protocol.cc:97`).
- **`version` must be a JSON number.** A string is stored as a string, `GetInt` then fails (`settings.cc:49-59`), and the device silently uses version 1.

### 1.7 Activation flow, and how to skip it

The flow, from `main/application.cc:441-528`:

1. After a successful check, if a newer firmware was offered, the device upgrades first (`application.cc:492-497`).
2. If the response has neither `activation.code` nor `activation.challenge`, activation is **skipped** and the loop exits (`application.cc:501-504`). **To skip: omit `activation` entirely.**
3. If there is a `code`, the device shows `message` and speaks the digits of `code` (`application.cc:508-510`, `application.cc:723-745`).
4. It then calls `Activate()` up to 10 times (`application.cc:513-526`):
   - `Activate()` fails immediately if there is no `challenge` (`ota.cc:497-500`). Such a failure, or any status other than 200/202, waits 10 s before the next try (`application.cc:520-522`).
   - It sends `POST {OTA_URL}activate` (a `/` is inserted if the URL does not end with one) with the same headers as section 1.2 (`ota.cc:502-512`).
   - The body is `{}` when there is no eFuse serial number (`ota.cc:459-462`). Otherwise it is `{"algorithm":"hmac-sha256","serial_number":"...","challenge":"...","hmac":"<hex of HMAC-SHA256(eFuse KEY0, challenge)>"}` (`ota.cc:464-493`).
   - Status `202` means "still pending": the device waits 3 s and retries (`ota.cc:524-526`, `application.cc:518-519`).
   - Status `200` means "done" (`ota.cc:527-533`).
5. After the activation loop, **the whole version check runs again** (the outer `while (true)` in `application.cc:447`). It only exits once a response carries no activation fields. So the server must stop returning `activation` after activation completes.

### 1.8 Retries and cadence

- A failed check shows an alert and waits 10 s, doubling each time (`application.cc:452-487`).
- After the 10th consecutive failure the device gives up (`application.cc:453-457`), then initialises the protocol, which falls back to MQTT (section 1.5).
- The OTA check runs **once per boot**: when the network first comes up while the device is starting or configuring Wi-Fi (`application.cc:288-308`, `application.cc:364-379`). Changes to `url` or `token` therefore take effect only after a reboot. The server can force one with `{"type":"system","command":"reboot"}` (section 6).

---

## 2. WebSocket connect

The connection is opened only when a session starts. `Start()` is a no-op (`main/protocols/websocket_protocol.cc:19-22`).

**URL parsing** (`esp-ml307/src/web_socket.cc:69-109`):

- The client looks for the first `:` after `://`. If there is none, the port defaults to 443 for `wss` and 80 otherwise.
- The port string goes through `std::stoi` (`web_socket.cc:135`), and exceptions are disabled in this project (`main/ota.cc:405-407` notes that). A malformed port can therefore abort.
- **Always write an explicit numeric port, and do not put `:` in the path or query**, because a `:` there is mistaken for the port separator.
- IPv4 only: plain TCP resolves with `gethostbyname` into `sockaddr_in` (`esp-ml307/src/esp/esp_tcp.cc:32-42`).

**Handshake request headers.** `GET <path> HTTP/1.1` (`web_socket.cc:142`), followed by:

| Header | Value | Source |
|---|---|---|
| `Host` | host **without port** | `web_socket.cc:143-145` |
| `Authorization` | `Bearer <token>`, only if a token is set | `websocket_protocol.cc:97-103` |
| `Protocol-Version` | `1`, `2` or `3` | `websocket_protocol.cc:104` |
| `Device-Id` | MAC as in 1.2 | `websocket_protocol.cc:105` |
| `Client-Id` | UUID as in 1.2 | `websocket_protocol.cc:106` |
| `Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Version: 13`, `Sec-WebSocket-Key` | standard | `web_socket.cc:115-125` |

Headers are stored in a `std::map` (`web_socket.cc:57-59`), so they go out in key order, not insertion order.

**Handshake response requirements:**

- The response must contain the literal substring `HTTP/1.1 101` (`web_socket.cc:295-309`). Anything else is a handshake failure.
- The client does **not** check `Sec-WebSocket-Accept` and sends **no** `Sec-WebSocket-Protocol`. The server must not require a subprotocol.
- The handshake timeout is 10 s (`web_socket.cc:174-201`). On failure the device raises a "cannot connect" error and returns to idle (`websocket_protocol.cc:169-174`, `application.cc:827-833`).

**Framing facts:**

- Device frames are masked (`web_socket.cc:228-248`).
- The device refuses to send frames over 65535 bytes (`web_socket.cc:210-213`).
- Inbound, it handles 16- and 64-bit lengths, masked or unmasked frames, and continuation frames (`web_socket.cc:321-385`).
- Server **pings** are answered with a pong (`web_socket.cc:392-394`).

---

## 3. Hello exchange

### 3.1 Device hello (first text frame after the handshake)

Built in `main/protocols/websocket_protocol.cc:199-223`. For this build it is:

```json
{"type":"hello","version":1,"features":{"mcp":true,"glyph_push":false},"transport":"websocket","audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}
```

- `version` equals the binary protocol version in use (`websocket_protocol.cc:203`).
- `features.aec` is only present with `CONFIG_USE_SERVER_AEC`, which is off (`websocket_protocol.cc:205-207`).
- `features.glyph_push` is always present, as a boolean.
- A `text_font` object `{"bundle","charset","size","bpp"}` is added only when `glyph_push` is true (`main/protocols/protocol.cc:8-24`). Whether the flashed assets advertise glyph push is decided at runtime; I have not checked it, so accept either value.

### 3.2 Server hello (required)

Parsed in `websocket_protocol.cc:225-255`:

| Field | Required | Effect |
|---|---|---|
| `type` | `"hello"` | Intercepted by the protocol layer, never passed to the application (`websocket_protocol.cc:146-147`). |
| `transport` | **`"websocket"`, exactly** | If it is missing, not a string, or different, the hello is **ignored** and the device times out (`websocket_protocol.cc:226-234`). |
| `session_id` | optional string | Stored and echoed in every later device message (`websocket_protocol.cc:236-240`). **It must not contain `"` or `\`**, because device messages are built by string concatenation without escaping (`protocol.cc:66-106`). |
| `audio_params.sample_rate` | optional number | Downlink decode rate. Default 24000 (`protocol.h:79`). |
| `audio_params.frame_duration` | optional number | Downlink Opus frame duration in ms. Default 60 (`protocol.h:80`). |

Other `audio_params` fields (`format`, `channels`) are not read.

- **Timeout:** the device waits **10 s** for a valid server hello after sending its own. Otherwise it raises a "server timeout" error and the session fails (`websocket_protocol.cc:182-190`).
- The event bit is set when the hello is parsed, so a server hello that arrives before the device's hello also counts. **Recommendation:** reply after receiving the device hello.
- **Values persist across connections.** `session_id_`, `server_sample_rate_` and `server_frame_duration_` are members of the protocol object and are not reset in `OpenAudioChannel` (`websocket_protocol.cc:79-197`). A later hello that omits them keeps the old values. **Recommendation:** send all three in every hello.
- A second hello mid-session would update these fields again. Do not send one.

---

## 4. Listening: start, stop, detect, and modes

### 4.1 Messages the device sends

All are text frames built in `main/protocols/protocol.cc`. `session_id` is always present, as `""` if the server never gave one.

| Message | JSON | Source |
|---|---|---|
| listen start | `{"session_id":"S","type":"listen","state":"start","mode":"realtime"}` (mode `"realtime"`, `"auto"` or `"manual"`) | `protocol.cc:82-94` |
| listen stop | `{"session_id":"S","type":"listen","state":"stop"}` | `protocol.cc:96-100` |
| listen detect | `{"session_id":"S","type":"listen","state":"detect","text":"<wake word>"}` | `protocol.cc:75-80` |
| abort | `{"session_id":"S","type":"abort"}`, plus `"reason":"wake_word_detected"` only when aborted by a wake word | `protocol.cc:66-73` |
| mcp | `{"session_id":"S","type":"mcp","payload":{...JSON-RPC 2.0...}}` | `protocol.cc:102-106` |

### 4.2 What this build actually does (important)

**There is no push-to-talk in today's build.** The BOOT button is wired to `OnClick` → `ToggleChatState()` (`main/boards/waveshare/esp32-s3-touch-amoled-2.06/esp32-s3-touch-amoled-2.06.cc:203-211`). The haptics hooks on press-down and long-press do not touch the protocol (`...amoled-2.06.cc:213-222`). Nothing in this board calls `StartListening()` or `StopListening()`, which are the manual-mode entry points (`application.cc:771-773`).

The listening mode is picked at the moment of the click: `realtime` if an AEC mode is on, `auto` otherwise (`application.cc:802`, `application.cc:1183-1185`).

- At boot the AEC mode is device-side because `CONFIG_USE_DEVICE_AEC=y` (`application.cc:26-34`), so **the default mode is `realtime`**.
- A **double click** while idle toggles AEC off or on (`...amoled-2.06.cc:224-231`, `application.cc:1328-1353`), switching future sessions to `auto` or back.
- The AEC choice is not saved, so every reboot returns to `realtime`.

The BOOT click behaves as follows (`HandleToggleChatEvent`, `application.cc:775-815`):

| Device state | Click does |
|---|---|
| idle, no channel | connecting → open WebSocket + hello → listening (`application.cc:801-807`, `application.cc:817-837`) |
| idle, channel still open | listening on the existing socket, sends a new listen start (`application.cc:809`) |
| listening | **close the channel** (TCP close, no `listen stop`) (`application.cc:812-813`) |
| speaking | send `abort`, stay in speaking (`application.cc:810-811`, `application.cc:1170-1176`) |

**`realtime` sequence** (the default):

1. Entering listening calls `StartListeningAudio()`, which sends `listen start` and **then** enables the microphone pipeline (`application.cc:1022-1036`, `application.cc:1066-1084`). The first audio frame is therefore always after `listen start`. There is also a 120 ms input warm-up (`audio_service.cc:276-279`).
2. The device streams 60 ms Opus frames continuously. There is no device-side end-of-utterance: the AFE engine emits every frame (`main/audio/engines/afe_audio_engine.cc:492-500`, `audio_service.cc:87-89`), and the main loop sends everything in the send queue regardless of state (`application.cc:239-251`).
3. **The microphone keeps streaming while speaking.** In realtime mode, entering speaking does not disable voice processing (`application.cc:1041-1050`).
4. After `tts stop` the device goes back to listening (`application.cc:628-637`). Voice processing is still running, so **no new `listen start` is sent** (`application.cc:1027-1039`).
5. `listen stop` is **never** sent. The session ends when the user clicks again (TCP close) or on a disconnect.

The server must therefore do its own turn detection (VAD or endpointing) on a continuous stream, ignore or handle speech during its own playback (barge-in), and never wait for `listen stop`.

**`auto` sequence** (after a double click):

1. `listen start` with `"mode":"auto"`, then streaming as above.
2. `tts start` → speaking. **The microphone stops**: voice processing is disabled in non-realtime modes (`application.cc:1044-1048`).
3. `tts stop` → listening. Once the playback queue drains, the device sends **another `listen start` `"mode":"auto"`** and restarts the microphone (`application.cc:1032-1035`, `application.cc:214-225`).
4. No `listen stop` is ever sent.

**`manual` mode (push-to-talk).** The code exists but is not wired to any button in this build. For the planned Phase 1 change, this is what it would do:

- **Press (`StartListening`)** from idle: open the channel if needed, then enter listening with `manual` → `listen start` `"mode":"manual"` followed by audio (`application.cc:839-873`). Pressed while speaking, it sends `abort`, then listening/`manual`.
- **Release (`StopListening`)** while listening: sends `listen stop` and goes to **idle, with the socket left open** (`application.cc:875-890`). Entering idle disables the microphone (`application.cc:1003-1016`).
- **Reply:** `tts start` moves idle → speaking, which is a valid transition (`main/device_state_machine.cc:72-80`). `tts stop` in manual mode returns to idle (`application.cc:631-632`).
- **Next press:** reuses the open socket and sends only a new `listen start`, with no new hello (`application.cc:861-868`). The exception is when the channel has timed out after 120 s with no server traffic (section 8), in which case it reconnects with a new hello.

**`detect`** is only sent with `CONFIG_SEND_WAKE_WORD_DATA` (`application.cc:974-987`). That option depends on a wake word being enabled (`main/Kconfig.projbuild:932-935`), and wake words are disabled here, so this build never sends `detect`.

**`abort`** leaves the device in speaking. The `aborted_` flag is set but never read (a search finds only `application.cc:625`, `application.cc:1172` and `application.h:150`), and incoming audio is still accepted while speaking. **The server must react to `abort` by stopping its audio and sending `tts stop`, otherwise the device stays in speaking.**

---

## 5. Binary audio frames

**Every binary WebSocket frame is treated as audio in both directions.** There is no binary JSON path, and the `type` fields below are ignored on receipt (`websocket_protocol.cc:108-140`).

**Which version is used.** `version_` defaults to 1 (`websocket_protocol.h:27`) and is overridden by NVS `websocket/version` if non-zero (`websocket_protocol.cc:83-86`). NVS gets it only from the OTA response. So **the build uses whatever `websocket.version` the OTA response sends, or 1 if it is absent.** Values other than 2 and 3 are treated as raw (v1), but the number is still advertised in the header and hello.

**Recommendation:** use version 1. The WebSocket layer already delimits frames, and v2/v3 add nothing this build uses (no server AEC).

### v1 (default): raw Opus

The frame payload is exactly one Opus packet (`websocket_protocol.cc:51-53`, `websocket_protocol.cc:133-139`).

### v2: 16-byte header, all multi-byte fields big-endian

`struct BinaryProtocol2` is packed (`main/protocols/protocol.h:19-26`); fields are converted with `htons`/`htonl` (`websocket_protocol.cc:29-40`, `websocket_protocol.cc:111-122`).

| Offset | Size | Field | Device sends | Device reads |
|---|---|---|---|---|
| 0 | 2 | version | 2 | ignored |
| 2 | 2 | type | 0 | ignored |
| 4 | 4 | reserved | 0 | ignored |
| 8 | 4 | timestamp (ms) | an echoed server timestamp, else 0 | queued for server AEC (`audio_service.cc:360-366`, `audio_service.cc:579-583`) |
| 12 | 4 | payload_size | Opus length | **trusted as-is** |
| 16 | n | payload | Opus packet | |

### v3: 4-byte header

`struct BinaryProtocol3` (`protocol.h:28-33`, `websocket_protocol.cc:41-50`, `websocket_protocol.cc:123-132`):

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | type | device sends 0, ignored on receipt |
| 1 | 1 | reserved | 0 |
| 2 | 2 | payload_size | big-endian, **trusted as-is** |
| 4 | n | payload | Opus packet |

**Inbound safety rule for v2 and v3.** The device casts the frame to the header struct and copies `payload_size` bytes without checking the frame length (`websocket_protocol.cc:111-122`, `websocket_protocol.cc:123-132`). The server must never send a binary frame shorter than the header, nor a `payload_size` larger than the bytes that follow; either would read past the buffer.

**Uplink packet sizes.** The encoder runs with VBR and DTX on (`audio_service.h:77-79`). Every encoded result is queued and sent, however small (`audio_service.cc:489-500`), so expect very small packets during silence. The server's Opus decoder must tolerate them. I have not verified whether the encoder ever returns a zero-length packet.

---

## 6. Server → device messages the device acts on

Dispatch is in `main/application.cc:578-718` (hello is handled earlier, in section 3). Every message needs a string `type`, otherwise it is logged and dropped (`websocket_protocol.cc:143-155`, `application.cc:580-584`). **Incoming `session_id` is never checked.** Messages are processed on the network receive task; UI and state changes are `Schedule`d onto the main task.

| type | Fields read | Effect | Source |
|---|---|---|---|
| `tts`, `state:"start"` | none | Scheduled: sets state **speaking**. Entering speaking **clears the decode queue** (`ResetDecoder`) and, in auto mode, stops the microphone. | `application.cc:623-627`, `application.cc:1041-1050` |
| `tts`, `state:"sentence_start"` | `text` (string); optional `glyph_push` object | Shows `text` as the assistant line. Display only. | `application.cc:638-652`, `main/protocols/text_glyph_payload.cc:14-29` |
| `tts`, `state:"stop"` | none | Scheduled: only if currently speaking, goes to **idle** in manual mode or **listening** otherwise. **Queued audio is not flushed**, so it plays out. | `application.cc:628-637`, `application.cc:1003-1016` |
| `stt` | `text` (string); optional `glyph_push` | Shows `text` as the user line. Display only. | `application.cc:654-668` |
| `llm` | `emotion` (string) | `display->SetEmotion(emotion)`. `text` is ignored. | `application.cc:669-675` |
| `mcp` | `payload` (object, JSON-RPC 2.0) | `McpServer::ParseMessage`. Replies come back as `type:"mcp"`. Requests need `jsonrpc:"2.0"`, a string `method` and a **numeric** `id`. Methods include `initialize`, `tools/list`, `tools/call`; methods starting with `notifications` are ignored without a reply (`mcp_server.cc:375-377`). | `application.cc:676-680`, `main/mcp_server.cc:358-424` |
| `system` | `command` (string) | Only `"reboot"` is handled; anything else is logged. | `application.cc:681-691` |
| `alert` | `status`, `message`, `emotion` (all strings, all required) | Shows an alert and plays the vibration sound. | `application.cc:692-701` |
| `notify` | `audio_url` (non-empty string), optional `subtitles` array of `{start_ms, text}` | Only while idle: plays audio fetched from the URL. Not needed for voice sessions. | `application.cc:585-617`, `application.cc:1096-1140` |
| `custom` | `payload` | **Compiled out** (`CONFIG_RECEIVE_CUSTOM_MESSAGE` off) | `application.cc:702-714` |
| anything else | | logged "Unknown message type" | `application.cc:715-717` |

**Downlink audio** is accepted **only while the state is speaking**; in every other state it is silently dropped (`application.cc:553-557`).

### Ordering rules

1. **Server hello first.** Nothing else matters until it arrives, and it must arrive within 10 s (section 3).
2. **`tts start` must precede the reply audio, and the first audio frame must not arrive immediately after it.**
   - `tts start` only *schedules* the switch to speaking (`application.cc:624-627`). Frames processed before the main task runs are dropped, because they arrive while not speaking (`application.cc:553-557`).
   - Frames that arrive after the switch but before the state-change handler runs are pushed and then wiped by `ResetDecoder` (`application.cc:1049`, `audio_service.cc:798-818`).
   - Frames read from the same TCP chunk as `tts start` are handled on the receive task right away (`web_socket.cc:321-385`), so a back-to-back burst loses its first frames.
   - **Recommendation:** wait about 100 ms after sending `tts start` before the first audio frame. This number is a margin, not a measurement.
3. **Send `tts stop` after the last audio frame.** Audio that arrives after the state leaves speaking is dropped; audio already queued keeps playing.
4. **Pace downlink audio in real time.** The decode queue is limited to `1200 / 60 = 20` packets (`audio_service.h:43`), about 1.2 s, and the push is non-blocking: when the queue is full, the packet is **dropped** (`application.cc:555` calls `PushPacketToDecodeQueue(packet)` with `wait = false`; `audio_service.cc:609-620`). **Recommendation:** send a small lead of a few frames, then one frame per 60 ms. Pace against what the device has queued, not a clock fixed at the first frame: if the source falls behind real time (for example TTS for the next sentence arrives after the previous sentence finished playing), the queue has drained, and frames that were "due" long ago must not all go out at once. Start a new lead from the current time instead.
5. **On `abort`,** stop sending audio and send `tts stop` promptly (section 4.2). Up to about 1.2 s of already-queued audio will still play.
6. `stt`, `llm` and `sentence_start` can arrive at any time; they only update the display. **Recommendation:** send `stt` before `tts start`, and `sentence_start` just before each sentence's audio.
7. Always send the reply in the order `tts start`, audio frames, `tts stop`. In **realtime** mode, if the device is already speaking when a new turn begins, send another `tts start`: it is a same-state no-op transition (`device_state_machine.cc:113-119`) and does not reset the decoder. When a reply is aborted and a new turn starts, the aborted reply's `tts stop` must be sent **before** the new reply's `tts start`: a `tts stop` that arrives after the new `tts start` moves the device out of speaking (`application.cc:628-637`), and it then drops the new reply's audio (`application.cc:553-556`).

---

## 7. Audio parameters

### Uplink (device → server)

- Opus, **16 kHz, mono, 60 ms frames** (960 samples each), bitrate auto, application AUDIO, complexity 0, FEC off, DTX on, VBR on (`main/audio/audio_service.h:40`, `audio_service.h:67-80`, `audio_service.cc:63-71`).
- The codec captures at 24 kHz and is resampled to 16 kHz before encoding (`config.h:6`, `audio_service.cc:73-76`, `audio_service.cc:195-220`).
- The value is also stated in the hello (`websocket_protocol.cc:212-217`).
- The server should not expect a different rate: the encoder is fixed at 16 kHz.

### Downlink (server → device)

- The decoder is configured from the server hello's `audio_params.sample_rate` and `frame_duration`, or 24000 Hz / 60 ms if they are omitted (`protocol.h:79-80`). The values are stamped on every inbound packet (`websocket_protocol.cc:118-138`).
- The speaker path runs at **24 kHz** (`config.h:7`).
- **Announce and encode at 24000 Hz, mono, 60 ms frames.** That matches the codec, so no resampling happens.

**If the server announces a different rate:**

- The device logs a warning when the channel opens (`application.cc:559-567`).
- On the first packet it re-creates the Opus decoder at the announced rate and opens a resampler to 24 kHz (`audio_service.cc:409`, `audio_service.cc:532-566`). Decoded PCM is then resampled on every packet (`audio_service.cc:430-442`), which costs CPU and "may cause distortion", as the firmware's own log says.
- Opus rates are 8000, 12000, 16000, 24000 or 48000; that list is documented in the encoder header (`audio-codec/include/encoder/impl/esp_opus_enc.h:70-72`). The decoder header does not list rates.
- If the decoder cannot be created, it logs "Failed to create audio decoder" and every packet is dropped with "Audio decoder is not configured", which means silence (`audio_service.cc:543-547`, `audio_service.cc:447-449`).

**Frame duration.**

- The decoder output buffer is sized to `sample_rate / 1000 * frame_duration` samples (`audio_service.cc:550`, `audio_service.cc:412`).
- Supported durations map to 5, 10, 20, 40, 60, 80, 100 or 120 ms (`audio_service.h:56-65`). Any other value becomes -1.
- **Send every packet at exactly the announced duration.** A longer packet does not fit the output buffer. I have not verified what the decoder does in that case (error or truncation).

### Local sounds

The device plays its own OGG prompts (for example the success chime) through the same decoder, switching the decoder rate as needed (`audio_service.cc:764-786`). This does not affect the wire.

---

## 8. Disconnect and reconnect behaviour

**Device-initiated close.** The device closes in these cases:

- a BOOT click while listening (`application.cc:812-813`);
- an AEC mode change (`application.cc:1348-1351`);
- the network dropping while connecting, listening or speaking (`application.cc:315-330`);
- a reboot or firmware upgrade (`application.cc:1192-1196`, `application.cc:1214-1218`).

`CloseAudioChannel` just destroys the WebSocket (`websocket_protocol.cc:74-77`): no goodbye message, and no WebSocket close frame. The destructor only disconnects TCP (`web_socket.cc:48-51`, `esp_tcp.cc:72-103`). **The server must treat a bare TCP close as a normal end of session.**

**Server-initiated close.**

- A close frame sets `connected_ = false` and fires the disconnect callback. The device does **not** reply with a close frame (`web_socket.cc:386-391`).
- A TCP close or error fires the same callback from the receive task (`web_socket.cc:160-167`, `esp_tcp.cc:129-140`, `esp-ml307/src/esp/esp_ssl.cc:128-137`).
- Either way the application schedules a return to **idle** (`websocket_protocol.cc:161-166`, `application.cc:569-576`).
- **Recommendation:** after sending a close frame, close the TCP connection yourself.

**Errors.**

- A failed text send raises a "server error": idle plus an alert (`websocket_protocol.cc:61-65`, `application.cc:189-196`).
- A failed audio send only drops the queued audio, with no error (`application.cc:239-251`).
- A failed connect or a hello timeout raises an error and returns to idle (`websocket_protocol.cc:169-174`, `websocket_protocol.cc:186-190`, `application.cc:827-833`).
- After an error, `IsAudioChannelOpened()` is false (`websocket_protocol.cc:70-72`), so the next session opens a fresh connection.

**No automatic reconnect.** Nothing re-dials after a drop. The next BOOT click opens a **new** connection with a new device hello (`application.cc:801-807`).

**The 120 s rule.**

- `IsAudioChannelOpened()` also returns false if nothing (text or binary) has arrived from the server for **more than 120 s** (`protocol.cc:108-117`, updated in `websocket_protocol.cc:158`).
- **WebSocket pings do not count.** They are answered inside the WebSocket class and never reach `OnData` (`web_socket.cc:392-394`).
- The timeout does not close the socket by itself. It only means the next session (for example the next manual-mode press) reconnects instead of reusing the socket.
- **Recommendation:** in long realtime sessions, send occasional JSON traffic if you want the device to keep treating the channel as open.

**Config refresh** requires a reboot, because the OTA check runs once per boot (section 1.8).

---

## 9. Plain `http://` and `ws://` for a LAN test, and TLS

### Plain HTTP and WS are accepted

- The HTTP client uses TLS only when the scheme is `https`; any other scheme gets a plain TCP socket (`esp-ml307/src/http_client.cc:200-204`). **`http://` works** for the OTA URL, the activation URL and the firmware download URL.
- The WebSocket client uses TLS only for `wss` or `https`; anything else is plain TCP (`web_socket.cc:127-131`). **`ws://` works.**

### TLS requirements for `https://` and `wss://`

- TLS goes through `esp_tls` with the ESP-IDF certificate bundle attached (`esp-ml307/src/esp/esp_ssl.cc:34-37`), using the default full bundle (`sdkconfig:3471`, `sdkconfig:3477`).
- There is no option to skip verification.
- The hostname is checked against the certificate: `skip_common_name` is left false and the host is passed to `mbedtls_ssl_set_hostname` (`IDF:esp-tls/esp_tls_mbedtls.c:927-939`).
- **TLS 1.2 only** (`sdkconfig:3502-3504`).
- **A self-signed or private-CA certificate on a LAN address will fail.** Use plain `http://` and `ws://` on the LAN, and a publicly trusted certificate on a real hostname in the cloud. I have not checked whether a specific CA, such as the one behind Cloud Run's managed certificates, is in the bundle.

### Pointing the current build at a LAN server

The flashed `CONFIG_OTA_URL` is `https://pocket-ota.invalid/ota/`. Two options:

1. **Rebuild** with `CONFIG_OTA_URL="http://<lan-ip>:<port>/ota/"` in the `pebble-pocket` entry of `main/boards/waveshare/esp32-s3-touch-amoled-2.06/config.json`.
2. **No rebuild:** the hotspot Wi-Fi setup page has a "Custom OTA URL" field, enabled for Wi-Fi boards (`main/boards/common/wifi_board.cc:59`, `wifi-connect/assets/wifi_configuration.html:551-553`). It saves NVS `wifi/ota_url` (`wifi-connect/wifi_configuration_ap.cc:596-612`), which takes priority over the Kconfig default (`main/ota.cc:48-55`).

Either way, then have the OTA response return a `ws://<lan-ip>:<port>/...` URL.

The token and audio travel unencrypted on `ws://`, which is fine for a bench test only.

---

## 10. Server checklist (recommendations derived from the rules above)

1. `POST /ota/` → `200` directly, no redirect. JSON `{"websocket":{"url":"ws://HOST:PORT/path","token":"...","version":1}}`. No `mqtt`, no `activation`, no `firmware`. Only these three keys inside `websocket`.
2. WebSocket upgrade: answer `HTTP/1.1 101`. Validate `Authorization: Bearer <token>`. Read `Device-Id` and `Client-Id`. Do not require a subprotocol.
3. On the device hello, reply within 10 s with `{"type":"hello","transport":"websocket","session_id":"<id without quotes or backslashes>","audio_params":{"format":"opus","sample_rate":24000,"channels":1,"frame_duration":60}}`.
4. Expect `listen start` with `mode:"realtime"`, then a continuous 16 kHz / 60 ms Opus stream with no `listen stop`. Do server-side endpointing. In `auto` mode expect a fresh `listen start` after each reply.
5. Reply with `stt` (optional), then `tts start`, a pause of about 100 ms, Opus 24 kHz / 60 ms frames paced in real time, `sentence_start` per sentence (optional), and `tts stop` after the last frame.
6. On `abort`: stop audio, send `tts stop`.
7. Treat a TCP close without a close frame as a normal hang-up. Expect a new hello on the next session.

---

## 11. Where `docs/websocket.md` differs from the code

- It says frames received while listening are dropped. In fact, audio is dropped in **every** state except speaking (`application.cc:553-557`).
- It says the device stops sending microphone audio when speaking. That is only true in `auto` and `manual`; in `realtime` (this build's default) it keeps streaming (`application.cc:1041-1050`).
- It says `abort` interrupts the session. The device only sends it and stays in speaking until the server sends `tts stop` (`application.cc:1170-1176`).
- It says the device "stops playback" on `tts stop`. Queued audio actually plays out (`application.cc:1003-1016`).
- It does not give the v2/v3 byte order (big-endian), and it omits the `notify` message type.

## 12. Not verified (no hardware yet)

- Actual `Activation-Version`: expected `1`, depending on the eFuse `USER_DATA` state of this unit.
- Whether the flashed assets advertise `glyph_push: true`.
- The real latency between `tts start` and the device entering speaking; the 100 ms gap is a guess with margin.
- Decoder behaviour for packets longer than the announced frame duration.
- Whether the encoder ever emits zero-byte DTX packets.
- Whether the BOOT `OnClick` also fires after a 1.5 s hold. That matters for the planned Hello gesture, not for this protocol.
