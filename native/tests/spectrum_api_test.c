#include "spectrum/spectrum.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "spectrum check failed: %s:%d: %s\n", __FILE__, __LINE__, #x); return 1; } } while (0)
int main(void) {
    const unsigned sizes[] = {1024, 2048, 4096}, hops[] = {64, 128, 256, 512};
    for (unsigned s = 0; s < 3; ++s) for (unsigned h = 0; h < 4; ++h) {
        CHECK(spc_spectrum_configure(sizes[s], hops[h]) == 0);
        for (unsigned phase = 0; phase < 3; ++phase) {
            spc_spectrum_reset();
            unsigned rows = 0;
            for (unsigned frame = 0; frame < sizes[s] + hops[h] * 3; ) {
                unsigned count = sizes[s] + hops[h] * 3 - frame;
                if (count > 512) count = 512;
                int16_t *pcm = spc_spectrum_input();
                for (unsigned i = 0; i < count; ++i) {
                    int16_t value = (int16_t)lround(16384.0 * sin(6.283185307179586 * 64 * (frame + i) / sizes[s]));
                    pcm[i * 2] = value;
                    pcm[i * 2 + 1] = phase == 0 ? value : phase == 1 ? (int16_t)-value : 0;
                }
                unsigned n = spc_spectrum_push(count);
                const float *output = spc_spectrum_output();
                const unsigned stride = (sizes[s] / 2 + 1) * 2;
                for (unsigned r = 0; r < n; ++r) {
                    CHECK(spc_spectrum_offset(r) + frame == sizes[s] + rows * hops[h]);
                    CHECK(fabs(output[r * stride + 128] - (phase == 2 ? 0.125 : 0.25)) < 0.0001);
                    CHECK(fabs(output[r * stride + 129] - (phase == 0 ? 0 : phase == 1 ? 0.25 : 0.0625)) < 0.0001);
                    ++rows;
                }
                frame += count;
            }
            CHECK(rows == 4);
        }
        // Reset must discard overlap; no transform may bridge a missing packet.
        spc_spectrum_reset();
        CHECK(spc_spectrum_push(512) == 0);
        spc_spectrum_reset();
        CHECK(spc_spectrum_push(512) == 0);
    }
    CHECK(spc_spectrum_configure(512, 256) != 0);
    CHECK(spc_spectrum_configure(2048, 32) != 0);
    CHECK(spc_spectrum_push(513) == 0);
    // DC/Nyquist are single-sided; silence is exactly finite zero power.
    CHECK(spc_spectrum_configure(2048, 256) == 0);
    for (unsigned mode = 0; mode < 3; ++mode) {
        spc_spectrum_reset();
        unsigned rows = 0;
        for (unsigned start = 0; start < 2048; start += 512) {
            int16_t *pcm = spc_spectrum_input();
            for (unsigned i = 0; i < 512; ++i)
                pcm[i * 2] = pcm[i * 2 + 1] = mode == 2 ? 0 : mode == 0 || i % 2 == 0 ? 16384 : -16384;
            rows = spc_spectrum_push(512);
        }
        CHECK(rows == 1);
        const float *output = spc_spectrum_output();
        if (mode != 2) CHECK(fabs(output[mode == 0 ? 0 : 2048] - 0.25) < 0.0001);
        for (unsigned b = 0; b < 1025; ++b) {
            CHECK(isfinite(output[b * 2]));
            CHECK(output[b * 2 + 1] == 0);
            if (mode == 2) CHECK(output[b * 2] == 0);
        }
    }
    puts("spectrum calibration and cadence passed");
    return 0;
}
