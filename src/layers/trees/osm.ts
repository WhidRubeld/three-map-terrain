// OpenStreetMap trees: Overpass API JSON → single trees and woods.

import { parseLength } from '../features'
import { type OverpassElement, overpassQl, polygonsOf } from '../osm'
import type { TreeFeature } from './features'

/**
 * Trees from an Overpass API `out body geom` response: nodes — `natural=tree`,
 * with their `height` — as single trees, and woods — `natural=wood`,
 * `landuse=forest` — as areas to fill; their `kind` is the `natural` tag
 * (or `landuse`).
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
          kind: tags.natural ?? 'tree',
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

/**
 * The Overpass QL query for the trees and woods in a bounding box — and
 * the elements of `more` selectors, e.g. `'way["natural"="scrub"]'`.
 */
export function overpassTreesQuery(
  bbox: readonly number[],
  more: readonly string[] = []
) {
  return overpassQl(bbox, [
    'node["natural"="tree"]',
    'way["natural"="wood"]',
    'relation["natural"="wood"]["type"="multipolygon"]',
    'way["landuse"="forest"]',
    'relation["landuse"="forest"]["type"="multipolygon"]',
    ...more
  ])
}
