/*
 * Pebble Pocket screen calibration pattern.
 *
 * Derived from Waveshare's ESP32-S3-Touch-AMOLED-2.06 example
 * examples/esp-idf/02_lvgl_demo_v9/main/main.c
 * (github.com/waveshareteam/ESP32-S3-Touch-AMOLED-2.06, commit b099739),
 * licensed under the Apache License, Version 2.0. A copy of the licence is in
 * LICENSE next to this project. You may not use this file except in compliance
 * with the Licence. Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND.
 *
 * Changes from the original (2026-09-12, Pebble Pocket): display and touch are
 * still brought up by the Waveshare BSP's bsp_display_start(), exactly as in
 * 02_lvgl_demo_v9. The LVGL music demo is replaced by a static, pixel-exact
 * calibration pattern at native 410 x 502, touch coordinates are logged to the
 * serial console on every touch sample, and BOOT (GPIO0) presses are logged.
 */

#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "lvgl.h"
#include "bsp/esp-bsp.h"
#include "bsp/display.h"

static const char *TAG = "calib";

#define W BSP_LCD_H_RES /* 410, bsp/display.h */
#define H BSP_LCD_V_RES /* 502, bsp/display.h */

/* Colours (8-bit per channel, converted to RGB565 by truncation like LVGL). */
#define C_WHITE      0xFFFFFF
#define C_GRID_MINOR 0x1C1C1C /* every 10 px */
#define C_GRID_MAJOR 0x3C3C3C /* every 50 px */
#define C_TEAL_GLOW  0x7DD4C8
#define GRAD_LEFT    0x1F5C54 /* PebblePath teal-deep */
#define GRAD_RIGHT   0x0B1F1D

static const int ARC_RADII[] = {20, 40, 60, 80, 100, 120};
static const uint32_t ARC_COLOURS[] = {
    0xFF4040, /* 20  red */
    0xFF9E2C, /* 40  orange */
    0xFFE14D, /* 60  yellow */
    0x4CD964, /* 80  green */
    0x3AB8FF, /* 100 blue */
    0xD66BFF, /* 120 magenta */
};
#define ARC_COUNT (sizeof(ARC_RADII) / sizeof(ARC_RADII[0]))

/* Gradient bands: x range and y ranges (inclusive). */
#define BAND_X0       20
#define BAND_X1       389
#define BAND_PLAIN_Y0 318
#define BAND_PLAIN_Y1 357
#define BAND_DITH_Y0  378
#define BAND_DITH_Y1  417

static lv_draw_buf_t *s_buf;
static uint16_t *s_px;
static uint32_t s_stride_px;

/* ---------------------------------------------------------------------------------------------
 * Pixel helpers. The canvas buffer is LV_COLOR_FORMAT_RGB565; LVGL packs it as
 * r<<11 | g<<5 | b (lv_color.c, lv_color_to_u16). The BSP swaps bytes at flush time.
 * ------------------------------------------------------------------------------------------- */
static inline uint16_t rgb565_from_hex(uint32_t hex)
{
    return lv_color_to_u16(lv_color_hex(hex));
}

static inline void put_px(int x, int y, uint16_t c)
{
    if (x < 0 || y < 0 || x >= W || y >= H) {
        return;
    }
    s_px[(uint32_t)y * s_stride_px + (uint32_t)x] = c;
}

static void hline(int x0, int x1, int y, uint16_t c)
{
    for (int x = x0; x <= x1; x++) {
        put_px(x, y, c);
    }
}

static void vline(int x, int y0, int y1, uint16_t c)
{
    for (int y = y0; y <= y1; y++) {
        put_px(x, y, c);
    }
}

/* 1 px quarter circle (midpoint algorithm), only the quadrant pointing at the corner.
 * sx, sy are -1 or +1: the direction from the centre towards the corner. */
static void quarter_arc(int cx, int cy, int r, int sx, int sy, uint16_t c)
{
    int x = r;
    int y = 0;
    int err = 1 - r;
    while (x >= y) {
        put_px(cx + sx * x, cy + sy * y, c);
        put_px(cx + sx * y, cy + sy * x, c);
        y++;
        if (err < 0) {
            err += 2 * y + 1;
        } else {
            x--;
            err += 2 * (y - x) + 1;
        }
    }
}

static uint8_t lerp8(uint8_t a, uint8_t b, int num, int den)
{
    /* Rounded linear interpolation from a to b at num/den. */
    int v = (int)a * (den - num) + (int)b * num;
    return (uint8_t)((v + den / 2) / den);
}

/* Horizontal gradient GRAD_LEFT -> GRAD_RIGHT. dither = 0: plain RGB565 truncation.
 * dither = 1: 4x4 ordered (Bayer) dither added before truncation. */
static void gradient_band(int y0, int y1, bool dither)
{
    static const uint8_t bayer4[4][4] = {
        {0, 8, 2, 10},
        {12, 4, 14, 6},
        {3, 11, 1, 9},
        {15, 7, 13, 5},
    };
    uint8_t lr = (GRAD_LEFT >> 16) & 0xFF, lg = (GRAD_LEFT >> 8) & 0xFF, lb = GRAD_LEFT & 0xFF;
    uint8_t rr = (GRAD_RIGHT >> 16) & 0xFF, rg = (GRAD_RIGHT >> 8) & 0xFF, rb = GRAD_RIGHT & 0xFF;
    int den = BAND_X1 - BAND_X0;

    for (int y = y0; y <= y1; y++) {
        for (int x = BAND_X0; x <= BAND_X1; x++) {
            int num = x - BAND_X0;
            int r8 = lerp8(lr, rr, num, den);
            int g8 = lerp8(lg, rg, num, den);
            int b8 = lerp8(lb, rb, num, den);
            int t = dither ? bayer4[y & 3][x & 3] : 0;
            int r5 = (r8 + t / 2) >> 3; /* 5-bit step is 8, add 0..7 */
            int g6 = (g8 + t / 4) >> 2; /* 6-bit step is 4, add 0..3 */
            int b5 = (b8 + t / 2) >> 3;
            if (r5 > 31) r5 = 31;
            if (g6 > 63) g6 = 63;
            if (b5 > 31) b5 = 31;
            put_px(x, y, (uint16_t)((r5 << 11) | (g6 << 5) | b5));
        }
    }
}

static void draw_pattern(void)
{
    uint16_t black = rgb565_from_hex(0x000000);
    uint16_t white = rgb565_from_hex(C_WHITE);
    uint16_t minor = rgb565_from_hex(C_GRID_MINOR);
    uint16_t major = rgb565_from_hex(C_GRID_MAJOR);

    /* 1. Black background. */
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            put_px(x, y, black);
        }
    }

    /* 2. Faint 10 px grid, slightly brighter every 50 px. Lines sit on multiples of 10. */
    for (int x = 0; x < W; x += 10) {
        vline(x, 0, H - 1, (x % 50 == 0) ? major : minor);
    }
    for (int y = 0; y < H; y += 10) {
        hline(0, W - 1, y, (y % 50 == 0) ? major : minor);
    }
    for (int x = 0; x < W; x += 50) {
        vline(x, 0, H - 1, major);
    }

    /* 3. Gradient bands (drawn over the grid). */
    gradient_band(BAND_PLAIN_Y0, BAND_PLAIN_Y1, false);
    gradient_band(BAND_DITH_Y0, BAND_DITH_Y1, true);

    /* 4. Corner guide arcs. A radius-r arc is the outline a rounded corner of radius r
     *    would have: it touches the edges at (0, r) and (r, 0) for the top-left corner. */
    for (size_t i = 0; i < ARC_COUNT; i++) {
        int r = ARC_RADII[i];
        uint16_t c = rgb565_from_hex(ARC_COLOURS[i]);
        quarter_arc(r, r, r, -1, -1, c);                   /* top-left */
        quarter_arc(W - 1 - r, r, r, +1, -1, c);           /* top-right */
        quarter_arc(r, H - 1 - r, r, -1, +1, c);           /* bottom-left */
        quarter_arc(W - 1 - r, H - 1 - r, r, +1, +1, c);   /* bottom-right */
    }

    /* 5. Centre crosshair. 410 and 502 are even, so the true centre is between pixels
     *    (204.5, 250.5); the crosshair is 2 px wide to straddle it exactly. */
    int cxl = W / 2 - 1, cxr = W / 2, cyt = H / 2 - 1, cyb = H / 2;
    vline(cxl, cyt - 40, cyb + 40, white);
    vline(cxr, cyt - 40, cyb + 40, white);
    hline(cxl - 40, cxr + 40, cyt, white);
    hline(cxl - 40, cxr + 40, cyb, white);

    /* 6. 1 px white border on the outermost pixels (drawn last so nothing covers it). */
    hline(0, W - 1, 0, white);
    hline(0, W - 1, H - 1, white);
    vline(0, 0, H - 1, white);
    vline(W - 1, 0, H - 1, white);
}

/* ---------------------------------------------------------------------------------------------
 * Labels
 * ------------------------------------------------------------------------------------------- */
static lv_obj_t *make_label(lv_obj_t *parent, const char *text, const lv_font_t *font, uint32_t colour)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_label_set_text(l, text);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(colour), 0);
    lv_obj_set_style_bg_opa(l, LV_OPA_TRANSP, 0);
    lv_obj_set_style_pad_all(l, 0, 0);
    lv_obj_remove_flag(l, LV_OBJ_FLAG_CLICKABLE);
    return l;
}

static lv_obj_t *s_touch_label;
static lv_obj_t *s_boot_label;
static lv_obj_t *s_touch_marker;

static void build_labels(lv_obj_t *scr)
{
    char buf[48];

    lv_obj_t *title = make_label(scr, "Pebble Pocket calibration 410 x 502", &lv_font_montserrat_14, C_WHITE);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 128);

    /* Legend: arc colour to radius. */
    lv_obj_t *legend = lv_obj_create(scr);
    lv_obj_remove_style_all(legend);
    lv_obj_set_size(legend, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(legend, LV_FLEX_FLOW_ROW);
    lv_obj_set_style_pad_column(legend, 10, 0);
    lv_obj_remove_flag(legend, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    for (size_t i = 0; i < ARC_COUNT; i++) {
        snprintf(buf, sizeof(buf), "r%d", ARC_RADII[i]);
        make_label(legend, buf, &lv_font_montserrat_14, ARC_COLOURS[i]);
    }
    lv_obj_align(legend, LV_ALIGN_TOP_MID, 0, 150);

    /* Radius numbers next to where each arc meets the top and bottom straight edges.
     * Small radii sit inside the rounded glass and may be hidden: that is expected. */
    for (size_t i = 0; i < ARC_COUNT; i++) {
        int r = ARC_RADII[i];
        snprintf(buf, sizeof(buf), "%d", r);
        lv_obj_t *tl = make_label(scr, buf, &lv_font_montserrat_12, ARC_COLOURS[i]);
        lv_obj_set_pos(tl, r + 3, 3);
        lv_obj_t *tr = make_label(scr, buf, &lv_font_montserrat_12, ARC_COLOURS[i]);
        lv_obj_align(tr, LV_ALIGN_TOP_RIGHT, -(r + 3), 3);
        lv_obj_t *bl = make_label(scr, buf, &lv_font_montserrat_12, ARC_COLOURS[i]);
        lv_obj_align(bl, LV_ALIGN_BOTTOM_LEFT, r + 3, -3);
        lv_obj_t *br = make_label(scr, buf, &lv_font_montserrat_12, ARC_COLOURS[i]);
        lv_obj_align(br, LV_ALIGN_BOTTOM_RIGHT, -(r + 3), -3);
    }

    /* Major grid coordinates, placed away from the bands, arcs and crosshair. */
    for (int x = 50; x <= 350; x += 50) {
        snprintf(buf, sizeof(buf), "%d", x);
        lv_obj_t *l = make_label(scr, buf, &lv_font_montserrat_12, 0x8A8A8A);
        lv_obj_update_layout(l);
        lv_obj_set_pos(l, x - lv_obj_get_width(l) / 2, 190);
    }
    static const int y_marks[] = {50, 100, 250, 450};
    for (size_t i = 0; i < sizeof(y_marks) / sizeof(y_marks[0]); i++) {
        snprintf(buf, sizeof(buf), "%d", y_marks[i]);
        lv_obj_t *l = make_label(scr, buf, &lv_font_montserrat_12, 0x8A8A8A);
        lv_obj_update_layout(l);
        lv_obj_set_pos(l, 126, y_marks[i] - lv_obj_get_height(l) / 2);
    }

    lv_obj_t *band_a = make_label(scr, "RGB565 no dither: #1F5C54 to #0B1F1D", &lv_font_montserrat_12, 0xB0B0B0);
    lv_obj_set_pos(band_a, BAND_X0 + 4, BAND_PLAIN_Y0 - 16);
    lv_obj_t *band_b = make_label(scr, "RGB565 with 4x4 ordered dither", &lv_font_montserrat_12, 0xB0B0B0);
    lv_obj_set_pos(band_b, BAND_X0 + 4, BAND_DITH_Y0 - 16);

    s_touch_label = make_label(scr, "touch: none yet", &lv_font_montserrat_16, C_TEAL_GLOW);
    lv_obj_align(s_touch_label, LV_ALIGN_TOP_MID, 0, 430);
    s_boot_label = make_label(scr, "BOOT: up", &lv_font_montserrat_12, 0xB0B0B0);
    lv_obj_align(s_boot_label, LV_ALIGN_TOP_MID, 0, 452);

    /* Ring that follows the finger. */
    s_touch_marker = lv_obj_create(scr);
    lv_obj_remove_style_all(s_touch_marker);
    lv_obj_set_size(s_touch_marker, 24, 24);
    lv_obj_set_style_radius(s_touch_marker, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(s_touch_marker, 2, 0);
    lv_obj_set_style_border_color(s_touch_marker, lv_color_hex(C_TEAL_GLOW), 0);
    lv_obj_set_style_border_opa(s_touch_marker, LV_OPA_COVER, 0);
    lv_obj_remove_flag(s_touch_marker, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(s_touch_marker, LV_OBJ_FLAG_HIDDEN | LV_OBJ_FLAG_IGNORE_LAYOUT);
}

/* ---------------------------------------------------------------------------------------------
 * Touch logging: wrap the BSP/esp_lvgl_port read callback so every sample the touch controller
 * delivers is logged with its raw coordinates (before LVGL clamps them to the screen).
 * ------------------------------------------------------------------------------------------- */
static lv_indev_read_cb_t s_orig_read_cb;
static volatile bool s_pressed;
static volatile int32_t s_last_x = -1;
static volatile int32_t s_last_y = -1;
static volatile uint32_t s_touch_count;
static volatile bool s_touch_dirty;

static void touch_read_logged(lv_indev_t *indev, lv_indev_data_t *data)
{
    s_orig_read_cb(indev, data);

    bool pressed = (data->state == LV_INDEV_STATE_PRESSED);
    int32_t x = data->point.x;
    int32_t y = data->point.y;
    const char *range = (x < 0 || y < 0 || x >= W || y >= H) ? " OUTSIDE 0..409 x 0..501" : "";

    if (pressed && !s_pressed) {
        s_touch_count++;
        ESP_LOGI(TAG, "touch #%" PRIu32 " down x=%" PRId32 " y=%" PRId32 "%s", s_touch_count, x, y, range);
    } else if (pressed && (x != s_last_x || y != s_last_y)) {
        ESP_LOGI(TAG, "touch #%" PRIu32 " move x=%" PRId32 " y=%" PRId32 "%s", s_touch_count, x, y, range);
    } else if (!pressed && s_pressed) {
        ESP_LOGI(TAG, "touch #%" PRIu32 " up   x=%" PRId32 " y=%" PRId32 " (last position)", s_touch_count, s_last_x,
                 s_last_y);
    }

    if (pressed) {
        s_last_x = x;
        s_last_y = y;
    }
    if (pressed != s_pressed || pressed) {
        s_touch_dirty = true;
    }
    s_pressed = pressed;
}

static volatile bool s_boot_down;
static volatile bool s_boot_dirty;

static void ui_timer_cb(lv_timer_t *t)
{
    (void)t;
    if (s_touch_dirty) {
        s_touch_dirty = false;
        lv_label_set_text_fmt(s_touch_label, "touch #%" PRIu32 " %s x=%" PRId32 " y=%" PRId32, s_touch_count,
                              s_pressed ? "down" : "up", s_last_x, s_last_y);
        if (s_pressed) {
            lv_obj_set_pos(s_touch_marker, s_last_x - 12, s_last_y - 12);
            lv_obj_remove_flag(s_touch_marker, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s_touch_marker, LV_OBJ_FLAG_HIDDEN);
        }
    }
    if (s_boot_dirty) {
        s_boot_dirty = false;
        lv_label_set_text(s_boot_label, s_boot_down ? "BOOT: down" : "BOOT: up");
    }
}

/* BOOT is GPIO0, low while pressed (xiaozhi board config.h:23, BOOT_BUTTON_GPIO GPIO_NUM_0). */
static void boot_button_task(void *arg)
{
    (void)arg;
    const gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << GPIO_NUM_0,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&cfg);

    int stable = gpio_get_level(GPIO_NUM_0);
    int count = 0;
    while (1) {
        int level = gpio_get_level(GPIO_NUM_0);
        if (level != stable) {
            if (++count >= 3) { /* 3 x 10 ms debounce */
                stable = level;
                count = 0;
                s_boot_down = (stable == 0);
                s_boot_dirty = true;
                ESP_LOGI(TAG, "BOOT (GPIO0) %s", s_boot_down ? "pressed" : "released");
            }
        } else {
            count = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "Pebble Pocket screen calibration, native %d x %d", W, H);

    /* Display and touch init: unchanged from Waveshare 02_lvgl_demo_v9. */
    lv_display_t *disp = bsp_display_start();
    if (disp == NULL) {
        ESP_LOGE(TAG, "bsp_display_start() failed, display not initialised");
        return;
    }

    bsp_display_lock(0);

    int64_t t0 = esp_timer_get_time();
    lv_obj_t *scr = lv_screen_active();
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(scr, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(scr, 0, 0);

    s_buf = lv_draw_buf_create(W, H, LV_COLOR_FORMAT_RGB565, LV_STRIDE_AUTO);
    if (s_buf == NULL) {
        bsp_display_unlock();
        ESP_LOGE(TAG, "could not allocate %d x %d RGB565 canvas", W, H);
        return;
    }
    s_px = (uint16_t *)s_buf->data;
    s_stride_px = s_buf->header.stride / 2;
    draw_pattern();

    lv_obj_t *canvas = lv_canvas_create(scr);
    lv_canvas_set_draw_buf(canvas, s_buf);
    lv_obj_set_pos(canvas, 0, 0);
    lv_obj_remove_flag(canvas, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    build_labels(scr);

    lv_indev_t *indev = bsp_display_get_input_dev();
    if (indev != NULL) {
        s_orig_read_cb = lv_indev_get_read_cb(indev);
        lv_indev_set_read_cb(indev, touch_read_logged);
        ESP_LOGI(TAG, "touch logging enabled");
    } else {
        ESP_LOGE(TAG, "no touch input device from the BSP, touch will not be logged");
    }
    lv_timer_create(ui_timer_cb, 30, NULL);

    bsp_display_unlock();

    ESP_LOGI(TAG, "pattern drawn in %" PRId64 " ms (canvas stride %" PRIu32 " px)", (esp_timer_get_time() - t0) / 1000,
             s_stride_px);
    ESP_LOGI(TAG, "border on x=0, x=%d, y=0, y=%d; grid every 10 px, brighter every 50 px", W - 1, H - 1);
    ESP_LOGI(TAG, "arc centres for radius r: TL (r,r) TR (%d-r,r) BL (r,%d-r) BR (%d-r,%d-r)", W - 1, H - 1, W - 1, H - 1);
    ESP_LOGI(TAG, "crosshair 2 px wide on x=%d..%d, y=%d..%d", W / 2 - 1, W / 2, H / 2 - 1, H / 2);
    ESP_LOGI(TAG, "free heap: internal %u, PSRAM %u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));

    xTaskCreate(boot_button_task, "boot_btn", 3072, NULL, 3, NULL);
    ESP_LOGI(TAG, "ready: touch the screen or press BOOT");
}
