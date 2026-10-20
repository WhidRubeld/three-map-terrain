// OpenStreetMap buildings: tags → heights, Overpass API JSON → features.

import type { BuildingAttributes, BuildingFeature, Position } from './features'
import { isColor, LEVEL_HEIGHT, ringAnchor, toNumber } from './features'

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

/** Height, min height and color of an OSM building or part from its tags. */
export function osmBuildingAttributes(
  tags: Readonly<Record<string, string | undefined>>
): BuildingAttributes {
  const levels = toNumber(tags['building:levels'])
  const roofLevels = toNumber(tags['roof:levels']) ?? 0
  const minLevel = toNumber(tags['building:min_level'])
  const color = tags['building:colour']?.trim()

  return {
    height:
      parseLength(tags.height) ??
      parseLength(tags['building:height']) ??
      (levels === undefined ? undefined : (levels + roofLevels) * LEVEL_HEIGHT),
    minHeight:
      parseLength(tags.min_height) ??
      (minLevel === undefined ? undefined : minLevel * LEVEL_HEIGHT),
    color: color && isColor(color) ? color : undefined,
    hidden:
      tags.location === 'underground' ||
      tags.building === 'no' ||
      tags['building:part'] === 'no'
  }
}

interface OverpassPoint {
  lat: number
  lon: number
}

interface OverpassElement {
  type: string
  id: number
  tags?: Record<string, string>
  geometry?: (OverpassPoint | null)[]
  members?: {
    type: string
    role: string
    geometry?: (OverpassPoint | null)[]
  }[]
}

const toPositions = (points: (OverpassPoint | null)[] = []): Position[] =>
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
function polygonsOf(element: OverpassElement): Position[][][] {
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

/**
 * Buildings from an Overpass API `out body geom` response with
 * `building` / `building:part` ways and multipolygons. Outlines that contain
 * building parts are left out: the parts model them (Simple 3D Buildings).
 */
export function buildingsFromOverpass(response: unknown): BuildingFeature[] {
  const elements =
    (response as { elements?: OverpassElement[] } | null)?.elements ?? []

  const shapes = elements.flatMap((element) => {
    const tags = element.tags ?? {}
    const attributes = osmBuildingAttributes(tags)
    const polygons = polygonsOf(element)
    if (attributes.hidden || polygons.length === 0) return []
    const isPart = 'building:part' in tags
    return [{ element, tags, attributes, polygons, isPart }]
  })

  const partAnchors = shapes
    .filter((shape) => shape.isPart)
    .map((shape) => ringAnchor(shape.polygons[0][0]))

  return shapes
    .filter(
      (shape) =>
        shape.isPart ||
        !shape.polygons.some(([outer]) =>
          partAnchors.some((anchor) => pointInRing(anchor, outer))
        )
    )
    .map(({ element, tags, attributes, polygons }): BuildingFeature => ({
      id: `${element.type}/${element.id}`,
      geometry:
        polygons.length === 1
          ? { type: 'Polygon', coordinates: polygons[0] }
          : { type: 'MultiPolygon', coordinates: polygons },
      height: attributes.height,
      minHeight: attributes.minHeight,
      color: attributes.color,
      properties: tags
    }))
}

/** The Overpass QL query for the buildings in a bounding box. */
export function overpassQuery([west, south, east, north]: readonly number[]) {
  const bbox = `(${south},${west},${north},${east})`
  return (
    `[out:json][timeout:60];(` +
    `way["building"]${bbox};relation["building"]["type"="multipolygon"]${bbox};` +
    `way["building:part"]${bbox};relation["building:part"]["type"="multipolygon"]${bbox};` +
    `);out body geom qt;`
  )
}
