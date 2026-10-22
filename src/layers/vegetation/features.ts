// Vegetation — woods and scrub to fill, single trees and bushes — as
// GeoJSON-like features, and from vector tiles.

import { gunzip, type VectorTileValue } from '../../io/mvt'
import { VectorTileData } from '../../sources/vector-tiles'
import { classifyRings, type Position, type Ring, toNumber } from '../features'

export type VegetationId = string | number

/**
 * GeoJSON points (single trees or bushes) or polygons (woods and scrub, to
 * fill), in `[lon, lat]`.
 */
export type VegetationGeometry =
  | { readonly type: 'Point'; readonly coordinates: Position }
  | { readonly type: 'MultiPoint'; readonly coordinates: readonly Position[] }
  | { readonly type: 'Polygon'; readonly coordinates: readonly Ring[] }
  | {
      readonly type: 'MultiPolygon'
      readonly coordinates: readonly (readonly Ring[])[]
    }

/** A wood, scrub, a tree or a bush, as a source delivers it. */
export interface VegetationFeature {
  id?: VegetationId
  geometry: VegetationGeometry
  /** Meters high; by default between the layer's `treeHeights` or `bushHeights`. */
  height?: number
  /**
   * What it is, as the source says: `forest`, `wood`, `tree`… — bushes
   * grow where it is one of `BUSH_KINDS`, trees elsewhere.
   */
  kind?: string
  /** Everything the source knows about it. */
  properties: Record<string, unknown>
}

/** How a vector tile feature becomes vegetation; `hidden` drops it. */
export interface VegetationAttributes {
  id?: VegetationId
  height?: number
  kind?: string
  hidden?: boolean
}

export type VegetationProperties = (
  properties: Record<string, VectorTileValue>,
  layer: string
) => VegetationAttributes

export interface VectorTileVegetationOptions {
  /** Layers holding the woods and scrub; default `'landcover'`. */
  layers?: string | readonly string[]
  /** Reads the attributes; default: OpenMapTiles `landcover` woods and scrub. */
  properties?: VegetationProperties
}

/**
 * Kinds that grow bushes — scrub and shrubbery (areas), shrubs (single,
 * OpenStreetMap `natural=shrub`); every other kind grows trees.
 */
export const BUSH_KINDS: readonly string[] = Object.freeze([
  'scrub',
  'shrubbery',
  'shrub'
])

/** Whether a feature grows bushes (`BUSH_KINDS`), not trees. */
export const isBush = (feature: VegetationFeature) =>
  feature.kind !== undefined && BUSH_KINDS.includes(feature.kind)

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

const grows = (kind: unknown) =>
  kind === 'wood' || kind === 'forest' || kind === 'scrub'

/**
 * OpenMapTiles `landcover` layer (OpenFreeMap, MapTiler): `class=wood`, and
 * scrub — `subclass=scrub` or `shrubbery`, in `class=grass`.
 */
export const openMapTilesVegetationProperties: VegetationProperties = (p) => ({
  kind: text(p.subclass) ?? text(p.class),
  hidden:
    p.class !== 'wood' && p.subclass !== 'scrub' && p.subclass !== 'shrubbery'
})

/** Mapbox Streets v8 `landuse` layer: `class=wood`, and `class=scrub` (with heaths). */
export const mapboxStreetsVegetationProperties: VegetationProperties = (p) => ({
  kind: p.class === 'scrub' ? 'scrub' : (text(p.type) ?? text(p.class)),
  hidden: p.class !== 'wood' && p.class !== 'scrub'
})

/** Protomaps basemap `landcover` / `landuse`: `kind=forest`, `wood` or `scrub`. */
export const protomapsVegetationProperties: VegetationProperties = (p) => ({
  kind: text(p.kind),
  hidden: !grows(p.kind)
})

/** Shortbread `land` layer (VersaTiles): `kind=forest`, `wood` or `scrub`. */
export const shortbreadVegetationProperties: VegetationProperties = (p) => ({
  kind: text(p.kind),
  hidden: !grows(p.kind)
})

/**
 * The vegetation of one vector tile (MVT; gzip is detected): its woods and
 * scrub, and its single trees.
 */
export async function vegetationFromVectorTile(
  data: ArrayBuffer | Uint8Array,
  tile: { readonly z: number; readonly x: number; readonly y: number },
  options: VectorTileVegetationOptions = {}
): Promise<VegetationFeature[]> {
  return readVegetation(new VectorTileData(await gunzip(data)), tile, options)
}

/** `vegetationFromVectorTile` for a tile already decoded. */
export function readVegetation(
  data: VectorTileData,
  tile: { readonly z: number; readonly x: number; readonly y: number },
  {
    layers = 'landcover',
    properties = openMapTilesVegetationProperties
  }: VectorTileVegetationOptions = {}
): VegetationFeature[] {
  const names = typeof layers === 'string' ? [layers] : layers
  const scale = 2 ** tile.z
  const plants: VegetationFeature[] = []

  for (const name of names) {
    const layer = data.layer(name)
    if (!layer) continue
    const { extent } = layer
    const toPositions = (line: number[]) => {
      const positions: Position[] = []
      for (let i = 0; i < line.length; i += 2) {
        const mercatorY = (tile.y + line[i + 1] / extent) / scale
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY)))
        positions.push([
          ((tile.x + line[i] / extent) / scale) * 360 - 180,
          (lat * 180) / Math.PI
        ])
      }
      return positions
    }

    for (const feature of layer.features) {
      if (feature.type !== 1 && feature.type !== 3) continue
      const { id, hidden, ...attributes } = properties(feature.properties, name)
      if (hidden) continue
      let geometry: VegetationGeometry
      if (feature.type === 1) {
        const points = feature.geometry.flatMap(toPositions)
        if (points.length === 0) continue
        geometry =
          points.length === 1
            ? { type: 'Point', coordinates: points[0] }
            : { type: 'MultiPoint', coordinates: points }
      } else {
        const polygons = classifyRings(feature.geometry).map((polygon) =>
          polygon.map(toPositions)
        )
        if (polygons.length === 0) continue
        geometry =
          polygons.length === 1
            ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons }
      }
      plants.push({
        id: id ?? feature.id,
        geometry,
        height: attributes.height ?? toNumber(feature.properties.height),
        kind: attributes.kind,
        properties: feature.properties
      })
    }
  }
  return plants
}
