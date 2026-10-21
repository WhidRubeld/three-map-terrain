// Bridges: pieces joined into whole decks, and the height of the deck.
// Internal: the Roads layer draws them.
//
// Coordinates are "map units": tile coordinates at the map's zoom (x east,
// y south), the same for every tile, so that pieces from different tiles
// meet. Distances along a bridge (`s`) are in meters.

import type { RoadFeature } from './features'

/** A bridge line from one source tile, cut to it (its buffer is dropped). */
export interface BridgePiece {
  feature: RoadFeature
  /** `[x0, y0, x1, y1, …]` in map units. */
  points: number[]
  /** Whether each end was cut at the source tile's edge. */
  cut: [start: boolean, end: boolean]
}

/** How a bridge ends: on the ground, cut off (unknown), or on another bridge. */
export type BridgeEnd =
  | { type: 'ground' }
  | { type: 'free' }
  | { type: 'on'; bridge: BridgeChain; s: number }

/** A whole bridge: pieces of one road, and roads meeting end to end. */
export interface BridgeChain {
  points: number[]
  /** The road of every segment. */
  features: RoadFeature[]
  ends: [BridgeEnd, BridgeEnd]
}

/** A deck: heights (scene units) at distances along the bridge (meters). */
export interface DeckProfile {
  s: number[]
  z: number[]
}

/** Grade of the ramps up to the clearance, from the ends on the ground. */
export const RAMP_GRADE = 0.15

/** Who a piece belongs with: its id, or its geometry (whole features). */
const keyOf = ({ feature }: BridgePiece) =>
  feature.id !== undefined
    ? `id ${String(feature.id)}`
    : `line ${JSON.stringify(feature.geometry.coordinates)}`

const near = (
  points: readonly number[],
  i: number,
  other: readonly number[],
  j: number,
  tolerance: number
) => Math.hypot(points[i] - other[j], points[i + 1] - other[j + 1]) <= tolerance

function reverse(points: readonly number[]) {
  const out: number[] = []
  for (let i = points.length - 2; i >= 0; i -= 2)
    out.push(points[i], points[i + 1])
  return out
}

interface Run {
  points: number[]
  features: RoadFeature[]
  cut: [boolean, boolean]
}

const flip = (run: Run): Run => ({
  points: reverse(run.points),
  features: [...run.features].reverse(),
  cut: [run.cut[1], run.cut[0]]
})

/** `b` appended to `a`, which ends where `b` starts (that point once). */
const concat = (a: Run, b: Run): Run => ({
  points: [...a.points, ...b.points.slice(2)],
  features: [...a.features, ...b.features],
  cut: [a.cut[0], b.cut[1]]
})

/**
 * Joins the runs whose ends meet, as long as `joinable` allows it for the
 * two ends (`'start'`/`'end'` of each).
 */
function chainRuns(
  runs: Run[],
  tolerance: number,
  joinable: (a: Run, aEnd: 0 | 1, b: Run, bEnd: 0 | 1) => boolean
): Run[] {
  const open = [...runs]
  const out: Run[] = []
  while (open.length > 0) {
    let chain = open.splice(0, 1)[0]
    for (let joined = true; joined;) {
      joined = false
      for (let k = 0; k < open.length; k++) {
        const other = open[k]
        const last = chain.points.length - 2
        const otherLast = other.points.length - 2
        let next: Run | undefined
        if (
          near(chain.points, last, other.points, 0, tolerance) &&
          joinable(chain, 1, other, 0)
        ) {
          next = concat(chain, other)
        } else if (
          near(chain.points, last, other.points, otherLast, tolerance) &&
          joinable(chain, 1, other, 1)
        ) {
          next = concat(chain, flip(other))
        } else if (
          near(chain.points, 0, other.points, otherLast, tolerance) &&
          joinable(chain, 0, other, 1)
        ) {
          next = concat(other, chain)
        } else if (
          near(chain.points, 0, other.points, 0, tolerance) &&
          joinable(chain, 0, other, 0)
        ) {
          next = concat(flip(other), chain)
        }
        if (next) {
          chain = next
          open.splice(k, 1)
          joined = true
          break
        }
      }
    }
    out.push(chain)
  }
  return out
}

/** Points of every chain in cells of `tolerance`, to find what meets where. */
class PointIndex {
  private readonly cells = new Map<string, { run: Run; index: number }[]>()

  constructor(
    runs: readonly Run[],
    private readonly tolerance: number
  ) {
    for (const run of runs) {
      for (let i = 0; i < run.points.length; i += 2) {
        const key = this.cell(run.points[i], run.points[i + 1])
        let list = this.cells.get(key)
        if (!list) {
          list = []
          this.cells.set(key, list)
        }
        list.push({ run, index: i })
      }
    }
  }

  private cell(x: number, y: number) {
    return `${Math.floor(x / this.tolerance)} ${Math.floor(y / this.tolerance)}`
  }

  /** The points within `tolerance` of `x`, `y`. */
  near(x: number, y: number) {
    const cx = Math.floor(x / this.tolerance)
    const cy = Math.floor(y / this.tolerance)
    const found: { run: Run; index: number }[] = []
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const point of this.cells.get(`${cx + i} ${cy + j}`) ?? []) {
          const [px, py] = [
            point.run.points[point.index],
            point.run.points[point.index + 1]
          ]
          if (Math.hypot(px - x, py - y) <= this.tolerance) found.push(point)
        }
      }
    }
    return found
  }
}

/**
 * Whole bridges from their pieces. Pieces of one road (same `id`, or the
 * same geometry) are joined at the edges they were cut at; then bridges
 * meeting end to end where nothing else meets — a viaduct mapped as
 * several roads — become one. A remaining end is cut off (`free`: the rest
 * is not loaded), on another bridge (a ramp joining it), or on the ground.
 */
export function joinBridges(
  pieces: readonly BridgePiece[],
  /** Map units within which points meet. */
  tolerance: number,
  /** Meters per map unit. */
  meters: number
): BridgeChain[] {
  const groups = new Map<string, Run[]>()
  for (const piece of pieces) {
    if (piece.points.length < 4) continue
    const key = keyOf(piece)
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
    }
    group.push({
      points: piece.points,
      features: Array.from(
        { length: piece.points.length / 2 - 1 },
        () => piece.feature
      ),
      cut: piece.cut
    })
  }

  // a road cut at tile edges, whole again
  let runs = [...groups.values()].flatMap((group) =>
    chainRuns(
      group,
      tolerance,
      (a, aEnd, b, bEnd) => a.cut[aEnd] && b.cut[bEnd]
    )
  )

  // bridges meeting end to end, and nothing else there: where exactly two
  // uncut ends of different roads meet
  const ends = new PointIndex(runs, tolerance)
  const joints: number[] = []
  for (const run of runs) {
    for (const end of [0, 1] as const) {
      if (run.cut[end]) continue
      const k = end === 0 ? 0 : run.points.length - 2
      const meeting = ends.near(run.points[k], run.points[k + 1])
      const through =
        meeting.length === 2 &&
        meeting[0].run !== meeting[1].run &&
        meeting.every(
          ({ run: other, index }) =>
            (index === 0 && !other.cut[0]) ||
            (index === other.points.length - 2 && !other.cut[1])
        )
      if (through) joints.push(run.points[k], run.points[k + 1])
    }
  }
  const isJoint = (x: number, y: number) => {
    for (let i = 0; i < joints.length; i += 2) {
      if (Math.hypot(joints[i] - x, joints[i + 1] - y) <= tolerance) return true
    }
    return false
  }
  runs = chainRuns(runs, tolerance, (a, aEnd, b, bEnd) => {
    if (a.cut[aEnd] || b.cut[bEnd]) return false
    const k = aEnd === 0 ? 0 : a.points.length - 2
    return isJoint(a.points[k], a.points[k + 1])
  })

  const chains = runs.map((run): BridgeChain => ({
    points: run.points,
    features: run.features,
    ends: [{ type: 'free' }, { type: 'free' }]
  }))
  const index = new PointIndex(runs, tolerance)
  const chainOf = new Map(runs.map((run, i) => [run, chains[i]]))
  for (const [i, run] of runs.entries()) {
    const chain = chains[i]
    for (const end of [0, 1] as const) {
      if (run.cut[end]) continue
      const k = end === 0 ? 0 : run.points.length - 2
      const other = index
        .near(run.points[k], run.points[k + 1])
        .find((point) => point.run !== run)
      const bridge = other && chainOf.get(other.run)
      chain.ends[end] =
        other && bridge
          ? {
              type: 'on',
              bridge,
              s: lengthTo(other.run.points, other.index, meters)
            }
          : { type: 'ground' }
    }
  }
  return chains
}

/** Meters along `points` up to point index `index` (a flat index). */
export function lengthTo(
  points: readonly number[],
  index: number,
  meters: number
) {
  let length = 0
  for (let i = 2; i <= index; i += 2) {
    length += Math.hypot(
      points[i] - points[i - 2],
      points[i + 1] - points[i - 1]
    )
  }
  return length * meters
}

/**
 * The deck of a bridge over the ground under it: the upper convex hull of
 * the ground raised by the clearance — a string stretched over the
 * terrain from end to end. It never goes under the ground and has no dips;
 * its grade changes only where it rests on the terrain.
 *
 * `samples` are distances along the bridge (meters, from 0 to `length`)
 * with the ground there (scene units; `undefined` where it is not loaded).
 * An end with a height (`start`, `end`) is fixed there; a free end stays
 * level with the fixed one, or with the highest ground. Returns the hull's
 * points, or `undefined` without any ground.
 */
export function deckProfile(
  samples: readonly { s: number; ground: number | undefined }[],
  length: number,
  {
    start,
    end,
    clearance
  }: {
    start?: number
    end?: number
    /** Least height above the ground at `s` (scene units). */
    clearance: (s: number) => number
  }
): DeckProfile | undefined {
  const inner: { s: number; z: number }[] = []
  let [atStart, atEnd]: (number | undefined)[] = [undefined, undefined]
  for (const { s, ground } of samples) {
    if (ground === undefined) continue
    const z = ground + clearance(s)
    if (s <= 0) atStart = z
    else if (s >= length) atEnd = z
    else inner.push({ s, z })
  }
  const known = [atStart, ...inner.map(({ z }) => z), atEnd].filter(
    (z): z is number => z !== undefined
  )
  const fixed = [start, end].filter((z): z is number => z !== undefined)
  if (known.length === 0 && fixed.length === 0) return undefined
  // a free end: level with the fixed one, or with the highest ground
  const level = Math.max(...(fixed.length > 0 ? fixed : known))
  const points = [
    { s: 0, z: start ?? Math.max(level, atStart ?? -Infinity) },
    ...inner.sort((a, b) => a.s - b.s),
    { s: length, z: end ?? Math.max(level, atEnd ?? -Infinity) }
  ]

  const hull: { s: number; z: number }[] = []
  for (const point of points) {
    while (hull.length >= 2) {
      const [o, a] = [hull[hull.length - 2], hull[hull.length - 1]]
      const cross =
        (a.s - o.s) * (point.z - o.z) - (a.z - o.z) * (point.s - o.s)
      if (cross >= 0) hull.pop()
      else break
    }
    hull.push(point)
  }
  return { s: hull.map(({ s }) => s), z: hull.map(({ z }) => z) }
}

/** Height of a deck at `s` (constant beyond its ends). */
export function deckAt({ s, z }: DeckProfile, at: number): number {
  if (at <= s[0]) return z[0]
  for (let i = 1; i < s.length; i++) {
    if (at <= s[i]) {
      const t = s[i] === s[i - 1] ? 0 : (at - s[i - 1]) / (s[i] - s[i - 1])
      return z[i - 1] + (z[i] - z[i - 1]) * t
    }
  }
  return z[z.length - 1]
}

/** The part of a segment inside a rectangle as parameters, or `undefined`. */
export function clipSegmentT(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  [minX, minY, maxX, maxY]: readonly number[]
): [number, number] | undefined {
  const [dx, dy] = [bx - ax, by - ay]
  let [t0, t1] = [0, 1]
  for (const [p, q] of [
    [-dx, ax - minX],
    [dx, maxX - ax],
    [-dy, ay - minY],
    [dy, maxY - ay]
  ]) {
    if (p === 0) {
      if (q < 0) return undefined
      continue
    }
    const r = q / p
    if (p < 0) t0 = Math.max(t0, r)
    else t1 = Math.min(t1, r)
    if (t0 >= t1) return undefined
  }
  return [t0, t1]
}

/**
 * A line cut to a rectangle (map units): the runs inside it, and whether
 * each of their ends was cut.
 */
export function clipLine(
  line: ArrayLike<number>,
  rect: readonly number[]
): { points: number[]; cut: [boolean, boolean] }[] {
  const runs: { points: number[]; cut: [boolean, boolean] }[] = []
  let run: { points: number[]; cut: [boolean, boolean] } | undefined
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, ay, bx, by] = [line[i], line[i + 1], line[i + 2], line[i + 3]]
    const cut = clipSegmentT(ax, ay, bx, by, rect)
    if (!cut) {
      if (run) runs.push(run)
      run = undefined
      continue
    }
    const [t0, t1] = cut
    const [px, py] = [ax + (bx - ax) * t0, ay + (by - ay) * t0]
    const [qx, qy] = [ax + (bx - ax) * t1, ay + (by - ay) * t1]
    run ??= { points: [px, py], cut: [t0 > 0, false] }
    run.points.push(qx, qy)
    if (t1 < 1) {
      run.cut[1] = true
      runs.push(run)
      run = undefined
    }
  }
  if (run) runs.push(run)
  return runs.filter(({ points }) => points.length >= 4)
}
