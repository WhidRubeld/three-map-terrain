import {
  type BuildingFeature,
  type BuildingProperties,
  buildingsFromVectorTile,
  mapboxStreetsProperties,
  openMapTilesProperties,
  protomapsProperties,
  shortbreadProperties,
  type VectorTileBuildingsOptions
} from './features'
import { isNotFound, loadArrayBuffer, loadJson } from '../io/fetch'
import { buildingsFromOverpass, overpassQuery } from './osm'
import {
  expandTileUrl,
  type Subdomains,
  type TileRequest,
  type TileUrl
} from '../sources/tile-source'
import { Utils } from '../geo/Utils.class'

export type BuildingSourceApi =
  | 'openfreemap'
  | 'versatiles'
  | 'overpass'
  | 'maptiler'
  | 'mapbox'
  | 'protomaps'

/** Options every building source accepts. */
export interface BuildingSourceOptions {
  /** Shallowest zoom the source has buildings at. */
  minZoom?: number
  /** Deepest zoom the source has tiles at; deeper terrain shares them. */
  maxZoom?: number
  /** Credit for the data, listed in `map.attributions`. */
  attribution?: string
}

/** Buildings from any vector tile (MVT) server. */
export interface VectorTileBuildingSourceProps
  extends BuildingSourceOptions, VectorTileBuildingsOptions {
  api?: undefined
  /** Tile URL template (`https://…/{z}/{x}/{y}.pbf`) or function… */
  url?: TileUrl
  /** …or the URL of a TileJSON listing the tiles (fetched once). */
  tilejson?: string
  /** Substituted for `{s}` in `url`; default `'abc'`. */
  subdomains?: Subdomains
  load?: undefined
}

/** Buildings from your own loader (GeoJSON, a database, PMTiles…). */
export interface CustomBuildingSourceProps extends BuildingSourceOptions {
  api?: undefined
  url?: undefined
  tilejson?: undefined
  /**
   * Loads the buildings of one tile (`minZoom` ≤ z ≤ `maxZoom`). Return the
   * buildings intersecting the tile, whole — a building is drawn by the tile
   * its center lies in — or clipped to the tile.
   */
  load: (tile: TileRequest) => Promise<BuildingFeature[]>
}

export type BuildingSourceProps =
  | ({ api: 'openfreemap' | 'versatiles' } & BuildingSourceOptions)
  | ({ api: 'overpass'; endpoint?: string } & BuildingSourceOptions)
  | ({
      api: 'maptiler' | 'mapbox' | 'protomaps'
      token: string
    } & BuildingSourceOptions)
  | VectorTileBuildingSourceProps
  | CustomBuildingSourceProps

interface VectorPreset {
  url?: (token: string) => string
  tilejson?: string
  layer: string
  properties: BuildingProperties
  minZoom: number
  maxZoom: number
  attribution: string
}

const OSM = '© OpenStreetMap contributors'

const VECTOR_PRESETS: Record<
  Exclude<BuildingSourceApi, 'overpass'>,
  VectorPreset
> = {
  // the tile URLs change with every planet build: resolved from the TileJSON
  openfreemap: {
    tilejson: 'https://tiles.openfreemap.org/planet',
    layer: 'building',
    properties: openMapTilesProperties,
    minZoom: 13,
    maxZoom: 14,
    attribution: `OpenFreeMap © OpenMapTiles ${OSM}`
  },
  versatiles: {
    url: () => 'https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}',
    layer: 'buildings',
    properties: shortbreadProperties,
    minZoom: 14,
    maxZoom: 14,
    attribution: `VersaTiles ${OSM}`
  },
  maptiler: {
    url: (token) =>
      `https://api.maptiler.com/tiles/v3/{z}/{x}/{y}.pbf?key=${token}`,
    layer: 'building',
    properties: openMapTilesProperties,
    minZoom: 13,
    maxZoom: 14,
    attribution: `© MapTiler ${OSM}`
  },
  // all buildings are in the tiles from zoom 16, large ones from 13
  mapbox: {
    url: (token) =>
      `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/{z}/{x}/{y}.vector.pbf?access_token=${token}`,
    layer: 'building',
    properties: mapboxStreetsProperties,
    minZoom: 15,
    maxZoom: 16,
    attribution: `© Mapbox ${OSM}`
  },
  protomaps: {
    url: (token) =>
      `https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?key=${token}`,
    layer: 'buildings',
    properties: protomapsProperties,
    minZoom: 14,
    maxZoom: 15,
    attribution: `Protomaps ${OSM}`
  }
}

export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'

/** One Overpass request at a time per endpoint: servers limit parallel ones. */
const overpassQueues = new Map<string, Promise<unknown>>()

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = overpassQueues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  overpassQueues.set(key, next)
  return next
}

type Loader = (tile: TileRequest) => Promise<BuildingFeature[]>

function vectorTileLoader(
  tileUrl: (tile: TileRequest) => Promise<string>,
  options: VectorTileBuildingsOptions
): Loader {
  return async (tile) => {
    const url = await tileUrl(tile)
    let data: ArrayBuffer | undefined
    try {
      data = await loadArrayBuffer(url, tile.signal)
    } catch (error) {
      if (isNotFound(error)) return [] // nothing there (sea, empty tiles)
      throw error
    }
    return data ? buildingsFromVectorTile(data, tile, options) : []
  }
}

/**
 * Resolves the tile URL template of a TileJSON once (again after a failure).
 * Shared by every tile, so no tile's signal cancels it.
 */
function tileJsonUrl(tilejson: string) {
  let template: Promise<string> | undefined
  return () => {
    template ??= loadJson(tilejson).then((json) => {
      const tiles = (json as { tiles?: unknown } | null)?.tiles
      const first: unknown = Array.isArray(tiles) ? tiles[0] : undefined
      if (typeof first !== 'string') {
        throw new Error(`No tile URL in the TileJSON ${tilejson}`)
      }
      if (/^[a-z][a-z\d+.-]*:/i.test(first)) return first
      // relative to the TileJSON; URL() escapes the template's braces
      return new URL(first, tilejson).href
        .replaceAll('%7B', '{')
        .replaceAll('%7D', '}')
    })
    template.catch(() => {
      template = undefined
    })
    return template
  }
}

/** Where the building footprints come from: a preset `api`, vector tiles, or a `load` function. */
export class BuildingSource {
  readonly api: BuildingSourceApi | 'custom'
  readonly minZoom: number
  readonly maxZoom: number
  readonly attribution: string

  private readonly loader: Loader

  constructor(props: BuildingSourceProps) {
    if (props.api === 'overpass') {
      const endpoint = props.endpoint ?? OVERPASS_ENDPOINT
      this.api = 'overpass'
      this.minZoom = props.minZoom ?? 14
      this.maxZoom = props.maxZoom ?? 14
      this.attribution = props.attribution ?? OSM
      this.loader = (tile) =>
        enqueue(endpoint, async () => {
          tile.signal.throwIfAborted()
          const bbox = Utils.tile2bbox([tile.x, tile.y, tile.z])
          const response = await loadJson(endpoint, tile.signal, {
            method: 'POST',
            body: new URLSearchParams({ data: overpassQuery(bbox) })
          })
          return buildingsFromOverpass(response)
        })
      return
    }

    if (props.api !== undefined) {
      if (!Object.hasOwn(VECTOR_PRESETS, props.api)) {
        throw new Error(`Unknown building source api: ${props.api}`)
      }
      const preset = VECTOR_PRESETS[props.api]
      const token = 'token' in props ? props.token : ''
      this.api = props.api
      this.minZoom = props.minZoom ?? preset.minZoom
      this.maxZoom = props.maxZoom ?? preset.maxZoom
      this.attribution = props.attribution ?? preset.attribution
      this.loader = this.vectorTiles(
        { url: preset.url?.(token), tilejson: preset.tilejson },
        { layers: preset.layer, properties: preset.properties }
      )
      return
    }

    this.api = 'custom'
    this.minZoom = props.minZoom ?? 14
    this.maxZoom = props.maxZoom ?? 14
    this.attribution = props.attribution ?? ''
    if (props.load) {
      this.loader = props.load
    } else if (props.url !== undefined || props.tilejson !== undefined) {
      this.loader = this.vectorTiles(props, props)
    } else {
      throw new Error(
        'BuildingSource needs an api, a url, a tilejson or a load function'
      )
    }
  }

  /** Loads the buildings of one tile. */
  load(tile: TileRequest): Promise<BuildingFeature[]> {
    return this.loader(tile)
  }

  private vectorTiles(
    {
      url,
      tilejson,
      subdomains
    }: { url?: TileUrl; tilejson?: string; subdomains?: Subdomains },
    options: VectorTileBuildingsOptions
  ): Loader {
    if (url !== undefined) {
      return vectorTileLoader(
        ({ z, x, y }) =>
          Promise.resolve(expandTileUrl(url, z, x, y, subdomains)),
        options
      )
    }
    if (tilejson === undefined) throw new Error('No tile URL')
    const template = tileJsonUrl(tilejson)
    return vectorTileLoader(
      async ({ z, x, y }) =>
        expandTileUrl(await template(), z, x, y, subdomains),
      options
    )
  }
}
