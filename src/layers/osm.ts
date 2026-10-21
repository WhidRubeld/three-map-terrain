// What the layers share for OpenStreetMap through Overpass: elements,
// positions, multipolygons. Internal.

import type { Position } from './features'

export interface OverpassPoint {
  lat: number
  lon: number
}

export interface OverpassElement {
  type: string
  id: number
  /** A node's position. */
  lat?: number
  lon?: number
  tags?: Record<string, string>
  geometry?: (OverpassPoint | null)[]
  members?: {
    type: string
    role: string
    geometry?: (OverpassPoint | null)[]
  }[]
}

export const toPositions = (
  points: (OverpassPoint | null)[] = []
): Position[] =>
  points.flatMap((point) => (point ? [[point.lon, point.lat]] : []))

const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1]

const isClosed = (ring: readonly Position[]) =>
  ring.length >= 4 && same(ring[0], ring[ring.length - 1])

/** Joins the member ways of a multipolygon into closed rings. */
export function joinRings(ways: readonly Position[][]): Position[][] {
  const open = ways.filter((way) => way.length >= 2).map((way) => [...way])
  const rings: Position[][] = []
  while (open.length > 0) {
    let ring = open.shift() ?? []
    while (!isClosed(ring)) {
      const last = ring[ring.length - 1]
      const index = open.findIndex(
        (way) => same(way[0], last) || same(way[way.length - 1], last)
      )
      if (index === -1) break // unclosed: dropped
      const [way] = open.splice(index, 1)
      ring = ring.concat(
        same(way[0], last) ? way.slice(1) : [...way].reverse().slice(1)
      )
    }
    if (isClosed(ring)) rings.push(ring)
  }
  return rings
}

/** Ray casting point-in-polygon (`[lon, lat]`). */
export function pointInRing([x, y]: Position, ring: readonly Position[]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Polygons (outer ring, then its holes) of a way or multipolygon relation. */
export function polygonsOf(element: OverpassElement): Position[][][] {
  if (element.type === 'way') {
    const ring = toPositions(element.geometry)
    return isClosed(ring) ? [[ring]] : []
  }
  const ways = (role: string) =>
    (element.members ?? [])
      .filter((member) => member.type === 'way' && member.role === role)
      .map((member) => toPositions(member.geometry))
  const polygons = joinRings([...ways('outer'), ...ways('')]).map((outer) => [
    outer
  ])
  for (const inner of joinRings(ways('inner'))) {
    const owner =
      polygons.find(([outer]) => pointInRing(inner[0], outer)) ?? polygons[0]
    owner.push(inner)
  }
  return polygons
}
