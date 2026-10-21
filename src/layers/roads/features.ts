// Roads and railways as GeoJSON-like line features, and from vector tiles.

import { gunzip, type VectorTileValue } from '../../io/mvt'
import { VectorTileData } from '../../sources/vector-tiles'
import { type Position, toNumber } from '../features'

export type RoadId = string | number

/** What a road is: its default width, and what `kinds` chooses from. */
export type RoadKind =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'minor'
  | 'service'
  | 'track'
  | 'path'
  | 'rail'

/** Every kind, from the widest road to railways. */
export const ROAD_KINDS: readonly RoadKind[] = Object.freeze([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'minor',
  'service',
  'track',
  'path',
  'rail'
])

/**
 * Meters across, by kind. A dual carriageway is two roads in OpenStreetMap,
 * so a motorway is one direction of it.
 */
export const ROAD_WIDTHS: Readonly<Record<RoadKind, number>> = Object.freeze({
  motorway: 11,
  trunk: 10,
  primary: 9,
  secondary: 8,
  tertiary: 7,
  minor: 5.5,
  service: 3.5,
  track: 3,
  path: 2,
  rail: 3
})

/** Links (ramps) are this much narrower than their road. */
export const LINK_WIDTH = 0.6

/** GeoJSON `LineString` / `MultiLineString` in `[lon, lat]`. */
export type RoadGeometry =
  | { readonly type: 'LineString'; readonly coordinates: readonly Position[] }
  | {
      readonly type: 'MultiLineString'
      readonly coordinates: readonly (readonly Position[])[]
    }

/** One road or railway (or a piece of it) as a source delivers it. */
export interface RoadFeature {
  /** Identifies the road, e.g. its OSM way id; `highlight()` accepts it. */
  id?: RoadId
  geometry: RoadGeometry
  kind: RoadKind
  /** Meters across; by default from its kind (`widths`). */
  width?: number
  /** A link (ramp) of its kind: narrower. */
  link?: boolean
  /** On a bridge: drawn as a deck at its own height. */
  bridge?: boolean
  /** In a tunnel: not drawn. */
  tunnel?: boolean
  /** OSM `layer`: above (1, 2…) or below (−1…) the others. */
  layer?: number
  /** Everything the source knows about it: OSM tags, vector tile properties. */
  properties: Record<string, unknown>
}

/** How a vector tile feature becomes a road; no `kind` or `hidden` drops it. */
export interface RoadAttributes {
  id?: RoadId
  kind?: RoadKind
  width?: number
  link?: boolean
  bridge?: boolean
  tunnel?: boolean
  layer?: number
  hidden?: boolean
}

export type RoadProperties = (
  properties: Record<string, VectorTileValue>,
  layer: string
) => RoadAttributes

export interface VectorTileRoadsOptions {
  /** Layers holding the roads; default `'transportation'`. */
  layers?: string | readonly string[]
  /** Reads the attributes from feature properties; default: OpenMapTiles fields. */
  properties?: RoadProperties
}

/**
 * Road kinds by the names sources use: OSM `highway` and `railway` values
 * (also in Shortbread and Protomaps `kind_detail`), OpenMapTiles and Mapbox
 * classes. Anything else — ferries, aerialways, runways, platforms, roads
 * under construction — is no road to draw.
 */
const KINDS: Readonly<Record<string, RoadKind>> = {
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'minor',
  unclassified: 'minor',
  residential: 'minor',
  living_street: 'minor',
  road: 'minor',
  street: 'minor',
  street_limited: 'minor',
  raceway: 'minor',
  service: 'service',
  busway: 'service',
  bus_guideway: 'service',
  driveway: 'service',
  parking_aisle: 'service',
  alley: 'service',
  'drive-through': 'service',
  emergency_access: 'service',
  track: 'track',
  path: 'path',
  footway: 'path',
  pedestrian: 'path',
  cycleway: 'path',
  bridleway: 'path',
  steps: 'path',
  sidewalk: 'path',
  crossing: 'path',
  rail: 'rail',
  transit: 'rail',
  major_rail: 'rail',
  minor_rail: 'rail',
  service_rail: 'rail',
  light_rail: 'rail',
  narrow_gauge: 'rail',
  tram: 'rail',
  subway: 'rail',
  monorail: 'rail',
  funicular: 'rail',
  preserved: 'rail',
  miniature: 'rail'
}

/** The kind of a road class (`motorway_link` is a motorway); `undefined` if none. */
export function roadKind(value: unknown): RoadKind | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.replace(/_link$/, '')
  return Object.hasOwn(KINDS, name) ? KINDS[name] : undefined
}

const isLink = (value: unknown) =>
  typeof value === 'string' && value.endsWith('_link')

/** `true`, `1`, `'yes'` or `'true'`. */
const yes = (value: unknown) =>
  value === true || value === 1 || value === 'yes' || value === 'true'

/** OpenMapTiles `transportation` layer (OpenFreeMap, MapTiler, self-hosted). */
export const openMapTilesRoadProperties: RoadProperties = (p) => ({
  kind: roadKind(p.class),
  link: yes(p.ramp),
  bridge: p.brunnel === 'bridge',
  tunnel: p.brunnel === 'tunnel',
  layer: toNumber(p.layer),
  hidden: yes(p.indoor)
})

/** Mapbox Streets v8 `road` layer. */
export const mapboxStreetsRoadProperties: RoadProperties = (p) => ({
  kind: roadKind(p.class),
  link: isLink(p.class),
  bridge: p.structure === 'bridge',
  tunnel: p.structure === 'tunnel',
  layer: toNumber(p.layer)
})

/** Protomaps basemap `roads` layer. */
export const protomapsRoadProperties: RoadProperties = (p) => ({
  kind:
    roadKind(p.kind_detail) ??
    (p.kind === 'rail' ? 'rail' : p.kind === 'path' ? 'path' : undefined),
  link: yes(p.is_link) || isLink(p.kind_detail),
  bridge: yes(p.is_bridge),
  tunnel: yes(p.is_tunnel)
})

/** Shortbread `streets` layer (VersaTiles). */
export const shortbreadRoadProperties: RoadProperties = (p) => ({
  kind: roadKind(p.kind),
  link: yes(p.link),
  bridge: yes(p.bridge),
  tunnel: yes(p.tunnel)
})

/**
 * Roads of one vector tile (MVT; gzip is detected), in `[lon, lat]`, as the
 * tile has them: with its buffer, which the layer cuts off.
 */
export async function roadsFromVectorTile(
  data: ArrayBuffer | Uint8Array,
  tile: { readonly z: number; readonly x: number; readonly y: number },
  options: VectorTileRoadsOptions = {}
): Promise<RoadFeature[]> {
  return readRoads(new VectorTileData(await gunzip(data)), tile, options)
}

/** `roadsFromVectorTile` for a tile already decoded. */
export function readRoads(
  data: VectorTileData,
  tile: { readonly z: number; readonly x: number; readonly y: number },
  {
    layers = 'transportation',
    properties = openMapTilesRoadProperties
  }: VectorTileRoadsOptions = {}
): RoadFeature[] {
  const names = typeof layers === 'string' ? [layers] : layers
  const scale = 2 ** tile.z
  const roads: RoadFeature[] = []

  for (const name of names) {
    const layer = data.layer(name)
    if (!layer) continue
    const { extent } = layer
    const toLine = (line: number[]) => {
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
      if (feature.type !== 2) continue
      const { id, kind, hidden, ...attributes } = properties(
        feature.properties,
        name
      )
      if (!kind || hidden) continue
      const lines = feature.geometry.filter((line) => line.length >= 4)
      if (lines.length === 0) continue
      roads.push({
        id: id ?? feature.id,
        geometry:
          lines.length === 1
            ? { type: 'LineString', coordinates: toLine(lines[0]) }
            : { type: 'MultiLineString', coordinates: lines.map(toLine) },
        kind,
        ...attributes,
        properties: feature.properties
      })
    }
  }
  return roads
}
