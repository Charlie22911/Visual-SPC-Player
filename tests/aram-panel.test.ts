import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AramPanel } from '../src/aram/AramPanel';
import { MemoryHistory } from '../src/aram/history';
import { VisualStream } from '../src/audio/visualStream';
import { PresentationQueue } from '../src/audio/presentationQueue';
import { makeSnapshot } from './helpers/snapshots';
let container: HTMLDivElement, root: Root;
let paints: ReturnType<typeof vi.fn>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(512);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(256);
  paints = vi.fn();
  const contexts = new WeakMap<HTMLCanvasElement, object>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    if (!contexts.has(this)) contexts.set(this, { createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData: paints, drawImage: paints, clearRect: vi.fn(), fillRect: vi.fn(), setTransform: vi.fn(), imageSmoothingEnabled: false });
    return contexts.get(this) as CanvasRenderingContext2D;
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const setup = () => {
  const history = new MemoryHistory(10); history.reset(1); const stream = new VisualStream();
  return { mode: 'activity' as const, activityUnit: 'byte' as const, onActivityUnitChange: vi.fn(), dataUnit: 'byte' as const, dataXor: false, entropyUnit: 'byte' as const, onDataUnitChange: vi.fn(), onDataXorChange: vi.fn(), onEntropyUnitChange: vi.fn(), geometry: 'map' as const, onModeChange: vi.fn(), onGeometryChange: vi.fn(), waterfallSeconds: 5 as const, onWaterfallSecondsChange: vi.fn(), activityByteBackground: false, onActivityByteBackgroundChange: vi.fn(), history, stream, generation: 1, snapshot: null, playing: true, palette: 'grayscale' as const, activityPersistence: false, activityPersistenceMilliseconds: 100, refreshRate: 60 as const, displayHz: 60 };
};
test('activity toggle is available in both geometries and recolors a paused sample immediately', () => {
  const props = setup();
  const next = makeSnapshot(1, { ram: r => r.fill(255) }); props.history.accept(next, 0); props.stream.publish(next);
  act(() => root.render(createElement(AramPanel, props)));
  const input = container.querySelector('input[aria-label="Show bytes underneath"]') as HTMLInputElement;
  expect(input).not.toBeNull(); act(() => input.click()); expect(props.onActivityByteBackgroundChange).toHaveBeenCalledWith(true);
  act(() => root.render(createElement(AramPanel, { ...props, activityByteBackground: true, playing: false })));
  const lastImage = paints.mock.calls.filter(call => call[0]?.data?.length === 256 * 256 * 4).at(-1)![0];
  expect([...lastImage.data.subarray(0, 4)]).toEqual([89, 89, 89, 255]);
  act(() => root.render(createElement(AramPanel, { ...props, geometry: 'waterfall', activityByteBackground: true })));
  expect((container.querySelector('input[aria-label="Show bytes underneath"]') as HTMLInputElement).checked).toBe(true);
  act(() => root.render(createElement(AramPanel, { ...props, mode: 'data', dataUnit: 'byte' })));
  expect(container.querySelector('input[aria-label="Show bytes underneath"]')).toBeNull();
});
test.each(['byte', 'bit'] as const)('Map preserves all interval accesses with %s data underneath without carrying trails into the next interval', activityUnit => {
  const props = { ...setup(), activityUnit, activityPersistence: true };
  const queue = new PresentationQueue();
  queue.enqueue(makeSnapshot(1, { frame: 0, activity: r => { r[0] = 1; } }), 0);
  queue.enqueue(makeSnapshot(2, { frame: 128, ram: r => r.fill(255) }), 4);
  const next = queue.take(100)!; props.history.accept(next, 0); props.stream.publish(next);
  const color = () => [...paints.mock.calls.filter(call => call[0]?.width === (activityUnit === 'bit' ? 1024 : 256) && call[0]?.height === (activityUnit === 'bit' ? 512 : 256)).at(-1)![0].data.subarray(0, 4)];
  act(() => root.render(createElement(AramPanel, props)));
  expect(color()).toEqual([42, 168, 255, 255]);
  act(() => root.render(createElement(AramPanel, { ...props, activityByteBackground: true })));
  expect(color()).toEqual([46, 162, 242, 255]);
  // No React commit: every new publication must pair its own flags and bytes.
  for (let i = 3; i < 10; i++) {
    const sample = makeSnapshot(i, { frame: i * 128, ram: r => r.fill(i & 1 ? 255 : 0) });
    props.history.accept(sample, 0); props.stream.publish(sample);
    expect(color()).toEqual(i & 1 ? [89, 89, 89, 255] : [0, 0, 0, 255]);
  }
});
test('Waterfall inspector and paused recoloring preserve the entire displayed access interval with its ending bytes', () => {
  const props = { ...setup(), geometry: 'waterfall' as const, activityByteBackground: true, playing: false };
  props.history.accept(makeSnapshot(1, { frame: 0 }), 0);
  const next = makeSnapshot(2, { frame: 100, ram: r => r.fill(100), activity: (_, w) => w.fill(255) });
  next.combinedActivity = new Uint8Array(24576); next.combinedActivity.fill(255);
  props.history.accept(next, 0); props.stream.publish(next);
  act(() => root.render(createElement(AramPanel, props)));
  act(() => container.querySelector('.waterfall-plot')!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1, clientY: 0 })));
  expect(container.querySelector('.waterfall-inspector')!.textContent).toContain('Read + Write + Execute · Mean 100.00');
  act(() => root.render(createElement(AramPanel, { ...props, activityByteBackground: false })));
  act(() => container.querySelector('.waterfall-plot')!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1, clientY: 0 })));
  expect(container.querySelector('.waterfall-inspector')!.textContent).toContain('Read + Write + Execute');
});
test('shared toolbar offers two geometries and three measurements', () => {
  const props = setup(); act(() => root.render(createElement(AramPanel, props)));
  expect(container.querySelectorAll('[aria-label="Memory geometry"] button')).toHaveLength(2);
  expect([...container.querySelectorAll('[aria-label="Memory measurement"] option')].map(o => o.textContent)).toEqual(['Activity', 'Data', 'Entropy']);
});

test('Activity exposes a Bit representation with the matching background toggle and immediate paused tiles', () => {
  const props = { ...setup(), activityUnit: 'bit' as const, onActivityUnitChange: vi.fn(), activityByteBackground: true, playing: false };
  const next = makeSnapshot(1, { ram: r => { r.fill(1); } }); props.history.accept(next, 0); props.stream.publish(next);
  act(() => root.render(createElement(AramPanel, props)));
  const group = container.querySelector('[aria-label="Activity representation"]');
  expect(group).not.toBeNull();
  expect((container.querySelector('input[aria-label="Show bits underneath"]') as HTMLInputElement).checked).toBe(true);
  const lastImage = paints.mock.calls.filter(call => call[0]?.data?.length === 1024 * 512 * 4).at(-1)![0];
  expect([...lastImage.data.subarray((1024 + 3) * 4, (1024 + 4) * 4)]).toEqual([89, 89, 89, 255]);
  act(() => (group!.querySelector('button') as HTMLButtonElement).click());
  expect(props.onActivityUnitChange).toHaveBeenCalledWith('byte');
});

test('Map entropy clears the previous generation while waiting for a new sample', () => {
  const props = { ...setup(), mode: 'entropy' as const };
  const next = makeSnapshot(1, { ram: r => { for (let a = 0; a < 65536; a++) r[a] = a & 255; } });
  props.history.accept(next, 0); props.stream.publish(next);
  act(() => root.render(createElement(AramPanel, props)));
  const lastMapImage = () => paints.mock.calls.filter(call => call[0]?.data?.length === 256 * 256 * 4).at(-1)![0];
  expect(lastMapImage().data[0]).toBe(255);
  props.history.reset(2); props.stream.latest = null;
  act(() => root.render(createElement(AramPanel, { ...props, generation: 2 })));
  expect(lastMapImage().data[0]).toBe(0);
});
test.each(['map', 'waterfall'] as const)('%s paints every publication before a React commit', geometry => {
  const props = { ...setup(), geometry }; act(() => root.render(createElement(AramPanel, props)));
  for (let i = 1; i <= 4; i++) {
    const next = makeSnapshot(i, { frame: i * 32000 / 240 }); props.history.accept(next, 0);
    const before = paints.mock.calls.length; props.stream.publish(next); expect(paints.mock.calls.length).toBeGreaterThan(before);
  }
});

test.each(['map', 'waterfall'] as const)('%s wheel zoom consumes page scrolling without a passive-listener warning', geometry => {
  act(() => root.render(createElement(AramPanel, { ...setup(), geometry })));
  const target = container.querySelector(geometry === 'map' ? '.map-stage' : '.waterfall-plot')!;
  const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -10, clientX: 100 });
  act(() => target.dispatchEvent(wheel));
  expect(wheel.defaultPrevented).toBe(true);
});

test('selected partial-band inspection follows the same latest value as its pixels', () => {
  const props = { ...setup(), geometry: 'waterfall' as const, mode: 'data' as const, dataUnit: 'byte' as const };
  props.history.accept(makeSnapshot(1, { frame: 0 }), 0);
  const first = makeSnapshot(2, { frame: 100, ram: r => r.fill(50) });
  props.history.accept(first, 0); props.stream.publish(first);
  act(() => root.render(createElement(AramPanel, props)));
  const plot = container.querySelector('.waterfall-plot')!;
  act(() => plot.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1, clientY: 0 })));
  expect(container.querySelector('.waterfall-inspector')!.textContent).toContain('Mean 50.00');
  const next = makeSnapshot(3, { frame: 200, ram: r => r.fill(200) });
  props.history.accept(next, 0); props.stream.publish(next);
  const rowImage = paints.mock.calls.filter(call => call[0]?.width === 512 && call[0]?.height === 1).at(-1)![0];
  expect([...rowImage.data.subarray(0, 4)]).toEqual([200, 200, 200, 255]);
  expect(container.querySelector('.waterfall-inspector')!.textContent).toContain('Mean 200.00');
});
test.each([1, 2])('waterfall 1:1 uses CSS columns at DPR %i and restores both viewports', dpr => {
  vi.stubGlobal('devicePixelRatio', dpr);
  const props = setup(); act(() => root.render(createElement(AramPanel, props)));
  act(() => (container.querySelector('.zoom-controls button:nth-child(3)') as HTMLButtonElement).click());
  const mapTransform = container.querySelector('.map-stage canvas')!.getAttribute('style');
  act(() => root.render(createElement(AramPanel, { ...props, geometry: 'waterfall' })));
  act(() => (container.querySelector('.zoom-controls button:nth-child(3)') as HTMLButtonElement).click());
  const c = container.querySelector('.waterfall-plot canvas') as HTMLCanvasElement;
  expect(c.dataset.span).toBe('512'); expect(c.width).toBe(512 * dpr);
  act(() => root.render(createElement(AramPanel, props)));
  expect(container.querySelector('.map-stage canvas')!.getAttribute('style')).toBe(mapTransform);
  act(() => root.render(createElement(AramPanel, { ...props, geometry: 'waterfall', mode: 'entropy', playing: false })));
  expect(c.dataset.span).toBe('512');
  const before = paints.mock.calls.length;
  act(() => root.render(createElement(AramPanel, { ...props, geometry: 'waterfall', mode: 'entropy', playing: false, palette: 'original' })));
  expect(paints.mock.calls.length).toBeGreaterThan(before);
});

test.each([1, 2])('Bits waterfall 1:1 resolves horizontal bits at DPR %i with the full time resolution', dpr => {
  vi.stubGlobal('devicePixelRatio', dpr);
  const props = { ...setup(), geometry: 'waterfall' as const, mode: 'data' as const, dataUnit: 'bit' as const };
  props.history.accept(makeSnapshot(1, { frame: 0 }), 0);
  const next = makeSnapshot(2, { frame: 1000, ram: r => r.fill(0x81) });
  props.history.accept(next, 0); props.stream.publish(next);
  act(() => root.render(createElement(AramPanel, props)));
  act(() => (container.querySelector('.zoom-controls button:nth-child(3)') as HTMLButtonElement).click());
  const c = container.querySelector('.waterfall-plot canvas') as HTMLCanvasElement;
  expect(c.dataset.span).toBe('64'); expect(c.dataset.columns).toBe('64');
  expect(c.width).toBe(512 * dpr); expect(c.height).toBe(256 * dpr);
  const plot = container.querySelector('.waterfall-plot')!;
  const inspect = (x: number, y: number) => {
    act(() => plot.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y })));
    return container.querySelector('.waterfall-inspector')!.textContent;
  };
  expect(inspect(0, 0)).toContain('$7FE0 · 0.020–0.039 s · Bit 7: 100.0% set');
  expect(inspect(7, 0)).toContain('$7FE0 · 0.020–0.039 s · Bit 0: 100.0% set');
  expect(inspect(8, 0)).toContain('$7FE1 · 0.020–0.039 s · Bit 7: 100.0% set');
  expect(inspect(7, 1)).toContain('$7FE0 · 0.000–0.020 s · Bit 0: 100.0% set');
  act(() => root.render(createElement(AramPanel, { ...props, mode: 'data', dataUnit: 'byte' })));
  expect(c.dataset.span).toBe('512'); expect(c.dataset.columns).toBe('512');
  act(() => root.render(createElement(AramPanel, props)));
  expect(c.dataset.span).toBe('64'); expect(c.dataset.columns).toBe('64');
});

test('Data controls show actual XOR bits while leaving representation and frame cadence independent', () => {
  const props = { ...setup(), mode: 'data' as const, dataUnit: 'bit' as const };
  props.history.accept(makeSnapshot(1, { ram: r => r.fill(0x80) }), 0);
  const next = makeSnapshot(2, { ram: r => r.fill(0x8f) }); props.history.accept(next, 0); props.stream.publish(next);
  act(() => root.render(createElement(AramPanel, props)));
  const last = () => paints.mock.calls.filter(call => call[0]?.width === 1024 && call[0]?.height === 512).at(-1)![0].data as Uint8ClampedArray;
  expect(last()[0]).toBe(255); // Bit 7 is set in RAM.
  act(() => (container.querySelector('[aria-label="XOR changes only"]') as HTMLInputElement).click());
  expect(props.onDataXorChange).toHaveBeenCalledWith(true);
  act(() => root.render(createElement(AramPanel, { ...props, dataXor: true })));
  expect(last()[0]).toBe(0); expect(last()[1024 * 4]).toBe(255); // Only low bits changed.
  act(() => (container.querySelector('[aria-label="Data representation"] button') as HTMLButtonElement).click());
  expect(props.onDataUnitChange).toHaveBeenCalledWith('byte');
});

test('Map entropy bit lanes and numeric readings distinguish fixed and varying bit positions', () => {
  const props = { ...setup(), mode: 'entropy' as const, entropyUnit: 'bit' as const };
  const next = makeSnapshot(1, { ram: r => { for (let a = 0; a < 65536; a++) r[a] = a & 1; } });
  props.history.accept(next, 0); props.stream.publish(next);
  act(() => root.render(createElement(AramPanel, props)));
  const image = paints.mock.calls.filter(call => call[0]?.width === 1024 && call[0]?.height === 512).at(-1)![0];
  expect(image.data[0]).toBe(0); expect(image.data[(1024 + 3) * 4]).toBe(255);
  const plot = container.querySelector('.map-stage')!;
  act(() => plot.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1.8, clientY: .8 })));
  expect(container.querySelector('.map-metric-inspector')!.textContent).toContain('$0000 · Bit 0 · 1.000 bits · $0000–$00FF');
  act(() => root.render(createElement(AramPanel, { ...props, entropyUnit: 'byte' })));
  act(() => plot.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 128, clientY: 0 })));
  expect(container.querySelector('.map-metric-inspector')!.textContent).toContain('1.000 bits/byte');
});
