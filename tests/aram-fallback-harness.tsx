import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MapView } from '../src/aram/MapView';
import { MemoryHistory } from '../src/aram/history';
import { WaterfallRenderer } from '../src/aram/waterfallRenderer';
import { WaterfallView } from '../src/aram/WaterfallView';
import { VisualStream } from '../src/audio/visualStream';
import { makeSnapshot } from './helpers/snapshots';

export async function fallbackPixels(failure: 'shader' | 'link') {
  const claimed = new WeakSet<HTMLCanvasElement>();
  const getContext = HTMLCanvasElement.prototype.getContext;
  const shaderParameter = WebGL2RenderingContext.prototype.getShaderParameter;
  const programParameter = WebGL2RenderingContext.prototype.getProgramParameter;
  const canvasPrototype = HTMLCanvasElement.prototype as unknown as { getContext: (this: HTMLCanvasElement, kind: string, options?: object) => RenderingContext | null };
  canvasPrototype.getContext = function (kind, options) {
    const result = getContext.call(this, kind as '2d', options);
    if (kind === 'webgl2' && result) claimed.add(this);
    return result;
  };
  if (failure === 'shader') WebGL2RenderingContext.prototype.getShaderParameter = function (shader, parameter) { return parameter === this.COMPILE_STATUS ? false : shaderParameter.call(this, shader, parameter); };
  else WebGL2RenderingContext.prototype.getProgramParameter = function (program, parameter) { return parameter === this.LINK_STATUS ? false : programParameter.call(this, program, parameter); };
  const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:256px'; document.body.append(host);
  const root = createRoot(host);
  try {
    const history = new MemoryHistory(); history.reset(1);
    const stream = new VisualStream(), snapshot = makeSnapshot(1, { frame: 0, ram: ram => ram.fill(255) });
    history.accept(snapshot, 0); stream.publish(snapshot);
    flushSync(() => root.render(createElement(MapView, { active: true, memoryHistory: history, onStats: () => {}, mode: 'bytes', snapshot, stream, generation: 1, palette: 'grayscale', activityByteBackground: false, activityPersistence: false, activityPersistenceMilliseconds: 100, refreshRate: 60, displayHz: 60 })));
    // A remount is a React update scheduled by the failed initialization effect.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const canvas = host.querySelector('canvas')!;
    const context = canvas.getContext('2d');
    const map = { fresh: !claimed.has(canvas), pixel: context ? [...context.getImageData(0, 0, 1, 1).data] : null };
    history.accept(makeSnapshot(2, { frame: 100, ram: ram => ram.fill(200) }), 0);
    const original = document.createElement('canvas'), waterfall = new WaterfallRenderer(original, history, true);
    waterfall.configure({ mode: 'bytes', palette: 'grayscale', columns: 2, height: 4, framesPerBand: 100, window: { start: 0, span: 2 } }); waterfall.update(); waterfall.flush(Infinity);
    const waterfallContext = waterfall.canvas.getContext('2d');
    const result = { failure, map, waterfall: { fresh: !claimed.has(waterfall.canvas), pixel: waterfallContext ? [...waterfallContext.getImageData(0, 1, 1, 1).data] : null } };
    waterfall.dispose();
    flushSync(() => root.render(createElement(WaterfallView, { active: true, mode: 'bytes', activityByteBackground: false, seconds: 5, palette: 'grayscale', stream, generation: 1, history, displayHz: 60, onStats: () => {}, onInfo: () => {} })));
    // ResizeObserver sizes the plot before the failed initialization schedules
    // the fresh-canvas commit. Observe the resulting backend, not a fixed delay.
    for (let frame = 0; frame < 60 && host.querySelector('canvas')?.dataset.renderer !== 'canvas2d'; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    const visible = host.querySelector('canvas')!, visibleContext = visible.getContext('2d');
    return { ...result, visibleWaterfall: { fresh: !claimed.has(visible), pixel: visibleContext ? [...visibleContext.getImageData(0, 0, 1, 1).data] : null } };
  } finally {
    flushSync(() => root.unmount()); host.remove();
    HTMLCanvasElement.prototype.getContext = getContext;
    WebGL2RenderingContext.prototype.getShaderParameter = shaderParameter;
    WebGL2RenderingContext.prototype.getProgramParameter = programParameter;
  }
}
