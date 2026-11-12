import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MemoryHistory } from './history';
import { blockEntropies, blockBitEntropies } from './metrics';
import { isActivityMode, isBitMode, isEntropyMode, isXorMode, type MemorySampling } from './types';
import { NumericGpu } from './numericGpu';
import { numericMapSource, renderSampledMap, summarizeMapFootprint } from './mapSampling';
import { formatAddress } from './mapping';
import type { MemoryViewHandle, DrawStats } from './viewTypes';
import type { VisualStream } from '../audio/visualStream';
import { ARAM_BYTES, type Snapshot } from '../audio/protocol';
import { ActivityHistory, renderAram, type AramMode } from './renderer';
import { type PalettePreset } from './palettes';
import { centeredViewport, pinchViewport, zoomAt, type Viewport } from './viewport';
import type { VisualizerRate } from '../settings';

type Props = {
  active: boolean;
  memoryHistory: MemoryHistory;
  onStats(stats: DrawStats): void;
  mode: AramMode;
  snapshot: Snapshot | null;
  stream: VisualStream;
  generation: number;
  palette: PalettePreset;
  activityByteBackground: boolean;
  activityPersistence: boolean;
  activityPersistenceMilliseconds: number;
  refreshRate: VisualizerRate;
  displayHz: number | null;
  mapSampling?: MemorySampling;
  inspectorTarget?: HTMLElement | null;
};

const dimensions = (mode: AramMode) => isBitMode(mode)
  ? { width: 1024, height: 512 }
  : { width: 256, height: 256 };

export const MapView = forwardRef<MemoryViewHandle, Props>(function MapView({
  active, memoryHistory, onStats,
  mode,
  snapshot,
  stream,
  generation,
  palette,
  activityByteBackground,
  activityPersistence,
  activityPersistenceMilliseconds,
  refreshRate,
  displayHz,
  mapSampling = 'nearest',
  inspectorTarget,
}: Props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const history = useMemo(
    () => new ActivityHistory(activityPersistenceMilliseconds),
    [activityPersistenceMilliseconds],
  );
  const renderImage = useRef<ImageData | null>(null);
  const gpu = useRef<NumericGpu | null | undefined>(undefined);
  const [canvasFallback, setCanvasFallback] = useState(false);
  const redraw = useRef<(() => void) | null>(null);
  const view = useRef<Viewport>({ scale: 1, offsetX: 0, offsetY: 0 });
  const held = useRef(new Uint8Array(ARAM_BYTES));
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const drawMeasurements = useRef({ count: 0, totalMs: 0, maxMs: 0, since: 0 });
  const xor = useRef(new Uint8Array(ARAM_BYTES));
  const entropy = useRef(new Float32Array(2048));
  const entropyId = useRef({ id: -1, mode: '' });
  const inspector = useRef<HTMLDivElement>(null);
  const selected = useRef<{ address: number; lane: number } | null>(null);
  const hoverPoint = useRef<{ x: number; y: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ start: { x: number; y: number }; viewport: Viewport; distance?: number; midpoint?: { x: number; y: number }; moved: boolean } | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [fit, setFit] = useState(true);
  view.current = viewport;

  const logical = dimensions(mode);
  const showEntropy = () => {
    if (!inspector.current || !selected.current) return;
    const record = memoryHistory.latest();
    if (!record) { inspector.current.textContent = 'No retained sample'; return; }
    const { address, lane } = selected.current;
    if (mapSampling === 'area' && hoverPoint.current) {
      const dpr = Math.max(1, globalThis.devicePixelRatio || 1), v = view.current, step = 1 / (v.scale * dpr);
      const lx = (Math.floor(hoverPoint.current.x * dpr) / dpr - v.offsetX) / v.scale, ly = (Math.floor(hoverPoint.current.y * dpr) / dpr - v.offsetY) / v.scale;
      const source = numericMapSource(mode, isXorMode(mode) ? xor.current : record.payload, record.combinedActivity, held.current, entropy.current);
      const area = summarizeMapFootprint(source, isBitMode(mode), lx, ly, lx + step, ly + step);
      const kinds = isActivityMode(mode) && activityPersistence && !activityByteBackground ? area.held : area.kind;
      const accesses = [kinds & 1 ? 'Read' : '', kinds & 2 ? 'Write' : '', kinds & 4 ? 'Execute' : ''].filter(Boolean).join(' + ') || 'No access';
      const reading = isXorMode(mode) && !memoryHistory.previous(record) ? 'Baseline unavailable' : isEntropyMode(mode) ? `${area.value.toFixed(3)} ${isBitMode(mode) ? 'bits' : 'bits/byte'}` : isBitMode(mode) ? `${(area.value * 100).toFixed(1)}% ${isXorMode(mode) ? 'changed' : 'set'}` : `Mean ${area.value.toFixed(2)}`;
      inspector.current.textContent = `${formatAddress(area.first)}–${formatAddress(area.last)} · Area ${area.cells} ${isBitMode(mode) ? 'bits' : 'cells'} / ${area.bytes} ${area.bytes === 1 ? 'byte' : 'bytes'} · ${isXorMode(mode) ? 'XOR ' : ''}${reading} · ${accesses}`;
      return;
    }
    if (!isEntropyMode(mode)) {
      const data = isXorMode(mode) ? xor.current[address] : record.payload[address];
      const i = address >>> 3, mask = 1 << (address & 7), a = record.combinedActivity;
      const kinds = isActivityMode(mode) && activityPersistence && !activityByteBackground ? history.kindAt(address, performance.now()) : (a[i] & mask ? 1 : 0) | (a[8192 + i] & mask ? 2 : 0) | (a[16384 + i] & mask ? 4 : 0);
      const access = [kinds & 1 ? 'Read' : '', kinds & 2 ? 'Write' : '', kinds & 4 ? 'Execute' : ''].filter(Boolean).join(' + ') || 'No access';
      const reading = isXorMode(mode) && !memoryHistory.previous(record) ? 'Baseline unavailable' : `${isXorMode(mode) ? 'XOR ' : ''}$${data.toString(16).toUpperCase().padStart(2, '0')}${isBitMode(mode) ? ` · Bit ${7 - lane}: ${(data >>> (7 - lane)) & 1}` : ''}`;
      inspector.current.textContent = `${formatAddress(address)} · ${reading} · ${access}`;
      return;
    }
    const value = entropy.current[(mode === 'entropy-bits' ? lane * 256 : 0) + (address >>> 8)];
    inspector.current.textContent = `${formatAddress(address)} · ${mode === 'entropy-bits' ? `Bit ${7 - lane} · ${value.toFixed(3)} bits` : `${value.toFixed(3)} bits/byte`} · ${formatAddress(address & 0xff00)}–${formatAddress((address & 0xff00) + 255)} (256-byte block)`;
  };
  const inspectEntropy = (point: { x: number; y: number }) => {
    if (!inspector.current) return;
    hoverPoint.current = point;
    const x = Math.floor((point.x - viewport.offsetX) / viewport.scale), y = Math.floor((point.y - viewport.offsetY) / viewport.scale);
    if (x < 0 || y < 0 || x >= logical.width || y >= logical.height) { selected.current = null; inspector.current.textContent = 'Hover or tap a memory cell to inspect it'; return; }
    selected.current = isBitMode(mode) ? { address: (y >>> 1) * 256 + (x >>> 2), lane: (y & 1) * 4 + (x & 3) } : { address: y * 256 + x, lane: 0 };
    showEntropy();
  };
  useEffect(() => {
    const stage = stageRef.current; if (!active || !stage) return;
    // React delegates wheel events passively. Cancel browser scrolling through
    // a native listener while the React handler updates the viewport.
    const cancelScroll = (event: WheelEvent) => event.preventDefault();
    stage.addEventListener('wheel', cancelScroll, { passive: false });
    return () => stage.removeEventListener('wheel', cancelScroll);
  }, [active]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const applyFit = () => {
      if (!active || !stage.clientWidth || !stage.clientHeight) return;
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
      if (!fit) return;
      setViewport(centeredViewport(
        stage.clientWidth,
        stage.clientHeight,
        logical.width,
        logical.height,
      ));
    };
    applyFit();
    const observer = new ResizeObserver(applyFit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [active, fit, logical.height, logical.width]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (gpu.current === undefined) gpu.current = canvasFallback ? null : NumericGpu.create(canvas, false);
    const graphics = gpu.current, context = graphics ? null : canvas.getContext('2d');
    if (!graphics && !context) {
      if (!canvasFallback) {
        // A shader/link failure can leave this canvas owned by WebGL. Canvas
        // context types cannot be changed; remount once with a fresh 2D canvas.
        gpu.current = undefined; setCanvasFallback(true);
      }
      return;
    }
    canvas.dataset.renderer = graphics ? 'webgl2' : 'canvas2d';
    const { width, height } = dimensions(mode);
    if (!graphics && mapSampling === 'nearest') { if (canvas.width !== width) canvas.width = width; if (canvas.height !== height) canvas.height = height; }
    if (renderImage.current?.width !== width || renderImage.current?.height !== height) {
      if (context) renderImage.current = context.createImageData(width, height);
    }
    history.clear();
    drawMeasurements.current = { count: 0, totalMs: 0, maxMs: 0, since: performance.now() };
    const blank = new Uint8Array(ARAM_BYTES);
    let lastApplied: Snapshot | null = null;
    const draw = (next: Snapshot | null, live = false) => {
      if (next && next.generation !== generation) return;
      const started = performance.now();
      canvas.dataset.viewScale = String(view.current.scale);
      canvas.dataset.offsetX = String(view.current.offsetX);
      canvas.dataset.offsetY = String(view.current.offsetY);
      const payload = next?.payload ?? null;
      const paired = isActivityMode(mode) && activityByteBackground;
      const access = payload ? next?.combinedActivity ?? new Uint8Array(payload, ARAM_BYTES, 24576) : null;
      const activity = access ? {
        read: access.subarray(0, 8192),
        write: access.subarray(8192, 16384),
        execute: access.subarray(16384, 24576),
      } : null;
      const record = memoryHistory.latest();
      const previous = record ? memoryHistory.previous(record) : null;
      if (isXorMode(mode) && record && previous) for (let a = 0; a < ARAM_BYTES; a++) xor.current[a] = record.payload[a] ^ previous.payload[a];
      if (isEntropyMode(mode) && record && (entropyId.current.id !== record.id || entropyId.current.mode !== mode)) {
        if (mode === 'entropy-bits') blockBitEntropies(record.payload, entropy.current); else blockEntropies(record.payload, entropy.current);
        entropyId.current = { id: record.id, mode };
      }
      if (!record) { entropy.current.fill(0); entropyId.current = { id: -1, mode: '' }; }
      const ram = payload ? new Uint8Array(payload, 0, ARAM_BYTES) : blank;
      if (graphics || mapSampling !== 'nearest') {
        if (next !== lastApplied && activityPersistence && !paired && !isEntropyMode(mode) && !isXorMode(mode) && activity) history.apply(activity, started);
        if (activityPersistence) history.copyKinds(held.current, started); else held.current.fill(0);
        const dpr = Math.max(1, globalThis.devicePixelRatio || 1), stage = stageRef.current!;
        const w = Math.max(1, Math.round(stage.clientWidth * dpr)), h = Math.max(1, Math.round(stage.clientHeight * dpr));
        const physical = { scale: view.current.scale * dpr, offsetX: view.current.offsetX * dpr, offsetY: view.current.offsetY * dpr };
        canvas.style.transform = 'none'; canvas.style.width = `${stage.clientWidth}px`; canvas.style.height = `${stage.clientHeight}px`;
        canvas.dataset.renderer = graphics ? 'webgl2' : 'canvas2d';
        const bytes = isXorMode(mode) ? xor.current : ram, flags = access ?? new Uint8Array(24576);
        if (graphics) { graphics.uploadMap(bytes, flags, held.current, entropy.current); graphics.draw({ mode, palette, sampling: mapSampling, activityByteBackground: paired }, w, h, 0, physical, previous !== null, activityPersistence && !paired); }
        else if (context) {
          if (canvas.width !== w) canvas.width = w; if (canvas.height !== h) canvas.height = h;
          if (renderImage.current?.width !== w || renderImage.current?.height !== h) renderImage.current = context.createImageData(w, h);
          renderSampledMap(renderImage.current!, numericMapSource(mode, bytes, flags, held.current, entropy.current), mode, palette, mapSampling, physical, paired, previous !== null, activityPersistence && !paired);
          context.putImageData(renderImage.current!, 0, 0);
        }
      } else if (context) {
        canvas.style.width = ''; canvas.style.height = ''; canvas.style.transform = `translate(${view.current.offsetX}px, ${view.current.offsetY}px) scale(${view.current.scale})`;
        renderAram(mode, ram, activityPersistence && !paired ? history : null, activityPersistence && !paired && next === lastApplied ? null : activity, started, palette, renderImage.current!.data, { xor: xor.current, xorValid: previous !== null, entropy: entropy.current, activityByteBackground });
        context.putImageData(renderImage.current!, 0, 0);
      }
      lastApplied = next;
      showEntropy();
      if (payload && live) {
        stream.draws += 1;
        const elapsed = performance.now() - started;
        const measurements = drawMeasurements.current;
        measurements.count += 1;
        measurements.totalMs += elapsed;
        measurements.maxMs = Math.max(measurements.maxMs, elapsed);
      }
    };
    draw(stream.latest?.generation === generation ? stream.latest : null);
    redraw.current = () => draw(stream.latest?.generation === generation ? stream.latest : null);
    // Called directly within the shared animation callback, without a React commit.
    const off = stream.subscribe(next => draw(next, true));
    return () => { off(); redraw.current = null; };
  }, [active, mode, palette, generation, stream, activityPersistence, activityByteBackground, history, memoryHistory, mapSampling, canvasFallback]);
  useEffect(() => { if (active) redraw.current?.(); }, [active, viewport, stageSize]);
  useEffect(() => () => gpu.current?.dispose(), []);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      const now = performance.now();
      const measurements = drawMeasurements.current;
      onStats({
        rate: Math.round(measurements.count * 1000 / Math.max(1, now - measurements.since)),
        averageMs: measurements.count ? measurements.totalMs / measurements.count : 0,
        maxMs: measurements.maxMs,
      });
      drawMeasurements.current = { count: 0, totalMs: 0, maxMs: 0, since: now };
    }, 1000);
    return () => window.clearInterval(timer);
  }, [stream, active, onStats]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 1) {
      gesture.current = { start: point, viewport, moved: false };
    } else if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      gesture.current = {
        start: a,
        viewport,
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        moved: true,
      };
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (!pointers.current.has(event.pointerId) || !gesture.current) { if (event.pointerType !== 'touch') inspectEntropy(point); return; }
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2 && gesture.current.distance && gesture.current.midpoint) {
      const [a, b] = Array.from(pointers.current.values());
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      setFit(false);
      setViewport(pinchViewport(
        gesture.current.viewport,
        gesture.current.midpoint,
        midpoint,
        distance / gesture.current.distance,
        0.25,
        32,
      ));
      return;
    }
    const dx = point.x - gesture.current.start.x;
    const dy = point.y - gesture.current.start.y;
    if (Math.hypot(dx, dy) > 4) gesture.current.moved = true;
    if (gesture.current.moved) {
      setFit(false);
      setViewport({
        ...gesture.current.viewport,
        offsetX: gesture.current.viewport.offsetX + dx,
        offsetY: gesture.current.viewport.offsetY + dy,
      });
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current && !gesture.current.moved) {
      const rect = event.currentTarget.getBoundingClientRect();
      inspectEntropy({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    }
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 1) {
      const remaining = Array.from(pointers.current.values())[0];
      gesture.current = { start: remaining, viewport, moved: true };
    } else if (pointers.current.size === 0) gesture.current = null;
  };

  const cancelPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    gesture.current = null;
  };

  const setScale = (factor: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    setFit(false);
    setViewport((current) => zoomAt(
      current,
      factor,
      { x: stage.clientWidth / 2, y: stage.clientHeight / 2 },
      0.25,
      32,
    ));
  };

  useImperativeHandle(ref, () => ({
    zoom: setScale,
    fit: () => setFit(true),
    oneToOne: () => { const stage = stageRef.current; if (!stage) return; setFit(false); setViewport(centeredViewport(stage.clientWidth, stage.clientHeight, logical.width, logical.height, 1 / Math.max(1, globalThis.devicePixelRatio || 1))); },
  }));
  return (
      <div
        ref={stageRef}
        className="aram-stage map-stage"
        hidden={!active}
        onDoubleClick={() => setFit(true)}
        tabIndex={0}
        onWheel={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setFit(false);
          setViewport((current) => zoomAt(
            current,
            Math.exp(-event.deltaY * 0.0015),
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            0.25,
            32,
          ));
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelPointer}
        onLostPointerCapture={cancelPointer}
        onKeyDown={(event) => {
          const delta = event.shiftKey ? 80 : 24;
          if (event.key === 'ArrowLeft') setViewport((v) => ({ ...v, offsetX: v.offsetX + delta }));
          else if (event.key === 'ArrowRight') setViewport((v) => ({ ...v, offsetX: v.offsetX - delta }));
          else if (event.key === 'ArrowUp') setViewport((v) => ({ ...v, offsetY: v.offsetY + delta }));
          else if (event.key === 'ArrowDown') setViewport((v) => ({ ...v, offsetY: v.offsetY - delta }));
          else return;
          setFit(false);
          event.preventDefault();
        }}
        aria-label="Zoomable SPC700 memory map"
      >
        <canvas
          key={canvasFallback ? 'canvas2d' : 'gpu'}
          ref={canvasRef}
          style={{
            // GPU and sampled canvases already cover the viewport. Their zoom
            // is rendered into pixels, so React must never add a CSS zoom.
            transform: (!canvasFallback && gpu.current !== null) || mapSampling !== 'nearest'
              ? 'none'
              : 'translate(' + viewport.offsetX + 'px, ' + viewport.offsetY + 'px) scale(' + viewport.scale + ')',
          }}
        />
        {active && (() => { const detail = <div ref={inspector} className="map-metric-inspector" aria-live="polite">Hover or tap a memory cell to inspect it</div>; return inspectorTarget ? createPortal(detail, inspectorTarget) : detail; })()}
        {!snapshot && <div className="map-empty">Choose an SPC file to begin</div>}
      </div>

  );
});
