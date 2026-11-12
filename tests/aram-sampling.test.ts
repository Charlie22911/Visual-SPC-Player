import { expect, test } from 'vitest';
import * as sampling from '../src/aram/sampling';
import { numericMapSource, summarizeMapFootprint } from '../src/aram/mapSampling';

test('numeric sampling averages values before applying a nonlinear byte palette', () => {
  const source = (x: number, y: number) => ({ value: [0, 255][x], background: 0, kind: 0, held: 0, changed: x === 1, valid: y === 0 && x >= 0 && x < 2 });
  expect(sampling.sampleNumeric(source, 2, 1, 1, .5, 2, 1, 'area').value).toBe(127.5);
  expect(sampling.sampleNumeric(source, 2, 1, 1, .5, 1, 1, 'smooth').value).toBe(127.5);
  expect(sampling.sampleNumeric(source, 2, 1, 1, .5, 1, 1, 'nearest').value).toBe(255);
});

test('fractional area footprints preserve access unions and bit coverage', () => {
  const source = (x: number) => ({ value: x ? 1 : 0, background: x * 100, kind: 1 << x, held: 0, changed: !!x, valid: true });
  const result = sampling.sampleNumeric(source, 2, 1, 1, .5, 1.5, 1, 'area');
  expect(result.value).toBeCloseTo(.5); expect(result.kind).toBe(3); expect(result.background).toBe(50);
});

test('causal temporal filtering leaves access timing intact and stops at missing bands', () => {
  const source = (_x: number, y: number) => ({ value: y ? 0 : 100, background: y ? 0 : 200, kind: y ? 2 : 1, held: 0, changed: false, valid: y !== 2 });
  const data = sampling.temporalSample(source, 0, 0, 4, 3, false);
  expect(data.value).toBeCloseTo(100 / 1.75); expect(data.kind).toBe(1);
  const activity = sampling.temporalSample(source, 0, 0, 4, 3, true);
  expect(activity.value).toBe(100); expect(activity.background).toBeCloseTo(200 / 1.75); expect(activity.kind).toBe(1);
});

test('smooth interpolation cannot invent valid samples inside a missing band', () => {
  const source = (_x: number, y: number) => ({ value: 255, background: 0, kind: 1, held: 0, changed: false, valid: y !== 1 });
  expect(sampling.sampleNumeric(source, 1, 3, .5, 1.1, 1, 1, 'smooth').coverage).toBe(0);
});

test('Map Area counts distinct bytes across fractional bit-tile footprints', () => {
  const ram = new Uint8Array(65536), access = new Uint8Array(24576); ram[0] = 0x88; access[0] = 1;
  const source = numericMapSource('bits', ram, access, new Uint8Array(65536), new Float32Array(2048));
  expect(summarizeMapFootprint(source, true, 0, 0, 2, 2)).toMatchObject({ cells: 4, bytes: 1, first: 0, last: 0, value: .5, kind: 1 });
  expect(summarizeMapFootprint(source, true, 3.5, 0, 4.5, 1)).toMatchObject({ cells: 2, bytes: 2, first: 0, last: 1 });
});

test('Map Area preserves fractional edges when enlarged instead of choosing the center cell', () => {
  const source = (x: number) => ({ value: x * 100, background: 0, kind: 0, held: 0, changed: false, valid: true });
  expect(sampling.sampleNumeric(source, 2, 1, 1, .5, .5, .5, 'area').value).toBe(50);
});
