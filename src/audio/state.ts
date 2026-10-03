export type VoiceState = {
  volumeLeft: number;
  volumeRight: number;
  pitch: number;
  envelope: number;
  brrAddress: number;
  sourceNumber: number;
  adsr0: number;
  adsr1: number;
  gain: number;
  envx: number;
  output: number;
  envelopeMode: number;
  keyOn: boolean;
  keyOff: boolean;
  endx: boolean;
};

export type EmulatorState = {
  generation: number;
  sequence: number;
  validity: number;
  nativeFrame: number;
  dspRegisters: Uint8Array;
  voices: VoiceState[];
};

const signed8 = (value: number) => (value & 0x80 ? value - 0x100 : value);

export const decodeStatePayload = (payload: Uint8Array): EmulatorState => {
  if (payload.byteLength < 288) throw new Error('Truncated state payload');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint32(0, true);
  const length = view.getUint32(4, true);
  if (version !== 1) throw new Error('Unsupported state ABI version');
  if (length !== 288 || payload.byteLength < length) throw new Error('Invalid state payload length');
  const voices: VoiceState[] = [];
  for (let index = 0; index < 8; index += 1) {
    const offset = 160 + index * 16;
    const flags = payload[offset + 15];
    voices.push({
      volumeLeft: signed8(payload[offset]),
      volumeRight: signed8(payload[offset + 1]),
      pitch: view.getUint16(offset + 2, true),
      envelope: view.getUint16(offset + 4, true),
      brrAddress: view.getUint16(offset + 6, true),
      sourceNumber: payload[offset + 8],
      adsr0: payload[offset + 9],
      adsr1: payload[offset + 10],
      gain: payload[offset + 11],
      envx: payload[offset + 12],
      output: signed8(payload[offset + 13]),
      envelopeMode: payload[offset + 14],
      keyOn: (flags & 1) !== 0,
      keyOff: (flags & 2) !== 0,
      endx: (flags & 4) !== 0,
    });
  }
  return {
    generation: view.getUint32(8, true),
    sequence: view.getUint32(12, true),
    validity: view.getUint32(16, true),
    nativeFrame: view.getFloat64(24, true),
    dspRegisters: payload.slice(32, 160),
    voices,
  };
};
