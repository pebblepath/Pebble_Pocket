# firmware

Pebble Pocket firmware is a fork of **xiaozhi-esp32** (MIT, github.com/78/xiaozhi-esp32), chosen on 2026-09-12 because it already runs push-to-talk voice, echo cancellation, and the power and audio bring-up on the Waveshare ESP32-S3-Touch-AMOLED-2.06.

```
firmware/
├── README.md          ← this file
├── docs/pinmap.md     ← pins read from source; tick each row on the bench
└── xiaozhi/           ← the fork (git subtree, imported at upstream commit 563a4f0)
```

## Build (macOS, ESP-IDF v6.1)

1. Open a new terminal and activate ESP-IDF:
   ```bash
   export PATH=/opt/homebrew/bin:$PATH; . ~/esp/esp-idf/export.sh
   ```
2. Build the Pocket variant:
   ```bash
   cd ~/Desktop/PebblePath/pebble-pocket/firmware/xiaozhi
   python scripts/build.py waveshare/esp32-s3-touch-amoled-2.06 --name pebble-pocket --language en-US --wake-word disabled
   ```
   The first build takes several minutes (it downloads components). The output is in `firmware/xiaozhi/build/`.
3. Flash (board plugged in over USB-C; find the port with `ls /dev/cu.*`):
   ```bash
   idf.py -p /dev/cu.<port> flash monitor
   ```
   If flashing fails: power off, hold BOOT, power on, flash again, then power-cycle.
4. Haptics check: at startup, hold the board and feel for one long buzz (about half a second), then a short tap on each BOOT press. A buzz means a motor is fitted. **Feeling nothing is inconclusive:** the board's motor drive is weak and may not start every motor, so confirm by looking at pads P1/P2 before deciding (the rest of the firmware works the same either way).

## What the `pebble-pocket` build variant changes

Set in `xiaozhi/main/boards/waveshare/esp32-s3-touch-amoled-2.06/config.json`, next to the untouched stock variant:

| Setting | Stock | Pocket | Why |
|---|---|---|---|
| Update and config server (`CONFIG_OTA_URL`) | `api.tenclass.net` (xiaozhi's servers) | `https://pocket-ota.invalid/ota/` | The `.invalid` domain can never resolve, so the board contacts nobody until our own server exists. |
| Flash size and partitions | 16 MB, `partitions/v2/16m.csv` | 32 MB, `partitions/v2/32m.csv` | The chip has 32 MB. |
| Language | zh-CN | en-US (build flag) | |
| Wake word | "nihaoxiaozhi" on | off (build flag) | Pocket is button-first. |
| Haptics (`CONFIG_POCKET_HAPTICS`) | off | on: ALDO3 at 3.0 V, GPIO18 pulses (`pocket_haptics.h`) | Tap (60 ms) on BOOT press, tick (100 ms) at the 1.5 s hold, one 400 ms buzz at startup as a bench test. |
| Battery charge current (`CONFIG_POCKET_SAFE_CHARGE`) | 400 mA | 100 mA | The battery may be about 100 mAh; raise it only after measuring capacity. |

## Still to change before the board joins Wi-Fi with a child nearby

- [ ] Point `CONFIG_OTA_URL` at the PebblePath Cloud Run service once it exists.
- [ ] Remove the remote-firmware tools: `self.upgrade_firmware` (`main/mcp_server.cc:145`), `self.assets.set_download_url` (`main/mcp_server.cc:295`), and the server-forced update flag (`main/ota.cc:239`).
- [ ] Replace the chat and emoji UI with the Pebble faces from `docs/screens.html` (xiaozhi uses a Material Symbols icon font; swap in the Phosphor set).
- [ ] Replace provisioning with BLE Wi-Fi setup driven from the PebblePath iOS app.
- [ ] Enable Secure Boot v2 and flash encryption (rehearse on a spare board first; eFuse writes are permanent).
- [ ] Add microSD songs (phase 2) and Hello record and upload (phase 3). Play the haptic double tap when a Hello is sent.
- [ ] Remove the startup buzz once the motor is confirmed (it is a bench self-test).
- [ ] If a motor is kept and feels weak: lower R12 (4.7 k) to 470 ohm to 1 k so Q1 fully switches on, add a small diode across P1/P2, then re-tune the pulse lengths.

## Pulling upstream fixes later

```bash
cd ~/Desktop/PebblePath/pebble-pocket
git fetch xiaozhi main
git subtree pull --prefix=firmware/xiaozhi --squash xiaozhi <commit>
```

Pull deliberately, one known commit at a time, and rebuild. The upstream board folder changes often.

## Licence

`xiaozhi/LICENSE` (MIT, Shenzhen Xinzhi Future Technology Co., Ltd.) must stay with the code. Its Espressif dependencies (esp-sr, esp_audio_codec) may only be used on Espressif chips, which this is.
