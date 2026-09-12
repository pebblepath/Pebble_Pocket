# Pebble Pocket — Handoff for Claude Code

Read this first. It is the complete context for building Pebble Pocket, written so a fresh Claude Code session in this repo can start Phase 0 without the original conversation.

## 1. What this is

Pebble Pocket is PebblePath's advisor, Pebble, made physical: a small wearable for a child aged three and up, worn on a neck lanyard or stood on a table. It does four things and nothing else:

1. **Translate.** Child presses the side button (later: says "Hey Pebble"), asks something in French or English, and Pebble answers aloud in the other language, in Pebble's own warm tone. The face shows only the two words being taught.
2. **Learn.** Plays songs and short videos a parent uploaded, from the microSD card, offline.
3. **Calm.** Full-face ambient loops (rain, tide, seeds, snow, a family photo) for hard moments. No timer, no reward.
4. **Hello.** Hold the button, talk for up to 20 s, release, and the clip goes to contacts a parent approved (grandparents, carer). No inbound messages in v0.1.

The device is a **thin client**. All intelligence (speech-to-text, Claude, text-to-speech, contacts, media prep) lives in PebblePath's existing Firebase cloud. The device holds one device key and no third-party secrets. The parent's remote control is the existing PebblePath iOS app or the Portal in a browser; the device talks to the cloud directly over Wi-Fi and does not depend on the phone at runtime.

Owner: Thomas Paris (thomas@pebblepath.ai). Pebble Pocket is a PebblePath side project; it shares PebblePath's Firebase project, design tokens and the Pebble persona.

## 2. Hardware (ordered Sep 2026, arriving ~Sep 14)

**Waveshare ESP32-S3-Touch-AMOLED-2.06**, Amazon ASIN B0FJQZ7SBG, the variant that includes the 400 mAh MX1.25 battery and straps.

| | |
|---|---|
| MCU | ESP32-S3R8, dual-core Xtensa LX7 @ 240 MHz, 512 KB SRAM, 8 MB octal PSRAM, 32 MB flash |
| Display | 2.06" AMOLED, 410 × 502, 16.7M colours, CO5300 driver over QSPI, FT3168 capacitive touch over I2C, 600 nits |
| Audio | ES8311 codec (playback), ES7210 ADC with echo cancellation (dual mics), 1 W speaker, all on I2S |
| Sensors | QMI8658 6-axis IMU, PCF85063 RTC |
| Radio | Wi-Fi 802.11 b/g/n 2.4 GHz, Bluetooth 5 LE. **No classic Bluetooth, so no A2DP speaker mode.** |
| Storage | microSD (TF) slot |
| Power | AXP2101 PMU, USB-C. Roughly 1 h screen-on at full brightness, 3 to 4 h screen-off, 6 h low power |
| Buttons | PWR and BOOT, both programmable. Two side buttons plus touch |
| Case | 50.8 × 42 × 13.6 mm, visible face 40.5 × 33.1 mm, 22 mm flat-end strap slot with screw bar |
| Pads | Reserved I2C, UART and USB pads for peripherals |

Wiki: https://www.waveshare.com/wiki/ESP32-S3-Touch-AMOLED-2.06
Demo firmware (MIT): on Waveshare's GitHub, linked from the wiki. Start from it, not from the wiki's Arduino sketches.

### Hardware gotchas already known (from buyer reports)

- **ES8311 and ES7210 share an I2S clock pin.** Full duplex (speak and listen at once) works on ESP-IDF v6.0.1 with this bring-up order: power rails first, then start the I2S master clock, then configure both codecs as I2S slaves. Arduino examples hide the order and fail. **Use ESP-IDF for the audio path.**
- **Waveshare's Arduino sketches are unreliable** for the display too; several buyers had to reverse-engineer the factory firmware. The MIT demo repo is the reliable starting point for pin maps and init sequences.
- **Pin map is under-documented.** Expect to read it out of the demo code. Known from a buyer: all I2C on one bus (GPIO 14 SCL, 15 SDA @ 100 kHz); display on dedicated QSPI (GPIOs 4 to 7, 11, 12); AMOLED brightness via QSPI register 0x51, 0 to 255.
- **Runs warm** (36 to 46 °C) with Wi-Fi up at full brightness. Dim aggressively.
- **Speaker wires are fragile.** One buyer had a speaker lead detach during assembly. Handle the case gently when opening it.
- **Battery reality:** plan the UI around about an hour of screen-on time. Dim at 10 s, sleep at 30 s, wake on raise (IMU) or press.

## 3. Repo layout

```
pebble-pocket/
├── HANDOFF.md        ← this file
├── README.md
├── docs/             ← GitHub Pages (Settings → Pages → main, /docs)
│   ├── index.html    ← architecture, flows, constraints, build plan
│   ├── screens.html  ← 12 face mockups for ages 3+, click to zoom, icon set, face rules
│   └── assets/pocket.css
├── firmware/         ← ESP-IDF project (empty; Phase 0 starts here)
├── cloud/            ← Firebase Cloud Functions (empty)
└── portal/           ← parent-side screens for the existing PebblePath Portal (empty)
```

GitHub: https://github.com/pebblepath/Pebble_Pocket
Pages (once enabled): https://pebblepath.github.io/Pebble_Pocket/

The design pages are the spec. When in doubt about a face, open `docs/screens.html`.

## 4. System architecture

```
Pebble Pocket (ESP32-S3, ESP-IDF)          PebblePath cloud (Firebase)
─────────────────────────────────          ─────────────────────────────────────
wake (button / ESP-SR) ──audio (Opus)──▶   Pocket session (Cloud Function, WebSocket)
                                              STT (fr/en auto) → Claude API (Pebble prompt
face text + TTS audio ◀────────────────       + child context) → TTS (Pebble voice)
                                           Media service: transcode uploads, sync manifest
microSD  ◀──manifest diff on charge────    Fleet: device keys, OTA, config, health
                                           Hello delivery: store clip, push to approved
hold-to-record ──Hello clip──▶                contacts, expiring link fallback
                                           Child profile + day view (same retention as chat)

PebblePath app / Portal (parent)
  pair over BLE and hand the Pocket its Wi-Fi · upload media · approve contacts
  · choose today's mode and language pair · see the day
```

Key decisions, with reasons:

- **Cloud does STT/LLM/TTS, not the device.** The ESP32-S3 cannot run open-vocabulary speech recognition. Streaming Opus at 16 kHz over a WebSocket to a Cloud Function is the standard pattern (see xiaozhi-esp32 for a mature open-source reference of exactly this device role).
- **Media is synced to microSD, not streamed.** Playback must work in a classroom with no Wi-Fi and must start instantly. Sync happens only on the charger.
- **No Bluetooth audio.** ESP32-S3 has BLE only. The iPhone cannot use the Pocket as a speaker. Media reaches the device via the cloud sync path only.
- **BLE is for setup only.** Provisioning Wi-Fi credentials from the PebblePath app. After that, the phone is not in the loop.
- **Custom wake word is deferred.** ESP-SR runs wake words on device, but "Hey Pebble" requires training through Espressif's service. v0.1 is button-first; ship with the stock ESP-SR wake word for bench testing only.
- **Privacy:** audio leaves the device only while the listening ring is pulsing. Nothing is captured in idle. Transcripts live under the child's PebblePath profile with the same retention as advisor chat. A parent can wipe the device from the app.

## 5. Child-facing UI rules (ages 3+)

The child cannot read. Every face follows these rules; `docs/screens.html` shows all twelve.

- **One shape per face**, centred. If a state needs two things, one is spoken by Pebble instead.
- **Words only when teaching.** The only text on a child-facing face is the word pair Pebble is teaching (French in amber `#D4A843`, English in white). Status, names, titles, errors: spoken, or shown to the parent in the app. The small clock and battery glyph in the corners are for the grown-up.
- **Colour is the label.** Teal glow `#7DD4C8` = Pebble listening or talking. Amber = French. Terracotta `#C67B5C` = the one action that leaves the device (Hello). Parents assign a colour per song, so tiles carry an icon and a colour, never a title.
- **Tap targets ≥ 96 px at 1×** (about 9 mm). Tiles fill the face in twos. Nothing in corners.
- **Buttons are the safety net.** Press: talk. Hold 1.5 s: Hello. Any press from anywhere: home.
- **Nothing to finish, nothing to win.** No streaks, stars, timers or prompts.
- **Icons:** 14 single-silhouette shapes on a 24 grid, 2.4 stroke, round caps, no inner detail (see the icon sheet on the screens page). The ripple stone is the only "character"; nothing has a face.
- **Dark faces** are the wearable exception to PebblePath's light-first rule, because black pixels are free on AMOLED. The dark mesh gradient keeps it PebblePath rather than generic gadget black.

### The twelve faces

| # | Face | What is on it |
|---|---|---|
| 1 | Home | Ripple stone, centred. Three faint hint icons at the bottom (note, drop, heart). Tiny clock and battery. |
| 2 | Listening | Big teal mic in a pulsing ring, three bouncing dots. No text. |
| 3 | Answer (fr→en) | `papillon` (amber) ↓ `butterfly` (white), one round replay button. |
| 4 | Answer (en→fr) | `I'm hungry` ↓ `J'ai faim` (amber), replay. |
| 5 | Songs | 2 × 2 colour tiles, note or film icon, selected tile outlined. Swipe up for the next four. |
| 6 | Playing | The chosen tile enlarged, progress line, one pause button. |
| 7 | Calm | Tiles: rain, seeds, tide (wide), snow, family photo. Icons only. |
| 8 | Calm: rain | Full-face animated loop, nothing on top. |
| 9 | Hello: hold | Terracotta heart in a ring that fills while held; two contact avatars below. |
| 10 | Hello: sent | Green heart with tick badge, the two avatars larger. Auto-returns home. |
| 11 | Resting | Dim stone, floating z's, small bolt. Sync and OTA happen here. |
| 12 | No Wi-Fi | Crossed-out cloud, lit note and drop icons for what still works. |

## 6. Design tokens (PebblePath, do not substitute)

```
teal #3D9B8F · teal-dark #2D7A70 · teal-deep #1F5C54 · teal-light #5CBFB0 · teal-glow #7DD4C8
sand #E8DCC8 · sand-light #F2EDE3 · off-white #FAF8F5
terracotta #C67B5C · terracotta-dark #A8624A
charcoal #2C3E40 · warm-gray #7A7A7A · light-gray #E5E0DA
domain: blue #6B9AC4 · amber #D4A843 · rose #C98A8A · purple #8B7BB5
display font Nunito (700/800) · body font Inter
```

The ripple-stone mark (Pebble's icon) is in `docs/screens.html` as `<symbol id="ripple-stone">`, 24-grid. Source of truth for tokens on the web side: `PebblePath/Website-Home/index.html` and `Website-Home/cairn-src/src/styles/tokens.css`; iOS: `Theme/Color+Pebble.swift`. The PebblePath workspace also has a `frontend-design` skill that encodes these.

Face mesh background (dark variant used on the wrist):

```css
background:
  radial-gradient(ellipse 60% 45% at 15% 20%, rgba(61,155,143,0.55), transparent 65%),
  radial-gradient(ellipse 50% 40% at 90% 25%, rgba(212,168,67,0.22), transparent 65%),
  radial-gradient(ellipse 70% 50% at 50% 105%, rgba(198,123,92,0.30), transparent 65%),
  linear-gradient(165deg, #1F5C54 0%, #143E39 55%, #0B1F1D 100%);
```

## 7. Pebble's voice (for the system prompt)

Pebble is PebblePath's advisor: warm, calm, brief, a knowledgeable friend rather than a teacher or a toy. On the Pocket it speaks to a child of three to six, so: short sentences, one idea, says the taught word twice (normal then slow), always offers one gentle next step ("want to hear it again?" / "try it with me"), never quizzes, never scores, never says "wrong". Detects the child's language and answers in the other one, then offers both. The child's age and first language come from the PebblePath child profile. Tone reference: the Pebble advisor in the iOS app and Portal; copy conventions in the PebblePath workspace memory (`voice-and-workflow`).

## 8. Build plan

| Phase | Deliverable | Notes |
|---|---|---|
| **0** · week of arrival | Waveshare demo flashed; then a bare ESP-IDF project: home face in LVGL, both buttons, Wi-Fi from a hard-coded config, **beep-and-record full-duplex audio test** | Proves the shared-I2S-clock bring-up. Nothing else matters until this passes. |
| **1** · 2 weeks | Translate, button-first | Cloud Function with a WebSocket per device; device streams Opus on press; STT → Claude (Pebble prompt) → TTS streamed back; faces 2, 3, 4. This is when it becomes Pebble. |
| **2** · 1 week | Learn and Calm from microSD | Upload in Portal, transcode Function (audio → 48 kHz Opus; video → 410 × 502 @ 15 fps), manifest diff on charge, faces 5 to 8. Ship five calm loops inside the firmware. |
| **3** · 1 week | Hello | Hold-to-record ring, upload, contact approval in Portal, push to PebblePath app with expiring link fallback, faces 9, 10. |
| **4** · ongoing | "Hey Pebble", OTA, day view | ESP-SR custom wake word; OTA so the classroom never needs a cable; the Pocket's day in the app next to the child's other signals. |

### Phase 0, concretely

1. Clone the Waveshare demo repo for ESP32-S3-Touch-AMOLED-2.06. Build and flash it with ESP-IDF (v5.3+ or v6.x; a buyer confirmed full duplex on v6.0.1). Confirm the screen, touch, buttons, battery readout and speaker all work on your unit before writing anything.
2. Extract from the demo: pin map, AXP2101 init, CO5300 QSPI init, FT3168 touch init, ES8311/ES7210 I2S init order. Write them into `firmware/docs/pinmap.md` so no one has to do this twice.
3. New ESP-IDF project in `firmware/` with components: `board` (PMU, display, touch, buttons, IMU), `audio` (codec bring-up, I2S full duplex, Opus encode/decode via `esp-audio-codec` or `libopus`), `ui` (LVGL 9, faces as separate screens), `net` (Wi-Fi, WebSocket client), `storage` (microSD, manifest).
4. Home face (face 1) in LVGL with the ripple stone, hint row, clock, battery.
5. Beep-and-record test: play a 1 kHz tone on ES8311 while recording from ES7210; assert mic energy rises during tone windows. Log to serial. When this passes, Phase 0 is done.

## 9. Open questions for Thomas

- Which STT and TTS providers for the Cloud Function. Any that stream both directions work; latency to first audio should be about a second.
- Whether the Pebble TTS voice is a fixed provider voice or something PebblePath already uses in the app.
- Contact delivery: push to the PebblePath app only, or also an SMS/iMessage link for grandparents without the app.
- Whether media uploads live in the existing PebblePath Storage bucket or a Pocket-specific one.
- Strap: the case has a 22 mm flat-end slot with a screw bar; the spring-bar lanyard adapter may or may not seat. Fallback is cord through the slot.

## 10. Working conventions

- Commit messages: plain, present tense, one line of what changed.
- No em-dashes in any text (Thomas's house rule); use commas, colons, parentheses or separate sentences.
- Keep `docs/` as the living spec. When a face changes in firmware, update `docs/screens.html` in the same PR.
- Never put secrets in the repo. The device key is provisioned at pairing; API keys live in Firebase config.
