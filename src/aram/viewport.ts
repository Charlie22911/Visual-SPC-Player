import type { Point } from './mapping';

export type Viewport = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export const fitScale = (
  containerWidth: number,
  containerHeight: number,
  logicalWidth: number,
  logicalHeight: number,
) => Math.min(containerWidth / logicalWidth, containerHeight / logicalHeight);

export const screenToLogical = (point: Point, viewport: Viewport): Point => ({
  x: (point.x - viewport.offsetX) / viewport.scale,
  y: (point.y - viewport.offsetY) / viewport.scale,
});

export const zoomAt = (
  viewport: Viewport,
  factor: number,
  anchor: Point,
  minimum: number,
  maximum: number,
): Viewport => {
  const logical = screenToLogical(anchor, viewport);
  const scale = Math.min(maximum, Math.max(minimum, viewport.scale * factor));
  return {
    scale,
    offsetX: anchor.x - logical.x * scale,
    offsetY: anchor.y - logical.y * scale,
  };
};

export const centerLogicalPoint = (
  viewport: Viewport,
  logical: Point,
  containerWidth: number,
  containerHeight: number,
): Viewport => ({
  ...viewport,
  offsetX: containerWidth / 2 - logical.x * viewport.scale,
  offsetY: containerHeight / 2 - logical.y * viewport.scale,
});

export const pinchViewport = (
  startViewport: Viewport,
  startMidpoint: Point,
  currentMidpoint: Point,
  factor: number,
  minimum: number,
  maximum: number,
): Viewport => {
  const logicalAnchor = screenToLogical(startMidpoint, startViewport);
  const scale = Math.min(maximum, Math.max(minimum, startViewport.scale * factor));
  return {
    scale,
    offsetX: currentMidpoint.x - logicalAnchor.x * scale,
    offsetY: currentMidpoint.y - logicalAnchor.y * scale,
  };
};

export const centeredViewport = (
  containerWidth: number,
  containerHeight: number,
  logicalWidth: number,
  logicalHeight: number,
  scale = fitScale(containerWidth, containerHeight, logicalWidth, logicalHeight),
): Viewport => ({
  scale,
  offsetX: (containerWidth - logicalWidth * scale) / 2,
  offsetY: (containerHeight - logicalHeight * scale) / 2,
});
