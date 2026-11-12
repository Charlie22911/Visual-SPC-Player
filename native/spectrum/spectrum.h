#ifndef SPC_SPECTRUM_H
#define SPC_SPECTRUM_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Fixed storage: no allocation in push; at most eight rows per 512-frame packet. */
int spc_spectrum_configure(unsigned fft_size, unsigned hop_size);
void spc_spectrum_reset(void);
int16_t *spc_spectrum_input(void);
const float *spc_spectrum_output(void);
unsigned spc_spectrum_push(unsigned frames);
unsigned spc_spectrum_offset(unsigned row);
#ifdef __cplusplus
}
#endif
#endif
