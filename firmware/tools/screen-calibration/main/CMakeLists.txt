idf_component_register(
    SRCS main.c
    INCLUDE_DIRS .
    PRIV_REQUIRES esp_driver_gpio esp_timer)

# Same LVGL compile option handling as Waveshare's 02_lvgl_demo_v9 main/CMakeLists.txt.
idf_build_get_property(build_components BUILD_COMPONENTS)
if("lvgl__lvgl" IN_LIST build_components)
    idf_component_get_property(LVGL_LIB lvgl__lvgl COMPONENT_LIB)
    if(TARGET ${LVGL_LIB})
        target_compile_options(${LVGL_LIB} PRIVATE -Wno-error=attributes -Wno-error=cpp)
    endif()
endif()
