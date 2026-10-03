import { useEffect, useState } from 'react';
import type { ByteRefreshMeasurement, ByteRefreshMonitor } from './byteRefresh';

export function ByteRefreshDiagnostics({ monitor, mode, geometry, target, buildId, hidden }: {
  monitor: ByteRefreshMonitor; mode: string; geometry: string; target: number | string; buildId?: string; hidden: boolean;
}) {
  const [measurement, setMeasurement] = useState<ByteRefreshMeasurement | null>(null);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    const update = () => setMeasurement(monitor.sample(performance.now(), { mode, geometry, target }));
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [monitor, mode, geometry, target]);
  const save = () => {
    const data = {
      format: 'spc-byte-refresh-diagnostic', version: 1, build: buildId ?? document.querySelector('script[type="module"][src]')?.getAttribute('src'),
      browser: navigator.userAgent, counterMeaning: 'Presented snapshots, not physical screen refreshes. A changed state means at least one byte changed.',
      measurements: monitor.measurements,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'SPC-byte-refresh.json'; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const p = measurement?.presented;
  const metrics: Array<[string, string]> = [
    ['Presented snapshots', `${p?.snapshots ?? 0}/s`],
    ['New emulator states', `${p?.advanced ?? 0}/s`],
    ['Changed RAM states', `${p?.ramChanged ?? 0}/s`],
    ['Changed echo states', `${p?.echoChanged ?? 0}/s`],
    ['Captured echo changes', `${measurement?.received.echoChanged ?? 0}/s`],
    ['Echo bytes changed', `${p?.changedEchoBytes ?? 0}/s`],
    ['Bytes with write activity', `${p?.writtenEchoAddresses ?? 0}/s`],
    ['Snapshot gap, median', `${p?.wallGapMedian ?? 0} ms`],
    ['Snapshot gap, 95th pct.', `${p?.wallGap95 ?? 0} ms`],
    ['Audio step, 95th pct.', `${p?.audioGap95 ?? 0} ms`],
    ['Longest repeated echo', `${p?.longestUnchangedEchoMs ?? 0} ms`],
  ];
  return <details className="byte-refresh-diagnostic" hidden={hidden} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)} aria-label="Byte refresh diagnostic">
    <summary>Byte refresh check</summary>
    <p>These counters measure snapshots. A changed state means at least one byte changed. Collapse this panel to see the whole player.</p>
    <dl>{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      <div><dt>Echo region</dt><dd>{measurement?.echoStart === null || measurement?.echoStart === undefined ? 'Waiting for track' : `$${measurement.echoStart.toString(16).toUpperCase().padStart(4, '0')} · ${measurement.echoLength.toLocaleString()} bytes`}</dd></div>
    </dl>
    <button onClick={save} disabled={!monitor.measurements.length}>Save measurements</button>
  </details>;
}
