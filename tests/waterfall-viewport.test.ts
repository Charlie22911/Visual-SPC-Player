import { expect, test } from 'vitest';
import { columnRange, zoomWindow, panWindow, resizeWindow, oneToOneWindow } from '../src/aram/waterfallViewport';
test.each([1024, 997, 390])('partitions all ARAM at width %i with no gaps or empty buckets', (columns) => {
  let end = 0;
  for (let x = 0; x < columns; x++) { const [a, b] = columnRange({ start: 0, span: 65536 }, columns, x); expect(a).toBe(end); expect(b).toBeGreaterThan(a); end = b; }
  expect(end).toBe(65536);
});
test('bucket endpoints, 1:1, anchored zoom, and pan are exact', () => {
  const fit = { start: 0, span: 65536 };
  expect(columnRange(fit, 1024, 0)).toEqual([0, 64]); expect(columnRange(fit, 1024, 1023)).toEqual([65472, 65536]);
  expect(zoomWindow(fit, 1024, 2, 0.5)).toEqual({ start: 16384, span: 32768 });
  const exact = oneToOneWindow({ start: 65000, span: 536 }, 390);
  for (let x = 0; x < 390; x++) expect(columnRange(exact, 390, x)).toEqual([exact.start + x, exact.start + x + 1]);
  expect(panWindow(exact, 1e9).start).toBe(65536 - 390); expect(panWindow(exact, -1e9).start).toBe(0);
  expect(resizeWindow({ start: 8192, span: 2048 }, 1024, 512)).toEqual({ start: 8704, span: 1024 });
});
