export enum MapSupportedApi {
  OSM = 'osm',
  Mapbox = 'mapbox',
  EOX = 'eox',
  Maptiler = 'maptiler'
}

export class Source {
  api: MapSupportedApi
  token: string
  //  options
  supportedApis: {
    [name in MapSupportedApi]: (z: number, x: number, y: number) => string
  }
  //  supportedApis:

  constructor(api: MapSupportedApi, token: string) {
    this.supportedApis = {
      [MapSupportedApi.OSM]: this.mapUrlOSM.bind(this),
      [MapSupportedApi.Mapbox]: this.mapUrlMapbox.bind(this),
      [MapSupportedApi.EOX]: this.mapUrlSentinel2Cloudless.bind(this),
      [MapSupportedApi.Maptiler]: this.mapUrlmapTiler.bind(this)
    }

    if (!(api in this.supportedApis)) throw new Error('Unknown source api')

    this.api = api
    this.token = token
    // this.options = options
  }

  mapUrlOSM(z: number, x: number, y: number) {
    return `https://c.tile.openstreetmap.org/${z}/${x}/${y}.png`
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
