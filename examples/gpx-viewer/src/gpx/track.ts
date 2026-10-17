import {
  type Bounds,
  boundsOf,
  fractionalIndex,
  haversine,
  type LatLon,
  minimumBounds
} from '../lib/geo'
import type { GpxDocument, GpxMetadata, GpxPoint, GpxWaypoint } from './parse'

export interface TrackWaypoint extends GpxWaypoint {
  /** index of the nearest track point */
  index: number
  /** distance along the track to that point, m */
  distance: number
  /** distance from the track, m */
  offset: number
}

export interface TrackStats {
  points: number
  distance: number
  startTime: number | null
  endTime: number | null
  /** ms */
  duration: number | null
  movingTime: number | null
  /** m/s */
  avgSpeed: number | null
  movingSpeed: number | null
  maxSpeed: number | null
  ascent: number | null
  descent: number | null
  minEle: number | null
  maxEle: number | null
  maxGrade: number | null
  minGrade: number | null
  avgHr: number | null
  maxHr: number | null
}

export interface Track {
  name: string
  type: string | null
  metadata: GpxMetadata
  points: GpxPoint[]
  /** index of the first point of every segment */
  segmentStarts: number[]
  waypoints: TrackWaypoint[]
  /** cumulative distance, m */
  distance: Float64Array
  /** m, NaN where unknown */
  elevation: Float32Array
  elevationSource: 'gpx' | 'dem' | 'none'
  /** ms since epoch, non-decreasing; `null` without timestamps */
  times: Float64Array | null
  /** smoothed speed, m/s (NaN without timestamps) */
  speed: Float32Array
  /** smoothed grade, rise/run */
  grade: Float32Array
  bounds: Bounds
  stats: TrackStats
}

/** Below this speed (m/s) a fix counts as standing still. */
const MOVING_SPEED = 0.5
/** Elevation changes smaller than this (m) are treated as noise. */
const ELEVATION_HYSTERESIS = 3

export function buildTrack(doc: GpxDocument, fallbackName: string): Track {
  const points: GpxPoint[] = []
  const segmentStarts: number[] = []
  for (const segment of doc.segments) {
    segmentStarts.push(points.length)
    points.push(...segment)
  }

  // gaps between segments are not part of the distance
  const distance = new Float64Array(points.length)
  const starts = new Set(segmentStarts)
  for (let i = 1; i < points.length; i++) {
    distance[i] =
      distance[i - 1] +
      (starts.has(i) ? 0 : haversine(points[i - 1], points[i]))
  }

  const elevation = Float32Array.from(points, (p) => p.ele ?? Number.NaN)
  const known = elevation.filter((e) => !Number.isNaN(e)).length
  const elevationSource = known >= points.length * 0.5 ? 'gpx' : 'none'
  if (elevationSource === 'gpx') fillGaps(elevation, distance)
  else elevation.fill(Number.NaN)

  const bounds = minimumBounds(boundsOf(points), 300)
  const track = derive({
    name: doc.metadata.name ?? doc.name ?? fallbackName,
    type: doc.type,
    metadata: doc.metadata,
    points,
    segmentStarts,
    distance,
    elevation,
    elevationSource,
    times: readTimes(points, distance),
    bounds
  })
  track.waypoints = doc.waypoints.map((w) => locate(track, w))
  return track
}

/** Returns a copy with elevations from the terrain where the GPX had none. */
export function withTerrainElevation(
  track: Track,
  sample: (point: LatLon) => number | undefined
): Track {
  if (track.elevationSource !== 'none') return track
  const elevation = Float32Array.from(
    track.points,
    (p) => sample(p) ?? Number.NaN
  )
  const known = elevation.filter((e) => !Number.isNaN(e)).length
  if (known < track.points.length * 0.5) return track
  fillGaps(elevation, track.distance)
  const waypoints = track.waypoints.map((w) => ({
    ...w,
    ele: w.ele ?? sample(w) ?? null
  }))
  return {
    ...derive({ ...track, elevation, elevationSource: 'dem' }),
    waypoints
  }
}

type TrackBase = Omit<Track, 'speed' | 'grade' | 'stats' | 'waypoints'>

function derive(base: TrackBase): Track {
  const speed = smoothedSpeed(base.distance, base.times)
  const grade = smoothedGrade(base.distance, base.elevation)
  return {
    ...base,
    waypoints: [],
    speed,
    grade,
    stats: computeStats(base, speed, grade)
  }
}

/** Interpolates NaN elevations over distance (and extends the ends). */
function fillGaps(values: Float32Array | Float64Array, distance: Float64Array) {
  let previous = -1
  for (let i = 0; i <= values.length; i++) {
    if (i < values.length && Number.isNaN(values[i])) continue
    if (i - previous > 1) {
      for (let k = previous + 1; k < i; k++) {
        if (previous < 0) values[k] = values[i]
        else if (i >= values.length) values[k] = values[previous]
        else {
          const span = distance[i] - distance[previous]
          const t = span > 0 ? (distance[k] - distance[previous]) / span : 0
          values[k] = values[previous] + (values[i] - values[previous]) * t
        }
      }
    }
    previous = i
  }
}

/** Timestamps if (almost) every point has one; gaps interpolated, never decreasing. */
function readTimes(
  points: GpxPoint[],
  distance: Float64Array
): Float64Array | null {
  const times = Float64Array.from(points, (p) => p.time ?? Number.NaN)
  const known = times.filter((t) => !Number.isNaN(t)).length
  if (known < Math.max(2, points.length * 0.9)) return null
  fillGaps(times, distance)
  for (let i = 1; i < times.length; i++)
    times[i] = Math.max(times[i], times[i - 1])
  return times[times.length - 1] > times[0] ? times : null
}

/** Speed over a ±15 s window. */
function smoothedSpeed(
  distance: Float64Array,
  times: Float64Array | null
): Float32Array {
  const speed = new Float32Array(distance.length).fill(Number.NaN)
  if (!times) return speed
  const window = 15_000
  let low = 0
  let high = 0
  for (let i = 0; i < distance.length; i++) {
    while (times[low] < times[i] - window) low++
    while (high < distance.length - 1 && times[high + 1] <= times[i] + window)
      high++
    const dt = (times[high] - times[low]) / 1000
    speed[i] = dt > 0 ? (distance[high] - distance[low]) / dt : 0
  }
  return speed
}

/** Moving average over ±`window` m of distance. */
function smoothed(
  distance: Float64Array,
  values: Float32Array,
  window: number
): Float32Array {
  const result = new Float32Array(values.length)
  let low = 0
  let high = -1
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    while (
      high < values.length - 1 &&
      distance[high + 1] <= distance[i] + window
    )
      sum += values[++high]
    while (distance[low] < distance[i] - window) sum -= values[low++]
    result[i] = sum / (high - low + 1)
  }
  return result
}

/** Grade over a ±40 m window. */
function smoothedGrade(
  distance: Float64Array,
  elevation: Float32Array
): Float32Array {
  const grade = new Float32Array(distance.length)
  if (Number.isNaN(elevation[0])) return grade
  const window = 40
  let low = 0
  let high = 0
  for (let i = 0; i < distance.length; i++) {
    while (distance[low] < distance[i] - window) low++
    while (
      high < distance.length - 1 &&
      distance[high + 1] <= distance[i] + window
    )
      high++
    const run = distance[high] - distance[low]
    grade[i] = run > 5 ? (elevation[high] - elevation[low]) / run : 0
  }
  return grade
}

function computeStats(
  base: TrackBase,
  speed: Float32Array,
  grade: Float32Array
): TrackStats {
  const { points, distance, elevation, times } = base
  const n = points.length
  const total = distance[n - 1]

  let ascent: number | null = null
  let descent: number | null = null
  let minEle: number | null = null
  let maxEle: number | null = null
  if (!Number.isNaN(elevation[0])) {
    ascent = 0
    descent = 0
    minEle = maxEle = elevation[0]
    for (const e of elevation) {
      minEle = Math.min(minEle, e)
      maxEle = Math.max(maxEle, e)
    }
    // per segment: the jump across a recording gap is not climbing
    const ends = [...base.segmentStarts.slice(1), n]
    base.segmentStarts.forEach((start, s) => {
      const range = [start, ends[s]] as const
      const smooth = smoothed(
        distance.subarray(...range),
        elevation.subarray(...range),
        25
      )
      let reference = smooth[0]
      for (const e of smooth) {
        if (e - reference >= ELEVATION_HYSTERESIS) {
          ascent! += e - reference
          reference = e
        } else if (reference - e >= ELEVATION_HYSTERESIS) {
          descent! += reference - e
          reference = e
        }
      }
    })
  }

  let duration: number | null = null
  let movingTime: number | null = null
  let maxSpeed: number | null = null
  if (times) {
    duration = times[n - 1] - times[0]
    movingTime = 0
    maxSpeed = 0
    for (let i = 1; i < n; i++) {
      const dt = times[i] - times[i - 1]
      const dd = distance[i] - distance[i - 1]
      if (dt > 0 && dt < 5 * 60_000 && dd / (dt / 1000) > MOVING_SPEED)
        movingTime += dt
      maxSpeed = Math.max(maxSpeed, speed[i])
    }
  }

  const hr = points.map((p) => p.hr).filter((v): v is number => v !== null)
  let maxGrade: number | null = null
  let minGrade: number | null = null
  if (ascent !== null) {
    maxGrade = Math.max(...grade)
    minGrade = Math.min(...grade)
  }

  return {
    points: n,
    distance: total,
    startTime: times ? times[0] : null,
    endTime: times ? times[n - 1] : null,
    duration,
    movingTime,
    avgSpeed: duration ? total / (duration / 1000) : null,
    movingSpeed: movingTime ? total / (movingTime / 1000) : null,
    maxSpeed,
    ascent,
    descent,
    minEle,
    maxEle,
    maxGrade,
    minGrade,
    avgHr: hr.length ? hr.reduce((a, b) => a + b, 0) / hr.length : null,
    maxHr: hr.length ? Math.max(...hr) : null
  }
}

function locate(track: Track, waypoint: GpxWaypoint): TrackWaypoint {
  let index = 0
  let offset = Infinity
  track.points.forEach((point, i) => {
    const d = haversine(point, waypoint)
    if (d < offset) {
      offset = d
      index = i
    }
  })
  return { ...waypoint, index, distance: track.distance[index], offset }
}

// ------------------------------------------------------------ sampling

/** Fractional point index at `progress` ∈ [0, 1] — by time when the track has it. */
export function indexAtProgress(track: Track, progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  if (track.times) {
    const start = track.times[0]
    return fractionalIndex(
      track.times,
      start + p * (track.times[track.times.length - 1] - start)
    )
  }
  return fractionalIndex(track.distance, p * track.stats.distance)
}

/** Inverse of `indexAtProgress`. */
export function progressAtIndex(track: Track, index: number): number {
  const value = (array: ArrayLike<number>) => {
    const i = Math.min(Math.max(index, 0), array.length - 1)
    const low = Math.floor(i)
    const high = Math.min(low + 1, array.length - 1)
    return array[low] + (array[high] - array[low]) * (i - low)
  }
  if (track.times) {
    const start = track.times[0]
    const span = track.times[track.times.length - 1] - start
    return span > 0 ? (value(track.times) - start) / span : 0
  }
  return track.stats.distance > 0
    ? value(track.distance) / track.stats.distance
    : 0
}

export interface TrackSample {
  index: number
  lat: number
  lon: number
  ele: number | null
  time: number | null
  distance: number
  speed: number | null
  grade: number | null
  hr: number | null
}

/** Values interpolated at a fractional point index. */
export function sampleTrack(track: Track, index: number): TrackSample {
  const last = track.points.length - 1
  const i = Math.min(Math.max(index, 0), last)
  const low = Math.floor(i)
  const high = Math.min(low + 1, last)
  const t = i - low
  const mix = (a: number, b: number) => a + (b - a) * t
  const a = track.points[low]
  const b = track.points[high]
  const ele = mix(track.elevation[low], track.elevation[high])
  const speed = mix(track.speed[low], track.speed[high])
  return {
    index: i,
    lat: mix(a.lat, b.lat),
    lon: mix(a.lon, b.lon),
    ele: Number.isNaN(ele) ? null : ele,
    time: track.times ? mix(track.times[low], track.times[high]) : null,
    distance: mix(track.distance[low], track.distance[high]),
    speed: Number.isNaN(speed) ? null : speed,
    grade:
      track.elevationSource === 'none'
        ? null
        : mix(track.grade[low], track.grade[high]),
    hr: a.hr
  }
}
