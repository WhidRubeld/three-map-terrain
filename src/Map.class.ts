import { Group, type Raycaster, type Vector3 } from 'three'

import { isAbortError } from './image'
import {
  defaultTextureOptions,
  type QuadTextureMaterialOptions
} from './quad-texture-material'
import type { Source } from './Source.class'
import { Tile } from './Tile.class'
import { Utils } from './Utils.class'

/** A geolocation in degrees, with the altitude in meters. */
export interface GeoLocation {
  lat: number
  lon: number
  alt: number
}

export interface MapOptions {
  nTiles: number
  zoom: number
  tileSize: number
  tileSegments: number
  zScale: number
}

export interface MapProps {
  source: Source
  location: { lat: number; lon: number }
  options?: Partial<MapOptions>
  material?: Partial<QuadTextureMaterialOptions>
}

export const defaultMapOptions: Readonly<MapOptions> = Object.freeze({
  nTiles: 3,
  zoom: 11,
  tileSize: 600,
  tileSegments: 100,
  zScale: 0.045
})

export class Map {
  materialOptions: QuadTextureMaterialOptions
  source: Source
  geoLocation: { lat: number; lon: number }
  options: MapOptions
  tileCache: Record<string, Tile> = {}

  terrain = new Group()
  center: { x: number; y: number }
  /** `true` once `init()` has loaded the initial grid. */
  ready = false

  defaultOptions: MapOptions = defaultMapOptions

  private loading: Promise<void> | undefined
  private loads: Record<string, Promise<Tile | undefined>> = {}

  constructor({ source, location, options = {}, material = {} }: MapProps) {
    this.source = source
    this.geoLocation = location
    this.materialOptions = { ...defaultTextureOptions, ...material }
    this.options = this.getOptions(options)
    this.center = this.getCenter()
  }

  getOptions(providedOptions: Partial<MapOptions> = {}): MapOptions {
    const options = { ...this.defaultOptions, ...providedOptions }
    options.tileSegments = Math.max(
      1,
      Math.min(256, Math.round(options.tileSegments))
    )
    return options
  }

  /**
   * Loads an `nTiles × nTiles` grid around `location`.
   * Resolves (and calls `cb`) once every tile has its elevation and the seams
   * are stitched; textures keep streaming in afterwards.
   * Calls made before `clean()` share one load; `clean()` cancels it, and the
   * cancelled call resolves without becoming ready or calling `cb`.
   */
  async init(cb?: () => void): Promise<void> {
    this.loading ??= this.loadGrid()
    const loading = this.loading
    await loading
    if (this.loading !== loading) return

    this.ready = true
    cb?.()
  }

  /** Loads one more tile (no-op if it is already cached). */
  async addTileSegment(x: number, y: number): Promise<void> {
    const tile = this.createTile(x, y)
    if (tile) await this.loadTile(tile)
  }

  /** Removes all tiles, aborts pending requests and frees GPU resources. */
  clean() {
    for (const tile of Object.values(this.tileCache)) tile.dispose()
    this.tileCache = {}
    this.loads = {}
    this.loading = undefined
    this.ready = false
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
      void this.addTileSegment(x, y)
    }

    const [w, s, e, n] = Utils.tile2bbox([x, y, z])
    const position = Utils.tile2position(z, x, y, center, options.tileSize)

    const xStart = position.x - options.tileSize / 2
    const yStart = position.y - options.tileSize / 2

    const xOffset = options.tileSize * (1 - (e - lon) / (e - w))
    const yOffset = options.tileSize * (1 - (n - lat) / (n - s))

    return { x: xStart + xOffset, y: yStart + yOffset, z: alt * zScale }
  }

  /**
   * Like `getPosition`, but `z` is read from the terrain at the location: the
   * point lies exactly on the rendered surface. Waits for the tile under the
   * location, loading it if needed; rejects if it cannot be loaded.
   */
  async getTerrainPosition(location: {
    lat: number
    lon: number
  }): Promise<{ x: number; y: number; z: number }> {
    const { x, y } = this.getPosition({ ...location, alt: 0 })
    const index = this.tileIndexAt(location)
    const tile = await this.loads[Utils.getTileKey(index.z, index.x, index.y)]
    if (!tile?.loaded) {
      throw new Error(`No terrain loaded at ${location.lat}, ${location.lon}`)
    }
    return { x, y, z: this.surfaceZ(tile, x, y) }
  }

  /**
   * Synchronous `getTerrainPosition` for areas that are already loaded, e.g.
   * to move an object along the terrain every frame. Returns `undefined` while
   * the tile under the location is not loaded, and starts loading it unless
   * `loadTile` is `false`.
   */
  getTerrainPositionSync(
    location: { lat: number; lon: number },
    opts: { loadTile: boolean } = { loadTile: true }
  ): { x: number; y: number; z: number } | undefined {
    const { x, y } = this.getPosition({ ...location, alt: 0 }, opts)
    const index = this.tileIndexAt(location)
    const tile = this.cachedTile(index.x, index.y)
    return tile?.loaded ? { x, y, z: this.surfaceZ(tile, x, y) } : undefined
  }

  /**
   * Inverse of `getPosition`: the geolocation of a point given in
   * `map.terrain` coordinates; `alt` is `z / zScale` (meters).
   */
  getLocation({ x, y, z }: { x: number; y: number; z: number }): GeoLocation {
    const { center } = this
    const { zoom, tileSize, zScale } = this.options
    // tiles lie on a regular grid around the center tile
    const origin = Utils.tile2position(
      zoom,
      center.x,
      center.y,
      center,
      tileSize
    )
    const col = (x - origin.x) / tileSize + 0.5
    const row = (origin.y - y) / tileSize + 0.5
    const [w, s, e, n] = Utils.tile2bbox([
      center.x + Math.floor(col),
      center.y + Math.floor(row),
      zoom
    ])

    return {
      lat: n - (row - Math.floor(row)) * (n - s),
      lon: w + (col - Math.floor(col)) * (e - w),
      alt: z / zScale
    }
  }

  /**
   * The terrain location hit by a ray — e.g. after
   * `raycaster.setFromCamera(pointer, camera)` — or `undefined` if it misses
   * the loaded tiles. `point` is the hit in world coordinates.
   */
  pick(raycaster: Raycaster): (GeoLocation & { point: Vector3 }) | undefined {
    this.terrain.updateWorldMatrix(true, true)
    const hit = raycaster.intersectObjects(this.terrain.children, false).at(0)
    if (!hit) return undefined

    const local = this.terrain.worldToLocal(hit.point.clone())
    return { ...this.getLocation(local), point: hit.point }
  }

  private async loadGrid() {
    this.center = this.getCenter()
    const { x, y } = this.center
    const { nTiles } = this.options
    const tileOffset = Math.floor(nTiles / 2)

    const pending: Promise<Tile | undefined>[] = []
    for (let i = 0; i < nTiles; i++) {
      for (let j = 0; j < nTiles; j++) {
        const tile = this.createTile(x + i - tileOffset, y + j - tileOffset)
        if (tile) pending.push(this.loadTile(tile))
      }
    }

    await Promise.all(pending)
  }

  private tileIndexAt({ lat, lon }: { lat: number; lon: number }) {
    return Utils.position2tile(lat, lon, this.options.zoom)
  }

  /** Height of the rendered surface of `tile` at terrain coordinates `x`, `y`. */
  private surfaceZ(tile: Tile, x: number, y: number) {
    const { tileSize } = this.options
    const u = (x - tile.mesh.position.x) / tileSize + 0.5
    const v = 0.5 - (y - tile.mesh.position.y) / tileSize
    return tile.heightAt(u, v)
  }

  private getCenter() {
    const { lat, lon } = this.geoLocation
    const { x, y } = Utils.position2tile(lat, lon, this.options.zoom)
    return { x, y }
  }

  private cachedTile(x: number, y: number): Tile | undefined {
    return this.tileCache[Utils.getTileKey(this.options.zoom, x, y)]
  }

  private createTile(x: number, y: number): Tile | undefined {
    const tile = new Tile(this, this.options.zoom, x, y)
    if (tile.key() in this.tileCache) return undefined
    this.tileCache[tile.key()] = tile
    return tile
  }

  private loadTile(tile: Tile): Promise<Tile | undefined> {
    const loading = this.fetchAndPlace(tile)
    this.loads[tile.key()] = loading
    return loading
  }

  private async fetchAndPlace(tile: Tile): Promise<Tile | undefined> {
    try {
      await tile.fetch()
    } catch (error) {
      if (!isAbortError(error)) console.error(error)
      return undefined
    }
    // The map may have been cleaned while the tile was loading
    if (this.tileCache[tile.key()] !== tile) return undefined

    tile.setPosition(this.center)
    this.stitchAround(tile)
    this.terrain.add(tile.mesh)
    return tile
  }

  /**
   * Stitches a freshly loaded tile into the already loaded ones, so that no
   * crack is ever visible. The tile shares edges with its east/south
   * neighbours (its own seams) and with its west, north and north-west
   * neighbours (their seams). A tile copies its edges from its east/south
   * neighbours, so those are stitched first: descending `x + y` order.
   */
  private stitchAround({ x, y }: Tile) {
    const tiles = [
      this.cachedTile(x, y),
      this.cachedTile(x - 1, y),
      this.cachedTile(x, y - 1),
      this.cachedTile(x - 1, y - 1)
    ].filter((tile): tile is Tile => tile?.loaded === true)

    tiles.sort((a, b) => b.x + b.y - (a.x + a.y))
    for (const tile of tiles) tile.resolveSeams(this.tileCache)

    const touched = new Set<Tile>()
    for (const [cx, cy] of [
      [x, y],
      [x + 1, y],
      [x, y + 1],
      [x + 1, y + 1]
    ]) {
      this.syncCorner(cx, cy, touched)
    }
    for (const tile of touched) tile.updateGeometry()
  }

  /**
   * Edges alone cannot agree on a point shared by four tiles while the
   * diagonal tile is missing: each side holds its own approximation. Give the
   * point (the top-left corner of tile `x`, `y`) one value from the best
   * loaded source — the exact pixel of tile `x`, `y` first — in every tile.
   */
  private syncCorner(x: number, y: number, touched: Set<Tile>) {
    const n = this.options.tileSegments
    const corners = [
      { tile: this.cachedTile(x, y), index: 0 },
      { tile: this.cachedTile(x - 1, y), index: n },
      { tile: this.cachedTile(x, y - 1), index: n * (n + 1) },
      { tile: this.cachedTile(x - 1, y - 1), index: (n + 1) ** 2 - 1 }
    ].filter(
      (corner): corner is { tile: Tile; index: number } =>
        corner.tile?.loaded === true
    )
    if (corners.length < 2) return

    const [source, ...others] = corners
    const z = source.tile.geometry.attributes.position.getZ(source.index)
    for (const { tile, index } of others) {
      const position = tile.geometry.attributes.position
      if (position.getZ(index) === z) continue
      position.setZ(index, z)
      touched.add(tile)
    }
  }
}
