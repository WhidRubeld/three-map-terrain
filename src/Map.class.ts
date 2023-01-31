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
  zoom: number
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
  source: Source
  geoLocation: [number, number]
  options: MapOptions
  tileCache: {
    [key: string]: Tile
  } = {}

  terrain = new Group()
  center: {
    x: number
    y: number
  }

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
    const [lat, lng] = this.geoLocation
    const [x, y] = point2tile(lng, lat, this.options.zoom)
    this.center = { x, y }

    const tileOffset = Math.floor(this.options.nTiles / 2)

    for (let i = 0; i < this.options.nTiles; i++) {
      for (let j = 0; j < this.options.nTiles; j++) {
        const tile = new Tile(
          this.options.zoom,
          this.center.x + i - tileOffset,
          this.center.y + j - tileOffset,
          this.center,
          this.source.mapUrl(
            this.options.zoom,
            this.center.x + i - tileOffset,
            this.center.y + j - tileOffset
          ),
          this.options,
          this.materialOptions
        )
        this.tileCache[tile.key()] = tile

        if (i === this.options.nTiles - 1 && j === this.options.nTiles - 1) {
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

  addTileSegmentAsync(x: number, y: number) {
    return new Promise<Tile>(async (resolve, reject) => {
      try {
        const tile = new Tile(
          this.options.zoom,
          x,
          y,
          this.center,
          this.source.mapUrl(this.options.zoom, x, y),
          this.options,
          this.materialOptions
        )

        if (tile.key() in this.tileCache) {
          throw new Error('Tile already added')
        }

        this.tileCache[tile.key()] = tile

        const data = await tile.fetch()
        this.terrain.add(data.mesh)

        Object.values(this.tileCache).forEach((v) => {
          v.resolveSeams(this.tileCache)
        })

        resolve(data)
      } catch (e) {
        reject(e)
      }
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

  getPositionAsync(
    [lat, lng, alt]: [number, number, number],
    providedOptions: { loadTile: boolean } = { loadTile: true }
  ) {
    return new Promise<[number, number, number]>(async (resolve, reject) => {
      try {
        const defaultOptions = { loadTile: true }
        const opts = Object.assign({}, defaultOptions, providedOptions)

        const { options, tileCache, center } = this
        const { zScale } = options

        const [x, y, z] = point2tile(lng, lat, options.zoom)
        const tileKey = Utils.getTileKey(z, x, y)

        let tile: Tile
        if (!(tileKey in tileCache)) {
          if (opts.loadTile) {
            tile = await this.addTileSegmentAsync(x, y)
          }
          // TODO: add reject if location without elevation
        } else tile = tileCache[tileKey]

        // console.log(tile)

        const [w, s, e, n] = tile2bbox([x, y, z])
        const position = Utils.tile2position(z, x, y, center, options.tileSize)

        const xStart = position.x - options.tileSize / 2
        const yStart = position.y - options.tileSize / 2

        const xOffset = options.tileSize * (1 - (e - lng) / (e - w))
        const yOffset = options.tileSize * (1 - (n - lat) / (n - s))

        resolve([xStart + xOffset, yStart + yOffset, alt * zScale])
      } catch (e) {
        reject(e)
      }
    })
  }
}