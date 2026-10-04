import { describe, expect, test } from 'vitest';
import {
  addressFromBytePoint,
  bitFromPoint,
  byteCoordinates,
  bitCoordinates,
  parseAddress,
} from '../src/aram/mapping';

describe('ARAM coordinate mapping', () => {
  test('round-trips every byte without collisions', () => {
    const occupied = new Uint8Array(256 * 256);
    for (let address = 0; address < 65536; address += 1) {
      const point = byteCoordinates(address);
      const pixel = point.y * 256 + point.x;
      expect(occupied[pixel]).toBe(0);
      occupied[pixel] = 1;
      expect(addressFromBytePoint(point.x, point.y)).toBe(address);
    }
    expect(occupied.every((value) => value === 1)).toBe(true);
  });

  test('round-trips all 524,288 bit pixels without collisions', () => {
    const occupied = new Uint8Array(1024 * 512);
    for (let address = 0; address < 65536; address += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        const point = bitCoordinates(address, bit);
        const pixel = point.y * 1024 + point.x;
        expect(occupied[pixel]).toBe(0);
        occupied[pixel] = 1;
        expect(bitFromPoint(point.x, point.y)).toEqual({ address, bit });
      }
    }
    expect(occupied.every((value) => value === 1)).toBe(true);
  }, 30_000); // Exhaustive bit coverage can exceed the default timeout on shared runners.

  test('places bit 7 upper-left and bit 0 lower-right in a byte tile', () => {
    expect(bitCoordinates(0, 7)).toEqual({ x: 0, y: 0 });
    expect(bitCoordinates(0, 0)).toEqual({ x: 3, y: 1 });
    expect(bitCoordinates(0xffff, 7)).toEqual({ x: 1020, y: 510 });
    expect(bitCoordinates(0xffff, 0)).toEqual({ x: 1023, y: 511 });
  });

  test.each([
    ['$1234', 0x1234],
    ['0x00ff', 0x00ff],
    ['ABCD', 0xabcd],
  ])('parses %s as an ARAM address', (text, expected) => {
    expect(parseAddress(text)).toBe(expected);
  });

  test.each(['', '$10000', '-1', 'xyz', '0x123'])('rejects invalid address %s', (text) => {
    expect(parseAddress(text)).toBeNull();
  });
});
