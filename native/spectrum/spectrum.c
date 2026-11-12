#include "spectrum.h"
#include "kiss_fftr.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

enum { MAX_FFT = 4096, MAX_BINS = 2049, MAX_ROWS = 8 };
static unsigned size = 0, hop = 0, write_at = 0, available = 0, since_row = 0;
static kiss_fftr_cfg fft;
static int16_t pcm[1024];
static float window[MAX_FFT], left[MAX_FFT], right[MAX_FFT], input[MAX_FFT];
static kiss_fft_cpx output[MAX_BINS], left_output[MAX_BINS];
static float rows[MAX_ROWS * MAX_BINS * 2], window_sum;
static unsigned offsets[MAX_ROWS];

void spc_spectrum_reset(void) { write_at = available = since_row = 0; }
int spc_spectrum_configure(unsigned fft_size, unsigned hop_size) {
    if ((fft_size != 1024 && fft_size != 2048 && fft_size != 4096) ||
        (hop_size != 64 && hop_size != 128 && hop_size != 256 && hop_size != 512)) return -1;
    kiss_fftr_cfg replacement = kiss_fftr_alloc((int)fft_size, 0, NULL, NULL);
    if (!replacement) return -2;
    if (fft) kiss_fftr_free(fft);
    fft = replacement; size = fft_size; hop = hop_size; window_sum = 0;
    for (unsigned i = 0; i < size; ++i) {
        window[i] = (float)(0.5 - 0.5 * cos(6.2831853071795864769 * i / size));
        window_sum += window[i];
    }
    spc_spectrum_reset();
    return 0;
}
int16_t *spc_spectrum_input(void) { return pcm; }
const float *spc_spectrum_output(void) { return rows; }
unsigned spc_spectrum_offset(unsigned row) { return row < MAX_ROWS ? offsets[row] : 0; }
static void transform(unsigned row) {
    float *result = rows + row * (size / 2 + 1) * 2;
    for (unsigned channel = 0; channel < 2; ++channel) {
        const float *samples = channel ? right : left;
        const unsigned tail = size - write_at;
        for (unsigned i = 0; i < tail; ++i) input[i] = samples[write_at + i] * window[i];
        for (unsigned i = tail; i < size; ++i) input[i] = samples[i - tail] * window[i];
        kiss_fftr(fft, input, output);
        for (unsigned b = 0; b <= size / 2; ++b) {
            const float scale = (b == 0 || b == size / 2 ? 1.0f : 2.0f) / window_sum;
            const float real = output[b].r * scale, imag = output[b].i * scale;
            const float power = (real * real + imag * imag) * 0.5f;
            if (!channel) { result[b * 2] = power; left_output[b].r = real; left_output[b].i = imag; }
            else {
                const float dr = left_output[b].r - real, di = left_output[b].i - imag;
                result[b * 2] += power; result[b * 2 + 1] = (dr * dr + di * di) * 0.25f;
            }
        }
    }
}
unsigned spc_spectrum_push(unsigned frames) {
    if (!fft || !frames || frames > 512) return 0;
    unsigned count = 0;
    for (unsigned i = 0; i < frames; ++i) {
        left[write_at] = pcm[i * 2] / 32768.0f; right[write_at] = pcm[i * 2 + 1] / 32768.0f;
        if (++write_at == size) write_at = 0;
        if (available < size) {
            if (++available != size) continue;
        } else if (++since_row != hop) continue;
        since_row = 0; offsets[count] = i + 1; transform(count++);
    }
    return count;
}
