// Trees — single ones, and forests to fill — as GeoJSON-like features, and
// from vector tiles.

import { gunzip, type VectorTileValue } from '../../io/mvt'
import { VectorTileData } from '../../sources/vector-tiles'
import { classifyRings, type Position, type Ring, toNumber } from '../features'

export type TreeId = string | number

/** GeoJSON points (trees) or polygons (woods, filled with trees), in `[lon, lat]`. */
export type TreeGeometry =
  | { readonly type: 'Point'; readonly coordinates: Position }
  | { readonly type: 'MultiPoint'; readonly coordinates: readonly Position[] }
  | { readonly type: 'Polygon'; readonly coordinates: readonly Ring[] }
  | {
      readonly type: 'MultiPolygon'
      readonly coordinates: readonly (readonly Ring[])[]
    }

/** A tree, or a wood, as a source delivers it. */
export interface TreeFeature {
  id?: TreeId
  geometry: TreeGeometry
  /** Meters high; by default between the layer's `heights`. */
  height?: number
  /** What it is, as the source says: `forest`, `wood`, `tree`… */
  kind?: string
  /** Everything the source knows about it. */
  properties: Record<string, unknown>
}

/** How a vector tile feature becomes trees; `hidden` drops it. */
export interface TreeAttributes {
  id?: TreeId
  height?: number
  kind?: string
  hidden?: boolean
}

export type TreeProperties = (
  properties: Record<string, VectorTileValue>,
  layer: string
) => TreeAttributes

export interface VectorTileTreesOptions {
  /** Layers holding the woods; default `'landcover'`. */
  layers?: string | readonly string[]
  /** Reads the attributes; default: OpenMapTiles `landcover` woods. */
  properties?: TreeProperties
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

const isWood = (kind: unknown) => kind === 'wood' || kind === 'forest'

/** OpenMapTiles `landcover` layer: `class=wood` (OpenFreeMap, MapTiler). */
export const openMapTilesTreeProperties: TreeProperties = (p) => ({
  kind: text(p.subclass) ?? text(p.class),
  hidden: p.class !== 'wood'
})

/** Mapbox Streets v8 `landuse` layer: `class=wood`. */
export const mapboxStreetsTreeProperties: TreeProperties = (p) => ({
  kind: text(p.type) ?? text(p.class),
  hidden: p.class !== 'wood'
})

/** Protomaps basemap `landcover` / `landuse`: `kind=forest` or `wood`. */
export const protomapsTreeProperties: TreeProperties = (p) => ({
  kind: text(p.kind),
  hidden: !isWood(p.kind)
})

/** Shortbread `land` layer (VersaTiles): `kind=forest` or `wood`. */
export const shortbreadTreeProperties: TreeProperties = (p) => ({
  kind: text(p.kind),
  hidden: !isWood(p.kind)
})

/** Trees of one vector tile (MVT; gzip is detected): its woods and its trees. */
export async function treesFromVectorTile(
  data: ArrayBuffer | Uint8Array,
  tile: { readonly z: number; readonly x: number; readonly y: number },
  options: VectorTileTreesOptions = {}
): Promise<TreeFeature[]> {
  return readTrees(new VectorTileData(await gunzip(data)), tile, options)
}

/** `treesFromVectorTile` for a tile already decoded. */
export function readTrees(
  data: VectorTileData,
  tile: { readonly z: number; readonly x: number; readonly y: number },
  {
    layers = 'landcover',
    properties = openMapTilesTreeProperties
  }: VectorTileTreesOptions = {}
): TreeFeature[] {
  const names = typeof layers === 'string' ? [layers] : layers
  const scale = 2 ** tile.z
  const trees: TreeFeature[] = []

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
      let geometry: TreeGeometry
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
      trees.push({
        id: id ?? feature.id,
        geometry,
        height: attributes.height ?? toNumber(feature.properties.height),
        kind: attributes.kind,
        properties: feature.properties
      })
    }
  }
  return trees
}
