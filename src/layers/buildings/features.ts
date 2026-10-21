// Building footprints as GeoJSON-like features, and from vector tiles.

import { Color } from 'three'

import { gunzip, type VectorTileValue } from '../../io/mvt'
import { VectorTileData } from '../../sources/vector-tiles'
import {
  clipRect,
  isRing,
  type Position,
  type Ring,
  ringArea,
  toNumber
} from '../features'

export type BuildingId = string | number

/** GeoJSON `Polygon` / `MultiPolygon`: each polygon is an outer ring, then its holes. */
export type BuildingGeometry =
  | { readonly type: 'Polygon'; readonly coordinates: readonly Ring[] }
  | {
      readonly type: 'MultiPolygon'
      readonly coordinates: readonly (readonly Ring[])[]
    }

/** One building (or building part) as a source delivers it. */
export interface BuildingFeature {
  /** Identifies the building, e.g. its OSM id; `highlight()` accepts it. */
  id?: BuildingId
  geometry: BuildingGeometry
  /** Meters from the ground to the top (the roof). */
  height?: number
  /** Meters from the ground to the bottom: above 0 for overhangs and parts. */
  minHeight?: number
  /** CSS color of the building, drawn with `featureColors: true`. */
  color?: string
  /** Everything the source knows about it: OSM tags, vector tile properties. */
  properties: Record<string, unknown>
}

/** How a vector tile feature becomes a building; `hidden` drops it. */
export interface BuildingAttributes {
  id?: BuildingId
  height?: number
  minHeight?: number
  color?: string
  hidden?: boolean
}

export type BuildingProperties = (
  properties: Record<string, VectorTileValue>,
  layer: string
) => BuildingAttributes

export interface VectorTileBuildingsOptions {
  /** Layers holding the buildings; default `'building'`. */
  layers?: string | readonly string[]
  /** Reads the attributes from feature properties; default: OpenMapTiles fields. */
  properties?: BuildingProperties
}

/** Meters per level, for heights given as a number of floors. */
export const LEVEL_HEIGHT = 3

/** Center of a ring's bounding box. */
export function ringAnchor(ring: Ring): Position {
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon)
    east = Math.max(east, lon)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return [(west + east) / 2, (south + north) / 2]
}

/** `#rgb`, `#rrggbb` or a CSS color name: what `Color` parses silently. */
export const isColor = (value: string) =>
  /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ||
  Object.hasOwn(Color.NAMES, value.toLowerCase())

const toColor = (value: unknown) =>
  typeof value === 'string' && isColor(value.trim()) ? value.trim() : undefined

/** OpenMapTiles `building` layer (OpenFreeMap, MapTiler, self-hosted). */
export const openMapTilesProperties: BuildingProperties = (p) => ({
  height: toNumber(p.render_height),
  minHeight: toNumber(p.render_min_height),
  color: toColor(p.colour),
  hidden: p.hide_3d === true
})

/** Mapbox Streets v8 `building` layer. */
export const mapboxStreetsProperties: BuildingProperties = (p) => ({
  height: toNumber(p.height),
  minHeight: toNumber(p.min_height),
  hidden: p.extrude === 'false' || p.underground === 'true'
})

/** Protomaps basemap `buildings` layer. */
export const protomapsProperties: BuildingProperties = (p) => ({
  height: toNumber(p.height),
  minHeight: toNumber(p.min_height)
})

/** Shortbread `buildings` layer (VersaTiles): footprints only. */
export const shortbreadProperties: BuildingProperties = () => ({})

/**
 * Overture Maps `building` and `building_part` layers (their PMTiles
 * archives): outlines with parts are left to the parts.
 */
export const overtureProperties: BuildingProperties = (p) => {
  const floors = toNumber(p.num_floors)
  return {
    id: typeof p.id === 'string' ? p.id : undefined,
    height:
      toNumber(p.height) ??
      (floors === undefined ? undefined : floors * LEVEL_HEIGHT),
    minHeight: toNumber(p.min_height),
    color: toColor(p.facade_color),
    hidden: p.has_parts === true || p.is_underground === true
  }
}

/** Clips a ring to `[0, extent]²`: buffered geometry would be drawn twice. */
export const clipRing = (ring: readonly number[], extent: number) =>
  clipRect(ring, 0, 0, extent, extent)

/**
 * Groups the rings of a vector tile polygon into polygons: per the spec an
 * outer ring has the sign of the first one, a hole the opposite sign.
 */
export function classifyRings(rings: readonly number[][]): number[][][] {
  const polygons: number[][][] = []
  let outerSign = 0
  for (const ring of rings) {
    const area = ringArea(ring)
    if (area === 0 || ring.length < 6) continue
    if (outerSign === 0) outerSign = Math.sign(area)
    if (Math.sign(area) === outerSign || polygons.length === 0) {
      polygons.push([ring])
    } else {
      polygons[polygons.length - 1].push(ring)
    }
  }
  return polygons
}

/**
 * Buildings of one vector tile (MVT; gzip is detected), clipped to the tile
 * and in `[lon, lat]`. Every polygon becomes its own building: tile
 * generators merge buildings with equal attributes into one multi-polygon.
 * A merged feature has no single id, so only single-polygon features keep it.
 */
export async function buildingsFromVectorTile(
  data: ArrayBuffer | Uint8Array,
  tile: { readonly z: number; readonly x: number; readonly y: number },
  options: VectorTileBuildingsOptions = {}
): Promise<BuildingFeature[]> {
  return readBuildings(new VectorTileData(await gunzip(data)), tile, options)
}

/** `buildingsFromVectorTile` for a tile already decoded. */
export function readBuildings(
  data: VectorTileData,
  tile: { readonly z: number; readonly x: number; readonly y: number },
  {
    layers = 'building',
    properties = openMapTilesProperties
  }: VectorTileBuildingsOptions = {}
): BuildingFeature[] {
  const names = typeof layers === 'string' ? [layers] : layers
  const scale = 2 ** tile.z
  const buildings: BuildingFeature[] = []

  for (const name of names) {
    const layer = data.layer(name)
    if (!layer) continue
    const { extent } = layer
    const toPosition = (px: number, py: number): Position => {
      const mercatorY = (tile.y + py / extent) / scale
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY)))
      return [
        ((tile.x + px / extent) / scale) * 360 - 180,
        (lat * 180) / Math.PI
      ]
    }
    const toRing = (ring: number[]) => {
      const positions: Position[] = []
      for (let i = 0; i < ring.length; i += 2) {
        positions.push(toPosition(ring[i], ring[i + 1]))
      }
      return positions
    }

    for (const feature of layer.features) {
      if (feature.type !== 3) continue
      const attributes = properties(feature.properties, name)
      if (attributes.hidden) continue

      const polygons: number[][][] = []
      for (const [outer, ...holes] of classifyRings(feature.geometry)) {
        // a polygon whose outer ring lies in the buffer is gone, holes too
        const clipped = clipRing(outer, extent)
        if (!isRing(clipped)) continue
        polygons.push([
          clipped,
          ...holes.map((hole) => clipRing(hole, extent)).filter(isRing)
        ])
      }

      const single = polygons.length === 1
      for (const polygon of polygons) {
        buildings.push({
          id: attributes.id ?? (single ? feature.id : undefined),
          geometry: { type: 'Polygon', coordinates: polygon.map(toRing) },
          height: attributes.height,
          minHeight: attributes.minHeight,
          color: attributes.color,
          properties: feature.properties
        })
      }
    }
  }
  return buildings
}
