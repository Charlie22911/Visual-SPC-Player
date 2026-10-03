import { describe, expect, test } from 'vitest';
import { decodeStatePayload } from '../src/audio/state';

describe('versioned emulator state', () => {
  test('decodes DSP and voice fields from the fixed ABI layout', () => {
    const payload = new ArrayBuffer(288);
    const view = new DataView(payload);
    view.setUint32(0, 1, true);
    view.setUint32(4, 288, true);
    view.setUint32(8, 7, true);
    view.setUint32(12, 42, true);
    view.setUint32(16, 3, true);
    view.setFloat64(24, 64000, true);
    new Uint8Array(payload)[32 + 0x6c] = 0x7f;
    const voice = new Uint8Array(payload, 160, 16);
    voice.set([0x80, 0x7f, 0x34, 0x12, 0xff, 0x07, 0xcd, 0xab, 6, 0x8f, 0xe0, 0x22, 0x55, 0xf0, 3, 5]);

    expect(decodeStatePayload(new Uint8Array(payload))).toMatchObject({
      generation: 7,
      sequence: 42,
      nativeFrame: 64000,
      dspRegisters: expect.any(Uint8Array),
      voices: [{
        volumeLeft: -128,
        volumeRight: 127,
        pitch: 0x1234,
        envelope: 0x07ff,
        brrAddress: 0xabcd,
        sourceNumber: 6,
        output: -16,
        envelopeMode: 3,
        keyOn: true,
        keyOff: false,
        endx: true,
      }, ...Array(7).fill(expect.any(Object))],
    });
  });

  test('rejects incompatible or truncated payloads', () => {
    expect(() => decodeStatePayload(new Uint8Array(20))).toThrow('state payload');
    const payload = new Uint8Array(288);
    new DataView(payload.buffer).setUint32(0, 2, true);
    new DataView(payload.buffer).setUint32(4, 288, true);
    expect(() => decodeStatePayload(payload)).toThrow('ABI');
  });
});
