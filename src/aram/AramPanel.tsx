import { useCallback, useMemo, useRef, useState } from 'react';
import type { VisualStream } from '../audio/visualStream';
import type { Snapshot } from '../audio/protocol';
import type { VisualizerRate } from '../settings';
import type { MemoryHistory } from './history';
import { MapView } from './MapView';
import { WaterfallView, type WaterfallInfo } from './WaterfallView';
import { bytePalette, metricPalette, type PalettePreset } from './palettes';
import { ARAM_MEASUREMENTS, renderingMode, isBitMode, isXorMode, isEntropyMode, type AramMeasurement, type DataUnit, type AramGeometry, type WaterfallSeconds } from './types';
import type { DrawStats, MemoryViewHandle } from './viewTypes';
type Props = {
  mode: AramMeasurement; onModeChange(mode: AramMeasurement): void; geometry: AramGeometry; onGeometryChange(geometry: AramGeometry): void;
  activityUnit: DataUnit; onActivityUnitChange(unit: DataUnit): void;
  dataUnit: DataUnit; dataXor: boolean; entropyUnit: DataUnit;
  onDataUnitChange(unit: DataUnit): void; onDataXorChange(enabled: boolean): void; onEntropyUnitChange(unit: DataUnit): void;
  waterfallSeconds: WaterfallSeconds; onWaterfallSecondsChange(seconds: WaterfallSeconds): void;
  activityByteBackground: boolean; onActivityByteBackgroundChange(enabled: boolean): void;
  snapshot: Snapshot | null; stream: VisualStream; generation: number; history: MemoryHistory; playing: boolean;
  palette: PalettePreset; activityPersistence: boolean; activityPersistenceMilliseconds: number; refreshRate: VisualizerRate; displayHz: number | null;
};
export function AramPanel(props: Props) {
  const { mode, geometry, palette, history } = props;
  const renderMode = renderingMode(props);
  const backgroundLabel = props.activityUnit === 'bit' ? 'Show bits underneath' : 'Show bytes underneath';
  const map = useRef<MemoryViewHandle>(null), waterfall = useRef<MemoryViewHandle>(null);
  const [stats, setStats] = useState<DrawStats>({ rate: 0, averageMs: 0, maxMs: 0 });
  const [info, setInfo] = useState<WaterfallInfo | null>(null);
  const onStats = useCallback((next: DrawStats) => setStats(next), []);
  const onInfo = useCallback((next: WaterfallInfo) => setInfo(next), []);
  const controls = () => geometry === 'map' ? map.current : waterfall.current;
  const gradient = useMemo(() => `linear-gradient(90deg, ${Array.from({ length: 16 }, (_, i) => {
    const color = mode === 'entropy' ? metricPalette(i / 15, palette) : bytePalette(i * 17, palette);
    return `rgb(${color[0]} ${color[1]} ${color[2]}) ${i / 15 * 100}%`;
  }).join(', ')})`, [mode, palette]);
  const latest = history.latest(), baseline = latest ? history.previous(latest) : null;
  const bucketLow = info ? Math.floor(info.window.span / info.columns) : 0, bucketHigh = info ? Math.ceil(info.window.span / info.columns) : 0;
  return <section className="aram-panel" aria-label="ARAM visualizer">
    <div className="panel-toolbar">
      <div className="measurement-controls">
        <div className="segmented" aria-label="Memory geometry">{(['map', 'waterfall'] as const).map(value => <button key={value} className={geometry === value ? 'active' : ''} aria-pressed={geometry === value} onClick={() => props.onGeometryChange(value)}>{value === 'map' ? 'Map' : 'Waterfall'}</button>)}</div>
        <select aria-label="Memory measurement" value={mode} onChange={event => props.onModeChange(event.target.value as AramMeasurement)}>{ARAM_MEASUREMENTS.map(value => <option value={value} key={value}>{value === 'data' ? 'Data' : value === 'activity' ? 'Activity' : 'Entropy'}</option>)}</select>
        <div className="segmented" aria-label={`${mode === 'activity' ? 'Activity' : mode === 'data' ? 'Data' : 'Entropy'} representation`}>{(['byte', 'bit'] as const).map(unit => {
          const selected = (mode === 'activity' ? props.activityUnit : mode === 'data' ? props.dataUnit : props.entropyUnit) === unit;
          return <button key={unit} className={selected ? 'active' : ''} aria-pressed={selected} onClick={() => mode === 'activity' ? props.onActivityUnitChange(unit) : mode === 'data' ? props.onDataUnitChange(unit) : props.onEntropyUnitChange(unit)}>{unit === 'byte' ? 'Byte' : 'Bit'}</button>;
        })}</div>
        {mode === 'data' && <label className="activity-byte-toggle" title="Show the mask of bits changed since the preceding continuous capture"><input type="checkbox" aria-label="XOR changes only" checked={props.dataXor} onChange={event => props.onDataXorChange(event.target.checked)} />XOR</label>}
        {mode === 'activity' && <label className="activity-byte-toggle" title="Darkened data at the interval's end with all address activity during that interval; activity trails are bypassed"><input type="checkbox" aria-label={backgroundLabel} checked={props.activityByteBackground} onChange={event => props.onActivityByteBackgroundChange(event.target.checked)} />{backgroundLabel}</label>}
        {geometry === 'waterfall' && <select aria-label="Waterfall time span" value={props.waterfallSeconds} onChange={event => props.onWaterfallSecondsChange(Number(event.target.value) as WaterfallSeconds)}>{[2, 5, 10].map(value => <option key={value} value={value}>{value} s</option>)}</select>}
      </div>
      <div className="zoom-controls"><button onClick={() => controls()?.zoom(0.8)} aria-label="Zoom out">−</button><button onClick={() => controls()?.fit()}>Fit</button><button onClick={() => controls()?.oneToOne()}>1:1</button><button onClick={() => controls()?.zoom(1.25)} aria-label="Zoom in">+</button></div>
    </div>
    <MapView ref={map} active={geometry === 'map'} memoryHistory={history} onStats={onStats} {...props} mode={renderMode} />
    <WaterfallView ref={waterfall} active={geometry === 'waterfall'} mode={renderMode} activityByteBackground={props.activityByteBackground} seconds={props.waterfallSeconds} palette={palette} history={history} stream={props.stream} generation={props.generation} displayHz={props.displayHz} onStats={onStats} onInfo={onInfo} />
    <div className="visual-status">
      <span className="live-status">{props.playing ? 'Live' : 'Paused'} · {stats.rate} draws/s</span>
      <span>Target · {props.refreshRate === 'display' ? `${props.displayHz ?? '…'} Hz display` : `${props.refreshRate} Hz`}</span>
      <span title="Canvas submission time; excludes display latency">Render · {stats.averageMs.toFixed(2)} ms avg · {stats.maxMs.toFixed(2)} ms max</span>
      {geometry === 'waterfall' && info && <span>{bucketLow === bucketHigh ? bucketLow : `${bucketLow}–${bucketHigh}`} bytes/{isBitMode(renderMode) ? 'bucket' : 'column'} · {props.waterfallSeconds} s window · {info.retainedSeconds.toFixed(1)} s retained</span>}
      {history.error && <span role="status">{history.error}</span>}
    </div>
    <div className="legend" aria-label="Visualizer legend">
      {mode === 'activity' ? <><span><i className="read" />Read</span><span><i className="write" />Write</span><span><i className="execute" />Execute</span><span>Overlaps blend</span></> :
        mode === 'entropy' ? <><div className="entropy-scale"><div className="value-gradient" style={{ background: gradient }} /><div className="scale-ticks">{[0, .25, .5, .75, 1].map(t => <span key={t}>{(t * (props.entropyUnit === 'bit' ? 1 : 8)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>)}</div></div><span>{props.entropyUnit === 'bit' ? 'bits per position · 0 = fixed · 1 = equal 0s and 1s' : 'bits/byte · 0 = repeated value · 8 = maximum diversity'}</span><span>256-byte blocks · hover or tap for values</span></> :
        isBitMode(renderMode) ? <><span><i className="bit-off" />0</span><span><i className="bit-on" />1</span><span>{geometry === 'map' ? 'MSB → LSB in each 4 × 2 byte tile' : 'Bit 7 → 0 left to right per bucket · 1:1 = one pixel per bit'}</span></> :
        <><span>$00</span><span className="value-gradient" style={{ background: gradient }} /><span>$FF</span></>}
      {geometry === 'waterfall' && mode === 'data' && !props.dataXor && props.dataUnit === 'byte' && <span>Bucket mean · latest sampled value</span>}
      {mode === 'activity' && props.activityByteBackground && <span>Interval activity + ending {props.activityUnit === 'bit' ? 'bits' : 'bytes'}{geometry === 'map' ? ' · trails off' : ''}</span>}
      {mode === 'activity' && props.activityUnit === 'bit' && <span>Accesses apply to the whole byte · {geometry === 'map' ? 'Bit 7 → 0 in each 4 × 2 tile' : 'Bit 7 → 0 per bucket · 1:1 = one pixel per bit'}</span>}
      {isXorMode(renderMode) && <span>XOR mask · {geometry === 'waterfall' ? 'all changed bits in each time band' : 'consecutive captures'} · 0 = unchanged</span>}
      {isXorMode(renderMode) && geometry === 'map' && !baseline && <span>Baseline unavailable</span>}
      {geometry === 'map' && !isXorMode(renderMode) && !isEntropyMode(renderMode) && !(mode === 'activity' && props.activityByteBackground) && props.activityPersistence && <span>Activity trail · {props.activityPersistenceMilliseconds.toLocaleString()} ms</span>}
    </div>
  </section>;
}
