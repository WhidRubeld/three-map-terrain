// OpenStreetMap water: Overpass API JSON → areas and waterways.

import { parseLength } from '../features'
import {
  type OverpassElement,
  overpassQl,
  polygonsOf,
  toPositions
} from '../osm'
import type { WaterFeature } from './features'

/** Waterways drawn as lines. */
const WATERWAYS = 'river|canal|stream|ditch|drain'

/**
 * Water from an Overpass API `out body geom` response: `natural=water` and
 * reservoirs as areas (multipolygons with their islands), waterways as lines.
 */
export function waterFromOverpass(response: unknown): WaterFeature[] {
  const elements =
    (response as { elements?: OverpassElement[] } | null)?.elements ?? []
  return elements.flatMap((element): WaterFeature[] => {
    const tags: Readonly<Record<string, string | undefined>> =
      element.tags ?? {}
    if (tags.tunnel !== undefined && tags.tunnel !== 'no') return []
    const id = `${element.type}/${element.id}`
    const { waterway } = tags
    if (
      element.type === 'way' &&
      waterway !== undefined &&
      new RegExp(`^(${WATERWAYS})$`).test(waterway)
    ) {
      const line = toPositions(element.geometry)
      if (line.length < 2) return []
      return [
        {
          id,
          geometry: { type: 'LineString', coordinates: line },
          kind: waterway,
          width: parseLength(tags.width),
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
        kind: tags.water ?? tags.natural ?? tags.landuse,
        properties: tags
      }
    ]
  })
}

/**
 * The Overpass QL query for the water in a bounding box — and the elements
 * of `more` selectors.
 */
export function overpassWaterQuery(
  bbox: readonly number[],
  more: readonly string[] = []
) {
  return overpassQl(bbox, [
    'way["natural"="water"]',
    'relation["natural"="water"]["type"="multipolygon"]',
    'way["landuse"="reservoir"]',
    `way["waterway"~"^(${WATERWAYS})$"]`,
    ...more
  ])
}
