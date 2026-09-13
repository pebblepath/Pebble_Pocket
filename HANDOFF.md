# Pebble Pocket: Handoff for Claude Code

Read this first. It is the complete context for building Pebble Pocket, written so a fresh Claude Code session in this repo can start Phase 0 without the original conversation.

## 1. What this is

Pebble Pocket is PebblePath's advisor, Pebble, made physical: a small wearable for a child aged three and up (Thomas is the sole tester until the legal terms are updated; Felix will be the first child to wear it after that), worn on a breakaway neck lanyard or stood on a table. **This is an internal prototype between the founders.** Nothing is sold or shared publicly; if the proof of concept is good we revisit compliance, safety and scope. It does four things and nothing else:

1. **Translate.** Child presses the top side button, BOOT (later: says "Hey Pebble"), asks something in French or English, and Pebble answers aloud in the other language, in Pebble's own warm tone. The face shows only the two words being taught.
2. **Learn.** Plays songs a parent uploaded, from the microSD card, offline. Video is out of scope.
3. **Calm.** Full-face ambient loops (rain, tide, seeds, snow, a family photo) for hard moments. No timer, no reward.
4. **Hello.** Hold BOOT, talk for up to 20 s, release, and the clip goes to contacts a parent approved (grandparents, carer). No inbound messages in v0.1.

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
| Buttons | BOOT (top) and PWR (bottom) on the right edge, both programmable, plus touch |
| Haptics | Optional vibration motor pads P1/P2: fed from AXP2101 ALDO3, switched by Q1 (MMBT3904) on GPIO18. Whether a motor is fitted is unconfirmed. The `pebble-pocket` build drives it (see section 5) |
| Case | 42.00 × 50.80 × 13.60 mm (Waveshare outline drawing). Visible AMOLED 33.09 × 40.51 mm, corner R9.2, so 12.39 px/mm (about 315 ppi). Right edge, top to bottom: mic, BOOT, USB-C, PWR, mic. Left edge: speaker slots and TF card slot. 22 mm flat-end strap slot with screw bar top and bottom |
| Pads | Reserved I2C, UART and USB pads for peripherals |

Wiki: https://www.waveshare.com/wiki/ESP32-S3-Touch-AMOLED-2.06
Reference code (corrected 2026-09-12 after reading the sources):
- Waveshare's official repo, github.com/waveshareteam/ESP32-S3-Touch-AMOLED-2.06, is **Apache-2.0, not MIT**. Use its ESP-IDF examples as read-only references. Never copy `examples/arduino/libraries/Arduino_DriveBus` (GPL-3.0).
- The MIT codebase is **github.com/78/xiaozhi-esp32**, which has an official folder for this exact board (`main/boards/waveshare/esp32-s3-touch-amoled-2.06/`) and already runs push-to-talk, Opus and WebSocket voice on it. Whether Pocket forks it is an open decision (section 9).
- Verified pin map: `firmware/docs/pinmap.md`. Full research brief with sources: `Claude outputs/Pebble-Pocket-Monday-Brief.md` in the PebblePath workspace (not in this repo).

### Hardware gotchas already known (from buyer reports)

- **ES8311 and ES7210 share all three I2S clock lines** (MCLK 16, BCLK 41, LRCK 45). So playback and recording must run at **one sample rate** (xiaozhi uses 24 kHz). Bring-up order: set the AXP2101 rails explicitly (Waveshare's examples rely on power-on defaults), then start the I2S master clock, then configure both codecs. **Use ESP-IDF for the audio path.** No hardware evidence yet that this works on IDF 6.x; xiaozhi recommends v6.1.
- **Echo cancellation is software.** Neither codec does it: the speaker output loops back into ES7210 MIC3 as a reference and ESP-SR cancels the echo. One mic is used for voice; the second is unused.
- **PWR is the power chip's on/off key.** Holding it about 4 to 6 s powers the board off, which is why Hello is held on BOOT. BOOT is GPIO0, a strapping pin: held down during a reset, it enters download mode.
- **microSD is wired 1-bit only.** Syncs are slow, which is one reason video is out of scope.
- **Flash is 32 MB but the examples configure 16 MB.** Use a 32 MB partition table.
- **Do not provision Wi-Fi on the factory firmware.** It talks to xiaozhi's servers. Build from source with your own server address, and erase the flash before a child handles the board.
- **Motor circuit is basic.** No flyback diode is drawn across P1/P2, and the transistor's base drive is weak (about 0.5 mA), which caps motor current near 45 to 65 mA and may not start a typical coin motor. If a motor is kept and feels weak, lower R12 (4.7 k) to about 470 ohm to 1 k and add a small diode across the pads.
- **Battery may be about 100 mAh, not 400.** One buyer measured under 400 mWh from empty to full. Measure it before charging unattended.
- **Waveshare's Arduino sketches are unreliable** for the display too; several buyers had to reverse-engineer the factory firmware. The ESP-IDF code (Waveshare's examples and xiaozhi's board folder) is the reliable starting point for pin maps and init sequences.
- **Pin map is under-documented.** Now read out of the source code into `firmware/docs/pinmap.md`: one I2C bus (GPIO 14 SCL, 15 SDA; speed set per device), display on QSPI (GPIOs 4 to 8, 11, 12), brightness via panel register 0x51, 0 to 255. Confirm each row on the bench.
- **Runs warm.** Waveshare measured 46 °C after 30 min while charging with Wi-Fi on, about 36 °C with wireless off. Long skin contact starts to burn at 43 °C, so measure the back of the case and never wear it while charging. Dim aggressively.
- **Speaker wires are fragile.** One buyer had a speaker lead detach during assembly. Handle the case gently when opening it.
- **Battery reality:** plan the UI around about an hour of screen-on time. Dim at 10 s, sleep at 30 s, wake on raise (IMU) or a press of the bottom button (PWR).

## 3. Repo layout

```
pebble-pocket/
├── HANDOFF.md        ← this file
├── README.md
├── docs/             ← GitHub Pages (Settings → Pages → main, /docs)
│   ├── index.html    ← architecture, flows, constraints, build plan
│   ├── screens.html  ← 12 face mockups for ages 3+, click to zoom, how it's held, icon set, face rules
│   └── assets/pocket.css
├── firmware/         ← xiaozhi-esp32 fork (firmware/xiaozhi, subtree at 563a4f0) + pinmap; build steps in firmware/README.md
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
  · choose today's mode · see the day
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
- **Words only when teaching.** The only text on a child-facing face is the word pair Pebble is teaching (French in amber: `#D4A843` on Dusk, the deeper `#946A10` on Sandbar; English in white on Dusk, charcoal on Sandbar). Status, names, titles, errors: spoken, or shown to the parent in the app. No clock and no battery indicator on any face: the Pocket is used in short bursts and nothing should distract the wearer.
- **Colour is the label.** Teal glow `#7DD4C8` = Pebble listening or talking. Amber = French. Terracotta `#C67B5C` = the one action that leaves the device (Hello). Parents assign a colour per song, so tiles carry an icon and a colour, never a title.
- **Tap targets ≥ 96 px at 1×**, which is 7.7 mm on this panel (112 px if we decide we want 9 mm). Tiles fill the face in twos. Nothing in corners: the R9.2 screen corners are about 114 px at 1×, so corner content clips.
- **Buttons are the safety net.** BOOT (top): press to talk, hold 1.5 s for Hello, press to pause while a song plays. PWR (bottom): wake, and home from anywhere. A terracotta sticker marks BOOT so a child can find the Hello button.
- **Swipes go left and right only.** No vertical paging.
- **Haptics confirm, never reward.** If a motor is fitted: a short tap on every BOOT press, a firmer tick when a hold reaches 1.5 s (Hello starts recording), and a double tap when something finishes (Hello sent, and at startup as a bench self-test). No buzzing for achievements, and everyday cues stay at or under 100 ms (only the startup bench test is longer).
- **Motion (QMI8658 IMU) only makes it easier, never a command.** (1) The face turns itself over when the case is upside down, which is what happens when a child lifts a lanyard-worn Pocket to their eyes. Lying flat, it keeps its last orientation so nothing turns mid-tap. (2) Face-down means asleep: screen off and microphone off, nothing can be recorded. (3) Hold for Hello is ignored while face-down, so no pocket hellos. (4) Raise to wake. No shake or tilt gestures.
- **No emoji, ever.** Faces use only the icon set and animations on `docs/screens.html`.
- **Nothing to finish, nothing to win.** No streaks, stars, timers or prompts.
- **Icons:** Phosphor Icons v2.1.1 (MIT), mirroring the SF Symbols style of the PebblePath iOS app: Fill style for solid shapes (mic, note, play, pause, drop, flower, heart, cloud-off, bolt, house) and Bold for line glyphs (replay, waves, snowflake, tick, arrow). SF Symbols themselves are licensed for Apple platforms, so they cannot ship on the Pocket. On the firmware the set converts to an LVGL font. The ripple stone is the only "character"; nothing has a face. See the icon sheet on `docs/screens.html`.
- **Two colour schemes, decide on the real screen.** **Sandbar** (default in the mockups) mirrors the PebblePath app's Home hero: sky blue to warm sand with a sun glow and faint wave lines, colours sampled from the iOS asset `sandbar-hero.jpg`. **Dusk** is the dark teal mesh, cheaper on AMOLED because dark pixels draw almost no power. Rain keeps its dusk scene and Resting stays near-black in both. The screens page has a Sandbar / Dusk switch.

### The twelve faces

| # | Face | What is on it |
|---|---|---|
| 1 | Home | Ripple stone, large, a little above centre. Three faint hint icons at the bottom (note, drop, heart). Nothing else. |
| 2 | Listening | Big teal mic in a pulsing ring, three bouncing dots. No text. |
| 3 | Answer (fr→en) | `papillon` (amber) ↓ `butterfly` (white), one round replay button. |
| 4 | Answer (en→fr) | `I'm hungry` ↓ `J'ai faim` (amber), replay. |
| 5 | Songs | 2 × 2 colour tiles with a note icon, selected tile outlined. Four songs, chosen by a parent in the app; nothing to scroll. |
| 6 | Playing | The chosen tile enlarged, progress line, one pause button. |
| 7 | Calm | Tiles: rain, seeds, tide (wide), snow, family photo (home icon until a parent adds a photo). Icons only. |
| 8 | Calm: rain | Full-face animated loop, nothing on top. |
| 9 | Hello: hold | Terracotta heart in a ring that fills while BOOT is held; two contact avatars below. |
| 10 | Hello: sent | Teal heart with tick badge, the two contact photos larger. Auto-returns home. |
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

Face backgrounds (both schemes are in `docs/screens.html`; decide on the real screen).

Sandbar (light, mirrors the app's Home hero `sandbar-hero.jpg`), plus two faint sand-coloured wave lines near the bottom:

```css
background:
  radial-gradient(circle at 70% 13%, rgba(255,255,255,0.95) 0 5%, rgba(255,255,255,0.5) 13%, transparent 32%),
  linear-gradient(180deg, #A6D9EA 0%, #C8E5E7 19%, #F5F3DD 40%, #F5E6C3 63%, #EFD5A8 100%);
```

Dusk (dark mesh, cheaper on AMOLED):

```css
background:
  radial-gradient(ellipse 60% 45% at 15% 20%, rgba(61,155,143,0.55), transparent 65%),
  radial-gradient(ellipse 50% 40% at 90% 25%, rgba(212,168,67,0.22), transparent 65%),
  radial-gradient(ellipse 70% 50% at 50% 105%, rgba(198,123,92,0.30), transparent 65%),
  linear-gradient(165deg, #1F5C54 0%, #143E39 55%, #0B1F1D 100%);
```

For the firmware, pre-render either background as an image (LVGL 9.5 has no dithering, so dark gradients band in RGB565); the screen calibration tool shows a banding test.

## 7. Pebble's voice (for the system prompt)

Pebble is PebblePath's advisor: warm, calm, brief, a knowledgeable friend rather than a teacher or a toy. On the Pocket it speaks to a child of three to six, so: short sentences, one idea, says the taught word twice (normal then slow), always offers one gentle next step ("want to hear it again?" / "try it with me"), never quizzes, never scores, never says "wrong". Detects the child's language and answers in the other one, then offers both. For the proof of concept the pair is fixed to English and French, so no language fields are added to the child profile; age comes from the PebblePath child profile. Tone reference: the Pebble advisor in the iOS app and Portal; copy conventions in the PebblePath workspace memory (`voice-and-workflow`).

## 8. Build plan

| Phase | Deliverable | Notes |
|---|---|---|
| **0** · week of arrival | Waveshare diagnostics flashed; then the xiaozhi-esp32 fork built for this board with our own server address: home face in LVGL, both buttons, Wi-Fi from a hard-coded config, **beep-and-record full-duplex audio test** | Proves the shared-I2S-clock bring-up. Nothing else matters until this passes. |
| **1** · 2 weeks | Translate, button-first | Cloud Run service with a WebSocket per device (Firebase Cloud Functions cannot accept WebSocket connections); device streams Opus on press; STT → Claude (Pebble prompt) → TTS streamed back; faces 2, 3, 4. This is when it becomes Pebble. |
| **2** · 1 week | Learn and Calm from microSD | Upload in Portal, transcode Function (audio → 24 kHz Opus to match the shared I2S clock), manifest diff on charge, faces 5 to 8. Ship four calm loops (rain, seeds, tide, snow) inside the firmware; the family-photo tile is filled by a parent. |
| **3** · 1 week | Hello | Hold-to-record ring, upload, contact approval in Portal, push to PebblePath app with expiring link fallback, faces 9, 10. |
| **4** · ongoing | "Hey Pebble", OTA, day view | ESP-SR custom wake word; OTA so the classroom never needs a cable; the Pocket's day in the app next to the child's other signals. |

### Phase 0, concretely

1. Build Waveshare's ESP-IDF examples (`01_AXP2101`, `05_Spec_Analyzer`, and `06_videoplayer` purely as a speaker and microSD test) with ESP-IDF v6.1 and flash them. Confirm the screen, touch, buttons, battery readout, mics and speaker all work on your unit before writing anything. Do not put the factory firmware on Wi-Fi.
2. Confirm `firmware/docs/pinmap.md` on the bench (written from source on 2026-09-12): tick each row, record AXP2101 rail voltages, and measure the screen's corner radius and safe area.
3. Fork github.com/78/xiaozhi-esp32 (MIT) into `firmware/`, pinned to a known commit. Keep its board layer (`main/boards/waveshare/esp32-s3-touch-amoled-2.06/`), audio pipeline (codecs, echo cancellation, Opus), WebSocket protocol and OTA. Replace its default server address (`api.tenclass.net`) before the board ever joins Wi-Fi, turn the wake word off, strip its remote-firmware tools, switch to the 32 MB partition table, and replace its UI with the Pebble faces. Add microSD songs and Hello later (phases 2 and 3). Keep the MIT licence notice.
4. Home face (face 1) in LVGL with the ripple stone and hint row.
5. Beep-and-record test: play a 1 kHz tone on ES8311 while recording from ES7210; assert mic energy rises during tone windows. Log to serial. When this passes, Phase 0 is done.

## 9. Open questions for Thomas

- ~~Which STT and TTS providers~~ **Decided 2026-09-12: Google for both.** Speech-to-text: Cloud Speech-to-Text v2 with the Chirp 3 model (the `us` multi-region; no us-central1 endpoint). Text-to-speech: Cloud Text-to-Speech Chirp 3 HD (one voice across fr-FR and en-US). Both in the `pebblepath-992b6` project, called only from the Cloud Run voice service with a service account (no API keys). Before a child uses it, confirm whether Google's Service Specific Terms on generative AI and under-18 users cover Chirp 3.
- Whether the Pebble TTS voice is a fixed provider voice or something PebblePath already uses in the app.
- Contact delivery (researched 2026-09-12, memo in `Claude outputs/Pebble-Pocket-Hello-Delivery-Memo.md`): a real iMessage is not possible (no Apple API; workarounds send from Thomas's Apple ID and risk bans). **Recommended for the prototype:** an email to Mamie and Papi with a Listen button that opens a simple PebblePath page (clip converted to AAC .m4a, unguessable expiring link, auto-delete). **Later, if the app integration goes ahead:** a PebblePath app push that opens the clip (the app needs iOS 26.4). SMS needs carrier registration even for two people; WhatsApp's business terms forbid family use. Awaiting Thomas's decision.
- Media storage (direction agreed 2026-09-12, not built): files in Cloud Storage for Firebase inside `pebblepath-992b6`, organised per family and child; song metadata and which four songs are on the Pocket in Firestore under the family/child; parents edit from the iOS app and Portal later. **Decided: a dedicated Pocket bucket** in the same project (own security rules and cost line; Hello clips auto-deleted by a folder-scoped lifecycle rule). The Pocket never reads Firebase directly: the Cloud Run service checks pairing and hands out short-lived download links.
- Lanyard: the case has a 22 mm flat-end slot with a screw bar top and bottom. Check whether the breakaway lanyard's spring-bar adapter seats; if not, run the breakaway cord through the top slot, as drawn on the screens page.

## 10. Working conventions

- Commit messages: plain, present tense, one line of what changed.
- No em-dashes in any text (Thomas's house rule); use commas, colons, parentheses or separate sentences.
- Keep `docs/` as the living spec. When a face changes in firmware, update `docs/screens.html` in the same PR.
- Never put secrets in the repo. The device key is provisioned at pairing; API keys live in Firebase config.

## 11. Decisions log

**2026-09-12** (Thomas, first Claude Code session)

- Internal founders' prototype only. Nothing sold or shared publicly; compliance (COPPA, product safety, radio) is revisited only if the proof of concept is good. A breakaway lanyard is used from day one.
- First wearers are a three-year-old and a four-year-old. **Updated same day:** Thomas is the sole tester until the legal terms are updated; Felix will be the first child to wear it after that.
- Language pair fixed to English and French for the proof of concept. No child-profile language fields.
- Buttons: BOOT (top) press to talk, hold 1.5 s for Hello, press to pause a playing song; PWR (bottom) wake and home. BOOT gets a terracotta sticker.
- Swipes left and right only. Songs show four tiles, chosen by a parent; no vertical paging.
- No emoji on any face. Use only the icon set and animations in `docs/screens.html`. The family-photo tile uses the home icon until a photo is added.
- Motion sensor: flip the face when upside down and keep its orientation when flat, face-down means screen and mic off, Hello ignored while face-down, raise to wake. No gesture commands.
- Tap-target note to keep handy: 96 px is 7.7 mm on this panel; 9 mm needs 112 px.
- Hello faces show real contact photos (`docs/assets/contacts/mamie.jpg`, `papi.jpg`), not letters. They become PebblePath profile photos if the app integration goes ahead.
- Screens redrawn on the real case from Waveshare's outline drawing (no straps). Confirm the R9.2 corner and the visible area on the physical unit.
- Local checkout lives at `~/Desktop/Pebble_Pocket`. Homebrew prerequisites installed (cmake, ninja, dfu-util, ccache); ESP-IDF version to be pinned after the audio research.
- Screens round 2: spec cards fixed, Home stone enlarged (92 to 120 px at half size), no battery indicator on any face, icons replaced with Phosphor Icons (Fill for solid shapes, Bold for line glyphs) to mirror the iOS app's SF Symbols style, rain face rebuilt as a dusk scene, contact photos cropped from the founders' photo (original stays local; it carries GPS metadata and `*.heic` is gitignored).
- Repo checkout moved to `PebblePath/pebble-pocket` (already excluded from the PebblePath backup).
- Wi-Fi: the factory firmware never joins any network. Our own firmware joins a phone hotspot or guest network during bench work, then home Wi-Fi once it only talks to PebblePath's own server.
- **Firmware: fork xiaozhi-esp32** (MIT), chosen by Thomas on 2026-09-12 after the research recommended it. It already runs push-to-talk voice, echo cancellation and the power and audio bring-up on this exact board.
- **Video is out of scope.** Learn is songs only (note icon on every tile); the film icon is removed from the set.
- **No clock on Home.** Home is the stone (raised a little above centre) and the three hint icons.
- **Calm: either button press goes home.**
- **Basic haptics added** to the `pebble-pocket` build (`CONFIG_POCKET_HAPTICS`): ALDO3 on at 3.0 V, GPIO18 pulses for tap (60 ms), tick (100 ms) and double. Monday test: one 400 ms buzz at startup means a motor is fitted; feeling nothing is inconclusive (weak drive), so check pads P1/P2 before deciding.
- **Speech-to-text and text-to-speech: Google** (Chirp 3 STT, Chirp 3 HD TTS), in the PebblePath Firebase project.
- **Media storage: a dedicated Pocket bucket** in `pebblepath-992b6`, organised `families/{family}/children/{child}/pocket/...`, with song metadata in Firestore. Not built yet.
- **Pebble's voice: Chirp 3 HD "Achernar"** (listed as female), the same voice in both languages: `en-US-Chirp3-HD-Achernar` and `fr-FR-Chirp3-HD-Achernar`. Confirm the fr-FR voice appears in the Text-to-Speech voices list on the first server call.
- **Hello delivery (prototype): PebblePath app push notification plus a small Home card under Upcoming Activities.** Email rejected. TestFlight only, sent only to Thomas's account. The card (`PocketHelloCard.swift` in the PebblePath iOS app) is a DEBUG-only preview with mock data for now; build notes for real delivery (data, rules, dedicated bucket, `pocket_hello` notification kind, guardrails) are in `Claude outputs/Pebble-Pocket-Hello-In-App-Build-Notes.md`.
- **Face colour scheme:** Thomas asked to try Sandbar (the app's Home hero palette, kept simple). Both Sandbar and Dusk stay in the mockups behind a switch until the faces are seen on the real AMOLED, weighing looks against battery.
