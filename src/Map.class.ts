import { Group } from 'three'
import { point2tile, tile2bbox } from './helpers'
import {
  defaultTextureOptions,
  QuadTextureMaterialOptions
} from './quad-texture-material'
import { Source } from './Source.class'
import { Tile } from './Tile.class'
import { Utils } from './Utils.class'

export type MapOptions = {
  nTiles: number
  zoom: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15
  tileSize: number
  tileSegments: number
  zScale: number
}

export type MapProps = {
  source: Source
  location: [number, number]
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
  zoom: number
  source: Source
  geoLocation: [number, number]
  options: MapOptions
  tileSize: number
  nTiles: number

  tileCache: {
    [key: string]: Tile
  } = {}

  terrain = new Group()
  center: {
    x: number
    y: number
  }

  defaultOptions: MapOptions = {
    nTiles: 3,
    zoom: 11,
    tileSize: 600,
    tileSegments: 100,
    zScale: 0.045
  }

  constructor({ source, location, options = {}, material = {} }: MapProps) {
    this.source = source
    this.geoLocation = location

    this.materialOptions = Object.assign(defaultTextureOptions, material)
    this.options = this.getOptions(options)
    this.nTiles = this.options.nTiles
    this.zoom = this.options.zoom
    this.tileSize = this.options.tileSize

    this.terrain = new Group()
    this.tileCache = {}
  }

  getOptions(providedOptions: MapProps['options'] = {}) {
    const options = Object.assign({}, this.defaultOptions, providedOptions)
    options.tileSegments = Math.min(256, Math.round(options.tileSegments))
    return options
  }

  init(cb?: () => void) {
    const [lat, lng] = this.geoLocation
    const [x, y] = point2tile(lng, lat, this.zoom)
    this.center = { x, y }

    const tileOffset = Math.floor(this.nTiles / 2)

    for (let i = 0; i < this.nTiles; i++) {
      for (let j = 0; j < this.nTiles; j++) {
        const tile = new Tile(
          this.zoom,
          this.center.x + i - tileOffset,
          this.center.y + j - tileOffset,
          this.center,
          this.source.mapUrl(
            this.zoom,
            this.center.x + i - tileOffset,
            this.center.y + j - tileOffset
          ),
          this.options,
          this.materialOptions
        )
        this.tileCache[tile.key()] = tile

        if (i === this.nTiles - 1 && j === this.nTiles - 1) {
          if (cb) cb()
        }
      }
    }

    const promises = Object.values(this.tileCache).map((tile) => {
      return tile.fetch().then((tile) => {
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
    // this.onReady()
  }

  addTileSegment(x: number, y: number) {
    const tile = new Tile(
      this.zoom,
      x,
      y,
      this.center,
      this.source.mapUrl(this.zoom, x, y),
      this.options,
      this.materialOptions
    )

    if (tile.key() in this.tileCache) return

    this.tileCache[tile.key()] = tile

    tile
      .fetch()
      .then((v) => this.terrain.add(v.mesh))
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

  getProjection(
    [lat, lng, alt]: [number, number, number],
    providedOptions: { loadTile: boolean } = { loadTile: true }
  ) {
    const defaultOptions = { loadTile: true }
    const opts = Object.assign({}, defaultOptions, providedOptions)

    const { options, zoom, tileCache, center, tileSize } = this
    const { zScale } = options

    const [x, y, z] = point2tile(lng, lat, zoom)
    const tileKey = Utils.getTileKey(z, x, y)

    if (opts.loadTile && !(tileKey in tileCache)) this.addTileSegment(x, y)

    const [w, s, e, n] = tile2bbox([x, y, z])
    const position = Utils.tile2position(z, x, y, center, tileSize)

    const xStart = position.x - tileSize / 2
    const yStart = position.y - tileSize / 2

    const xOffset = tileSize * (1 - (e - lng) / (e - w))
    const yOffset = tileSize * (1 - (n - lat) / (n - s))

    return [xStart + xOffset, yStart + yOffset, alt * zScale]
  }
}
