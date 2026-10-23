/**
 * Corrects the characters ÷ 4 estimate against provider-reported prompt sizes.
 *
 * actual ≈ overhead + factor × estimate, where estimate covers the conversation messages and overhead is the
 * system prompt and tool definitions. The factor is learned from pairs of requests whose conversation size
 * differs enough; the overhead is whatever the latest request leaves over.
 */
export interface Calibration {
  readonly factor: number
  readonly overhead: number
  /** Number of factor measurements folded in; 0 means the factor is still the default. */
  readonly samples: number
}

export interface Sample {
  /** Estimated conversation tokens sent with the request. */
  readonly estimate: number
  /** Prompt tokens the provider reported for the same request (input + cache read + cache write). */
  readonly actual: number
}

export const DEFAULT_CALIBRATION: Calibration = { factor: 1, overhead: 0, samples: 0 }

/** Minimum change in estimated conversation size between two requests before a factor is measured. */
const MIN_DELTA = 5_000
const MIN_FACTOR = 0.5
const MAX_FACTOR = 4
const WEIGHT = 0.3

const clampOverhead = (sample: Sample, factor: number) => Math.max(0, Math.round(sample.actual - factor * sample.estimate))

/**
 * Folds a new sample into the calibration. `anchor` is the earlier sample to measure against; the caller
 * should move the anchor to `sample` when `measured` is true.
 */
export const calibrate = (calibration: Calibration, anchor: Sample | undefined, sample: Sample) => {
  let { factor, samples } = calibration
  let measured = false
  if (anchor && Math.abs(sample.estimate - anchor.estimate) >= MIN_DELTA) {
    const slope = (sample.actual - anchor.actual) / (sample.estimate - anchor.estimate)
    if (slope >= MIN_FACTOR && slope <= MAX_FACTOR) {
      factor = samples ? factor + WEIGHT * (slope - factor) : slope
      samples += 1
      measured = true
    }
  }
  return { calibration: { factor, overhead: clampOverhead(sample, factor), samples }, measured }
}

export const promptTokens = (tokens: { input: number; cache: { read: number; write: number } }) =>
  tokens.input + tokens.cache.read + tokens.cache.write
