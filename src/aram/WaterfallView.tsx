import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Snapshot } from '../audio/protocol';
import type { VisualStream } from '../audio/visualStream';
import type { MemoryHistory } from './history';
import { formatAddress } from './mapping';
import type { PalettePreset } from './palettes';
import { isActivityMode, isBitMode, isEntropyMode, isXorMode, type AramMode, type WaterfallSeconds } from './types';
import type { DrawStats, MemoryViewHandle } from './viewTypes';
import { WaterfallRenderer } from './waterfallRenderer';
import { columnRange, fitWindow, oneToOneWindow, panWindow, plotColumns, resizeWindow, zoomWindow, type AddressWindow } from './waterfallViewport';

export type WaterfallInfo = { columns: number; window: AddressWindow; retainedSeconds: number; cacheBytes: number; payloadBytes: number; error: string };
type Props = { active: boolean; mode: AramMode; activityByteBackground: boolean; seconds: WaterfallSeconds; palette: PalettePreset; stream: VisualStream; generation: number; history: MemoryHistory; displayHz: number | null; onStats(stats: DrawStats): void; onInfo(info: WaterfallInfo): void };
export const WaterfallView = forwardRef<MemoryViewHandle, Props>(function WaterfallView({ active, mode, activityByteBackground, seconds, palette, stream, generation, history, displayHz, onStats, onInfo }, ref) {
  const plot = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const backing = useRef<HTMLCanvasElement | null>(null), renderer = useRef<WaterfallRenderer | null>(null);
  const job = useRef(0), inspector = useRef<HTMLDivElement>(null), crosshair = useRef<HTMLDivElement>(null), empty = useRef<HTMLDivElement>(null);
  const selected = useRef<{ pixel: number; band: number; recordId: number | null } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [window, setWindow] = useState<AddressWindow>(fitWindow), [fit, setFit] = useState(true);
  const points = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ window: AddressWindow; x: number; midpoint?: number; distance?: number; moved: boolean } | null>(null);
  const stats = useRef({ count: 0, total: 0, max: 0, since: performance.now() });
  const oldColumns = useRef(0);
  const pixelsPerBucket = isBitMode(mode) ? 8 : 1;
  const columns = plotColumns(size.width / pixelsPerBucket), width = columns * pixelsPerBucket;
  const height = Math.max(1, Math.floor(size.height));
  const updateInfo = () => {
    let oldestFrame: number | null = null;
    for (const record of history.records()) { oldestFrame = record.intervalStartFrame ?? record.audibleFrame; break; }
    const latest = history.latest();
    onInfo({ columns, window, retainedSeconds: latest && oldestFrame !== null ? (latest.audibleFrame - oldestFrame) / 32000 : 0, cacheBytes: renderer.current?.cache.bytes ?? 0, payloadBytes: history.payloadBytes, error: history.error });
  };
  useEffect(() => {
    const element = plot.current; if (!active || !element) return;
    const cancelScroll = (event: WheelEvent) => event.preventDefault();
    element.addEventListener('wheel', cancelScroll, { passive: false });
    return () => element.removeEventListener('wheel', cancelScroll);
  }, [active]);
  useEffect(() => {
    if (!active || !plot.current) return;
    const element = plot.current;
    const measure = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      const width = plotColumns(element.clientWidth);
      const nextColumns = plotColumns(width / pixelsPerBucket);
      const previousColumns = oldColumns.current;
      setSize({ width, height: Math.floor(element.clientHeight) });
      setWindow(current => fit ? fitWindow() : previousColumns ? resizeWindow(current, previousColumns, nextColumns) : current);
      oldColumns.current = nextColumns;
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [active, fit, pixelsPerBucket]);
  useImperativeHandle(ref, () => ({
    zoom: factor => { setFit(false); setWindow(current => zoomWindow(current, columns, factor, 0.5)); },
    fit: () => { setFit(true); setWindow(fitWindow()); },
    oneToOne: () => { setFit(false); setWindow(current => oneToOneWindow(current, columns)); },
  }));
  useEffect(() => {
    // A resize or mode change can increase the bucket count before its window
    // adjustment commits. Wait for that adjustment instead of drawing empty buckets.
    if (!active || !canvas.current || !size.width || !size.height || window.span < columns) return;
    if (!backing.current) { backing.current = document.createElement('canvas'); renderer.current = new WaterfallRenderer(backing.current, history); }
    const view = renderer.current!, destination = canvas.current;
    const context = destination.getContext('2d'); if (!context) return;
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    destination.width = Math.round(width * dpr); destination.height = Math.round(height * dpr);
    destination.style.width = `${width}px`; destination.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0); context.imageSmoothingEnabled = false;
    view.configure({ mode, window, columns, height, framesPerBand: seconds * 32000 / height, palette, activityByteBackground: isActivityMode(mode) && activityByteBackground });
    selected.current = null; if (crosshair.current) crosshair.current.hidden = true;
    if (inspector.current) inspector.current.textContent = 'Hover or tap to inspect an address and time interval';
    const budget = Math.min(4, 500 / (displayHz ?? 60));
    const showSelection = () => {
      const choice = selected.current;
      if (!choice || !crosshair.current || !inspector.current) return;
      if (choice.recordId !== null && !history.get(choice.recordId)) { selected.current = null; crosshair.current.hidden = true; inspector.current.textContent = 'The selected sample is no longer retained'; return; }
      const y = view.currentBand - choice.band;
      crosshair.current.hidden = y < 0 || y >= height;
      crosshair.current.style.left = `${choice.pixel}px`; crosshair.current.style.top = `${y}px`;
      // A partial band's latest values, activity union, or XOR peak can change
      // without pointer movement. Keep the reading tied to its current pixels.
      if (!crosshair.current.hidden) inspect({ x: choice.pixel, y });
    };
    const blit = () => { context.drawImage(backing.current!, 0, 0); showSelection(); if (empty.current) empty.current.hidden = history.latest() !== null; };
    const backfill = () => { job.current = 0; view.flush(budget); blit(); if (view.pendingCount) job.current = requestAnimationFrame(backfill); };
    const paint = (snapshot: Snapshot | null, live = false) => {
      if (snapshot && snapshot.generation !== generation) return;
      const started = performance.now(); view.update(); view.flush(budget); blit();
      if (snapshot && live) { const elapsed = performance.now() - started; stats.current.count++; stats.current.total += elapsed; stats.current.max = Math.max(stats.current.max, elapsed); stream.draws++; }
      if (view.pendingCount && !job.current) job.current = requestAnimationFrame(backfill);
    };
    stats.current = { count: 0, total: 0, max: 0, since: performance.now() };
    paint(stream.latest?.generation === generation ? stream.latest : null); updateInfo();
    const off = stream.subscribe(next => paint(next, true));
    const timer = globalThis.setInterval(() => {
      const now = performance.now(), measurements = stats.current;
      onStats({ rate: Math.round(measurements.count * 1000 / Math.max(1, now - measurements.since)), averageMs: measurements.count ? measurements.total / measurements.count : 0, maxMs: measurements.max });
      stats.current = { count: 0, total: 0, max: 0, since: now }; updateInfo();
    }, 1000);
    return () => { off(); clearInterval(timer); if (job.current) cancelAnimationFrame(job.current); job.current = 0; };
  }, [active, mode, activityByteBackground, seconds, palette, stream, generation, history, columns, width, height, size.width, size.height, window, displayHz, onStats, onInfo]);
  const localPoint = (event: React.PointerEvent<HTMLDivElement>) => { const rect = event.currentTarget.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const inspect = (point: { x: number; y: number }) => {
    const view = renderer.current; if (!view || !inspector.current || !crosshair.current || !view.config) return;
    const x = Math.max(0, Math.min(width - 1, Math.floor(point.x))), y = Math.max(0, Math.min(height - 1, Math.floor(point.y)));
    const result = view.inspect(x, y); if (!result) return;
    const [a, b] = columnRange(window, columns, result.column);
    const address = b - a === 1 ? formatAddress(a) : `${formatAddress(a)}–${formatAddress(b - 1)} (${b - a} bytes)`;
    const time = `${Math.max(0, result.startFrame / 32000).toFixed(3)}–${Math.max(0, result.endFrame / 32000).toFixed(3)} s`;
    let value = !result.row.valid ? isXorMode(mode) && result.recordId !== null ? 'Baseline unavailable' : 'No retained sample' :
      mode === 'bytes' || mode === 'xor' ? `${mode === 'xor' ? 'XOR ' : ''}${b - a === 1 ? `$${Math.round(result.value).toString(16).toUpperCase().padStart(2, '0')}` : `Mean ${result.value.toFixed(2)}`}` :
      mode === 'bits' || mode === 'xor-bits' ? `Bit ${7 - result.lane}: ${(result.value * 100).toFixed(1)}% ${mode === 'xor-bits' ? 'changed' : 'set'}` :
      mode === 'entropy-bits' ? `Bit ${7 - result.lane}: ${result.value.toFixed(3)} bits · 256-byte windows` :
      mode === 'entropy' ? `${result.value.toFixed(3)} bits/byte · 256-byte windows` :
      [result.value & 1 ? 'Read' : '', result.value & 2 ? 'Write' : '', result.value & 4 ? 'Execute' : ''].filter(Boolean).join(' + ') || 'No access';
    if (isEntropyMode(mode) && b - a === 1) value += ` · ${formatAddress(a & 0xff00)}–${formatAddress((a & 0xff00) + 255)}`;
    if (result.row.valid && result.byteValue !== undefined) value += b - a === 1 ? ` · $${Math.round(result.byteValue).toString(16).toUpperCase().padStart(2, '0')}` : ` · Mean ${result.byteValue.toFixed(2)}`;
    if (result.row.valid && mode === 'activity-bits') value += result.row.bitValues
      ? ` · Bit ${7 - result.lane}: ${(result.row.bitValues[result.lane * columns + result.column] * 100).toFixed(1)}% set`
      : ` · Bit ${7 - result.lane} (address access)`;
    inspector.current.textContent = `${address} · ${time} · ${value}`;
    selected.current = { pixel: x, band: result.band, recordId: result.recordId };
    crosshair.current.hidden = false; crosshair.current.style.left = `${x}px`; crosshair.current.style.top = `${y}px`;
  };
  const finish = (event: React.PointerEvent<HTMLDivElement>, canceled = false) => {
    if (!canceled && gesture.current && !gesture.current.moved) inspect(localPoint(event));
    points.current.delete(event.pointerId);
    if (points.current.size === 1) { const remaining = [...points.current.values()][0]; gesture.current = { window, x: remaining.x, moved: true }; } else gesture.current = null;
  };
  return <div className="aram-stage waterfall-stage" hidden={!active}>
    <div className="waterfall-address-ruler" aria-hidden="true">{[0, 0.25, 0.5, 0.75, 1].map(u => <span key={u} style={{ left: `${u * width}px` }}>{formatAddress(Math.min(65535, window.start + Math.floor(u * window.span)))}</span>)}</div>
    <div className="waterfall-time-ruler" aria-hidden="true">{[0, 0.25, 0.5, 0.75, 1].map(u => <span key={u} style={{ top: `${u * 100}%` }}>−{(u * seconds).toFixed(1)}s</span>)}</div>
    <div ref={plot} className="waterfall-plot" tabIndex={0} aria-label="Zoomable ARAM waterfall"
      onDoubleClick={() => { setFit(true); setWindow(fitWindow()); }}
      onWheel={event => { const rect = event.currentTarget.getBoundingClientRect(); setFit(false); setWindow(current => zoomWindow(current, columns, Math.exp(-event.deltaY * 0.0015), (event.clientX - rect.left) / Math.max(1, width))); }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); const p = localPoint(event); points.current.set(event.pointerId, p); gesture.current = { window, x: p.x, moved: false }; if (points.current.size === 2) { const [a, b] = [...points.current.values()]; gesture.current = { window, x: p.x, midpoint: (a.x + b.x) / 2, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), moved: true }; } }}
      onPointerMove={event => {
        const p = localPoint(event); if (!points.current.has(event.pointerId) || !gesture.current) { if (event.pointerType !== 'touch') inspect(p); return; }
        points.current.set(event.pointerId, p); const g = gesture.current;
        if (points.current.size === 2 && g.distance && g.midpoint !== undefined) {
          const [a, b] = [...points.current.values()]; const midpoint = (a.x + b.x) / 2;
          const next = zoomWindow(g.window, columns, Math.hypot(a.x - b.x, a.y - b.y) / g.distance, g.midpoint / width);
          setFit(false); setWindow(panWindow(next, (g.midpoint - midpoint) * next.span / width));
        } else if (Math.abs(p.x - g.x) > 4 || g.moved) { g.moved = true; setFit(false); setWindow(panWindow(g.window, -(p.x - g.x) * g.window.span / width)); }
      }}
      onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
      onKeyDown={event => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); setFit(false); setWindow(current => panWindow(current, current.span * (event.shiftKey ? 0.5 : 0.1) * (event.key === 'ArrowLeft' ? -1 : 1))); }}>
      <canvas ref={canvas} data-columns={columns} data-pixels-per-bucket={pixelsPerBucket} data-start={window.start} data-span={window.span} />
      <div ref={crosshair} className="waterfall-crosshair" hidden />
      <div ref={empty} className="map-empty">Choose an SPC file to begin</div>
    </div>
    <div ref={inspector} className="waterfall-inspector" aria-live="polite">Hover or tap to inspect an address and time interval</div>
  </div>;
});
