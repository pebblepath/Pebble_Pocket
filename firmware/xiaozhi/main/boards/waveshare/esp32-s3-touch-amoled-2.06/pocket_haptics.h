#pragma once

// Pebble Pocket: short vibration cues on the board's optional motor pads (P1/P2).
//
// Hardware (Waveshare schematic V1.0, "Motor" block): P1 is fed from AXP2101 ALDO3; P2 goes to the
// collector of Q1 (MMBT3904, low-side NPN, emitter to GND). GPIO18 drives the base through 4.7 k,
// with a 47 k pull-down, so the motor runs while GPIO18 is high. Whether a motor is fitted on the
// retail board is unconfirmed; if the pads are empty, pulsing GPIO18 is harmless.
//
// The drive is weak: about 0.5 mA of base current keeps Q1 out of saturation, capping motor current
// near 45 to 65 mA, and coin motors take 50 to 90 ms to spin up. So cues are 60 to 100 ms, and the
// startup self-test is one long pulse. Pulse length does not reduce the turn-off spike (no flyback
// diode is drawn across the pads); the energy is tiny, but add a diode if a motor is fitted by hand.
// Tune these durations on the bench once the motor situation is known.
//
// Threading: call Play() from button callbacks (they run on the esp_timer task, like Step()). From
// any other task, schedule the call onto the main loop instead.
//
// Enabled only when CONFIG_POCKET_HAPTICS=y (the pebble-pocket build variant).

#include <driver/gpio.h>
#include <esp_log.h>
#include <esp_timer.h>

#include <atomic>
#include <cstddef>

class PocketHaptics {
public:
    enum class Pattern {
        kTap,     // a press was felt: one short pulse
        kTick,    // a hold reached its threshold (Hello starts recording): one firmer pulse
        kDouble,  // something finished (Hello sent): two short pulses
        kSelfTest, // startup bench test: one long pulse, long enough to feel through a weak drive
    };

    static PocketHaptics& GetInstance() {
        static PocketHaptics instance;
        return instance;
    }

    void Initialize(gpio_num_t pin) {
        pin_ = pin;
        gpio_config_t io = {};
        io.pin_bit_mask = 1ULL << pin_;
        io.mode = GPIO_MODE_OUTPUT;
        io.pull_down_en = GPIO_PULLDOWN_ENABLE;
        gpio_config(&io);
        gpio_set_level(pin_, 0);

        esp_timer_create_args_t args = {};
        args.callback = [](void* arg) { static_cast<PocketHaptics*>(arg)->Step(); };
        args.arg = this;
        args.name = "pocket_haptics";
        esp_timer_create(&args, &timer_);
        ready_ = true;
        ESP_LOGI(kTag, "Haptics ready on GPIO%d", static_cast<int>(pin_));
    }

    // Starts a pattern, replacing any pattern already playing. Safe to call from button callbacks.
    void Play(Pattern pattern) {
        if (!ready_) {
            return;
        }
        esp_timer_stop(timer_);
        switch (pattern) {
            case Pattern::kTap:    steps_ = kTapSteps;    count_ = sizeof(kTapSteps) / sizeof(kTapSteps[0]);       break;
            case Pattern::kTick:   steps_ = kTickSteps;   count_ = sizeof(kTickSteps) / sizeof(kTickSteps[0]);     break;
            case Pattern::kDouble: steps_ = kDoubleSteps; count_ = sizeof(kDoubleSteps) / sizeof(kDoubleSteps[0]); break;
            case Pattern::kSelfTest: steps_ = kSelfTestSteps; count_ = sizeof(kSelfTestSteps) / sizeof(kSelfTestSteps[0]); break;
        }
        index_ = 0;
        Step();
    }

private:
    static constexpr const char* kTag = "PocketHaptics";

    // Alternating on/off durations in milliseconds, starting with "on". Everyday cues stay at or under
    // 100 ms; only the startup self-test is longer.
    static constexpr int kTapSteps[] = {60};
    static constexpr int kTickSteps[] = {100};
    static constexpr int kDoubleSteps[] = {70, 110, 70};
    static constexpr int kSelfTestSteps[] = {400};

    PocketHaptics() = default;

    void Step() {
        size_t i = index_.load();
        if (i >= count_) {
            gpio_set_level(pin_, 0);
            return;
        }
        bool on = (i % 2) == 0;
        gpio_set_level(pin_, on ? 1 : 0);
        index_.store(i + 1);
        esp_timer_start_once(timer_, static_cast<uint64_t>(steps_[i]) * 1000ULL);
    }

    gpio_num_t pin_ = GPIO_NUM_NC;
    esp_timer_handle_t timer_ = nullptr;
    const int* steps_ = nullptr;
    size_t count_ = 0;
    std::atomic<size_t> index_{0};
    bool ready_ = false;
};
