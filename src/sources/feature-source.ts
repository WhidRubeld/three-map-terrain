// Features of a layer from a provider read through a schema.

import { Utils } from '../geo/Utils.class'
import { OVERPASS_ENDPOINT, Overpass } from './overpass'
import type { TileRequest, TileUrl, Subdomains } from './tile-source'
import {
  type VectorSchema,
  type VectorTileData,
  VectorTiles,
  type VectorTilesApi
} from './vector-tiles'

/**
 * Where a layer's features come from: anything that loads the features of
 * a tile — the library's sources, or your own adapter for GeoJSON, a
 * database, PMTiles…
 */
export interface FeatureSource<F> {
  /** Shallowest zoom the source has features at. */
  readonly minZoom: number
  /** Deepest zoom it has tiles at; deeper terrain shares them. */
  readonly maxZoom: number
  /** Credit for the data, listed in `map.attributions`. */
  readonly attribution?: string
  /** The features of one tile (`minZoom` ≤ z ≤ `maxZoom`). */
  load(tile: TileRequest): Promise<F[]>
}

/** Which layers of a vector tile hold the features, and how to read them. */
export interface VectorTileReading<P> {
  /** Layer names. */
  layers: string | readonly string[]
  /** Reads a feature's attributes from its properties. */
  properties: P
}

/** How a layer reads each kind of provider. */
export interface FeatureSchema<F, P> {
  /** Names the source in errors. */
  name: string
  /** Where each vector tile schema has the features, from which zoom. */
  vectorTiles: Readonly<
    Record<VectorSchema, VectorTileReading<P> & { minZoom: number }>
  >
  /** The features of a decoded vector tile. */
  read: (
    tile: VectorTileData,
    request: { readonly z: number; readonly x: number; readonly y: number },
    reading: VectorTileReading<P>
  ) => F[]
  /** OpenStreetMap through Overpass: the query of a bounding box, the answer. */
  overpass: {
    query: (bbox: readonly number[]) => string
    parse: (response: unknown) => F[]
  }
}

/** Options every feature source accepts. */
export interface FeatureSourceOptions {
  /** Shallowest zoom the source has features at. */
  minZoom?: number
  /** Deepest zoom it has tiles at; deeper terrain shares them. */
  maxZoom?: number
  /** Credit for the data, listed in `map.attributions`. */
  attribution?: string
}

/** Overrides of the schema: for vector tiles it does not know, or to read more. */
export interface VectorTileReadingProps<P> {
  /** Layers holding the features; by default the schema's. */
  layers?: string | readonly string[]
  /** Reads the attributes from feature properties; by default the schema's. */
  properties?: P
}

export type FeatureSourceProps<F, P> =
  /** A basemap preset; layers using the same one share its tiles. */
  | ({ api: 'openfreemap' | 'versatiles' } & VectorTileReadingProps<P> &
      FeatureSourceOptions)
  | ({
      api: 'maptiler' | 'mapbox' | 'protomaps'
      token: string
    } & VectorTileReadingProps<P> &
      FeatureSourceOptions)
  /** OpenStreetMap through the Overpass API: every tag, slow. */
  | ({
      api: 'overpass'
      endpoint?: string
      /**
       * The Overpass QL query of a bounding box `[west, south, east,
       * north]`; by default the schema's — whose `more` adds selectors.
       */
      query?: (bbox: readonly number[]) => string
    } & FeatureSourceOptions)
  /** Vector tiles of your own — shared with other layers when they get the same `tiles`. */
  | ({
      api?: undefined
      tiles: VectorTiles
      url?: undefined
      tilejson?: undefined
      load?: undefined
    } & VectorTileReadingProps<P> &
      FeatureSourceOptions)
  | ({
      api?: undefined
      tiles?: undefined
      /** Tile URL template (`https://…/{z}/{x}/{y}.pbf`) or function… */
      url?: TileUrl
      /** …or the URL of a TileJSON listing the tiles (fetched once). */
      tilejson?: string
      /** Substituted for `{s}` in `url`; default `'abc'`. */
      subdomains?: Subdomains
      load?: undefined
    } & VectorTileReadingProps<P> &
      FeatureSourceOptions)
  /** Your own loader: return the features of a tile. */
  | ({
      api?: undefined
      tiles?: undefined
      url?: undefined
      tilejson?: undefined
      load: (tile: TileRequest) => Promise<F[]>
    } & FeatureSourceOptions)

const PRESETS: ReadonlySet<string> = new Set<VectorTilesApi>([
  'openfreemap',
  'versatiles',
  'maptiler',
  'mapbox',
  'protomaps'
])

/**
 * A layer's features from a basemap preset, vector tiles, Overpass or a
 * `load` function, read through the layer's schema. `BuildingSource` and
 * `RoadSource` are its schemas for buildings and roads.
 */
export class TileFeatureSource<F, P> implements FeatureSource<F> {
  readonly api: VectorTilesApi | 'overpass' | 'custom'
  readonly minZoom: number
  readonly maxZoom: number
  readonly attribution: string
  /** The vector tiles read, if any. */
  readonly tiles: VectorTiles | undefined

  private readonly loader: (tile: TileRequest) => Promise<F[]>

  constructor(props: FeatureSourceProps<F, P>, schema: FeatureSchema<F, P>) {
    if (props.api === 'overpass') {
      const overpass = new Overpass({
        endpoint: props.endpoint ?? OVERPASS_ENDPOINT
      })
      this.api = 'overpass'
      this.tiles = undefined
      this.minZoom = props.minZoom ?? 14
      this.maxZoom = props.maxZoom ?? 14
      this.attribution = props.attribution ?? overpass.attribution
      const query = props.query ?? schema.overpass.query
      this.loader = async (tile) =>
        schema.overpass.parse(
          await overpass.query(
            query(Utils.tile2bbox([tile.x, tile.y, tile.z])),
            tile.signal
          )
        )
      return
    }

    if ('load' in props && props.load) {
      this.api = 'custom'
      this.tiles = undefined
      this.minZoom = props.minZoom ?? 14
      this.maxZoom = props.maxZoom ?? 14
      this.attribution = props.attribution ?? ''
      this.loader = props.load
      return
    }

    let tiles: VectorTiles
    if (props.api !== undefined) {
      if (!PRESETS.has(props.api)) {
        throw new Error(`Unknown ${schema.name} api: ${props.api}`)
      }
      tiles = VectorTiles.preset(props.api, 'token' in props ? props.token : '')
    } else if (props.tiles) {
      tiles = props.tiles
    } else if (props.url !== undefined || props.tilejson !== undefined) {
      tiles =
        props.url !== undefined
          ? new VectorTiles({ url: props.url, subdomains: props.subdomains })
          : new VectorTiles({ tilejson: props.tilejson ?? '' })
    } else {
      throw new Error(
        `${schema.name} needs an api, tiles, a url, a tilejson or a load function`
      )
    }
    const known = schema.vectorTiles[tiles.schema]
    const reading: VectorTileReading<P> = {
      layers:
        'layers' in props && props.layers !== undefined
          ? props.layers
          : known.layers,
      properties:
        'properties' in props && props.properties !== undefined
          ? props.properties
          : known.properties
    }
    this.api = tiles.api === 'custom' ? 'custom' : tiles.api
    this.tiles = tiles
    this.minZoom =
      props.minZoom ?? (tiles.api === 'custom' ? 14 : known.minZoom)
    this.maxZoom = props.maxZoom ?? tiles.maxZoom
    this.attribution = props.attribution ?? tiles.attribution
    this.loader = async (tile) => {
      const data = await tiles.load(tile)
      return data ? schema.read(data, tile, reading) : []
    }
  }

  /** Loads the features of one tile. */
  load(tile: TileRequest): Promise<F[]> {
    return this.loader(tile)
  }
}
