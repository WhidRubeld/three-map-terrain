// What the features of every layer share: GeoJSON-like positions, reading
// attributes, cutting rings.

/** A GeoJSON position: `[lon, lat]` in degrees (further values are ignored). */
export type Position = readonly number[]

/** A ring of positions; it may or may not repeat its first position. */
export type Ring = readonly Position[]

export const toNumber = (value: unknown): number | undefined => {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number)
    ? number
    : undefined
}

const FEET = 0.3048
const INCHES = 0.0254

/**
 * Parses an OSM length (`height`, `min_height`): `12`, `12.5 m`, `12,5`,
 * `40 ft`, `40'6"`; the first of `;`-separated values. Meters.
 */
export function parseLength(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const text = value.split(';')[0].trim().replace(',', '.')

  const imperial = /^(\d+(?:\.\d+)?)\s*'(?:\s*(\d+(?:\.\d+)?)\s*")?$/.exec(text)
  if (imperial) {
    return Number(imperial[1]) * FEET + Number(imperial.at(2) ?? 0) * INCHES
  }
  const match = /^(-?\d+(?:\.\d+)?)\s*(m|ft|feet)?$/i.exec(text)
  if (!match) return undefined
  const number = Number(match[1])
  const unit = match.at(2)?.toLowerCase()
  return unit === undefined || unit === 'm' ? number : number * FEET
}

/** Signed area of a flat `[x0, y0, x1, y1, …]` ring (shoelace). */
export function ringArea(ring: readonly number[]) {
  let area = 0
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    area += (ring[j] - ring[i]) * (ring[j + 1] + ring[i + 1])
  }
  return area / 2
}

export const isRing = (ring: readonly number[]) =>
  ring.length >= 6 && ringArea(ring) !== 0

/** Sutherland–Hodgman against one side of the tile square. */
function clipSide(
  ring: readonly number[],
  inside: (x: number, y: number) => boolean,
  cross: (ax: number, ay: number, bx: number, by: number) => [number, number]
) {
  const out: number[] = []
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + ring.length - 2) % ring.length
    const [ax, ay, bx, by] = [ring[j], ring[j + 1], ring[i], ring[i + 1]]
    const aIn = inside(ax, ay)
    const bIn = inside(bx, by)
    if (bIn) {
      if (!aIn) out.push(...cross(ax, ay, bx, by))
      out.push(bx, by)
    } else if (aIn) {
      out.push(...cross(ax, ay, bx, by))
    }
  }
  return out
}

/** Clips a flat ring to a rectangle (Sutherland–Hodgman). */
export function clipRect(
  ring: readonly number[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): number[] {
  const atX = (x: number) => (ax: number, ay: number, bx: number, by: number) =>
    [x, ay + ((by - ay) * (x - ax)) / (bx - ax)] as [number, number]
  const atY = (y: number) => (ax: number, ay: number, bx: number, by: number) =>
    [ax + ((bx - ax) * (y - ay)) / (by - ay), y] as [number, number]
  let clipped = clipSide(ring, (x) => x >= minX, atX(minX))
  clipped = clipSide(clipped, (x) => x <= maxX, atX(maxX))
  clipped = clipSide(clipped, (_, y) => y >= minY, atY(minY))
  return clipSide(clipped, (_, y) => y <= maxY, atY(maxY))
}
