export type SpcMetadata = {
  valid: boolean;
  hasId666: boolean;
  binaryId666: boolean;
  title: string;
  game: string;
  artist: string;
  dumper: string;
  comments: string;
  songSeconds: number;
  fadeMilliseconds: number;
};

const signature = 'SNES-SPC700 Sound File Data v0.30';
const signatureBytes = new TextEncoder().encode(signature);
const decoder = new TextDecoder('ascii');

const field = (data: Uint8Array, offset: number, length: number) => {
  let end = offset;
  while (end < offset + length && data[end] !== 0) end += 1;
  return decoder
    .decode(data.subarray(offset, end))
    .replace(/[^\x20-\x7e]/g, '?')
    .trimEnd();
};

const decimal = (data: Uint8Array, offset: number, length: number): number | null => {
  const text = field(data, offset, length).trim();
  return /^\d+$/.test(text) ? Number.parseInt(text, 10) : null;
};

const littleEndian = (data: Uint8Array, offset: number, length: number) => {
  let value = 0;
  for (let index = 0; index < length; index += 1) value += data[offset + index] * 2 ** (index * 8);
  return value;
};

const fallbackTitle = (filename: string) => filename.replace(/\.spc$/i, '');

export const parseSpcMetadata = (data: Uint8Array, filename: string): SpcMetadata => {
  const base: SpcMetadata = {
    valid: false,
    hasId666: false,
    binaryId666: false,
    title: fallbackTitle(filename),
    game: '',
    artist: '',
    dumper: '',
    comments: '',
    songSeconds: 0,
    fadeMilliseconds: 0,
  };
  if (data.length < 0x100 || signatureBytes.some((value, index) => data[index] !== value)) return base;
  if (data[0x21] !== 0x1a || data[0x22] !== 0x1a || data[0x24] !== 0x1e) return base;
  base.valid = true;
  if (data[0x23] !== 0x1a) return base;

  const textSeconds = decimal(data, 0xa9, 3);
  const textFade = decimal(data, 0xac, 5);
  const date = field(data, 0x9e, 11);
  const textDate = date.length > 0 && /^[0-9/\- ]+$/.test(date);
  const binary = !textDate && (textSeconds === null || textFade === null);
  return {
    valid: true,
    hasId666: true,
    binaryId666: binary,
    title: field(data, 0x2e, 32) || base.title,
    game: field(data, 0x4e, 32),
    artist: field(data, binary ? 0xb0 : 0xb1, 32),
    dumper: field(data, 0x6e, 16),
    comments: field(data, 0x7e, 32),
    songSeconds: binary ? littleEndian(data, 0xa9, 3) : (textSeconds ?? 0),
    fadeMilliseconds: binary ? littleEndian(data, 0xac, 4) : (textFade ?? 0),
  };
};

export const readSpcMetadata = async (file: File) => {
  const header = new Uint8Array(await file.slice(0, 0x100).arrayBuffer());
  return parseSpcMetadata(header, file.name);
};
