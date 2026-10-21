// The imagery `filter`: CSS filter functions that act on colors, applied to
// the pixels by the library. The canvas `filter` is not an option — Safari
// has none (none on OffscreenCanvas at all), so the imagery stayed in color
// there — and material colors can only tint: mixing channels (grayscale,
// saturate, …) would take custom shaders. Each function is the color matrix
// the Filter Effects spec defines it as, applied in sRGB to non-premultiplied
// colors and clamped after each step, as CSS does: what Chrome draws, in
// every browser and renderer, baked into the texture (and exported models).

/**
 * An affine transform of RGBA in 0…1, as the values of an SVG
 * `feColorMatrix`: the rows R, G, B, A of `[r, g, b, a, offset]`.
 */
export type ColorMatrix = readonly number[]

type Matrix3 = readonly (readonly number[])[]

const IDENTITY: Matrix3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
]
/** `Σ k · matrix` */
const combine = (...terms: (readonly [Matrix3, number])[]): Matrix3 =>
  IDENTITY.map((row, i) =>
    row.map((_, j) => terms.reduce((sum, [m, k]) => sum + m[i][j] * k, 0))
  )
const mix = (a: Matrix3, b: Matrix3, t: number) => combine([a, 1 - t], [b, t])
const scale = (k: number) => combine([IDENTITY, k])
const rows = (row: readonly number[]): Matrix3 => [row, row, row]

/** grayscale(1); saturate(0) uses the rounded weights of the spec */
const GRAYSCALE = rows([0.2126, 0.7152, 0.0722])
const DESATURATED = rows([0.213, 0.715, 0.072])
const SEPIA: Matrix3 = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131]
]
const HUE_COS: Matrix3 = [
  [0.787, -0.715, -0.072],
  [-0.213, 0.285, -0.072],
  [-0.213, -0.715, 0.928]
]
const HUE_SIN: Matrix3 = [
  [-0.213, -0.715, 0.928],
  [0.143, 0.14, -0.283],
  [-0.787, 0.715, 0.072]
]

const colorMatrix = (rgb: Matrix3, offset = 0, alpha = 1): ColorMatrix => [
  ...rgb.flatMap((row) => [...row, 0, offset]),
  ...[0, 0, 0, alpha, 0]
]

/** By name: the matrix for an amount (1 = 100%), or an angle in radians. */
const FUNCTIONS: Record<string, (value: number) => ColorMatrix> = {
  grayscale: (amount) =>
    colorMatrix(mix(IDENTITY, GRAYSCALE, Math.min(amount, 1))),
  sepia: (amount) => colorMatrix(mix(IDENTITY, SEPIA, Math.min(amount, 1))),
  saturate: (amount) => colorMatrix(mix(DESATURATED, IDENTITY, amount)),
  'hue-rotate': (angle) =>
    colorMatrix(
      combine(
        [DESATURATED, 1],
        [HUE_COS, Math.cos(angle)],
        [HUE_SIN, Math.sin(angle)]
      )
    ),
  invert: (amount) => {
    const t = Math.min(amount, 1)
    return colorMatrix(scale(1 - 2 * t), t)
  },
  opacity: (amount) => colorMatrix(IDENTITY, 0, Math.min(amount, 1)),
  brightness: (amount) => colorMatrix(scale(amount)),
  contrast: (amount) => colorMatrix(scale(amount), 0.5 - 0.5 * amount)
}

const ANGLE_UNITS: Record<string, number> = {
  deg: Math.PI / 180,
  grad: Math.PI / 200,
  rad: 1,
  turn: 2 * Math.PI
}

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`
const FILTER_FUNCTION = new RegExp(
  String.raw`\s*([a-z-]+)\(\s*(?:(${NUMBER})([a-z%]*)\s*)?\)\s*`,
  'iy'
)

/** The argument of `name` in 1 = 100% or radians, `undefined` if invalid. */
function argument(name: string, number?: string, unit = '') {
  if (number === undefined) return name === 'hue-rotate' ? 0 : 1
  const value = Number(number)
  if (name === 'hue-rotate') {
    const factor = ANGLE_UNITS[unit.toLowerCase()] as number | undefined
    if (factor !== undefined) return value * factor
    return unit === '' && value === 0 ? 0 : undefined
  }
  if (value < 0) return undefined
  if (unit === '%') return value / 100
  return unit === '' ? value : undefined
}

const isIdentity = (matrix: ColorMatrix) =>
  matrix.every((v, i) => Math.abs(v - (i % 6 === 0 ? 1 : 0)) < 1e-9)

/**
 * Parses a CSS filter of color functions — `grayscale`, `sepia`, `saturate`,
 * `hue-rotate`, `invert`, `opacity`, `brightness`, `contrast` — into the
 * matrices to apply in order (none for `'none'`). Throws a `SyntaxError` for
 * anything else, e.g. `blur()`, which does not act on colors.
 */
export function parseFilter(filter: string): ColorMatrix[] {
  const steps: ColorMatrix[] = []
  if (/^\s*(none)?\s*$/i.test(filter)) return steps
  const pattern = new RegExp(FILTER_FUNCTION)
  while (pattern.lastIndex < filter.length) {
    const match = pattern.exec(filter)
    const name = match?.[1].toLowerCase() ?? ''
    const value = match && argument(name, match[2], match[3])
    const create = FUNCTIONS[name] as
      ((value: number) => ColorMatrix) | undefined
    if (value === undefined || value === null || !create) {
      throw new SyntaxError(
        `Invalid imagery filter "${filter}": it takes the CSS color functions ${Object.keys(FUNCTIONS).join(', ')}`
      )
    }
    const matrix = create(value)
    if (!isIdentity(matrix)) steps.push(matrix)
  }
  return steps
}

let parsed: { filter: string; steps: readonly ColorMatrix[] } | undefined

/**
 * `parseFilter` once for all the tiles of a filter. An invalid filter is
 * ignored with a warning, as CSS ignores it.
 */
export function colorFilter(filter: string): readonly ColorMatrix[] {
  if (parsed?.filter !== filter) {
    let steps: readonly ColorMatrix[] = []
    try {
      steps = parseFilter(filter)
    } catch (error) {
      console.warn(error instanceof Error ? error.message : error)
    }
    parsed = { filter, steps }
  }
  return parsed.steps
}

const clamp = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value)

/** Applies `steps` in order to RGBA8 pixels (`ImageData.data`), in place. */
export function applyColorFilter(
  pixels: Uint8ClampedArray,
  steps: readonly ColorMatrix[]
) {
  if (steps.length === 0) return
  for (let i = 0; i < pixels.length; i += 4) {
    let r = pixels[i] / 255
    let g = pixels[i + 1] / 255
    let b = pixels[i + 2] / 255
    let a = pixels[i + 3] / 255
    for (const m of steps) {
      const r1 = clamp(m[0] * r + m[1] * g + m[2] * b + m[3] * a + m[4])
      const g1 = clamp(m[5] * r + m[6] * g + m[7] * b + m[8] * a + m[9])
      const b1 = clamp(m[10] * r + m[11] * g + m[12] * b + m[13] * a + m[14])
      a = clamp(m[15] * r + m[16] * g + m[17] * b + m[18] * a + m[19])
      r = r1
      g = g1
      b = b1
    }
    // Uint8ClampedArray rounds
    pixels[i] = r * 255
    pixels[i + 1] = g * 255
    pixels[i + 2] = b * 255
    pixels[i + 3] = a * 255
  }
}
