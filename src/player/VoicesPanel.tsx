import { useLayoutEffect, useRef } from 'react';
import { setLiveText, subscribeLiveState, type LiveStateProps } from './liveState';

const envelopeNames = ['Release', 'Attack', 'Decay', 'Sustain'];

const hex = (value: number, digits: number) => '$' + value.toString(16).toUpperCase().padStart(digits, '0');

export function VoicesPanel({ stream, generation, onError }: LiveStateProps) {
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const cards = Array.from(root.current!.querySelectorAll('.voice-card'), (card) => ({
      source: card.querySelector<HTMLElement>('header span')!,
      envelope: card.querySelector<HTMLElement>('.meter-label span:last-child')!,
      meter: card.querySelector<HTMLElement>('.meter i')!,
      pitchMarker: card.querySelector<HTMLElement>('.pitch-track i')!,
      details: card.querySelectorAll<HTMLElement>('dd'),
    }));
    return subscribeLiveState({ stream, generation, onError }, (state) => {
      for (let index = 0; index < cards.length; index += 1) {
        const card = cards[index];
        const voice = state?.voices[index];
        const envelope = voice?.envelope ?? 0;
        const pitch = voice?.pitch ?? 0;
        setLiveText(card.source, 'SRC ' + (voice?.sourceNumber ?? '—'));
        setLiveText(card.envelope, hex(envelope, 3));
        card.meter.style.width = (envelope / 0x7ff) * 100 + '%';
        card.pitchMarker.style.left = (pitch / 0x3fff) * 100 + '%';
        setLiveText(card.details[0], hex(pitch, 4));
        setLiveText(card.details[1], voice ? hex(voice.brrAddress, 4) : '—');
        setLiveText(card.details[2], voice ? envelopeNames[voice.envelopeMode] ?? '—' : '—');
        setLiveText(card.details[3], String(voice?.output ?? '—'));
      }
    });
  }, [stream, generation, onError]);
  return (
    <section ref={root} className="detail-panel">
      <div className="section-heading">
        <div><span className="eyebrow">S-DSP</span><h2>Eight voices</h2></div>
        <p>Envelope and pitch are synthesizer state, not separate output meters.</p>
      </div>
      <div className="voice-grid">
        {Array.from({ length: 8 }, (_, index) => {
          return (
            <article className="voice-card" key={index}>
              <header><strong>Voice {index + 1}</strong><span>SRC —</span></header>
              <div className="meter-label"><span>Envelope</span><span>$000</span></div>
              <div className="meter"><i style={{ width: '0%' }} /></div>
              <div className="pitch-track"><i style={{ left: '0%' }} /></div>
              <dl>
                <div><dt>Pitch</dt><dd>$0000</dd></div>
                <div><dt>BRR</dt><dd>—</dd></div>
                <div><dt>Mode</dt><dd>—</dd></div>
                <div><dt>Output</dt><dd>—</dd></div>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}
