import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ACTIVITY_BYTES, ARAM_BYTES, SNAPSHOT_BYTES, STATE_BYTES, type Snapshot } from '../src/audio/protocol';
import { VisualStream } from '../src/audio/visualStream';
import { DspPanel } from '../src/player/DspPanel';
import { VoicesPanel } from '../src/player/VoicesPanel';

const snapshot = (value: number, generation = 1): Snapshot => {
  const payload = new ArrayBuffer(SNAPSHOT_BYTES);
  const state = new DataView(payload, ARAM_BYTES + ACTIVITY_BYTES);
  state.setUint32(0, 1, true);
  state.setUint32(4, STATE_BYTES, true);
  state.setUint32(8, generation, true);
  state.setUint8(32, value);
  state.setUint16(164, value, true);
  return { type: 'snapshot', generation, requestId: 1, sequence: value, audibleFrame: value * 32000 / 240, payload };
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test.each([
  { name: 'DSP', component: DspPanel, selector: '.dsp-cell strong', expected: ['01', '02', '03', '04'] },
  { name: 'Voices', component: VoicesPanel, selector: '.meter-label span:last-child', expected: ['$001', '$002', '$003', '$004'] },
])('$name paints every presented snapshot without waiting for React or a timer', ({ component, selector, expected }) => {
  const stream = new VisualStream();
  const onError = (message: string) => { throw new Error(message); };
  act(() => root.render(createElement(component, { stream, generation: 1, onError })));
  for (let index = 0; index < expected.length; index += 1) {
    // Four snapshots less than one 100 ms UI interval apart. No timers or
    // React commits are advanced between publishing and inspecting the DOM.
    stream.publish(snapshot(index + 1));
    expect(container.querySelector(selector)?.textContent).toBe(expected[index]);
  }
  stream.publish(snapshot(255, 2));
  expect(container.querySelector(selector)?.textContent).toBe(expected[3]);
  act(() => root.render(createElement(component, { stream, generation: 2, onError })));
  expect(container.querySelector(selector)?.textContent).toBe(component === DspPanel ? 'FF' : '$0FF');
  // A normal parent rerender must preserve the live values and subscription.
  act(() => root.render(createElement(component, { stream, generation: 2, onError })));
  stream.publish(snapshot(1, 2));
  expect(container.querySelector(selector)?.textContent).toBe(expected[0]);
});
