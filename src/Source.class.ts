export type MapSupportedApi = 'osm' | 'mapbox' | 'eox' | 'maptiler'

export type SourceProps =
  { api: 'osm' | 'eox' } | { api: 'mapbox' | 'maptiler'; token: string }

type TileUrlBuilder = (z: number, x: number, y: number) => string

export class Source {
  api: MapSupportedApi
  token = ''
  supportedApis: Record<MapSupportedApi, TileUrlBuilder>

  constructor(props: SourceProps) {
    this.supportedApis = {
      osm: this.mapUrlOSM.bind(this),
      mapbox: this.mapUrlMapbox.bind(this),
      eox: this.mapUrlSentinel2Cloudless.bind(this),
      maptiler: this.mapUrlmapTiler.bind(this)
    }

    if (!Object.hasOwn(this.supportedApis, props.api)) {
      throw new Error(`Unknown source api: ${props.api}`)
    }

    this.api = props.api
    if ('token' in props) this.token = props.token
  }

  mapUrlOSM(z: number, x: number, y: number) {
    return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
  }

  mapUrlMapbox(z: number, x: number, y: number) {
    return `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg80?access_token=${this.token}`
  }

  mapUrlSentinel2Cloudless(z: number, x: number, y: number) {
    // cf. https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml
    return `https://tiles.maps.eox.at/wmts?layer=s2cloudless_3857&style=default&tilematrixset=g&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fjpeg&TileMatrix=${z}&TileCol=${x}&TileRow=${y}`
  }

  mapUrlmapTiler(z: number, x: number, y: number) {
    return `https://api.maptiler.com/tiles/satellite/${z}/${x}/${y}.jpg?key=${this.token}`
  }

  mapUrl(z: number, x: number, y: number) {
    return this.supportedApis[this.api](z, x, y)
  }
}
