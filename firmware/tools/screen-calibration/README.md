# Screen calibration

A standalone ESP-IDF program that draws a pixel-exact test pattern on the Waveshare ESP32-S3-Touch-AMOLED-2.06 at its native 410 x 502, and prints every touch to the serial log. Use it on the bench to measure the real corner radius, the safe area, touch accuracy and RGB565 banding before any Pebble face is drawn.

Display and touch are brought up exactly as in Waveshare's `examples/esp-idf/02_lvgl_demo_v9` (commit b099739), through the board BSP's `bsp_display_start()`. This folder is derived from that example and keeps its Apache-2.0 licence (`LICENSE`).

## What is on the screen

| Element | Where | Purpose |
|---|---|---|
| Black background | everywhere | AMOLED black is "off", so the glass edge is easy to see |
| 1 px white border | the outermost pixels: x=0, x=409, y=0, y=501 | Is the very edge visible? |
| Corner guide arcs | every corner, radius 20, 40, 60, 80, 100, 120 px, one colour per radius (legend in the middle: red 20, orange 40, yellow 60, green 80, blue 100, magenta 120) | Each arc is the outline a rounded corner of that radius would have. The arc that just fits inside the glass is the corner radius |
| Radius numbers | next to where each arc meets the top and bottom edges | Small numbers may be hidden by the glass; that is expected |
| Faint grid | a line every 10 px, brighter every 50 px, with some 50 px lines numbered | Count squares to measure insets |
| Centre crosshair | 2 px wide on x=204..205 and y=250..251 (the true centre is between pixels) | Is the panel centred in the case? |
| Gradient band 1 | y=318..357, x=20..389, #1F5C54 on the left to #0B1F1D on the right, plain RGB565 | How visible is banding? |
| Gradient band 2 | y=378..417, same colours with a 4x4 ordered dither | Does dithering fix it? |
| Touch readout and ring | text near the bottom, a teal ring under your finger | Quick visual check of touch |

## Build and flash

```bash
export PATH=/opt/homebrew/bin:$PATH; . ~/esp/esp-idf/export.sh
cd ~/Desktop/PebblePath/pebble-pocket/firmware/tools/screen-calibration
idf.py set-target esp32s3     # only the first time
idf.py build
ls /dev/cu.*                  # find the board's port
idf.py -p /dev/cu.<port> flash monitor
```

Quit the monitor with `Ctrl+]`. If flashing fails: power off, hold BOOT, power on, release BOOT, flash again, then power-cycle (same recovery as `firmware/README.md`).

## What the serial log shows

```
I (...) calib: Pebble Pocket screen calibration, native 410 x 502
I (...) calib: touch logging enabled
I (...) calib: pattern drawn in ... ms (canvas stride 410 px)
I (...) calib: ready: touch the screen or press BOOT
I (...) calib: touch #1 down x=205 y=250
I (...) calib: touch #1 move x=207 y=252
I (...) calib: touch #1 up   x=207 y=252 (last position)
I (...) calib: BOOT (GPIO0) pressed
```

Coordinates are the raw values the touch controller reports, before LVGL clamps them. A value past 409 or 501 is tagged `OUTSIDE`.

## What to photograph

Room lights dimmed, phone exposure turned down until the white border is not blown out. If the grid shows moire stripes in a photo, move the phone a little closer or further.

1. The whole face, straight on, filling the frame.
2. Each of the four corners, as close as the phone will focus. Label them TL, TR, BL, BR.
3. The two gradient bands, straight on.
4. The face from about 45 degrees left and right (checks whether the edge rows vanish under the bezel at an angle).

## What to write down

Copy this into the bench notes (for example next to the pin map in `firmware/docs/pinmap.md`).

- **Corner radius, per corner:** the largest arc whose whole quarter circle is visible, and the smallest arc that is clipped. Example: "TL: 120 clipped at the ends, 100 fully visible". Say whether all four corners agree.
- **Edges:** is the white border visible along the top, bottom, left and right? If not, how many pixels in does the first visible grid line sit (count 10 px squares)?
- **Centre:** does the crosshair look centred inside the glass? If not, which way and by roughly how many grid squares.
- **Banding:** how many distinct steps you can count across band 1, and whether band 2 looks smooth. Note any colour cast (a pink or green tint would suggest the colour order or byte swap is wrong).
- **Touch accuracy:** tap each of these points and write down the logged x and y:

  | Aim at | Expected |
  |---|---|
  | crosshair centre | about 204 to 205, 250 to 251 |
  | grid crossing 50, 50 | 50, 50 |
  | grid crossing 350, 50 | 350, 50 |
  | grid crossing 50, 450 | 50, 450 |
  | grid crossing 350, 450 | 350, 450 |

  Also confirm the axes: x should grow to the right and y downwards. Then slide a finger slowly along each straight edge and note the smallest and largest x and y the log reaches.
- **BOOT:** does each press print `pressed` and `released` once?

## Cautions

- The pattern is static and the panel runs at 100 % brightness (the BSP sets register 0x51 to 255). Do not leave it on for more than about 15 minutes: AMOLED can retain a static image, and the board runs warm.
- Unplug before handing the board to anyone else, and never wear it while it is charging.
- The build uses Waveshare's 16 MB flash layout. That is harmless on the 32 MB chip and does not touch the Pocket firmware settings.
