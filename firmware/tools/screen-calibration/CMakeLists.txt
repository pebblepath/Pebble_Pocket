# Pebble Pocket screen calibration.
# Project boilerplate derived from Waveshare's examples/esp-idf/02_lvgl_demo_v9
# (github.com/waveshareteam/ESP32-S3-Touch-AMOLED-2.06 @ b099739, Apache-2.0, see LICENSE).
cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

add_compile_options(-Wno-format)
project(screen_calibration)
