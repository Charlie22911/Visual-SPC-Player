#pragma once
#include <array>
#include <atomic>
#include <cstddef>
namespace visual_spc {
// One producer, one consumer; pointers expire after publish/consume respectively.
template<class T, std::size_t N> class SpscRing {
    static_assert(N >= 2 && (N & (N - 1)) == 0);
    alignas(64) std::atomic<std::size_t> write_{0};
    alignas(64) std::atomic<std::size_t> read_{0};
    std::array<T, N> slots_{};
public:
    T* producer_slot() noexcept {
        const auto w = write_.load(std::memory_order_relaxed);
        if (((w + 1) & (N - 1)) == read_.load(std::memory_order_acquire)) return nullptr;
        return &slots_[w];
    }
    void publish() noexcept {
        write_.store((write_.load(std::memory_order_relaxed) + 1) & (N - 1), std::memory_order_release);
    }
    const T* consumer_slot() const noexcept {
        const auto r = read_.load(std::memory_order_relaxed);
        return r == write_.load(std::memory_order_acquire) ? nullptr : &slots_[r];
    }
    void consume() noexcept {
        read_.store((read_.load(std::memory_order_relaxed) + 1) & (N - 1), std::memory_order_release);
    }
};
}
