import { describe, expect, test } from 'vitest';
import { centerLogicalPoint, fitScale, pinchViewport, screenToLogical, zoomAt, type Viewport } from '../src/aram/viewport';

describe('ARAM viewport', () => {
  test('fit scale contains the complete logical image', () => {
    expect(fitScale(800, 600, 1024, 512)).toBeCloseTo(0.78125);
    expect(fitScale(300, 700, 256, 256)).toBeCloseTo(300 / 256);
  });

  test('cursor anchored zoom preserves the pointed logical coordinate', () => {
    const before: Viewport = { scale: 2, offsetX: -100, offsetY: 30 };
    const anchor = { x: 240, y: 180 };
    const logicalBefore = screenToLogical(anchor, before);
    const after = zoomAt(before, 1.75, anchor, 0.25, 32);
    expect(screenToLogical(anchor, after).x).toBeCloseTo(logicalBefore.x);
    expect(screenToLogical(anchor, after).y).toBeCloseTo(logicalBefore.y);
  });

  test('centers a selected logical cell in the stage', () => {
    const next = centerLogicalPoint({ scale: 8, offsetX: 0, offsetY: 0 }, { x: 171.5, y: 205.5 }, 600, 400);
    expect(screenToLogical({ x: 300, y: 200 }, next)).toEqual({ x: 171.5, y: 205.5 });
  });

  test('pinch keeps the original anchor under a moving midpoint', () => {
    const start: Viewport = { scale: 2, offsetX: 10, offsetY: 20 };
    const next = pinchViewport(start, { x: 100, y: 100 }, { x: 140, y: 125 }, 1.5, 0.25, 32);
    expect(screenToLogical({ x: 140, y: 125 }, next)).toEqual(screenToLogical({ x: 100, y: 100 }, start));
  });

  test('converts client coordinates through the CSS rectangle once at high DPR', () => {
    const viewport: Viewport = { scale: 4, offsetX: -20, offsetY: 12 };
    const point = screenToLogical({ x: 230 - 100, y: 160 - 50 }, viewport);
    expect(point).toEqual({ x: 37.5, y: 24.5 });
  });
});
