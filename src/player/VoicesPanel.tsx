import { useLayoutEffect, useRef } from 'react';
import { setLiveText, subscribeLiveState, type LiveStateProps } from './liveState';

const envelopeNames = ['Release', 'Attack', 'Decay', 'Sustain'];
const headers = ['Voice', 'L', 'R', 'Pitch', 'BRR', 'Source', 'Envelope', 'ADSR', 'Gain', 'ENVX', 'OUTX', 'Mode', 'KON/KOFF/ENDX'];
// Monospace ch units reserve the widest header or legal value, plus padding.
// They scale with font size and display scaling without measuring live values.
const columnCharacters = [5, 4, 4, 5, 5, 6, 12, 6, 4, 4, 4, 7, 13];
const hex = (value: number, digits: number) => '$' + value.toString(16).toUpperCase().padStart(digits, '0');

export function VoicesPanel({ stream, generation, onError }: LiveStateProps) {
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const rows = Array.from(root.current!.querySelectorAll('tbody tr'), row => ({
      cells: row.querySelectorAll<HTMLTableCellElement>('td'),
      envelope: row.querySelector<HTMLElement>('.voice-envelope-value')!,
      meter: row.querySelector<HTMLElement>('.meter i')!,
    }));
    return subscribeLiveState({ stream, generation, onError }, state => {
      rows.forEach((row, index) => {
        const voice = state?.voices[index];
        const envelope = voice?.envelope ?? 0;
        const values = voice ? [
          String(voice.volumeLeft), String(voice.volumeRight), hex(voice.pitch, 4), hex(voice.brrAddress, 4),
          hex(voice.sourceNumber, 2), '', hex(voice.adsr0, 2) + ' ' + hex(voice.adsr1, 2).slice(1), hex(voice.gain, 2),
          String(voice.envx), String(voice.output), envelopeNames[voice.envelopeMode] ?? '?',
          `${+voice.keyOn} / ${+voice.keyOff} / ${+voice.endx}`,
        ] : Array.from({ length: 12 }, () => '—');
        values.forEach((value, column) => {
          if (column !== 5) setLiveText(row.cells[column + 1], value);
        });
        setLiveText(row.envelope, hex(envelope, 3));
        row.meter.style.width = Math.min(100, Math.max(0, envelope / 0x7ff * 100)) + '%';
      });
    });
  }, [stream, generation, onError]);
  return (
    <section ref={root} className="detail-panel voices-panel">
      <div className="section-heading">
        <div><span className="eyebrow">S-DSP</span><h2>Eight voices</h2></div>
        <p>Envelope and pitch are synthesizer state, not separate output meters.</p>
      </div>
      <div className="voice-table-scroll" role="region" aria-label="Eight voice states" tabIndex={0}>
        <table className="voice-table">
          <colgroup>{columnCharacters.map((characters, index) => <col key={index} style={{ width: `calc(${characters}ch + 1.5em)` }} />)}</colgroup>
          <thead><tr>{headers.map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{Array.from({ length: 8 }, (_, index) => (
            <tr key={index}><td>{index + 1}</td>{headers.slice(1).map((label, column) => (
              <td key={label}>{column === 5 ? <><div className="meter-label"><span className="voice-envelope-value">$000</span></div><div className="meter"><i style={{ width: '0%' }} /></div></> : '—'}</td>
            ))}</tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}
