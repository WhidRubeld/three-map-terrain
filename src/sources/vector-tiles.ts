// Vector tiles (MVT) from a tile server: loaded once, read by every layer.

import { isNotFound, loadArrayBuffer, loadJson } from '../io/fetch'
import { decodeVectorTile, gunzip, type VectorTileLayer } from '../io/mvt'
import {
  expandTileUrl,
  type Subdomains,
  type TileRequest,
  type TileUrl
} from './tile-source'

export type VectorTilesApi =
  'openfreemap' | 'versatiles' | 'maptiler' | 'mapbox' | 'protomaps'

/**
 * How a basemap's vector tiles are organized — layer names and fields. The
 * layers read each one their way; anything else needs `layers` and
 * `properties`.
 */
export type VectorSchema =
  'openmaptiles' | 'shortbread' | 'mapbox' | 'protomaps'

interface Options {
  /** Deepest zoom the tiles have; deeper terrain shares them. */
  maxZoom?: number
  /** Credit for the data, listed in `map.attributions`. */
  attribution?: string
}

export type VectorTilesProps =
  | ({ api: 'openfreemap' | 'versatiles' } & Options)
  | ({ api: 'maptiler' | 'mapbox' | 'protomaps'; token: string } & Options)
  | ({
      api?: undefined
      /** Tile URL template (`https://…/{z}/{x}/{y}.pbf`) or function… */
      url: TileUrl
      tilejson?: undefined
      /** Substituted for `{s}` in `url`; default `'abc'`. */
      subdomains?: Subdomains
      /** Default `'openmaptiles'`. */
      schema?: VectorSchema
    } & Options)
  | ({
      api?: undefined
      url?: undefined
      /** …or the URL of a TileJSON listing the tiles (fetched once). */
      tilejson: string
      schema?: VectorSchema
    } & Options)

interface Preset {
  url?: (token: string) => string
  tilejson?: string
  schema: VectorSchema
  maxZoom: number
  attribution: string
}

const OSM = '© OpenStreetMap contributors'

const PRESETS: Record<VectorTilesApi, Preset> = {
  // the tile URLs change with every planet build: resolved from the TileJSON
  openfreemap: {
    tilejson: 'https://tiles.openfreemap.org/planet',
    schema: 'openmaptiles',
    maxZoom: 14,
    attribution: `OpenFreeMap © OpenMapTiles ${OSM}`
  },
  versatiles: {
    url: () => 'https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}',
    schema: 'shortbread',
    maxZoom: 14,
    attribution: `VersaTiles ${OSM}`
  },
  maptiler: {
    url: (token) =>
      `https://api.maptiler.com/tiles/v3/{z}/{x}/{y}.pbf?key=${token}`,
    schema: 'openmaptiles',
    maxZoom: 14,
    attribution: `© MapTiler ${OSM}`
  },
  mapbox: {
    url: (token) =>
      `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/{z}/{x}/{y}.vector.pbf?access_token=${token}`,
    schema: 'mapbox',
    maxZoom: 16,
    attribution: `© Mapbox ${OSM}`
  },
  protomaps: {
    url: (token) =>
      `https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?key=${token}`,
    schema: 'protomaps',
    maxZoom: 15,
    attribution: `Protomaps ${OSM}`
  }
}

/**
 * A decoded vector tile. Its layers are decoded when first read, so that a
 * tile serves every layer of the map without decoding what none needs.
 */
export class VectorTileData {
  private readonly layers = new Map<string, VectorTileLayer | undefined>()

  constructor(private readonly bytes: Uint8Array) {}

  /** The layer of that name, or `undefined`. */
  layer(name: string): VectorTileLayer | undefined {
    if (!this.layers.has(name)) {
      this.layers.set(name, decodeVectorTile(this.bytes, [name])[name])
    }
    return this.layers.get(name)
  }
}

interface Pending {
  data: Promise<VectorTileData | undefined>
  controller: AbortController
  users: number
}

const shared = new Map<string, VectorTiles>()

/**
 * Vector tiles (MVT) from a preset `api`, a `url` template or a `tilejson`.
 * A tile asked for by several layers at once — buildings and roads from the
 * same basemap — is loaded and decoded once; it is cancelled only when all
 * of them let go.
 */
export class VectorTiles {
  readonly api: VectorTilesApi | 'custom'
  readonly schema: VectorSchema
  readonly maxZoom: number
  readonly attribution: string

  private readonly tileUrl: (z: number, x: number, y: number) => Promise<string>
  private readonly pending = new Map<string, Pending>()

  constructor(props: VectorTilesProps) {
    if (props.api !== undefined) {
      if (!Object.hasOwn(PRESETS, props.api)) {
        throw new Error(`Unknown vector tiles api: ${props.api}`)
      }
      const preset = PRESETS[props.api]
      const token = 'token' in props ? props.token : ''
      this.api = props.api
      this.schema = preset.schema
      this.maxZoom = props.maxZoom ?? preset.maxZoom
      this.attribution = props.attribution ?? preset.attribution
      this.tileUrl = urlBuilder({
        url: preset.url?.(token),
        tilejson: preset.tilejson
      })
      return
    }
    this.api = 'custom'
    this.schema = props.schema ?? 'openmaptiles'
    this.maxZoom = props.maxZoom ?? 14
    this.attribution = props.attribution ?? ''
    this.tileUrl = urlBuilder(props)
  }

  /** The instance of a preset shared by every layer using it. */
  static preset(api: VectorTilesApi, token = ''): VectorTiles {
    const key = `${api} ${token}`
    let tiles = shared.get(key)
    if (!tiles) {
      tiles = new VectorTiles(
        api === 'openfreemap' || api === 'versatiles' ? { api } : { api, token }
      )
      shared.set(key, tiles)
    }
    return tiles
  }

  /** Loads a tile; `undefined` where there is none (HTTP 404: sea, empty). */
  load({ z, x, y, signal }: TileRequest): Promise<VectorTileData | undefined> {
    const key = `${z}/${x}/${y}`
    let pending = this.pending.get(key)
    if (!pending) {
      const controller = new AbortController()
      const entry: Pending = {
        controller,
        users: 0,
        data: this.fetch(z, x, y, controller.signal)
      }
      const done = () => {
        if (this.pending.get(key) === entry) this.pending.delete(key)
      }
      entry.data.then(done, done)
      this.pending.set(key, entry)
      pending = entry
    }
    const entry = pending
    entry.users++
    return new Promise((resolve, reject) => {
      const leave = () => {
        if (--entry.users === 0 && this.pending.get(key) === entry) {
          this.pending.delete(key)
          entry.controller.abort()
        }
        reject(signal.reason as Error)
      }
      if (signal.aborted) {
        leave()
        return
      }
      signal.addEventListener('abort', leave, { once: true })
      entry.data
        .finally(() => {
          signal.removeEventListener('abort', leave)
        })
        .then(resolve, reject)
    })
  }

  private async fetch(z: number, x: number, y: number, signal: AbortSignal) {
    const url = await this.tileUrl(z, x, y)
    let data: ArrayBuffer | undefined
    try {
      data = await loadArrayBuffer(url, signal)
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
    return data ? new VectorTileData(await gunzip(data)) : undefined
  }
}

/** Tile URLs from a template, or from a TileJSON resolved once. */
function urlBuilder({
  url,
  tilejson,
  subdomains
}: {
  url?: TileUrl
  tilejson?: string
  subdomains?: Subdomains
}): (z: number, x: number, y: number) => Promise<string> {
  if (url !== undefined) {
    return (z, x, y) => Promise.resolve(expandTileUrl(url, z, x, y, subdomains))
  }
  if (tilejson === undefined) {
    throw new Error('Vector tiles need an api, a url or a tilejson')
  }
  const template = tileJsonUrl(tilejson)
  return async (z, x, y) => expandTileUrl(await template(), z, x, y, subdomains)
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
