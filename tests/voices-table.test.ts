import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { VoicesPanel } from '../src/player/VoicesPanel';
import { VisualStream } from '../src/audio/visualStream';
import { ACTIVITY_BYTES, ARAM_BYTES } from '../src/audio/protocol';
import { makeSnapshot } from './helpers/snapshots';

let container: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

test('Voices presents every native field in fixed columns and keeps widths stable at extreme values', () => {
  const stream = new VisualStream();
  act(() => root.render(createElement(VoicesPanel, { stream, generation: 1, onError: message => { throw new Error(message); } })));
  expect([...container.querySelectorAll('thead th')].map(node => node.textContent)).toEqual(['Voice', 'L', 'R', 'Pitch', 'BRR', 'Source', 'Envelope', 'ADSR', 'Gain', 'ENVX', 'OUTX', 'Mode', 'KON/KOFF/ENDX']);
  const widths = [...container.querySelectorAll<HTMLTableColElement>('col')].map(node => node.style.width);
  expect(widths).toHaveLength(13);
  expect(widths.every(value => value.length > 0)).toBe(true);
  const sample = makeSnapshot(1);
  const voices = new Uint8Array(sample.payload, ARAM_BYTES + ACTIVITY_BYTES + 160, 128);
  voices.set([128, 127, 255, 63, 255, 7, 255, 255, 255, 255, 255, 255, 255, 128, 3, 7]);
  stream.publish(sample);
  const cells = [...container.querySelectorAll('tbody tr:first-child td')].map(node => node.textContent);
  expect(cells).toEqual(['1', '-128', '127', '$3FFF', '$FFFF', '$FF', '$7FF', '$FF FF', '$FF', '255', '-128', 'Sustain', '1 / 1 / 1']);
  expect([...container.querySelectorAll<HTMLTableColElement>('col')].map(node => node.style.width)).toEqual(widths);
});
