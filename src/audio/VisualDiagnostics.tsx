import { useEffect, useState } from 'react';
import type { VisualStream } from './visualStream';

export function VisualDiagnostics({ stream, displayHz }: { stream: VisualStream; displayHz: number | null }) {
  const [rates, setRates] = useState({ received: 0, fresh: 0, coalesced: 0, presented: 0 });
  useEffect(() => {
    let previous = { received: stream.received, fresh: stream.fresh, coalesced: stream.coalesced, presented: stream.presented };
    let time = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const current = { received: stream.received, fresh: stream.fresh, coalesced: stream.coalesced, presented: stream.presented };
      const seconds = (now - time) / 1000;
      setRates({
        presented: Math.round((current.presented - previous.presented) / seconds),
        received: Math.round((current.received - previous.received) / seconds),
        fresh: Math.round((current.fresh - previous.fresh) / seconds),
        coalesced: Math.round((current.coalesced - previous.coalesced) / seconds),
      });
      previous = current;
      time = now;
    }, 1000);
    return () => window.clearInterval(timer);
  }, [stream]);
  return <>
    <div><span>States presented to visual stream</span><strong>{rates.presented}/s</strong></div>
    <div><span>Visual buffer</span><strong>1 frame · {(1000 / (displayHz ?? 60)).toFixed(1)} ms</strong></div>
    <div><span>Visual queue overflows</span><strong>{stream.queueOverflows}</strong></div>
    <div><span>Snapshots received</span><strong>{rates.received}/s</strong></div>
    <div><span>Advanced emulator states received</span><strong>{rates.fresh}/s</strong></div>
    <div><span>Snapshots combined before drawing</span><strong>{rates.coalesced}/s</strong></div>
  </>;
}
