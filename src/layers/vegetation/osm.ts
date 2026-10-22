// OpenStreetMap vegetation: Overpass API JSON → woods, scrub, single trees
// and bushes.

import { parseLength } from '../features'
import { type OverpassElement, overpassQl, polygonsOf } from '../osm'
import type { VegetationFeature } from './features'

/**
 * Vegetation from an Overpass API `out body geom` response: nodes —
 * `natural=tree`, `natural=shrub`, with their `height` — as single plants,
 * and woods — `natural=wood`, `landuse=forest` — and scrub —
 * `natural=scrub`, `natural=shrubbery` — as areas to fill; their `kind` is
 * the `natural` tag (or `landuse`).
 */
export function vegetationFromOverpass(response: unknown): VegetationFeature[] {
  const elements =
    (response as { elements?: OverpassElement[] } | null)?.elements ?? []
  return elements.flatMap((element): VegetationFeature[] => {
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
 * The Overpass QL query for the woods, scrub, single trees and bushes in a
 * bounding box — and the elements of `more` selectors, e.g.
 * `'way["landuse"="orchard"]'`.
 */
export function overpassVegetationQuery(
  bbox: readonly number[],
  more: readonly string[] = []
) {
  return overpassQl(bbox, [
    'node["natural"="tree"]',
    'node["natural"="shrub"]',
    'way["natural"="wood"]',
    'relation["natural"="wood"]["type"="multipolygon"]',
    'way["landuse"="forest"]',
    'relation["landuse"="forest"]["type"="multipolygon"]',
    'way["natural"="scrub"]',
    'relation["natural"="scrub"]["type"="multipolygon"]',
    'way["natural"="shrubbery"]',
    ...more
  ])
}
