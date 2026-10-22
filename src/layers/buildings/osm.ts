// OpenStreetMap buildings: tags → heights, Overpass API JSON → features.

import type { BuildingAttributes, BuildingFeature } from './features'
import { isColor, LEVEL_HEIGHT, ringAnchor } from './features'
import { parseLength, toNumber } from '../features'
import {
  joinRings,
  type OverpassElement,
  overpassQl,
  pointInRing,
  polygonsOf
} from '../osm'

// kept here for the tests and older imports
export { joinRings, pointInRing }

/**
 * A count of levels; several — the sections of one building, `9;10` or
 * `9,10` — give the highest (or with `pick = Math.min` the lowest).
 */
function levelsOf(
  value: string | undefined,
  pick: (...counts: number[]) => number = Math.max
): number | undefined {
  const counts = (value ?? '').split(/[;,]/).flatMap((part) => {
    const count = part.trim() === '' ? undefined : toNumber(part)
    return count === undefined ? [] : [count]
  })
  return counts.length > 0 ? pick(...counts) : undefined
}

/** Height, min height and color of an OSM building or part from its tags. */
export function osmBuildingAttributes(
  tags: Readonly<Record<string, string | undefined>>
): BuildingAttributes {
  const levels = levelsOf(tags['building:levels'])
  const roofLevels = levelsOf(tags['roof:levels']) ?? 0
  const minLevel = levelsOf(tags['building:min_level'], Math.min)
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

/**
 * The Overpass QL query for the buildings in a bounding box — and the
 * elements of `more` selectors.
 */
export function overpassQuery(
  bbox: readonly number[],
  more: readonly string[] = []
) {
  return overpassQl(bbox, [
    'way["building"]',
    'relation["building"]["type"="multipolygon"]',
    'way["building:part"]',
    'relation["building:part"]["type"="multipolygon"]',
    ...more
  ])
}
