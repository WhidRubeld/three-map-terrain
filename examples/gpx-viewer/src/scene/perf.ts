/**
 * Renderer statistics, written by `<PerfProbe>` every frame and read by the
 * performance panel a few times per second (no React updates per frame).
 */
export const perf = {
  /** frame times in ms, a ring buffer */
  frames: new Float32Array(96),
  head: 0,
  count: 0,
  calls: 0,
  triangles: 0,
  points: 0,
  lines: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  dpr: 1,
  width: 0,
  height: 0,
  backend: 'webgl2'
}

/** Mean frame time over the last `n` frames, in ms. */
export function meanFrame(n = 30) {
  const count = Math.min(n, perf.count)
  if (!count) return 0
  let sum = 0
  for (let i = 1; i <= count; i++) {
    sum +=
      perf.frames[(perf.head - i + perf.frames.length) % perf.frames.length]
  }
  return sum / count
}
