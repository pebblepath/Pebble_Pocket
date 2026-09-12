# Pebble Pocket

An internal founders' prototype of a pocket-sized, wearable Pebble: PebblePath's advisor on a 2.06" AMOLED watch board that listens for "Hey Pebble", answers in French or English in Pebble's voice, plays the family's learning songs, calms a hard moment, and sends a hello to approved contacts.

**Start with `HANDOFF.md`** if you are a Claude Code session: it holds the full context, hardware gotchas, UI rules and the Phase 0 checklist.

**Working documents (GitHub Pages):**

- `docs/index.html`: system architecture, the four feature flows, hardware constraints, build plan
- `docs/screens.html`: twelve face mockups designed for ages 3+ (icons first, words only when teaching), at 0.5× with click-to-zoom, plus the icon set and face rules

Open them locally by double-clicking, or turn on GitHub Pages (Settings → Pages → Deploy from branch → `main` / `docs`) and they are served at `https://<org>.github.io/<repo>/`.

## Hardware

| | |
|---|---|
| Board | Waveshare ESP32-S3-Touch-AMOLED-2.06 (watch case, straps and 400 mAh battery included) |
| MCU | ESP32-S3R8, 240 MHz dual core, 8 MB PSRAM, 32 MB flash |
| Display | 2.06" AMOLED 410 × 502, capacitive touch, CO5300 + FT3168, 600 nits. Case 50.8 × 42 × 13.6 mm |
| Audio | ES8311 codec, ES7210 mic ADC with a speaker loopback for software echo cancellation (ESP-SR), dual mics, NS4150B speaker amp on 3.3 V |
| Radio | Wi-Fi 2.4 GHz, Bluetooth LE 5 (no classic Bluetooth, so no A2DP) |
| Storage | microSD slot (media library lives here) |
| Power | AXP2101 PMU, USB-C. About 1 h screen-on at full brightness, 3 to 4 h screen-off |
| Carry | 22 mm flat-end strap slot with screw bar (per Waveshare outline drawing), neck lanyard adapter |

GitHub: https://github.com/pebblepath/Pebble_Pocket

## Architecture in one paragraph

The Pocket is a thin client. It captures audio, draws faces, plays sound and reads two buttons. A WebSocket to a PebblePath Cloud Run service (Cloud Functions cannot hold WebSockets) carries audio up and Pebble's voice plus screen text down; the service does speech-to-text, calls the Claude API with the Pebble system prompt and the child's context, and streams text-to-speech back. Songs and calm loops are uploaded in the PebblePath app or Portal, transcoded by a Function, and synced to the microSD card while the Pocket charges, so Learn and Calm work offline. Hello clips go to the cloud and are pushed only to contacts a parent approved in the app. The Pocket holds one device key and no third-party secrets.

## Planned repo layout

```
pebble-pocket/
├── docs/          # these pages (GitHub Pages root)
│   ├── index.html
│   ├── screens.html
│   └── assets/pocket.css
├── firmware/      # fork of xiaozhi-esp32 (MIT) in firmware/xiaozhi; build steps in firmware/README.md
├── cloud/         # Firebase Cloud Functions (pocket session, media, hello, fleet)
└── portal/        # Parent-side screens for the existing PebblePath Portal (Lit)
```

## Build plan

| Phase | Scope |
|---|---|
| 0 · week of arrival | Waveshare demo, then bare ESP-IDF: idle face in LVGL, buttons, Wi-Fi, full-duplex audio beep-and-record test |
| 1 · 2 weeks | Translate, button-first. WebSocket session, STT → Claude (Pebble prompt) → TTS, both languages on screen |
| 2 · 1 week | Learn and Calm from microSD. Upload in Portal, transcode, manifest sync on charge, Songs and Calm tile faces |
| 3 · 1 week | Hello. Hold-to-record ring, upload, contact approval, push to PebblePath app with expiring link fallback |
| 4 · ongoing | "Hey Pebble" custom wake word (ESP-SR), OTA firmware, the Pocket's day view in the app |

## Things we already know

- **Use ESP-IDF for audio, not Arduino.** The ES8311 and ES7210 share all three I2S clock lines, so playback and recording run at one sample rate. Set the power rails explicitly first, then the I2S master clock, then both codecs. The Arduino examples hide the ordering.
- **Waveshare's Arduino sketches are unreliable.** Use ESP-IDF code instead: Waveshare's examples (Apache-2.0) as references, and github.com/78/xiaozhi-esp32 (MIT), which already supports this board. Verified pins: `firmware/docs/pinmap.md`.
- **Battery is the real budget.** Dim at 10 s, sleep at 30 s, wake on raise or a press of the bottom button (PWR). Learn and Calm run at 40 percent brightness.
- **The speaker is small** (an NS4150B amp on the 3.3 V rail; no wattage is published). Fine for one child at arm's length. A tabletop dock with a real speaker is a later option over the reserved I2C and UART pads.
- **Custom wake word is v0.2.** ESP-SR runs wake words on-device, but "Hey Pebble" has to be trained through Espressif's service. v0.1 is button-first.

## Design language

Tokens, type and the ripple-stone mark are PebblePath's, taken from `Website-Home/index.html` and the `frontend-design` skill in the PebblePath workspace. Teal glow = Pebble listening or speaking. Amber = the French word (Language domain colour). Terracotta = the one action that leaves the device, Hello. Dark faces are the wearable exception to the app's light-by-default rule, because black pixels cost nothing on AMOLED.
