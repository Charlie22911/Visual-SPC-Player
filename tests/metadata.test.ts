import { describe, expect, test } from 'vitest';
import { parseSpcMetadata } from '../src/library/metadata';

const writeAscii = (data: Uint8Array, offset: number, length: number, value: string) => {
  data.fill(0, offset, offset + length);
  data.set(new TextEncoder().encode(value).subarray(0, length), offset);
};

const makeHeader = (tagged = true) => {
  const data = new Uint8Array(0x10180);
  writeAscii(data, 0, 33, 'SNES-SPC700 Sound File Data v0.30');
  data[0x21] = 0x1a;
  data[0x22] = 0x1a;
  data[0x23] = tagged ? 0x1a : 0x1b;
  data[0x24] = 0x1e;
  return data;
};

describe('ID666 metadata', () => {
  test('parses text fields and timing from a valid SPC header', () => {
    const data = makeHeader();
    writeAscii(data, 0x2e, 32, 'Aquatic Ambience');
    writeAscii(data, 0x4e, 32, 'Donkey Kong Country');
    writeAscii(data, 0x6e, 16, 'Dumper');
    writeAscii(data, 0x7e, 32, 'Test comment');
    writeAscii(data, 0x9e, 11, '09/11/2026');
    writeAscii(data, 0xa9, 3, '123');
    writeAscii(data, 0xac, 5, '04567');
    writeAscii(data, 0xb1, 32, 'David Wise');

    expect(parseSpcMetadata(data, 'fallback.spc')).toMatchObject({
      valid: true,
      hasId666: true,
      title: 'Aquatic Ambience',
      game: 'Donkey Kong Country',
      artist: 'David Wise',
      dumper: 'Dumper',
      comments: 'Test comment',
      songSeconds: 123,
      fadeMilliseconds: 4567,
    });
  });

  test('rejects malformed input and uses filename fallback when tags are absent', () => {
    expect(parseSpcMetadata(new Uint8Array(40), 'bad.spc').valid).toBe(false);
    const data = makeHeader(false);
    expect(parseSpcMetadata(data, 'Boss Theme.spc')).toMatchObject({
      valid: true,
      hasId666: false,
      title: 'Boss Theme',
    });
  });

  test('parses binary ID666 timing and artist offset', () => {
    const data = makeHeader();
    writeAscii(data, 0x2e, 32, 'Binary Track');
    data[0x9e] = 0x01;
    data[0xa9] = 0x2c;
    data[0xaa] = 0x01;
    data[0xab] = 0x00;
    data[0xac] = 0x88;
    data[0xad] = 0x13;
    writeAscii(data, 0xb0, 32, 'Binary Artist');

    expect(parseSpcMetadata(data, 'binary.spc')).toMatchObject({
      valid: true,
      hasId666: true,
      binaryId666: true,
      title: 'Binary Track',
      artist: 'Binary Artist',
      songSeconds: 300,
      fadeMilliseconds: 5000,
    });
  });

  test('rejects malformed marker bytes even when the text signature is present', () => {
    const data = makeHeader();
    data[0x22] = 0;
    expect(parseSpcMetadata(data, 'bad-marker.spc').valid).toBe(false);
  });
});
