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

## What the `pebble-pocket` build variant changes

Set in `xiaozhi/main/boards/waveshare/esp32-s3-touch-amoled-2.06/config.json`, next to the untouched stock variant:

| Setting | Stock | Pocket | Why |
|---|---|---|---|
| Update and config server (`CONFIG_OTA_URL`) | `api.tenclass.net` (xiaozhi's servers) | `https://pocket-ota.invalid/ota/` | The `.invalid` domain can never resolve, so the board contacts nobody until our own server exists. |
| Flash size and partitions | 16 MB, `partitions/v2/16m.csv` | 32 MB, `partitions/v2/32m.csv` | The chip has 32 MB. |
| Language | zh-CN | en-US (build flag) | |
| Wake word | "nihaoxiaozhi" on | off (build flag) | Pocket is button-first. |

## Still to change before the board joins Wi-Fi with a child nearby

- [ ] Point `CONFIG_OTA_URL` at the PebblePath Cloud Run service once it exists.
- [ ] Remove the remote-firmware tools: `self.upgrade_firmware` (`main/mcp_server.cc:145`), `self.assets.set_download_url` (`main/mcp_server.cc:295`), and the server-forced update flag (`main/ota.cc:239`).
- [ ] Replace the chat and emoji UI with the Pebble faces from `docs/screens.html` (xiaozhi uses a Material Symbols icon font; swap in the Phosphor set).
- [ ] Replace provisioning with BLE Wi-Fi setup driven from the PebblePath iOS app.
- [ ] Enable Secure Boot v2 and flash encryption (rehearse on a spare board first; eFuse writes are permanent).
- [ ] Add microSD songs (phase 2) and Hello record and upload (phase 3).

## Pulling upstream fixes later

```bash
cd ~/Desktop/PebblePath/pebble-pocket
git fetch xiaozhi main
git subtree pull --prefix=firmware/xiaozhi --squash xiaozhi <commit>
```

Pull deliberately, one known commit at a time, and rebuild. The upstream board folder changes often.

## Licence

`xiaozhi/LICENSE` (MIT, Shenzhen Xinzhi Future Technology Co., Ltd.) must stay with the code. Its Espressif dependencies (esp-sr, esp_audio_codec) may only be used on Espressif chips, which this is.
