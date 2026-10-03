const DEFAULT_RING_FRAMES = 32768;
const DEFAULT_TAPS = 16;
const DEFAULT_PHASES = 512;

export class StreamingSincResampler {
  private readonly ratio: number;
  private readonly direct: boolean;
  private readonly half: number;
  private readonly ringFrames: number;
  private readonly ringMask: number;
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readonly coefficients: Float32Array;
  private writeFrame = 0;
  private readPosition = 0;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
    ringFrames = DEFAULT_RING_FRAMES,
    private readonly taps = DEFAULT_TAPS,
    private readonly phases = DEFAULT_PHASES,
  ) {
    if (inputRate <= 0 || outputRate <= 0) throw new RangeError('sample rates must be positive');
    if ((ringFrames & (ringFrames - 1)) !== 0) throw new RangeError('ring size must be a power of two');
    if (taps < 4 || taps % 2 !== 0) throw new RangeError('tap count must be a positive even number');
    this.ratio = inputRate / outputRate;
    this.direct = inputRate === outputRate;
    this.half = this.direct ? 0 : taps / 2;
    this.ringFrames = ringFrames;
    this.ringMask = ringFrames - 1;
    this.left = new Float32Array(ringFrames);
    this.right = new Float32Array(ringFrames);
    this.coefficients = this.direct ? new Float32Array(0) : this.makeCoefficients();
    this.reset();
  }

  reset() {
    this.left.fill(0);
    this.right.fill(0);
    this.writeFrame = this.half;
    this.readPosition = this.half;
  }

  push(interleaved: Int16Array) {
    if (interleaved.length % 2 !== 0) throw new RangeError('stereo input must be interleaved');
    for (let index = 0; index < interleaved.length; index += 2) {
      const oldestNeeded = Math.floor(this.readPosition) - this.half - 1;
      if (this.writeFrame - oldestNeeded >= this.ringFrames) {
        throw new RangeError('resampler input ring overflow');
      }
      const ring = this.writeFrame & this.ringMask;
      this.left[ring] = interleaved[index] / 32768;
      this.right[ring] = interleaved[index + 1] / 32768;
      this.writeFrame += 1;
    }
  }

  neededInputFrames(outputFrames: number) {
    if (outputFrames <= 0) return 0;
    const lastPosition = this.readPosition + (outputFrames - 1) * this.ratio;
    const requiredWrite = Math.floor(lastPosition) + this.half + 1;
    return Math.max(0, requiredWrite - this.writeFrame);
  }

  read(outLeft: Float32Array, outRight: Float32Array) {
    const capacity = Math.min(outLeft.length, outRight.length);
    let produced = 0;
    while (produced < capacity && this.neededInputFrames(1) === 0) {
      if (this.direct) {
        const ring = Math.floor(this.readPosition) & this.ringMask;
        outLeft[produced] = this.left[ring];
        outRight[produced] = this.right[ring];
      } else {
        this.interpolate(outLeft, outRight, produced);
      }
      this.readPosition += this.ratio;
      produced += 1;
    }
    return produced;
  }

  private makeCoefficients() {
    const table = new Float32Array(this.phases * this.taps);
    const cutoff = Math.min(1, this.outputRate / this.inputRate) * 0.94;
    for (let phase = 0; phase < this.phases; phase += 1) {
      const fraction = phase / this.phases;
      let sum = 0;
      for (let tap = 0; tap < this.taps; tap += 1) {
        const offset = tap - this.half + 1 - fraction;
        const scaled = Math.PI * cutoff * offset;
        const sinc = Math.abs(scaled) < 1e-9 ? 1 : Math.sin(scaled) / scaled;
        const window = Math.abs(offset) >= this.half
          ? 0
          : 0.5 + 0.5 * Math.cos((Math.PI * offset) / this.half);
        const coefficient = cutoff * sinc * window;
        table[phase * this.taps + tap] = coefficient;
        sum += coefficient;
      }
      for (let tap = 0; tap < this.taps; tap += 1) {
        table[phase * this.taps + tap] /= sum;
      }
    }
    return table;
  }

  private interpolate(outLeft: Float32Array, outRight: Float32Array, outputIndex: number) {
    const center = Math.floor(this.readPosition);
    const fraction = this.readPosition - center;
    const phase = Math.min(this.phases - 1, Math.floor(fraction * this.phases + 0.5));
    const coefficientOffset = phase * this.taps;
    let left = 0;
    let right = 0;
    for (let tap = 0; tap < this.taps; tap += 1) {
      const source = (center + tap - this.half + 1) & this.ringMask;
      const coefficient = this.coefficients[coefficientOffset + tap];
      left += this.left[source] * coefficient;
      right += this.right[source] * coefficient;
    }
    outLeft[outputIndex] = left;
    outRight[outputIndex] = right;
  }
}
