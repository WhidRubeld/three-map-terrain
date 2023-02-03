import { Group } from 'three'
import {
  defaultTextureOptions,
  QuadTextureMaterialOptions
} from './quad-texture-material'
import { Source } from './Source.class'
import { Tile } from './Tile.class'
import { Utils } from './Utils.class'

export type MapOptions = {
  nTiles: number
  zoom: number
  tileSize: number
  tileSegments: number
  zScale: number
}

export type MapProps = {
  source: Source
  location: { lat: number; lon: number }
  options?: Partial<MapOptions>
  material?: Partial<QuadTextureMaterialOptions>
}

export const defaultMapOptions: MapOptions = {
  nTiles: 3,
  zoom: 11,
  tileSize: 600,
  tileSegments: 100,
  zScale: 0.045
}

export class Map {
  materialOptions: QuadTextureMaterialOptions = defaultTextureOptions
  source: Source
  geoLocation: { lat: number; lon: number }
  options: MapOptions
  tileCache: {
    [key: string]: Tile
  } = {}

  terrain = new Group()
  center: {
    x: number
    y: number
  }
  ready: boolean

  defaultOptions: MapOptions = defaultMapOptions
  constructor({ source, location, options = {}, material = {} }: MapProps) {
    this.source = source
    this.geoLocation = location

    this.materialOptions = Object.assign(defaultTextureOptions, material)
    this.options = this.getOptions(options)

    this.terrain = new Group()
    this.tileCache = {}
  }

  getOptions(providedOptions: MapProps['options'] = {}) {
    const options = Object.assign({}, this.defaultOptions, providedOptions)
    options.tileSegments = Math.min(256, Math.round(options.tileSegments))
    return options
  }

  init(cb?: () => void) {
    const { x, y } = Utils.position2tile(
      this.geoLocation.lat,
      this.geoLocation.lon,
      this.options.zoom
    )
    this.center = { x, y }

    const tileOffset = Math.floor(this.options.nTiles / 2)

    for (let i = 0; i < this.options.nTiles; i++) {
      for (let j = 0; j < this.options.nTiles; j++) {
        const tile = new Tile(
          this,
          this.options.zoom,
          this.center.x + i - tileOffset,
          this.center.y + j - tileOffset
        )
        this.tileCache[tile.key()] = tile

        if (i === this.options.nTiles - 1 && j === this.options.nTiles - 1) {
          if (cb) cb()
        }
      }
    }

    const promises = Object.values(this.tileCache).map((tile) => {
      return tile.fetch().then((tile) => {
        tile.setPosition(this.center)
        this.terrain.add(tile.mesh)
        return tile
      })
    })

    Promise.all(promises).then((tiles) => {
      tiles.reverse().forEach((tile) => {
        // reverse to avoid seams artifacts
        tile.resolveSeams(this.tileCache)
      })
    })
  }

  addTileSegment(x: number, y: number) {
    const tile = new Tile(this, this.options.zoom, x, y)

    if (tile.key() in this.tileCache) return
    console.log('test 2')
    this.tileCache[tile.key()] = tile

    tile
      .fetch()
      .then((v) => {
        tile.setPosition(this.center)
        this.terrain.add(v.mesh)
      })
      .then(() => {
        Object.values(this.tileCache).forEach((v) => {
          v.resolveSeams(this.tileCache)
        })
      })
  }

  clean() {
    Object.values(this.tileCache).forEach((tile) => {
      this.terrain.remove(tile.mesh)
      tile.mesh.geometry.dispose()
      ;['mapSW', 'mapNW', 'mapSE', 'mapNE'].forEach((key) =>
        // @ts-ignore
        tile.mesh.material.uniforms[key].value.dispose()
      )
      // @ts-ignore
      tile.mesh.material.dispose()
    })
    this.tileCache = {}
  }

  getPosition(
    { lat, lon, alt }: { lat: number; lon: number; alt: number },
    opts: { loadTile: boolean } = { loadTile: true }
  ) {
    const { options, tileCache, center } = this
    const { zScale } = options

    const { x, y, z } = Utils.position2tile(lat, lon, options.zoom)
    const tileKey = Utils.getTileKey(z, x, y)

    if (!(tileKey in tileCache) && opts.loadTile) {
      this.addTileSegment(x, y)
    }

    const [w, s, e, n] = Utils.tile2bbox([x, y, z])
    const position = Utils.tile2position(z, x, y, center, options.tileSize)

    const xStart = position.x - options.tileSize / 2
    const yStart = position.y - options.tileSize / 2

    const xOffset = options.tileSize * (1 - (e - lon) / (e - w))
    const yOffset = options.tileSize * (1 - (n - lat) / (n - s))

    return { x: xStart + xOffset, y: yStart + yOffset, z: alt * zScale }
  }
}
