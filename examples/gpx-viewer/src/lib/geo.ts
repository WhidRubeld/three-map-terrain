export interface LatLon {
  lat: number
  lon: number
}

/** Geographic bounds in degrees. */
export interface Bounds {
  south: number
  west: number
  north: number
  east: number
}

export const EARTH_RADIUS = 6371008.8
/** Equatorial circumference of the Web Mercator sphere, in meters. */
export const EARTH_CIRCUMFERENCE = 40075016.686

const toRad = (deg: number) => (deg * Math.PI) / 180

/** Great-circle distance in meters. */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function boundsOf(points: Iterable<LatLon>): Bounds {
  const bounds = { south: 90, west: 180, north: -90, east: -180 }
  for (const { lat, lon } of points) {
    bounds.south = Math.min(bounds.south, lat)
    bounds.north = Math.max(bounds.north, lat)
    bounds.west = Math.min(bounds.west, lon)
    bounds.east = Math.max(bounds.east, lon)
  }
  return bounds
}

/** Grows `bounds` to at least `meters` across in both directions. */
export function minimumBounds(bounds: Bounds, meters: number): Bounds {
  const lat = (bounds.south + bounds.north) / 2
  const dLat = (meters / EARTH_RADIUS) * (180 / Math.PI)
  const dLon = dLat / Math.max(0.01, Math.cos(toRad(lat)))
  const grow = (min: number, max: number, size: number) => {
    const missing = Math.max(0, size - (max - min)) / 2
    return [min - missing, max + missing] as const
  }
  const [south, north] = grow(bounds.south, bounds.north, dLat)
  const [west, east] = grow(bounds.west, bounds.east, dLon)
  return { south, west, north, east }
}

export function boundsCenter(bounds: Bounds): LatLon {
  return {
    lat: (bounds.south + bounds.north) / 2,
    lon: (bounds.west + bounds.east) / 2
  }
}

/** A "nice" step (1, 2 or 5 × 10ⁿ) close to `rough`. */
export function niceStep(rough: number): number {
  const power = 10 ** Math.floor(Math.log10(rough))
  const fraction = rough / power
  const nice = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10
  return nice * power
}

/** Index of the last element ≤ `value` in a sorted array, interpolated. */
export function fractionalIndex(
  sorted: ArrayLike<number>,
  value: number
): number {
  const last = sorted.length - 1
  if (last <= 0 || value <= sorted[0]) return 0
  if (value >= sorted[last]) return last
  let low = 0
  let high = last
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (sorted[mid] <= value) low = mid
    else high = mid
  }
  const span = sorted[high] - sorted[low]
  return low + (span > 0 ? (value - sorted[low]) / span : 0)
}
