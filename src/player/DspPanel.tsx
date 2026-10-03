import { useLayoutEffect, useRef } from 'react';
import { setLiveText, subscribeLiveState, type LiveStateProps } from './liveState';

const hex = Array.from({ length: 256 }, (_, value) => value.toString(16).toUpperCase().padStart(2, '0'));

export function DspPanel({ stream, generation, onError }: LiveStateProps) {
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const values = root.current!.querySelectorAll<HTMLElement>('.dsp-cell strong');
    return subscribeLiveState({ stream, generation, onError }, (state) => {
      for (let address = 0; address < 128; address += 1) {
        setLiveText(values[address], hex[state?.dspRegisters[address] ?? 0]);
      }
    });
  }, [stream, generation, onError]);
  return (
    <section ref={root} className="detail-panel">
      <div className="section-heading">
        <div><span className="eyebrow">S-DSP</span><h2>Register matrix</h2></div>
        <p>Live copied values for the 128 DSP registers.</p>
      </div>
      <div className="dsp-matrix">
        {Array.from({ length: 128 }, (_, address) => (
          <div className="dsp-cell" key={address} title={'Register $' + address.toString(16).toUpperCase().padStart(2, '0')}>
            <span>{'$' + address.toString(16).toUpperCase().padStart(2, '0')}</span>
            <strong>00</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
