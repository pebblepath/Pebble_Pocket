# Pin map: Waveshare ESP32-S3-Touch-AMOLED-2.06

Read from source code on 2026-09-12, before the board arrived. Every row in the first two tables has a code citation; confirm each on the bench and tick it off.

Sources:
- **[BSP]** github.com/waveshareteam/Waveshare-ESP32-components @d081959, `bsp/esp32_s3_touch_amoled_2_06/`
- **[XZB]** github.com/78/xiaozhi-esp32 @563a4f0, `main/boards/waveshare/esp32-s3-touch-amoled-2.06/`
- **[WS]** github.com/waveshareteam/ESP32-S3-Touch-AMOLED-2.06 @b099739 (includes the schematic PDF)

## GPIO

| Signal | GPIO | Citation | Bench |
|---|---|---|---|
| I2C SCL (one shared bus) | 14 | [BSP] `include/bsp/esp32_s3_touch_amoled_2_06.h:35-36`; [XZB] `config.h:19` | [ ] |
| I2C SDA (one shared bus) | 15 | same; [XZB] `config.h:18` | [ ] |
| I2S MCLK (shared by ES8311 and ES7210) | 16 | [BSP] `.h:38-42`; [XZB] `config.h:11` | [ ] |
| I2S BCLK (shared) | 41 | same; [XZB] `config.h:13` | [ ] |
| I2S WS / LRCK (shared, strapping pin) | 45 | same; [XZB] `config.h:12` | [ ] |
| I2S DOUT to ES8311 (speaker) | 40 | same; [XZB] `config.h:15` | [ ] |
| I2S DIN from ES7210 (mics + echo reference) | 42 | same; [XZB] `config.h:14` | [ ] |
| Speaker amp enable, NS4150B (active high, strapping pin) | 46 | [BSP] `.h:43`; [XZB] `config.h:17` | [ ] |
| LCD QSPI CS | 12 | [BSP] `.h:46-54`; [XZB] `config.h:25` | [ ] |
| LCD QSPI PCLK | 11 | same; [XZB] `config.h:26` | [ ] |
| LCD QSPI D0 / D1 / D2 / D3 | 4 / 5 / 6 / 7 | same; [XZB] `config.h:27-30` | [ ] |
| LCD reset | 8 | same; [XZB] `config.h:31` | [ ] |
| LCD backlight | none. Brightness is panel register 0x51, one byte 0 to 255 | [BSP] `.c:58-64`; [XZB] `.cc:128-137` | [ ] |
| Touch reset (FT3168) | 9 | [BSP] `.h:55-56` | [ ] |
| Touch interrupt (active low) | 38 | [BSP] `.h:55-56` | [ ] |
| microSD CLK (SDMMC, **1-bit only**) | 2 | [BSP] `.h:59-61`, `.c:160-176` (`.width = 1`) | [ ] |
| microSD CMD | 1 | same | [ ] |
| microSD D0 (strapping pin) | 3 | same | [ ] |
| BOOT button (low when pressed, strapping pin) | 0 | [XZB] `config.h:23` | [ ] |
| AXP2101 interrupt | not routed. Poll registers 0x48 to 0x4A over I2C | [WS] `examples/esp-idf/01_AXP2101/sdkconfig.defaults:3` | [ ] |

## I2C addresses (7-bit)

| Device | Address | Citation | Bench |
|---|---|---|---|
| AXP2101 power chip | 0x34 | XPowersLib `REG/AXP2101Constants.h:3` | [ ] |
| ES8311 speaker codec | 0x18 | esp_codec_dev `es8311_codec.h:18` | [ ] |
| ES7210 mic ADC | 0x40 | esp_codec_dev `es7210_adc.h:16` | [ ] |
| QMI8658 motion sensor | 0x6B (schematic suggests 0x6A; code and a buyer's scan say 0x6B) | [WS] `examples/esp-idf/04_Immersive_block/main/main.c:423` | [ ] |
| PCF85063 clock | 0x51 | Waveshare components `sensor/pcf85063a/include/pcf85063a.h:15` | [ ] |
| FT3168 touch | 0x38 (sometimes drops out of a scan) | `Arduino_FT3x68.h:56`; [WS] issue 15 | [ ] |

## Schematic only (no code uses these yet)

| Signal | GPIO | Note |
|---|---|---|
| PWR button mirror | 10 | Reads high while PWR is pressed. PWR itself is the AXP2101 power key: holding it about 4 to 6 s powers the board off. |
| IMU interrupt INT1 | 21 | Can wake the chip from deep sleep (only GPIO0 to GPIO21 can). Candidate for raise-to-wake. |
| RTC interrupt | 39 | Cannot wake from deep sleep; reported to stay low (issue 7). |
| LCD tearing effect | 13 | Unused; available for tear-free drawing. |
| Vibration motor driver | 18 | Motor pads powered from ALDO3. Whether a motor is fitted is unknown: check pads P1/P2. |
| UART0 TX / RX | 43 / 44 | |
| USB D- / D+ | 19 / 20 | |
| Octal PSRAM | 33 to 37 | **Never configure these.** |

## Power rails (AXP2101)

xiaozhi sets these explicitly ([XZB] `.cc:27-55`); Waveshare's own examples rely on power-on defaults.

| Rail | Setting | Feeds |
|---|---|---|
| DC1 | 3.3 V | main system |
| ALDO1 | 3.3 V | codec analog supply. **Must stay on.** |
| ALDO2 | 3.3 V | display power enable. **Must stay on.** |
| ALDO3 | off | vibration motor (if fitted) |
| everything else | off | |

## Display

- 410 x 502 px, 12.39 px per mm. Corner radius measured by a buyer at 115 px with a 4 px safe inset (issue 18), which matches the R9.2 mm on Waveshare's drawing.
- Working driver is `waveshare/esp_lcd_sh8601` with a 0x16 column gap; flush areas are rounded to even coordinates ([BSP] `.c:456`; [XZB] `.cc:61-93,245`).

## Things these pins force on the design

- **One audio sample rate at a time.** Both codecs share MCLK, BCLK and LRCK, so playback and recording must run at the same rate. xiaozhi uses 24 kHz; songs get resampled at sync time.
- **Only one mic is used for voice.** The ES7210 records one mic plus a hardware loopback of the speaker output, and ESP-SR cancels the echo in software. The second mic is unused.
- **Hello stays on BOOT, not PWR.** A long PWR hold powers the board off. Note that BOOT (GPIO0) held down while the board resets puts it into download mode.
- **Slow microSD.** 1-bit wiring means slow syncs. Video is out of scope; songs only.
- **Flash is 32 MB, but the examples configure 16 MB.** Use xiaozhi's `partitions/v2/32m.csv` and set flash size to 32 MB.
