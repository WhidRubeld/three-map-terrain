import { isNotFound } from '../io/fetch'
import { loadImageData } from '../io/image'
import {
  expandTileUrl,
  type Subdomains,
  type TileRequest,
  type TileSourceOptions,
  type TileUrl
} from './tile-source'

/** RGBA pixels of an RGB-encoded elevation tile (e.g. `ImageData`). */
export interface ElevationPixels {
  readonly width: number
  readonly height: number
  readonly data: ArrayLike<number>
}

/** Turns the RGB of one pixel into meters. */
export type ElevationDecoder = (r: number, g: number, b: number) => number

/** `terrarium`: `R·256 + G + B/256 − 32768`; `mapbox`: `(R·65536 + G·256 + B)·0.1 − 10000`. */
export type ElevationEncoding = 'terrarium' | 'mapbox'

export type ElevationApi = 'aws' | 'mapterhorn' | 'mapbox' | 'maptiler'

export const decodeTerrarium: ElevationDecoder = (r, g, b) =>
  r * 256 + g + b / 256 - 32768

export const decodeMapbox: ElevationDecoder = (r, g, b) =>
  (r * 65536 + g * 256 + b) * 0.1 - 10000

const DECODERS: Record<ElevationEncoding, ElevationDecoder> = {
  terrarium: decodeTerrarium,
  mapbox: decodeMapbox
}

/** Elevation from any tile server or loader. */
export interface CustomElevationProps extends TileSourceOptions {
  api?: undefined
  /** Tile URL template (`https://…/{z}/{x}/{y}.png`) or function. */
  url?: TileUrl
  /** Substituted for `{s}` in `url`; default `'abc'`. */
  subdomains?: Subdomains
  /** How the pixels encode meters; default `terrarium`. */
  encoding?: ElevationEncoding | ElevationDecoder
  /**
   * Loads a tile yourself (GeoTIFF, LERC, a cache…) as RGBA pixels decoded
   * by `encoding`. Resolve to `null` when the tile does not exist: its
   * ancestor is used.
   */
  load?: (tile: TileRequest) => Promise<ElevationPixels | null>
}

export type ElevationSourceProps =
  | ({ api: 'aws' | 'mapterhorn' } & TileSourceOptions)
  | ({ api: 'mapbox' | 'maptiler'; token: string } & TileSourceOptions)
  | CustomElevationProps

interface Preset {
  url: (token: string) => string
  encoding: ElevationEncoding
  maxZoom: number
  attribution: string
}

const PRESETS: Record<ElevationApi, Preset> = {
  // https://registry.opendata.aws/terrain-tiles/
  aws: {
    url: () =>
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding: 'terrarium',
    maxZoom: 15,
    attribution: 'Terrain Tiles by Mapzen on AWS Open Data'
  },
  // https://mapterhorn.com: 512 px tiles, deeper where finer data exists
  mapterhorn: {
    url: () => 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
    encoding: 'terrarium',
    maxZoom: Infinity,
    attribution: '© Mapterhorn'
  },
  mapbox: {
    url: (token) =>
      `https://api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}.pngraw?access_token=${token}`,
    encoding: 'mapbox',
    maxZoom: 15,
    attribution: '© Mapbox'
  },
  maptiler: {
    url: (token) =>
      `https://api.maptiler.com/tiles/terrain-rgb-v2/{z}/{x}/{y}.webp?key=${token}`,
    encoding: 'mapbox',
    maxZoom: 14,
    attribution: '© MapTiler'
  }
}

/** Where the elevation comes from: a preset `api`, a `url` template or a `load` function. */
export class ElevationSource {
  readonly api: ElevationApi | 'custom'
  /** Deepest zoom of the data; deeper tiles are cut out of ancestors. */
  readonly maxZoom: number
  readonly attribution: string
  /** Meters from the RGB of a pixel. */
  readonly decode: ElevationDecoder

  private readonly url: TileUrl | undefined
  private readonly subdomains: Subdomains | undefined
  private readonly customLoad: CustomElevationProps['load']

  constructor(props: ElevationSourceProps = { api: 'aws' }) {
    if (props.api === undefined) {
      if (props.url === undefined && props.load === undefined) {
        throw new Error(
          'ElevationSource needs an api, a url or a load function'
        )
      }
      const { encoding = 'terrarium' } = props
      this.api = 'custom'
      this.url = props.url
      this.subdomains = props.subdomains
      this.customLoad = props.load
      this.decode =
        typeof encoding === 'function' ? encoding : DECODERS[encoding]
      this.maxZoom = props.maxZoom ?? Infinity
      this.attribution = props.attribution ?? ''
      return
    }

    if (!Object.hasOwn(PRESETS, props.api)) {
      throw new Error(`Unknown elevation api: ${props.api}`)
    }
    const preset = PRESETS[props.api]
    this.api = props.api
    this.url = preset.url('token' in props ? props.token : '')
    this.decode = DECODERS[preset.encoding]
    this.maxZoom = props.maxZoom ?? preset.maxZoom
    this.attribution = props.attribution ?? preset.attribution
  }

  /** URL of an elevation tile; `''` for a source that only has a `load` function. */
  tileUrl(z: number, x: number, y: number) {
    return this.url === undefined
      ? ''
      : expandTileUrl(this.url, z, x, y, this.subdomains)
  }

  /** Loads the pixels of one tile; `null` if it does not exist (HTTP 404). */
  async load(tile: TileRequest): Promise<ElevationPixels | null> {
    if (this.customLoad) return this.customLoad(tile)
    try {
      return await loadImageData(
        this.tileUrl(tile.z, tile.x, tile.y),
        tile.signal
      )
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }
}
