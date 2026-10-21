// Water — the sea, lakes, rivers, streams — as GeoJSON-like features, and
// from vector tiles.

import { gunzip, type VectorTileValue } from '../../io/mvt'
import { VectorTileData } from '../../sources/vector-tiles'
import { classifyRings, type Position, type Ring } from '../features'

export type WaterId = string | number

/**
 * GeoJSON polygons (areas of water: their holes are islands) or lines
 * (waterways), in `[lon, lat]`.
 */
export type WaterGeometry =
  | { readonly type: 'Polygon'; readonly coordinates: readonly Ring[] }
  | {
      readonly type: 'MultiPolygon'
      readonly coordinates: readonly (readonly Ring[])[]
    }
  | { readonly type: 'LineString'; readonly coordinates: readonly Position[] }
  | {
      readonly type: 'MultiLineString'
      readonly coordinates: readonly (readonly Position[])[]
    }

/** An area of water or a waterway as a source delivers it. */
export interface WaterFeature {
  id?: WaterId
  geometry: WaterGeometry
  /** What it is, as the source says: `lake`, `river`, `stream`, `canal`… */
  kind?: string
  /** Meters across a waterway; by default from its kind (`widths`). */
  width?: number
  /** Everything the source knows about it. */
  properties: Record<string, unknown>
}

/** How a vector tile feature becomes water; `hidden` drops it. */
export interface WaterAttributes {
  id?: WaterId
  kind?: string
  width?: number
  hidden?: boolean
}

export type WaterProperties = (
  properties: Record<string, VectorTileValue>,
  layer: string
) => WaterAttributes

export interface VectorTileWaterOptions {
  /** Layers holding the water; default `['water', 'waterway']`. */
  layers?: string | readonly string[]
  /** Reads the attributes from feature properties; default: OpenMapTiles fields. */
  properties?: WaterProperties
}

/** Meters across a waterway, by kind; others are 3 m. */
export const WATERWAY_WIDTHS: Readonly<Partial<Record<string, number>>> =
  Object.freeze({
    river: 12,
    canal: 8,
    stream: 2.5,
    drain: 1.5,
    ditch: 1.5
  })

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** OpenMapTiles `water` and `waterway` layers (OpenFreeMap, MapTiler). */
export const openMapTilesWaterProperties: WaterProperties = (p) => ({
  kind: text(p.class),
  hidden: p.brunnel === 'tunnel'
})

/** Mapbox Streets v8 `water` and `waterway` layers. */
export const mapboxStreetsWaterProperties: WaterProperties = (p, layer) => ({
  kind: layer === 'water' ? 'water' : text(p.class),
  hidden: p.structure === 'tunnel'
})

/** Protomaps basemap `water` layer. */
export const protomapsWaterProperties: WaterProperties = (p) => ({
  kind: text(p.kind_detail) ?? text(p.kind),
  hidden: p.is_tunnel === true
})

/** Shortbread `water_polygons` and `water_lines` layers (VersaTiles). */
export const shortbreadWaterProperties: WaterProperties = (p) => ({
  kind: text(p.kind),
  hidden: p.tunnel === true
})

/**
 * Water of one vector tile (MVT; gzip is detected), in `[lon, lat]`, as the
 * tile has it — with its buffer, which the layer cuts off.
 */
export async function waterFromVectorTile(
  data: ArrayBuffer | Uint8Array,
  tile: { readonly z: number; readonly x: number; readonly y: number },
  options: VectorTileWaterOptions = {}
): Promise<WaterFeature[]> {
  return readWater(new VectorTileData(await gunzip(data)), tile, options)
}

/** `waterFromVectorTile` for a tile already decoded. */
export function readWater(
  data: VectorTileData,
  tile: { readonly z: number; readonly x: number; readonly y: number },
  {
    layers = ['water', 'waterway'],
    properties = openMapTilesWaterProperties
  }: VectorTileWaterOptions = {}
): WaterFeature[] {
  const names = typeof layers === 'string' ? [layers] : layers
  const scale = 2 ** tile.z
  const water: WaterFeature[] = []

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
      if (feature.type !== 2 && feature.type !== 3) continue
      const { id, hidden, ...attributes } = properties(feature.properties, name)
      if (hidden) continue
      let geometry: WaterGeometry
      if (feature.type === 3) {
        const polygons = classifyRings(feature.geometry).map((polygon) =>
          polygon.map(toPositions)
        )
        if (polygons.length === 0) continue
        geometry =
          polygons.length === 1
            ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons }
      } else {
        const lines = feature.geometry.filter((line) => line.length >= 4)
        if (lines.length === 0) continue
        geometry =
          lines.length === 1
            ? { type: 'LineString', coordinates: toPositions(lines[0]) }
            : { type: 'MultiLineString', coordinates: lines.map(toPositions) }
      }
      water.push({
        id: id ?? feature.id,
        geometry,
        ...attributes,
        properties: feature.properties
      })
    }
  }
  return water
}
