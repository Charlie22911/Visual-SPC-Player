import { expect, test } from 'vitest';
import { SpcAudioEngine } from '../src/audio/engine';

test('choosing spectrum analysis before playback never initializes an audio context', async () => {
  const engine = new SpcAudioEngine();
  engine.setSpectrumOptions({ fftSize: 1024, hopSize: 64 });
  expect(engine.state).toBe('idle');
  expect(engine.sampleRate).toBe(0);
  expect(engine.spectrumStats().active).toBe(false);
  expect(engine.spectrumClock()).toEqual({ generation: 0, nativeFrame: 0, playing: false });
  engine.setSpectrumOptions(null);
  expect(() => engine.setSpectrumOptions({ fftSize: 512, hopSize: 64 })).toThrow(RangeError);
  await engine.dispose();
});
