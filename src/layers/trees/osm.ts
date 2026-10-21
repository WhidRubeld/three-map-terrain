// OpenStreetMap trees: Overpass API JSON → single trees and woods.

import { parseLength } from '../features'
import { type OverpassElement, polygonsOf } from '../osm'
import type { TreeFeature } from './features'

/**
 * Trees from an Overpass API `out body geom` response: `natural=tree`
 * nodes (with their `height`), and woods — `natural=wood`,
 * `landuse=forest` — as areas to fill.
 */
export function treesFromOverpass(response: unknown): TreeFeature[] {
  const elements =
    (response as { elements?: OverpassElement[] } | null)?.elements ?? []
  return elements.flatMap((element): TreeFeature[] => {
    const tags: Readonly<Record<string, string | undefined>> =
      element.tags ?? {}
    const id = `${element.type}/${element.id}`
    if (element.type === 'node') {
      if (element.lat === undefined || element.lon === undefined) return []
      return [
        {
          id,
          geometry: { type: 'Point', coordinates: [element.lon, element.lat] },
          height: parseLength(tags.height),
          kind: 'tree',
          properties: tags
        }
      ]
    }
    const polygons = polygonsOf(element)
    if (polygons.length === 0) return []
    return [
      {
        id,
        geometry:
          polygons.length === 1
            ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons },
        kind: tags.natural ?? tags.landuse,
        properties: tags
      }
    ]
  })
}

/** The Overpass QL query for the trees and woods in a bounding box. */
export function overpassTreesQuery([
  west,
  south,
  east,
  north
]: readonly number[]) {
  const bbox = `(${south},${west},${north},${east})`
  return (
    `[out:json][timeout:60];(` +
    `node["natural"="tree"]${bbox};` +
    `way["natural"="wood"]${bbox};relation["natural"="wood"]["type"="multipolygon"]${bbox};` +
    `way["landuse"="forest"]${bbox};relation["landuse"="forest"]["type"="multipolygon"]${bbox};` +
    `);out body geom qt;`
  )
}
