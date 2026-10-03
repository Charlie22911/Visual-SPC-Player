export type Point = { x: number; y: number };

const assertIntegerRange = (value: number, max: number, label: string) => {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(label + ' is out of range');
  }
};

export const byteCoordinates = (address: number): Point => {
  assertIntegerRange(address, 0xffff, 'address');
  return { x: address & 0xff, y: address >>> 8 };
};

export const addressFromBytePoint = (x: number, y: number): number | null => {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 255 || y < 0 || y > 255) {
    return null;
  }
  return (y << 8) | x;
};

export const bitCoordinates = (address: number, bit: number): Point => {
  assertIntegerRange(address, 0xffff, 'address');
  assertIntegerRange(bit, 7, 'bit');
  const slot = 7 - bit;
  return {
    x: (address & 0xff) * 4 + (slot % 4),
    y: (address >>> 8) * 2 + Math.floor(slot / 4),
  };
};

export const bitFromPoint = (x: number, y: number): { address: number; bit: number } | null => {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 1023 || y < 0 || y > 511) {
    return null;
  }
  return {
    address: (Math.floor(y / 2) << 8) | Math.floor(x / 4),
    bit: 7 - ((y % 2) * 4 + (x % 4)),
  };
};

export const parseAddress = (value: string): number | null => {
  const match = value.trim().match(/^(?:\$|0x)?([0-9a-f]{4})$/i);
  return match ? Number.parseInt(match[1], 16) : null;
};

export const formatAddress = (address: number) => {
  assertIntegerRange(address, 0xffff, 'address');
  return '$' + address.toString(16).toUpperCase().padStart(4, '0');
};
