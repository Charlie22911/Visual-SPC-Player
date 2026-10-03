import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { MemoryHistory } from './history';
import { blockEntropies, blockBitEntropies } from './metrics';
import { isActivityMode, isBitMode, isEntropyMode, isXorMode } from './types';
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
}: Props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const history = useMemo(
    () => new ActivityHistory(activityPersistenceMilliseconds),
    [activityPersistenceMilliseconds],
  );
  const renderImage = useRef<ImageData | null>(null);
  const drawMeasurements = useRef({ count: 0, totalMs: 0, maxMs: 0, since: 0 });
  const xor = useRef(new Uint8Array(ARAM_BYTES));
  const entropy = useRef(new Float32Array(2048));
  const entropyId = useRef({ id: -1, mode: '' });
  const inspector = useRef<HTMLDivElement>(null);
  const selected = useRef<{ address: number; lane: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ start: { x: number; y: number }; viewport: Viewport; distance?: number; midpoint?: { x: number; y: number }; moved: boolean } | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [fit, setFit] = useState(true);

  const logical = dimensions(mode);
  const showEntropy = () => {
    if (!inspector.current || !selected.current || !isEntropyMode(mode)) return;
    if (!memoryHistory.latest()) { inspector.current.textContent = 'No retained sample'; return; }
    const { address, lane } = selected.current;
    const value = entropy.current[(mode === 'entropy-bits' ? lane * 256 : 0) + (address >>> 8)];
    inspector.current.textContent = `${formatAddress(address)} · ${mode === 'entropy-bits' ? `Bit ${7 - lane} · ${value.toFixed(3)} bits` : `${value.toFixed(3)} bits/byte`} · ${formatAddress(address & 0xff00)}–${formatAddress((address & 0xff00) + 255)} (256-byte block)`;
  };
  const inspectEntropy = (point: { x: number; y: number }) => {
    if (!isEntropyMode(mode) || !inspector.current) return;
    const x = Math.floor((point.x - viewport.offsetX) / viewport.scale), y = Math.floor((point.y - viewport.offsetY) / viewport.scale);
    if (x < 0 || y < 0 || x >= logical.width || y >= logical.height) { selected.current = null; inspector.current.textContent = 'Hover or tap a memory cell for its entropy'; return; }
    selected.current = mode === 'entropy-bits' ? { address: (y >>> 1) * 256 + (x >>> 2), lane: (y & 1) * 4 + (x & 3) } : { address: y * 256 + x, lane: 0 };
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
      if (!fit || !active || !stage.clientWidth || !stage.clientHeight) return;
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
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const { width, height } = dimensions(mode);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    if (renderImage.current?.width !== width || renderImage.current?.height !== height) {
      renderImage.current = context.createImageData(width, height);
    }
    const image = renderImage.current;
    history.clear();
    drawMeasurements.current = { count: 0, totalMs: 0, maxMs: 0, since: performance.now() };
    const blank = new Uint8Array(ARAM_BYTES);
    const draw = (next: Snapshot | null, live = false) => {
      if (next && next.generation !== generation) return;
      const started = performance.now();
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
      renderAram(mode, payload ? new Uint8Array(payload, 0, ARAM_BYTES) : blank,
        activityPersistence && !paired ? history : null, activity, started, palette, image.data, { xor: xor.current, xorValid: previous !== null, entropy: entropy.current, activityByteBackground });
      context.putImageData(image, 0, 0);
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
    // Called directly within the shared animation callback, without a React commit.
    return stream.subscribe(next => draw(next, true));
  }, [active, mode, palette, generation, stream, activityPersistence, activityByteBackground, history, memoryHistory]);

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
    oneToOne: () => { const stage = stageRef.current; if (!stage) return; setFit(false); setViewport(centeredViewport(stage.clientWidth, stage.clientHeight, logical.width, logical.height, 1)); },
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
          ref={canvasRef}
          style={{
            transform: 'translate(' + viewport.offsetX + 'px, ' + viewport.offsetY + 'px) scale(' + viewport.scale + ')',
          }}
        />
        {isEntropyMode(mode) && <div ref={inspector} className="map-metric-inspector" aria-live="polite">Hover or tap a memory cell for its entropy</div>}
        {!snapshot && <div className="map-empty">Choose an SPC file to begin</div>}
      </div>

  );
});
