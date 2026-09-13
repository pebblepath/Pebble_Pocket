# Bench day 1: Monday 2026-09-14

This is the checklist for the first day with the Waveshare ESP32-S3-Touch-AMOLED-2.06. It is written for Thomas, working alone, with no prior hardware or terminal experience. Follow it top to bottom. Every command has been checked against the installed tools (ESP-IDF v6.1, esptool v5.4.0) and every expected result was read out of the source code. **None of it has been run on a real board yet**, because the board had not arrived when this was written. If what you see differs from what this page says, write it down: that difference is the most useful thing the day can produce.

The day has one goal: prove that every part of the board works on your unit (power chip, microphones, speaker, microSD, screen, touch, buttons, vibration motor) before any Pebble Pocket code is written.

---

## Ground rules for the whole day

- **Never put the board on Wi-Fi today.** Do not connect your phone or laptop to any network the board creates (it will be called `Xiaozhi-` followed by four characters), do not scan any QR code it shows, do not install any app it asks for, and do not open any web address it shows.
- **Stay with the board whenever the USB cable is plugged in.** The board charges its battery from USB, and the test programs set a charge current that may be too high for this battery (see Part 12). Unplug before you leave the room.
- **Stop if it gets hot.** If the back of the case reaches 43 °C, or you smell anything, or the battery looks swollen: unplug the USB cable, hold the bottom button (PWR) until the screen goes dark, and let it cool for at least 10 minutes.
- **Nobody wears it today,** and nobody else handles it until Part 14 is done.
- **Only one program can talk to the board at a time.** Before running a new command, make sure the previous one has finished (you see the prompt again) or you have left the monitor with Ctrl+].

---

## Part 0: How to use this page and the Terminal

**0.1** Open the Terminal app: press Cmd+Space, type `Terminal`, press Return. Use this one Terminal window for the whole day. If you close it, redo steps 0.2 and 0.3 in the new window.

**0.2** Each grey box below holds exactly one command. Click inside the box, select all the text in it, copy it, paste it into Terminal, and press Return. Wait until the command finishes (a new prompt line appears) before the next one. Copy only the text inside the box.

**0.3** Switch on the ESP-IDF tools for this window. Paste this first:

```bash
export PATH=/opt/homebrew/bin:$PATH
```

You should see nothing, just a new prompt. Then paste this:

```bash
. /Users/thomasparis/esp/esp-idf/export.sh
```

You should see about a dozen lines, then `Done! You can now compile ESP-IDF projects.`, then `Go to the project directory and run:` and `idf.py build` (ignore that last suggestion; nothing needs building today). If you see an error instead, stop and ask Claude, pasting the whole Terminal text.

**0.4** Check the tools are ready:

```bash
idf.py --version
```

You should see `ESP-IDF v6.1`. If you see `command not found: idf.py`, step 0.3 did not work in this window: redo it.

**0.5** Make a folder on the Mac for today's files (backups, logs, photos):

```bash
mkdir -p /Users/thomasparis/esp/bench-2026-09-14
```

You should see nothing, just a new prompt. It sits outside the Pebble Pocket git repo on purpose, so nothing large gets committed by accident.

**0.6** Keys you will use. "Ctrl" is the Control key (bottom left of the keyboard), not Cmd.

| Keys | What it does |
|---|---|
| Ctrl+] (Control plus the right square bracket key, next to P) | Leaves the monitor (the live log from the board) |
| Ctrl+T, then Ctrl+L | Starts (or stops) saving the monitor log to a file |
| Ctrl+T, then Ctrl+R | Restarts the board while the monitor keeps listening |
| Ctrl+C | Stops any other command that is stuck |

**0.7** About the port name. The board appears on the Mac as a device file whose name starts with `/dev/cu.usbmodem`. Every command on this page types it as `/dev/cu.usbmodem*`: the star tells the Mac to fill in the rest of the name automatically. This only works when **exactly one** such board is plugged in. If a command answers `no matches found: /dev/cu.usbmodem*`, the Mac cannot see the board: go to "If something goes wrong" at the end.

---

## Part 1: What to have ready

**1.1** A **USB-C data cable**. Many USB-C cables only carry power; a power-only cable will light the board but the Mac will never see it. Use one you know syncs data (for example the one that came with a phone). Have a second one as a spare.

**1.2** A **microSD card**, 32 GB or smaller if you have one (larger cards work too, but must be reformatted, see Part 9), plus a way to put it in the Mac (built-in slot or a USB-C card reader). Anything on it will be erased.

**1.3** A **phone with a good camera** for close-up photos of the screen.

**1.4** Optional but useful: a **USB-C power meter** that sits between the cable and the Mac and shows volts, amps and mWh. It must pass data through; if the board is not seen with the meter in place, take the meter out.

**1.5** Optional but useful: a **thermometer** that can read a surface (an infrared thermometer, or a thermocouple probe), for the back of the case.

**1.6** A pen, or this page open for editing, to fill in the results table in Part 13.

**1.7** Not needed today: a phone hotspot or any Wi-Fi. Nothing today joins a network.

---

## Part 2: Inspect the unit (before plugging anything in)

**2.1** Take the board out of the box. Photograph the front, the back and all four edges.

**2.2** Find the controls. On the right edge, from top to bottom: a microphone hole, the **BOOT** button, the **USB-C** socket, the **PWR** button, a second microphone hole. On the left edge: the speaker slots and the **microSD card slot**. (If your unit differs, note it.)

**2.3** Check whether the battery is plugged into the board (a small two-wire connector). Photograph any label on the battery and write down what it says (capacity in mAh, voltage).

**2.4** Only if the back comes off easily without force: look for a small round vibration motor on two pads marked P1 and P2 and photograph it. If the case does not open easily, skip this step; the vibration test in Part 11 answers the same question. Handle the inside gently: a buyer reported a speaker wire coming loose.

**2.5** Write your findings in the results table (Part 13, rows A1 to A3).

---

## Part 3: Plug in and find the port

**3.1** With the board **not** plugged in, list the Mac's serial devices:

```bash
ls /dev/cu.*
```

You should see the Mac's own devices, for example `/dev/cu.Bluetooth-Incoming-Port` and `/dev/cu.debug-console`. There should be no `usbmodem` line yet.

**3.2** Plug the USB-C cable into the board and the Mac (through the power meter if you have one). If the Mac asks whether to allow the accessory to connect, click Allow. The screen may light up with whatever the factory installed: text in Chinese or English, a picture, a network name, a code, or a voice. **Do not follow any instructions it gives** (see Part 4). Just photograph the screen.

**3.3** Look for the board:

```bash
ls /dev/cu.usbmodem*
```

You should see exactly one line, for example `/dev/cu.usbmodem1101`. Write the name in Part 13 (row B1).
If you see `no matches found`: unplug, try the spare cable and a different USB port on the Mac, remove the power meter, and try again. If it still does not appear, do the recovery drill in Part 6 (it puts the board in a mode where the Mac always sees it), then come back to this step.

**3.4** Ask the chip who it is:

```bash
python -m esptool --chip esp32s3 --port /dev/cu.usbmodem* flash-id
```

You should see, among other lines: `Connected to ESP32-S3 on /dev/cu.usbmodem...`, a `Chip type:` line starting with `ESP32-S3`, a `Features:` line that includes `Embedded PSRAM 8MB`, `USB mode: USB-Serial/JTAG`, a `MAC:` line, and `Detected flash size: 32MB`. At the end it restarts the board (`Hard resetting via RTS pin...`). Write the chip type, features, MAC and flash size in Part 13 (row B2).
If you see `Failed to connect to ESP32-S3`, do the recovery drill (Part 6), then run this step again.

---

## Part 4: Do not join the factory firmware to Wi-Fi

**4.1** The firmware that came on the board is a build of xiaozhi, a Chinese voice assistant. If it gets onto Wi-Fi it contacts xiaozhi's servers and sends details about the network and the device.

**4.2** So, while the factory firmware is on the board: do not connect anything to a network whose name starts with `Xiaozhi`, do not visit any address it shows (such as `192.168.4.1`), do not scan its QR codes, do not speak to it on purpose.

**4.3** You do not need to do anything with it. Part 5 copies it to the Mac, and from Part 7 onward it is replaced.

---

## Part 5: Back up the factory flash

This copies everything on the board's 32 MB memory chip into one file on the Mac, so the original state can always be restored.

**5.1** Read the whole memory into a file:

```bash
python -m esptool --chip esp32s3 --port /dev/cu.usbmodem* read-flash 0 ALL /Users/thomasparis/esp/bench-2026-09-14/factory-flash-32mb.bin
```

You should see `Connected to ESP32-S3`, then `Detected flash size: 32MB`, then progress while it reads. This may take several minutes (not measured). It ends with `Read 33554432 bytes from 0x00000000 in ... seconds` and the file name.
If it fails with `Failed to connect`, do Part 6 and run it again. If it says the flash size could not be detected, run this version instead (it gives the size by hand):

```bash
python -m esptool --chip esp32s3 --port /dev/cu.usbmodem* read-flash 0 0x2000000 /Users/thomasparis/esp/bench-2026-09-14/factory-flash-32mb.bin
```

**5.2** Check the copy matches the board byte for byte:

```bash
python -m esptool --chip esp32s3 --port /dev/cu.usbmodem* verify-flash 0 /Users/thomasparis/esp/bench-2026-09-14/factory-flash-32mb.bin
```

You should see `Verification successful (digest matched).` If you see `Verification failed`, run step 5.1 again (use a different file name, for example `factory-flash-32mb-try2.bin`, and verify that one). Do not continue to Part 7 until one copy verifies.

**5.3** Check the file size:

```bash
ls -l /Users/thomasparis/esp/bench-2026-09-14/factory-flash-32mb.bin
```

You should see the number `33554432` on the line (that is exactly 32 MB). Write "backup verified" in Part 13 (row B3).

**5.4** If the backup cannot be made at all, note it and continue anyway: Waveshare publishes a factory firmware image at `/Users/thomasparis/esp/src/ws206/FirmWare/ESP32-S3-Touch-AMOLED-2.06-xiaozhi-251104.bin` (28 MB, so not a copy of the whole 32 MB chip, and it may not be identical to what shipped on your unit).

---

## Part 6: Recovery drill (practise it once now)

If the board ever stops being seen by the Mac, or flashing fails, this puts it into "download mode": a built-in mode where the board runs no program and just waits for the Mac. You cannot damage anything by doing it. BOOT is the top button on the right edge; PWR is the bottom one.

**6.1** Unplug the USB cable.

**6.2** If the screen is still lit (it is running on its battery), hold PWR until the screen goes dark, about 4 to 6 seconds, then let go.

**6.3** Press and hold BOOT. Keep holding it.

**6.4** While still holding BOOT, plug the USB cable back in. If the Mac does not see the board in step 6.6, repeat from 6.1 and this time, still holding BOOT, also give PWR one short press after plugging in.

**6.5** Keep holding BOOT for 2 more seconds, then let go. The screen should stay **dark**: that is normal in download mode.

**6.6** Check the Mac sees it:

```bash
ls /dev/cu.usbmodem*
```

You should see one `/dev/cu.usbmodem...` line.

**6.7** Check the chip answers:

```bash
python -m esptool --chip esp32s3 --port /dev/cu.usbmodem* flash-id
```

You should see the same `Connected to ESP32-S3` and `Detected flash size: 32MB` as in step 3.4. Write "drill works" in Part 13 (row B4).

**6.8** To leave download mode you do not need to do anything special: the next flash in Part 7 restarts the board normally. If a board ever stays dark after flashing, unplug, hold PWR until it is off, and plug in again without touching BOOT.

---

## Part 7: Power chip test (01_AXP2101)

This program reads the power management chip (AXP2101): which power rails are on and at what voltage, the battery voltage and charge state, and the chip's temperature. **The screen stays dark during this test.** That is expected: the program has no display code.

**7.1** Go to the program's folder:

```bash
cd /Users/thomasparis/esp/src/ws206/examples/esp-idf/01_AXP2101
```

You should see nothing, just a new prompt.

**7.2** Put the program on the board and open the live log:

```bash
idf.py -p /dev/cu.usbmodem* flash monitor
```

You should see the flashing progress, `Hash of data verified.` for each part, `Hard resetting via RTS pin...`, then a monitor banner ending `Quit: Ctrl+] | Menu: Ctrl+T | Help: Ctrl+T followed by Ctrl+H`, then the board's log.
If flashing fails, do Part 6 and run this step again.

**7.3** Start saving the log to a file, then restart the board so the start-up lines are captured: press Ctrl+T then Ctrl+L (you should see `Logging is enabled into file log.XPowersLib_Example....txt`), then press Ctrl+T then Ctrl+R. If the restart key does nothing, just scroll the Terminal window up to find the start-up lines.

**7.4** Find these lines near the start of the log:
- `main: I2C initialized successfully`
- `AXP2101: Init PMU SUCCESS!`
- A table with one line per rail, in the form `DC1  : +   Voltage:3300 mV`. A `+` means the rail is on, `-` means off. The rails are DC1, DC2, DC3, DC4, DC5, ALDO1, ALDO2, ALDO3, ALDO4, BLDO1, BLDO2, CPUSLDO, DLDO1, DLDO2.
- `battery percentage:NN %`

**Write every rail line into Part 13 (rows C1 to C14).** The two that matter most: **ALDO1** (feeds the audio chips) and **ALDO2** (feeds the screen) should both show `+`. If either shows `-`, the later speaker, microphone or screen tests may fail for that reason alone, not because the board is broken: note it and carry on.

**7.5** After that, a block of lines repeats every second. Read one block and write the values in Part 13 (rows C15 to C22):
- `Power Temperature: NN.NN°C` (the power chip's own temperature)
- `isCharging: YES` or `NO`
- `isVbusIn: YES` (USB is plugged in) and `isVbusGood: YES`
- `Charger Status:` one of `constant charge`, `constant voltage`, `charge done`, `not charge`, `pre_charge`, `tri_charge`
- `getBattVoltage: NNNN mV` (with a battery connected, expect somewhere between about 3300 and 4200)
- `getVbusVoltage: NNNN mV` (USB, expect about 5000)
- `getSystemVoltage: NNNN mV`
- `getBatteryPercent: NN %` (this line only appears when a battery is detected)

**7.6** Failure looks like `PMU READ FAILED!` and `Init PMU FAILED!` followed by the board restarting over and over. If you see that, write it down, photograph the Terminal, and continue with Part 8 anyway.

**7.7** Important: this program also sets the battery charger to 400 mA with a 4.2 V target. If the battery really is about 100 mAh, as one buyer measured, that is fast. Keep this test short and do not leave the board plugged in unattended (see Part 12).

**7.8** Leave the monitor: press Ctrl+]. You should see the normal prompt again.

**7.9** Move the saved log into today's folder:

```bash
mv /Users/thomasparis/esp/src/ws206/examples/esp-idf/01_AXP2101/log.*.txt /Users/thomasparis/esp/bench-2026-09-14/
```

You should see nothing. If it says `no matches found`, the log was not saved (step 7.3 was skipped); that is fine as long as Part 13 is filled in.

---

## Part 8: Microphone test (05_Spec_Analyzer)

This program listens through the microphones and draws the sound as moving bars. **It makes no sound itself.**

**8.1** Go to the program's folder:

```bash
cd /Users/thomasparis/esp/src/ws206/examples/esp-idf/05_Spec_Analyzer
```

**8.2** Flash and monitor:

```bash
idf.py -p /dev/cu.usbmodem* flash monitor
```

You should see the same flashing lines as in Part 7, then the log.

**8.3** Press Ctrl+T then Ctrl+L to save the log.

**8.4** In the log, look for: `audio_fft: Starting Audio Spectrum Analyzer`, `Backlight on`, `audio_fft: FFT and window initialized`, `ES7210: Enable ES7210_INPUT_MIC1` and `ES7210: Enable ES7210_INPUT_MIC2`.

**8.5** On the screen you should see: a black background with a band across the middle, 410 pixels wide and 200 tall, holding 64 thin vertical bars mirrored above and below a horizontal centre line. The bars are coloured from red on the left through the rainbow towards violet on the right, and each has a small tick at its peak that falls slowly.

**8.6** In a quiet room the bars are short. Hold the board about 20 cm from your mouth, with the right edge (where the microphone holes are) towards you, and talk, clap, then whistle. **The bars should jump immediately.** Each bar covers about 125 Hz, from 0 on the left to 8000 Hz on the right, so a whistle around 2000 Hz should lift bars about a quarter of the way in from the left. Photograph or film the screen while whistling.

**8.7** Failure signs: `Audio codec init failed` in the log; `I2S read error` warnings repeating; or bars that never move when you speak (microphone path not working). A completely black screen: check whether ALDO2 showed `+` in Part 7.

**8.8** Write the result in Part 13 (rows D1 to D3), then press Ctrl+] to leave the monitor.

**8.9** Move the log:

```bash
mv /Users/thomasparis/esp/src/ws206/examples/esp-idf/05_Spec_Analyzer/log.*.txt /Users/thomasparis/esp/bench-2026-09-14/
```

---

## Part 9: Speaker and microSD test (06_videoplayer)

Video is out of scope for Pebble Pocket. This program is used only because it is the simplest way to check two things at once: that the microSD slot reads a card, and that the speaker plays sound. Only one sample file has sound: `test5.avi`. Use only that one.

### Prepare the card (on the Mac; the board can stay plugged in)

**9.1** With the microSD card **not** in the Mac yet, list the Mac's disks:

```bash
diskutil list
```

Note the disk names shown (`/dev/disk0`, `/dev/disk1` and so on).

**9.2** Put the card in and run the same command again:

```bash
diskutil list
```

You should see one **new** disk that was not there before, with a size close to your card's size (for example `*31.9 GB` next to `/dev/disk4`). That new `/dev/diskN` is the card. **If you are not completely sure which disk is the card, stop and ask Claude.** Erasing the wrong disk destroys its data. (The Mac refuses to erase its own start-up disk, but it would erase another external drive, so unplug any other external drives first.)

**9.3** Erase the card as FAT32. In this command, replace `diskN` with the card's name from step 9.2 (for example `disk4`) before pressing Return:

```bash
diskutil eraseDisk FAT32 POCKETSD MBRFormat /dev/diskN
```

You should see lines about unmounting, creating the partition map and formatting, ending with `Finished erase on diskN`. The card then appears as a drive called `POCKETSD`. The board cannot read cards formatted as exFAT, which is how most cards over 32 GB come from the shop; this step fixes that.

**9.4** Confirm the format:

```bash
diskutil info /Volumes/POCKETSD
```

Look for the line `File System Personality:` and check it says `MS-DOS FAT32`. If it says anything else (for example `ExFAT`), the card is not usable for this test: try a card of 32 GB or less.

**9.5** Make the folder the program looks in:

```bash
mkdir /Volumes/POCKETSD/avi
```

**9.6** Copy the one sample file that has sound (the `-X` stops the Mac adding hidden helper files, which the program would mistake for a second video):

```bash
cp -X /Users/thomasparis/esp/src/ws206/Material/videos/test5.avi /Volumes/POCKETSD/avi/
```

**9.7** Check the folder:

```bash
ls -la /Volumes/POCKETSD/avi
```

You should see `test5.avi` (about 9 MB) and nothing else apart from the `.` and `..` lines. If you also see `._test5.avi`, delete it:

```bash
rm /Volumes/POCKETSD/avi/._test5.avi
```

**9.8** Eject the card safely:

```bash
diskutil eject /Volumes/POCKETSD
```

You should see `Disk /Volumes/POCKETSD ejected`. Take the card out of the Mac.

### Run the test

**9.9** Unplug the board's USB cable. If the screen stays lit, hold PWR until it goes dark. Push the card gently into the slot on the board's left edge. It should go in without force; if it will not, turn it over and try again. Plug the USB cable back in.

**9.10** Go to the program's folder:

```bash
cd /Users/thomasparis/esp/src/ws206/examples/esp-idf/06_videoplayer
```

**9.11** Flash and monitor:

```bash
idf.py -p /dev/cu.usbmodem* flash monitor
```

**9.12** Press Ctrl+T then Ctrl+L to save the log.

**9.13** On the screen you should first see white text `Mounting SD card...` with `Attempt: 1`, then a small video (320 by 200 pixels) playing in the middle of a black screen.

**9.14** **You should hear the video's soundtrack from the speaker** (left edge) for about 16 seconds, then about a second of silence, then it loops. The volume is fixed by the program at 80 out of 100. Note how loud and how clean it sounds.

**9.15** In the log, look for: `Setting volume: 80`, `Found 1 AVI files in directory /sdcard/avi`, `AVI file 1: /sdcard/avi/test5.avi`, `SD card mounted successfully, found 1 AVI files`, `Playing: /sdcard/avi/test5.avi (1/1)`, `Find a video stream`, `Find a audio stream`, `Setting I2S clock: sample rate=16000, bit width=16, channels=2`, and from time to time `Frame rate: ...` (about 33 is normal; this figure measures the program's own loop, not the video).

**9.16** What failures look like:
- `SD card mount attempt N failed` every 2 seconds, with the `Attempt:` counter on screen climbing forever: the card is missing, not FAT32, or not seated. Unplug, reseat the card, repeat from step 9.9. The program never gives up on its own, so leave it with Ctrl+].
- Red text `No AVI files found in /sdcard/avi`: the card was read but the `avi` folder or the file is missing. Redo steps 9.1 to 9.8.
- Video plays but **no sound**: points at the speaker path (speaker amplifier, codec chip, or a loose speaker wire). Check whether ALDO1 showed `+` in Part 7.
- The board restarts over and over right after flashing: the audio chip did not start. Write it down.

**9.17** Write the results in Part 13 (rows E1 to E4). Press Ctrl+] to leave the monitor. You can leave the card in the board.

**9.18** Move the log:

```bash
mv /Users/thomasparis/esp/src/ws206/examples/esp-idf/06_videoplayer/log.*.txt /Users/thomasparis/esp/bench-2026-09-14/
```

---

## Part 10: Screen calibration

This is a Pebble Pocket program that draws an exact test pattern at the screen's native 410 by 502 pixels and logs every touch. It measures how much of each corner the rounded glass hides, which decides where Pebble's faces can safely put things. The screen runs at full brightness: **do not leave this pattern up for more than about 15 minutes** (a static image can mark an AMOLED, and the board warms up). More detail: `/Users/thomasparis/Desktop/PebblePath/pebble-pocket/firmware/tools/screen-calibration/README.md`.

**10.1** Go to the program's folder:

```bash
cd /Users/thomasparis/Desktop/PebblePath/pebble-pocket/firmware/tools/screen-calibration
```

**10.2** Flash and monitor:

```bash
idf.py -p /dev/cu.usbmodem* flash monitor
```

**10.3** Press Ctrl+T then Ctrl+L to save the log.

**10.4** In the log you should see: `calib: Pebble Pocket screen calibration, native 410 x 502`, `calib: touch logging enabled`, `calib: pattern drawn in N ms (canvas stride 410 px)`, a few lines describing the border, arcs and crosshair, and `calib: ready: touch the screen or press BOOT`.

**10.5** On the screen you should see:
- a black background with a faint grid (a line every 10 pixels, brighter every 50, some numbered);
- a thin white line on the very outermost pixels (visible along the straight edges, hidden under the glass in the corners);
- in each corner, six coloured quarter circles: red (radius 20), orange (40), yellow (60), green (80), blue (100), magenta (120), with a colour legend near the top middle;
- a white cross at the exact centre;
- two dark teal bands: the upper one plain (you may see vertical steps), the lower one dithered (should look smoother);
- teal text `touch: none yet` and grey `BOOT: up` near the bottom.

**10.6** Photograph, with room lights dimmed and the phone's exposure turned down until the white line is not blown out:
1. the whole face, straight on;
2. each corner as close as the phone focuses, named TL (top left), TR, BL, BR;
3. the two teal bands, straight on;
4. the face from about 45 degrees to the left and to the right.

**10.7** For **each corner**, write in Part 13 (rows F1 to F4):
- the **largest** coloured arc that is **completely cut off** (none of it visible), and
- the **smallest** coloured arc that is **completely visible**.

The real corner radius lies between those two numbers. (Geometry of the pattern: an arc smaller than the glass corner is hidden entirely, an arc larger than it is visible entirely, so the boundary brackets the radius.) A buyer measured about 115 pixels, which would mean 100 hidden and 120 visible.

**10.8** Also note (rows F5 to F8): whether the white edge line shows along the top, bottom, left and right; whether the cross looks centred inside the glass; any garbage, stripes or shifted columns along the left edge; how many distinct steps you can count across the plain teal band, whether the dithered one looks smooth, and any pink or green tint.

**10.9** Touch test. Tap each point below with a fingertip and read the logged position from lines like `calib: touch #1 down x=205 y=250`. Write the numbers in Part 13 (rows F9 to F13).

| Aim at | You should see about |
|---|---|
| the centre cross | x 204 to 205, y 250 to 251 |
| grid crossing 50, 50 (top left area) | x 50, y 50 |
| grid crossing 350, 50 (top right area) | x 350, y 50 |
| grid crossing 50, 450 (bottom left area) | x 50, y 450 |
| grid crossing 350, 450 (bottom right area) | x 350, y 450 |

x should grow to the right and y downwards. A teal ring should follow your finger on screen.

**10.10** Corners: tap as far into each of the four physical corners as your finger will go and write the logged x and y (rows F14 to F17). Then slide a finger slowly along each straight edge and note the smallest and largest x and y the log reaches (row F18). Any value past 409 or 501 is marked `OUTSIDE 0..409 x 0..501`; note those.

**10.11** Press BOOT (top button) a few times. Each press should log `calib: BOOT (GPIO0) pressed` then `released`, once each (row F19).

**10.12** Failure signs: `bsp_display_start() failed` (no screen), or `no touch input device from the BSP`; a pattern with no touch lines at all when you tap (the touch chip's interrupt is not arriving).

**10.13** Press Ctrl+] to leave the monitor, then move the log:

```bash
mv /Users/thomasparis/Desktop/PebblePath/pebble-pocket/firmware/tools/screen-calibration/log.*.txt /Users/thomasparis/esp/bench-2026-09-14/
```

---

## Part 11: Pebble Pocket firmware and the vibration test

This is our own build of the xiaozhi firmware (the `pebble-pocket` variant). Today it has **no Wi-Fi settings and a server address that cannot exist** (`https://pocket-ota.invalid/ota/`), so it contacts nobody. Its screen still shows xiaozhi's own interface: the Pebble faces are not built yet. Three things are tested: the start-up buzz, the button taps, and a record-and-play-back check of the microphone and speaker.

**11.1** Check the build on disk is the Pocket variant (and not the stock one, which would contact xiaozhi's servers):

```bash
grep -E "CONFIG_OTA_URL=|CONFIG_POCKET_HAPTICS=|CONFIG_ESPTOOLPY_FLASHSIZE=" /Users/thomasparis/Desktop/PebblePath/pebble-pocket/firmware/xiaozhi/sdkconfig
```

You should see exactly these three lines (in some order):
`CONFIG_ESPTOOLPY_FLASHSIZE="32MB"`, `CONFIG_OTA_URL="https://pocket-ota.invalid/ota/"`, `CONFIG_POCKET_HAPTICS=y`.
If the address shows `api.tenclass.net`, or a line is missing, **do not flash**. Rebuild the Pocket variant first with steps 11.1a and 11.1b (the build takes several minutes), then repeat 11.1.

**11.1a** (only if 11.1 failed)

```bash
cd /Users/thomasparis/Desktop/PebblePath/pebble-pocket/firmware/xiaozhi
```

**11.1b** (only if 11.1 failed)

```bash
python scripts/build.py waveshare/esp32-s3-touch-amoled-2.06 --name pebble-pocket --language en-US --wake-word disabled
```

**11.2** Wipe the board's memory first, so no settings left by the factory firmware (such as a saved network) carry over:

```bash
python -m esptool --chip esp32s3 --port /dev/cu.usbmodem* erase-flash
```

You should see `Erasing flash memory (this may take a while)...` then `Flash memory erased successfully in N seconds.` The screen goes dark and stays dark: nothing is installed now.

**11.3** Go to the firmware folder:

```bash
cd /Users/thomasparis/Desktop/PebblePath/pebble-pocket/firmware/xiaozhi
```

**11.4** **Hold the board in your hand for this step**, fingers resting lightly on the back. Flash and monitor:

```bash
idf.py -p /dev/cu.usbmodem* flash monitor
```

This flash is larger (five parts, about 5.6 MB of data spread across the first 13 MB of the chip), so it takes longer than the others. When it finishes you should see `Hard resetting via RTS pin...` and the monitor starts.

**11.5** **Vibration test.** At each start the firmware pulses the motor once for 400 ms (about half a second). The monitor restarts the board when it opens, so you may feel it **twice**, a second or so apart. Write in Part 13 (row G2) whether you felt it.
- Felt a buzz: a motor is fitted and works.
- Felt nothing: **inconclusive**, not a failure. The board's motor drive is weak and may not spin every motor, or no motor is fitted. Check pads P1/P2 if you can see them (step 2.4). Everything else in the firmware works the same either way.
- To feel it again at any time: press Ctrl+T then Ctrl+R to restart the board.

**11.6** Press Ctrl+T then Ctrl+L to save the log.

**11.7** In the log, look for these lines (the part before the colon is the program area):
- `WaveshareEsp32s3TouchAMOLED2inch06: Init AXP2101`
- `WaveshareEsp32s3TouchAMOLED2inch06: Touch panel initialized successfully`
- `PocketHaptics: Haptics ready on GPIO18`
- `WifiBoard: WiFi config mode entered`
- a yellow line starting `Application: Alert [gear] Wi-Fi Configuration Mode: Hotspot: Xiaozhi-` followed by four characters and `Config URL: http://192.168.4.1`

Nothing in the log should mention `tenclass` or `xiaozhi.me`. If it does, unplug immediately and write it down.

**11.8** On the screen you should see text including `Wi-Fi Configuration Mode` and the hotspot name, and you should hear a short spoken prompt (about 3 seconds) from the speaker. **Do not connect to the `Xiaozhi-` network** it names. It is an open network with no password, so the board should stay with you until Part 14.

**11.9** **Button taps.** Wait until the `Wi-Fi Configuration Mode` text is on the screen. Do this step with a **hold**, not a brief press: a brief press on this screen starts the recording test in step 11.10. Press and hold BOOT. If a motor is fitted you should feel a short tap (60 ms) the moment it goes down, then a firmer tick (100 ms) once you have held it for 1.5 seconds. Let go after the tick. Letting go after a long hold does not count as a press, so nothing else should happen and the log should **not** show `Enabling audio testing`. Write the results in Part 13 (rows G3 and G4). You will feel the short tap again in step 11.10.

**11.10** **Record and play back test.** This checks the microphones and speaker through the Pocket firmware's own audio code. Wait for the screen to settle. Then:
1. Press BOOT **once**, briefly, and let go (not twice quickly: a double press does nothing on this screen). The log should show `AudioService: Enabling audio testing`.
2. Hold the board about 20 cm away and say, clearly, "one, two, three, Pebble Pocket". Keep it under 10 seconds.
3. Press BOOT **once** again. The log should show `AudioService: Disabling audio testing`.
4. **You should hear your own words played back** from the speaker.

If you run past 10 seconds, the recording stops by itself: the log shows `Audio testing queue is full, stopping audio testing` and the playback starts on its own. In that case skip step 3 and just listen, because a BOOT press during the playback cuts it off. When the playback has finished, press BOOT once to leave the test (the log shows `Disabling audio testing` again and nothing more is played).

Write what you heard (clear, quiet, distorted, nothing) in Part 13 (row G5). This is a record-then-play check, one after the other. The real Phase 0 test (playing and recording at the same moment) comes later.

**11.11** Optional: PWR timing. Unplug the USB cable (the board keeps running on its battery), then press and hold PWR and count the seconds until the screen goes dark. This firmware sets the power chip to switch off after a 4 second hold. Write the time in Part 13 (row G6), then plug the cable back in. If the screen stays dark after plugging in, give PWR one short press to start the board.

**11.12** Press Ctrl+] to leave the monitor, then move the log out of the git repo:

```bash
mv /Users/thomasparis/Desktop/PebblePath/pebble-pocket/firmware/xiaozhi/log.*.txt /Users/thomasparis/esp/bench-2026-09-14/
```

---

## Part 12: Temperature and battery notes

Do these alongside the parts above, not as a separate run.

**12.1** At the start of the day, note the room temperature (row H1).

**12.2** At the end of Parts 7, 8, 9, 10 and 11, point the thermometer at the **back** of the case (the side that would touch skin) and note the reading in the temperature log (Part 13, table H). In Part 7 also note the power chip's own `Power Temperature` from the log. If you have the power meter, note volts and amps at the same moment.

**12.3** Compare with these reference points: 43 °C is the level at which long skin contact (8 hours or more) starts to burn, and 48 °C burns in about 10 minutes. Waveshare measured 46 °C on their sensor after 30 minutes charging with Wi-Fi on, and about 36 °C with wireless off. Today nothing joins a network, and the radio is only switched on in Part 11 (the Pocket firmware runs its setup hotspot), so readings well below 40 °C are expected; anything at or above 43 °C: stop, unplug, cool down, and write it down.

**12.4** Charging caution. The power chip test (Part 7) sets the charge current to 400 mA. The Pocket firmware (Part 11) sets it back to a conservative 100 mA every time it starts, so flash the Pocket firmware before leaving the board charging for any length of time. At 400 mA, if the battery is really about 100 mAh, as one buyer measured, that is four times its capacity per hour, which is aggressive for a small cell. The power chip may keep whatever was set last until a program changes it, so assume the 400 mA setting stays until the Pocket firmware has run. Until the battery's real capacity has been measured: **never leave the board charging while you are not in the room**, and unplug whenever you take a break.

**12.5** Battery readings. From Part 7, copy the battery voltage, percentage and charger status (rows C15 to C22). If you have the power meter, note its mWh counter at the start and end of the day (row H9). A full capacity measurement (run the battery flat, then charge to full through the meter) takes hours of supervised time and is **not** part of today.

---

## Part 13: Results table

Fill this in as you go. "Expected" comes from reading the source code; "Seen" is what actually happened.

### A. Inspection

| Row | Item | Expected | Seen |
|---|---|---|---|
| A1 | Controls in the positions of step 2.2 | yes | |
| A2 | Battery plugged in, label text (mAh, V) | a battery is included in this kit | |
| A3 | Motor visible on P1/P2 | unknown | |

### B. Connection and backup

| Row | Item | Expected | Seen |
|---|---|---|---|
| B1 | Port name | `/dev/cu.usbmodem...` | |
| B2 | Chip type, features, MAC, flash size | ESP32-S3, Embedded PSRAM 8MB, 32MB | |
| B3 | Factory backup | 33554432 bytes, verification successful | |
| B4 | Recovery drill | port appears, screen dark, flash-id works | |

### C. Power chip (Part 7)

| Row | Item | Expected | Seen (+ or -, and mV) |
|---|---|---|---|
| C1 | DC1 | on, about 3300 mV | |
| C2 | DC2 | unknown | |
| C3 | DC3 | unknown | |
| C4 | DC4 | unknown | |
| C5 | DC5 | unknown | |
| C6 | ALDO1 (audio chips) | **must be +** | |
| C7 | ALDO2 (screen) | **must be +** | |
| C8 | ALDO3 (motor pads) | unknown | |
| C9 | ALDO4 | unknown | |
| C10 | BLDO1 | unknown | |
| C11 | BLDO2 | unknown | |
| C12 | CPUSLDO | unknown | |
| C13 | DLDO1 | unknown | |
| C14 | DLDO2 | unknown | |
| C15 | Power Temperature | | |
| C16 | isCharging | | |
| C17 | isVbusIn / isVbusGood | YES / YES | |
| C18 | Charger Status | | |
| C19 | getBattVoltage | about 3300 to 4200 mV | |
| C20 | getVbusVoltage | about 5000 mV | |
| C21 | getSystemVoltage | | |
| C22 | battery percentage | | |

### D. Microphones (Part 8)

| Row | Item | Expected | Seen |
|---|---|---|---|
| D1 | Bars on screen | 64 rainbow bars around a centre line | |
| D2 | Bars react to voice, clap, whistle | immediately | |
| D3 | Errors in log | none | |

### E. Speaker and microSD (Part 9)

| Row | Item | Expected | Seen |
|---|---|---|---|
| E1 | Card format check | MS-DOS FAT32 | |
| E2 | Card mounted, 1 file found | yes | |
| E3 | Video plays in the middle | 320 by 200 | |
| E4 | Sound from speaker (loudness, clean or distorted) | soundtrack for about 16 s, loops | |

### F. Screen and touch (Part 10)

| Row | Item | Expected | Seen |
|---|---|---|---|
| F1 | TL corner: largest arc fully hidden / smallest fully visible | about 100 / 120 | |
| F2 | TR corner | about 100 / 120 | |
| F3 | BL corner | about 100 / 120 | |
| F4 | BR corner | about 100 / 120 | |
| F5 | White edge line visible: top, bottom, left, right | yes on all four | |
| F6 | Cross centred in the glass | yes | |
| F7 | Left-edge garbage or shifted columns | none | |
| F8 | Band steps counted, dither smooth, colour tint | steps visible on plain band | |
| F9 | Tap centre cross | x 204 to 205, y 250 to 251 | |
| F10 | Tap 50, 50 | 50, 50 | |
| F11 | Tap 350, 50 | 350, 50 | |
| F12 | Tap 50, 450 | 50, 450 | |
| F13 | Tap 350, 450 | 350, 450 | |
| F14 | Tap into TL physical corner | | |
| F15 | Tap into TR physical corner | | |
| F16 | Tap into BL physical corner | | |
| F17 | Tap into BR physical corner | | |
| F18 | Edge slides: smallest and largest x and y reached | near 0 to 409, 0 to 501 | |
| F19 | BOOT press logs pressed and released once | yes | |

### G. Pebble Pocket firmware (Part 11)

| Row | Item | Expected | Seen |
|---|---|---|---|
| G1 | sdkconfig check (3 lines) and erase | as in 11.1 and 11.2 | |
| G2 | Start-up buzz felt | felt = motor present; nothing = inconclusive | |
| G3 | Short tap on BOOT press | 60 ms, if motor fitted | |
| G4 | Firmer tick at 1.5 s hold | 100 ms, if motor fitted | |
| G5 | Record and play back | your words played back | |
| G6 | PWR hold time to switch off | about 4 s | |
| G7 | Screen shows Wi-Fi Configuration Mode, prompt sound heard, no tenclass in log | yes | |

### H. Temperature log (Part 12)

| Row | After part | USB plugged? | Back of case °C | Power chip °C (Part 7 only) | Room °C | Meter V / A |
|---|---|---|---|---|---|---|
| H1 | Start of day | no | | | | |
| H2 | 7 (power chip) | yes | | | | |
| H3 | 8 (microphones) | yes | | | | |
| H4 | 9 (speaker, microSD) | yes | | | | |
| H5 | 10 (screen) | yes | | | | |
| H6 | 11 (Pocket firmware) | yes | | | | |
| H7 | Highest reading of the day | | | | | |
| H8 | Any moment it felt warm (note the time and part) | | | | | |
| H9 | Meter mWh at start / end of day | | | | | |

### I. Close-out

| Row | Item | Expected | Seen |
|---|---|---|---|
| I1 | Final erase done (Part 14) | `Flash memory erased successfully` | |
| I2 | Logs and photos saved in `/Users/thomasparis/esp/bench-2026-09-14` | yes | |

---

## Part 14: Erase the board before anyone else handles it

This removes every program and setting from the board, including the Pocket firmware and anything it recorded in memory. The factory backup stays safe on the Mac (Part 5), and the Pocket firmware can be flashed again at any time with Part 11.

**14.1** Make sure no monitor is running (you see a normal prompt; if not, press Ctrl+]).

**14.2** Erase:

```bash
python -m esptool --chip esp32s3 --port /dev/cu.usbmodem* erase-flash
```

You should see `Flash memory erased successfully in N seconds.` The screen goes dark and stays dark: that is the goal.
If it fails with `Failed to connect`, do the recovery drill (Part 6, steps 6.1 to 6.6) and run this step again.

**14.3** Check the backup is still on the Mac:

```bash
ls -l /Users/thomasparis/esp/bench-2026-09-14
```

You should see `factory-flash-32mb.bin` and the `log...txt` files from today.

**14.4** Unplug the USB cable. If the screen is somehow lit, hold PWR until it goes dark. Take the microSD card out. Store the board somewhere cool, not on a charger.

**14.5** Copy your photos from the phone into `/Users/thomasparis/esp/bench-2026-09-14`, fill in row I2, and send the results table plus the folder to Claude for the pin map update.

---

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `command not found: idf.py`, `command not found: python`, or `No module named esptool` | This Terminal window does not have the tools switched on | Redo Part 0, steps 0.3 and 0.4 |
| `no matches found: /dev/cu.usbmodem*` | The Mac cannot see the board | Try the spare cable, another USB port, remove the power meter; then Part 6 |
| `ls` lists two `usbmodem` devices, or a command fails with `No such command '/dev/cu.usbmodem...'` or `command "/dev/cu.usbmodem..." is not known to idf.py` | Two boards or two such devices are plugged in, so the star filled in two names | Unplug everything except this board |
| `Failed to connect to ESP32-S3` | The board did not enter download mode on its own | Part 6, then run the same command again |
| An error saying the port cannot be opened or is busy | Another command (usually a monitor in another window) is using the board | Close the other window or press Ctrl+] there, then retry |
| The monitor shows nothing at all | The board may be stuck or in download mode | Ctrl+T then Ctrl+R; if still nothing, Ctrl+], unplug, PWR off, plug in, run `idf.py -p /dev/cu.usbmodem* monitor` from the same folder |
| Board restarts over and over, log shows `abort()` or `ESP_ERROR_CHECK failed` | A chip the program needs did not answer | Photograph the Terminal, note the part, move on to the next part |
| Anything hot, smelly or swollen | Stop | Unplug, hold PWR until dark, cool down, note it, do not continue today |

When in doubt, stop and paste the whole Terminal text to Claude. Nothing in this checklist can permanently damage the board: every state can be recovered with Part 6 and a fresh flash. (The permanent operations, eFuse and Secure Boot, are not used anywhere on this page.)

---

## Where each claim comes from

Tool behaviour was checked on 2026-09-12 by running `--help` with ESP-IDF v6.1 activated, and by reading the installed tool source in `/Users/thomasparis/.espressif/python_env/idf6.1_py3.14_env/lib/python3.14/site-packages/`. Firmware behaviour was read from the source files named below. Nothing was observed on hardware.

**Tools**
- `idf.py --version` prints `ESP-IDF v6.1`; `export.sh` ends with `Done! You can now compile ESP-IDF projects.` (run locally).
- esptool is v5.4.0 (`python -m esptool version`). Global options `--chip`, `--port` come before the command (`python -m esptool --help`).
- `read-flash ADDRESS SIZE OUTPUT` (`python -m esptool read-flash --help`); SIZE accepts `all` in any case: `esp_pylib/cli_types.py:73` and `esptool/cli_util.py:351`; done message `esptool/cmds.py:2528`; flash-size detection message `esptool/cli_util.py:361`; 32 MB label `esptool/cmds.py:89`.
- `verify-flash <address> <filename>` (`--help`); success text `Verification successful (digest matched).` at `esptool/cmds.py:2641`.
- `erase-flash` takes no arguments besides `--force` (`--help`); messages at `esptool/cmds.py:2273` and `:2282`.
- `flash-id` output: `Connected to ...` `esptool/__init__.py:558`, chip type, features, crystal, USB mode, MAC at `:571-577`; `Detected flash size:` `esptool/cmds.py:2415`; S3 features including `Embedded PSRAM 8MB` `esptool/targets/esp32s3.py:229-237`; `USB-Serial/JTAG` label `esptool/loader.py:1354`.
- esptool resets an ESP32-S3 automatically over its built-in USB (Espressif VID 0x303A, PID 0x1001): `esptool/loader.py:837-838`, `esp_pylib/constants.py:19,22`. `Failed to connect to` text `esptool/loader.py:904`; `Hard resetting via RTS pin...` `esptool/loader.py:2146`; `Hash of data verified.` `esptool/cmds.py:1927`.
- The monitor restarts the board when it opens unless told not to (`python -m esp_idf_monitor --help` lists `--no-reset: Do not reset the chip on monitor startup`), which is why the start-up buzz in Part 11 may be felt twice.
- Monitor keys: exit Ctrl+], menu Ctrl+T, reset R, log L `esp_idf_monitor/base/key_config.py:30-37`; banner text `esp_idf_monitor/idf_monitor.py:629`; log file name `log.<program>.<timestamp>.txt` `esp_idf_monitor/base/logger.py:83`, written in the project folder because idf.py starts the monitor there `/Users/thomasparis/esp/esp-idf/tools/idf_py_actions/serial_ext.py:196-199`.
- `diskutil eraseDisk format name [MBR[Format]] device`, and "You cannot erase the boot disk" (`diskutil eraseDisk` usage text); `FAT32` is an accepted alias (`diskutil listFilesystems`); `File System Personality:` field (`diskutil info /`); `cp -X` does not copy extended attributes or resource forks (`man cp`). Before plugging in, this Mac lists `/dev/cu.Bluetooth-Incoming-Port` and `/dev/cu.debug-console` (run locally).

**Board and project facts**
- Button, socket, speaker and slot positions, battery doubts, heat figures, speaker wire report, factory firmware phoning home: `/Users/thomasparis/Desktop/PebblePath/pebble-pocket/HANDOFF.md:33,46,49,51,54,55`; research brief `/Users/thomasparis/Desktop/PebblePath/Claude outputs/Pebble-Pocket-Monday-Brief.md` section 2 rows 8, 9, 14 and section 9 steps 2, 6, 12, 15, 16 (these cite Waveshare's FAQ and GitHub issues; not re-checked here). Burn thresholds 43 °C and 48 °C: same brief, section 7 item 10.
- Only native USB is wired (no separate USB serial chip): `firmware/docs/pinmap.md:56`. BOOT is GPIO0, held at reset enters download mode: `pinmap.md:32,80`.
- All five programs flashed today send their log to the USB port as well as the UART (`CONFIG_ESP_CONSOLE_SECONDARY_USB_SERIAL_JTAG=y` in each project's `sdkconfig`: 01 line 1908, 05 line 1923, 06 line 1923, screen-calibration line 1930, Pocket firmware `firmware/xiaozhi/sdkconfig` line 2213).
- Every project has a finished ESP-IDF v6.1 build on disk (checked 2026-09-12: `build/flasher_args.json`, the app `.bin` and `.elf`, and `project_description.json` reporting `v6.1` and `esp32s3` in 01_AXP2101, 05_Spec_Analyzer, 06_videoplayer, screen-calibration and xiaozhi; a `ninja -n` dry run listed no source files to recompile, only the bootloader sub-build check that always runs and, for xiaozhi, CMake's re-check of its file lists), so each `flash` step should spend at most a short while checking the build before it starts writing. Monitor log file names follow the project name: `log.XPowersLib_Example...` (01), `log.lvgl_demo_v9...` (05 and 06), `log.screen_calibration...`, `log.xiaozhi...`.
- The xiaozhi build keeps its Pocket settings when flashed with plain `idf.py flash`: `build/CMakeCache.txt` line 18 `BOARD_NAME=pebble-pocket` and line 418 `SDKCONFIG_DEFAULTS=sdkconfig.defaults;build/xiaozhi-build.sdkconfig.defaults`, and `sdkconfig` line 1111 `CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_2_06=y` (set by `scripts/build.py:1370-1376`). `python scripts/build.py --help` lists `--name`, `--language`, `--wake-word`; `--list-languages` includes `en-US`; the `pebble-pocket` build is defined in `main/boards/waveshare/esp32-s3-touch-amoled-2.06/config.json`.
- Shell messages: zsh prints `no matches found: /dev/cu.usbmodem*` when nothing matches, and `command not found: python` when ESP-IDF is not activated (run locally). With two ports the second name becomes a command: esptool answers `No such command` (run locally with made-up paths), idf.py answers `is not known to idf.py` (`/Users/thomasparis/esp/esp-idf/tools/idf_py_actions/core_ext.py:185`).

**01_AXP2101** (`/Users/thomasparis/esp/src/ws206/examples/esp-idf/01_AXP2101/main/`)
- No display code (`main/` holds only `main.cpp` and `port_axp2101.cpp`, and neither uses a display or LVGL). Log lines: `I2C initialized successfully` `main.cpp:111`; `Init PMU SUCCESS!` / `FAILED!` `port_axp2101.cpp:20,24`; rail table `port_axp2101.cpp:84-103`; battery percentage `:140`; repeating block `:151-205`, every second `main.cpp:99-102`; `PMU READ FAILED!` `main.cpp:75`; abort on failure `main.cpp:113`.
- Charger set to 400 mA and 4.2 V, battery temperature sensing off: `port_axp2101.cpp:132,137,114`.

**05_Spec_Analyzer** (`.../05_Spec_Analyzer/main/main.c`)
- 16 kHz, 64 stripes, 410 by 200 canvas `main.c:17,20,22-23`, 1024-sample FFT `:16`; hue from 0 to 270 degrees across the bars `:129-131`; peak ticks `:122-126`; log lines `:188,44,48,60`. ES7210 enabling MIC1 and MIC2 when none selected: esp_codec_dev `es7210.c:452-455` (from the diagnostics build report).

**06_videoplayer** (`.../06_videoplayer/main/main.c`)
- Volume 80 `main.c:357`; mount retry every 2 s forever with on-screen attempt counter `:374-389`; `No AVI files found` `:403-405`; files accepted by `.avi` extension (so `._test5.avi` would count) `:59-60`; log lines `:113,115,249,292,296,316,418`; audio chip failure aborts `:356`. `test5.avi` is the only sample with sound and is 16.1 s long (ffprobe, from the diagnostics build report). exFAT is not compiled into ESP-IDF v6.1 (`/Users/thomasparis/esp/esp-idf/components/fatfs/src/ffconf.h:294`, from the diagnostics build report).

**Screen calibration** (`/Users/thomasparis/Desktop/PebblePath/pebble-pocket/firmware/tools/screen-calibration/`)
- Log lines `main/main.c:405,444,452-457,461`; touch lines and `OUTSIDE` tag `:326-334`; BOOT line `:394`; failures `:410,446`. Pattern, colours, photos, touch table and 15 minute caution: `README.md:9-19,49-83`. Buyer's 115 px corner figure: `firmware/docs/pinmap.md:73`.

**Pebble Pocket firmware** (`/Users/thomasparis/Desktop/PebblePath/pebble-pocket/firmware/xiaozhi/`)
- Build settings on disk: `sdkconfig` contains `CONFIG_OTA_URL="https://pocket-ota.invalid/ota/"`, `CONFIG_POCKET_HAPTICS=y`, `CONFIG_ESPTOOLPY_FLASHSIZE="32MB"`, `CONFIG_USE_HOTSPOT_WIFI_PROVISIONING=y`, `CONFIG_WAKE_WORD_DISABLED=y`, `CONFIG_BUTTON_LONG_PRESS_TIME_MS=1500` (line 4346). Flash: `build/flash_args` writes five files (bootloader 16736, partition table 3072, otadata 8192, app 2882288 and assets 2694681 bytes, about 5.6 MB in total), the highest at 0xa00000, which is why `build/merged-binary.bin` is 13180441 bytes. Build command: `firmware/README.md:21`.
- Board start-up order, including the self-test buzz after touch init: `main/boards/waveshare/esp32-s3-touch-amoled-2.06/esp32-s3-touch-amoled-2.06.cc:331-345`; `Init AXP2101` `:187`; PWR hold 4 s to power off `:35`; ALDO3 at 3.0 V for the motor `:54-56`; charger 4.1 V and 400 mA `:59,62`; BOOT press tap and long-press tick `:216-221`; BOOT click in Wi-Fi setup state toggles the audio test `:204-211` with `main/application.cc:786-793`; motor on GPIO18 `config.h:26`.
- Buzz lengths 400, 60, 100 ms and `Haptics ready on GPIO` log: `pocket_haptics.h:57,81-84`.
- With no saved network the board enters Wi-Fi setup after 1.5 s: `main/boards/common/wifi_board.cc:102-114`; `WiFi config mode entered` `:139`; alert with hotspot name and URL `:170-187`; alert log format `main/application.cc:749`; text strings `main/assets/locales/en-US/language.json:34-36`; hotspot name `Xiaozhi-XXXX` `wifi_board.cc:57` and `managed_components/78__esp-wifi-connect/wifi_configuration_ap.cc:125`; open network with no password `:164`; URL `http://192.168.4.1` `:132`; prompt sound `main/assets/locales/en-US/wificonfig.ogg` is 2.76 s (ffprobe).
- Audio test: `Enabling` / `Disabling audio testing` log `main/audio/audio_service.cc:735`; recorded audio is played back when the test is switched off `:740-747`; 10 s maximum `main/audio/audio_service.h:45,185-190` and auto stop `audio_service.cc:286-290`.
- Long press default when none is given: `managed_components/espressif__button/include/button_types.h:28`; the board passes none (`main/boards/common/button.h:14`).
- A hold does not also count as a click: once the long-press time is reached the button moves to its long-press state (`managed_components/espressif__button/iot_button.c:154-156`) and on release goes straight back to waiting (`:305-307`), so `BUTTON_SINGLE_CLICK` (`:183-186`) is never sent. A brief click in Wi-Fi setup starts the audio test (`main/application.cc:786-789`). The double-click action only runs in the idle state (`esp32-s3-touch-amoled-2.06.cc:225-230`).
- If the 10 s test buffer fills, the test switches itself off and plays back, but the device state stays "audio testing" (`audio_service.cc:286-290`; no `on_audio_testing_queue_full` handler is set in `main/application.cc`), so the next BOOT click switches it off again, which empties the playback queue (`audio_service.cc:740-747`).
- Wi-Fi radio: in setup mode the board runs an open access point in AP plus station mode (`managed_components/78__esp-wifi-connect/wifi_configuration_ap.cc:164-167`); it joins no network because none is saved (`wifi_board.cc:102-114`).
- esptool `verify-flash` does not alter the image it compares, because flash mode, frequency and size all default to `keep` (`esptool/__init__.py:273-340`, `esptool/cmds.py:740-743`).
- Factory image size: `ESP32-S3-Touch-AMOLED-2.06-xiaozhi-251104.bin` is 29360128 bytes (`ls -l`).
