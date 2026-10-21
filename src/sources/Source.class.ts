import { isNotFound } from '../io/fetch'
import { loadImage } from '../io/image'
import {
  expandTileUrl,
  type Subdomains,
  type TileRequest,
  type TileSourceOptions,
  type TileUrl
} from './tile-source'

export type MapSupportedApi = 'osm' | 'mapbox' | 'eox' | 'maptiler'

/** What a texture tile may be decoded into; anything `drawImage` accepts. */
export type TileImageSource =
  ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas

/** Imagery from any tile server or loader. */
export interface CustomSourceProps extends TileSourceOptions {
  api?: undefined
  /** Tile URL template (`https://…/{z}/{x}/{y}.jpg`) or function. */
  url?: TileUrl
  /** Substituted for `{s}` in `url`; default `'abc'`. */
  subdomains?: Subdomains
  /**
   * Loads a tile yourself (custom headers, WMS, a cache, local files…).
   * Resolve to `null` when the tile does not exist: its ancestor is used.
   * Returned `ImageBitmap`s are closed once drawn.
   */
  load?: (tile: TileRequest) => Promise<TileImageSource | null>
}

export type SourceProps =
  /** No imagery: the terrain is drawn in the map's `material.color`. */
  | { api: 'none' }
  | ({ api: 'osm' | 'eox' } & TileSourceOptions)
  | ({ api: 'mapbox' | 'maptiler'; token: string } & TileSourceOptions)
  | CustomSourceProps

interface Preset {
  url: (z: number, x: number, y: number, token: string) => string
  attribution: string
}

const PRESETS: Record<MapSupportedApi, Preset> = {
  osm: {
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attribution: '© OpenStreetMap contributors'
  },
  // cf. https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml
  eox: {
    url: (z, x, y) =>
      `https://tiles.maps.eox.at/wmts?layer=s2cloudless_3857&style=default&tilematrixset=g&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fjpeg&TileMatrix=${z}&TileCol=${x}&TileRow=${y}`,
    attribution:
      'Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016)'
  },
  mapbox: {
    url: (z, x, y, token) =>
      `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg80?access_token=${token}`,
    attribution: '© Mapbox © OpenStreetMap contributors © Maxar'
  },
  maptiler: {
    url: (z, x, y, token) =>
      `https://api.maptiler.com/tiles/satellite/${z}/${x}/${y}.jpg?key=${token}`,
    attribution: '© MapTiler © OpenStreetMap contributors'
  }
}

/**
 * Where the textures come from: a preset `api`, a `url` template or a `load`
 * function — or `{ api: 'none' }` for no imagery at all.
 */
export class Source {
  readonly api: MapSupportedApi | 'custom' | 'none'
  /** Deepest zoom of the imagery; deeper tiles are cut out of ancestors. */
  readonly maxZoom: number
  readonly attribution: string

  private readonly token: string = ''
  private readonly url: TileUrl | undefined
  private readonly subdomains: Subdomains | undefined
  private readonly customLoad: CustomSourceProps['load']

  constructor(props: SourceProps) {
    if (props.api === 'none') {
      this.api = 'none'
      this.attribution = ''
    } else if (props.api === undefined) {
      if (props.url === undefined && props.load === undefined) {
        throw new Error('Source needs an api, a url or a load function')
      }
      this.api = 'custom'
      this.url = props.url
      this.subdomains = props.subdomains
      this.customLoad = props.load
      this.attribution = props.attribution ?? ''
    } else {
      if (!Object.hasOwn(PRESETS, props.api)) {
        throw new Error(`Unknown source api: ${props.api}`)
      }
      this.api = props.api
      if ('token' in props) this.token = props.token
      this.attribution = props.attribution ?? PRESETS[props.api].attribution
    }
    this.maxZoom = ('maxZoom' in props ? props.maxZoom : undefined) ?? Infinity
  }

  /** URL of a texture tile; `''` without one (`none`, or only a `load` function). */
  tileUrl(z: number, x: number, y: number): string {
    if (this.api === 'none') return ''
    if (this.api !== 'custom') return PRESETS[this.api].url(z, x, y, this.token)
    return this.url === undefined
      ? ''
      : expandTileUrl(this.url, z, x, y, this.subdomains)
  }

  /** Loads one texture tile; `null` if it does not exist (HTTP 404). */
  async load(tile: TileRequest): Promise<TileImageSource | null> {
    if (this.api === 'none') return null
    if (this.customLoad) return this.customLoad(tile)
    try {
      return await loadImage(this.tileUrl(tile.z, tile.x, tile.y), tile.signal)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }
}
