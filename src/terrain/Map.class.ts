import { Group, Matrix4, type Raycaster, type Vector3 } from 'three'

import {
  exportModel,
  type ModelFormat,
  type ModelOptions
} from '../export/model'

import {
  ElevationSource,
  type ElevationSourceProps
} from '../sources/ElevationSource.class'
import { isAbortError } from '../io/fetch'
import { defaultMaterialOptions, type TerrainMaterialOptions } from './material'
import { Source, type SourceProps } from '../sources/Source.class'
import { Tile } from './Tile.class'
import { Utils } from '../geo/Utils.class'

/** A geolocation in degrees, with the altitude in meters. */
export interface GeoLocation {
  lat: number
  lon: number
  alt: number
}

export interface MapOptions {
  nTiles: number
  /**
   * The grid in tiles of `zoom`, inclusive: any rectangle, e.g. around a
   * track. Replaces the `nTiles × nTiles` square around `location`, which
   * still sets the coordinates (`center`: the tile at the origin of
   * `map.terrain`) and need not lie in the grid.
   */
  grid?: { minX: number; minY: number; maxX: number; maxY: number }
  zoom: number
  tileSize: number
  tileSegments: number
  /** Scene units per meter of elevation. */
  zScale: number
  /**
   * Vertical exaggeration relative to true scale (1: as wide as high); when
   * set, it decides `zScale` for the map's latitude, zoom and tile size.
   */
  exaggeration?: number
  /** Altitude in meters drawn at z = 0, e.g. the city's: the scene stays near the origin. */
  baseAltitude?: number
  /**
   * Zoom levels the imagery is deeper than the terrain: a tile is textured
   * with `4^offset` imagery tiles stitched into one — 0: its own (a quarter
   * of the requests and texture memory), 1 (default): its four children,
   * 2: sixteen, sharper; at most 3.
   */
  imageryZoomOffset?: number
  /**
   * Meters a skirt hangs straight down from every tile's edges, in its
   * material: it fills the cracks where this map meets another whose edges
   * lie at other heights — e.g. a coarser map around it (levels of detail,
   * see `alignTo()`). 0 (default): none. Never picked or exported.
   */
  skirt?: number
}

export interface MapProps {
  /**
   * Texture tiles: a `Source`, or the props to create one. Without it the
   * terrain has no imagery and is drawn in `material.color`.
   */
  source?: Source | SourceProps
  /** Elevation tiles; AWS Terrain Tiles by default. */
  elevation?: ElevationSource | ElevationSourceProps
  location: { lat: number; lon: number }
  options?: Partial<MapOptions>
  /**
   * How the terrain is drawn: the look (`color`, `lights`, `wireframe`,
   * `fog`), a `process` for the imagery, or your own material factory
   * (`create`).
   */
  material?: Partial<TerrainMaterialOptions>
}

/**
 * Something drawn with the terrain, tile by tile — e.g. `Buildings`. Add it
 * with `map.addLayer()`; every method is optional.
 */
export interface MapLayer {
  /** Credit for the layer's data, listed in `map.attributions`. */
  readonly attribution?: string
  /** Called by `map.addLayer()`, before `tileLoaded` for the loaded tiles. */
  attach?(map: Map): void
  /** Called by `map.removeLayer()`: remove and free everything. */
  detach?(map: Map): void
  /** A tile has its elevation, its seams are stitched and it is in `map.terrain`. */
  tileLoaded?(tile: Tile): void
  /**
   * The heights of a placed tile changed: its edges were stitched to a
   * neighbour that loaded. Geometry lying on the surface follows.
   */
  tileChanged?(tile: Tile): void
  /** A loaded tile is about to be disposed (`map.clean()`, `map.removeTileSegment()`). */
  tileRemoved?(tile: Tile): void
  /** `map.setMaterial()` changed the style, which layers may follow. */
  materialChanged?(map: Map): void
  /** Resolves once the layer has everything for the loaded tiles; `map.whenReady()` waits for it. */
  whenReady?(): Promise<void>
}

export interface MapExportOptions extends Omit<
  ModelOptions,
  'scale' | 'filter'
> {
  /**
   * `meters` (default): true to scale horizontally, heights with the map's
   * exaggeration; or `scene` units.
   */
  units?: 'meters' | 'scene'
  /** Also the layers — buildings, base; default `true`. */
  layers?: boolean
}

/** The grid of `init()`, as tile coordinates at `zoom`. */
export interface TileGrid {
  zoom: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Calls a layer hook; a failing layer must not break the terrain. */
function notify(
  layer: MapLayer,
  hook: 'tileLoaded' | 'tileChanged' | 'tileRemoved',
  tile: Tile
) {
  try {
    layer[hook]?.(tile)
  } catch (error) {
    console.error(error)
  }
}

export const defaultMapOptions: Readonly<MapOptions> = Object.freeze({
  nTiles: 3,
  zoom: 11,
  tileSize: 600,
  tileSegments: 100,
  zScale: 0.045,
  baseAltitude: 0,
  imageryZoomOffset: 1,
  skirt: 0
})

export class Map {
  materialOptions: TerrainMaterialOptions
  source: Source
  elevation: ElevationSource
  geoLocation: { lat: number; lon: number }
  options: MapOptions
  tileCache: Record<string, Tile> = {}

  terrain = new Group()
  /**
   * Where the layers draw first — the tiles nearest it, a few at a time
   * between frames: e.g. `camera.position` or the controls' `target`, in
   * world coordinates (followed as it moves). By default the `location`.
   */
  focus: Vector3 | undefined
  center: { x: number; y: number }
  /** `true` once `init()` has loaded the initial grid. */
  ready = false

  private loading: Promise<void> | undefined
  private loads: Record<string, Promise<Tile | undefined>> = {}
  private readonly mapLayers: MapLayer[] = []

  constructor({
    source = { api: 'none' },
    elevation = new ElevationSource(),
    location,
    options = {},
    material = {}
  }: MapProps) {
    this.source = source instanceof Source ? source : new Source(source)
    this.elevation =
      elevation instanceof ElevationSource
        ? elevation
        : new ElevationSource(elevation)
    this.geoLocation = location
    this.materialOptions = { ...defaultMaterialOptions, ...material }
    this.options = this.getOptions(options)
    this.center = this.getCenter()
  }

  getOptions(providedOptions: Partial<MapOptions> = {}): MapOptions {
    const options = { ...defaultMapOptions, ...providedOptions }
    options.tileSegments = Math.max(
      1,
      Math.min(256, Math.round(options.tileSegments))
    )
    options.imageryZoomOffset = Math.max(
      0,
      Math.min(3, Math.round(options.imageryZoomOffset ?? 1))
    )
    if (options.grid) {
      const { minX, minY, maxX, maxY } = options.grid
      if (
        ![minX, minY, maxX, maxY].every(Number.isInteger) ||
        minX > maxX ||
        minY > maxY
      ) {
        throw new Error(
          `The grid needs integer tiles, minX ≤ maxX and minY ≤ maxY: ${JSON.stringify(options.grid)}`
        )
      }
      options.grid = { minX, minY, maxX, maxY }
    }
    if (options.exaggeration !== undefined) {
      const { lat } = this.geoLocation
      options.zScale =
        (options.exaggeration * options.tileSize) /
        Utils.tileWidth(lat, options.zoom)
    }
    return options
  }

  /**
   * Loads the tiles of `grid`: `options.grid`, else `nTiles × nTiles`
   * around `location`.
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

  /**
   * Removes a tile — e.g. one the camera has left far behind, or one that
   * another map covers in more detail: the layers drop what they drew on
   * it, a load still running is aborted, its GPU resources are freed. Its
   * neighbours keep their stitched edges; `addTileSegment()` loads it again.
   * Returns whether there was such a tile.
   */
  removeTileSegment(x: number, y: number): boolean {
    const tile = this.cachedTile(x, y)
    if (!tile) return false
    this.removeTile(tile)
    Reflect.deleteProperty(this.tileCache, tile.key())
    Reflect.deleteProperty(this.loads, tile.key())
    return true
  }

  /** The layers added with `addLayer()`, in order. */
  get layers(): readonly MapLayer[] {
    return this.mapLayers
  }

  /**
   * Adds a layer: it is attached, then told about every tile loaded so far
   * and about every tile from now on. Layers survive `clean()`.
   */
  addLayer<T extends MapLayer>(layer: T): T {
    if (this.mapLayers.includes(layer)) return layer
    this.mapLayers.push(layer)
    layer.attach?.(this)
    for (const tile of this.placedTiles()) notify(layer, 'tileLoaded', tile)
    return layer
  }

  /** Removes a layer added with `addLayer()` and lets it free its resources. */
  removeLayer(layer: MapLayer) {
    const index = this.mapLayers.indexOf(layer)
    if (index === -1) return
    this.mapLayers.splice(index, 1)
    layer.detach?.(this)
  }

  /**
   * Credits for the data shown — imagery, elevation and layers — to display
   * next to the map, as most data licenses require.
   */
  get attributions(): string[] {
    const credits = [
      this.source.attribution,
      this.elevation.attribution,
      ...this.mapLayers.map((layer) => layer.attribution ?? '')
    ]
    return [...new Set(credits.filter((credit) => credit !== ''))]
  }

  /**
   * The grid of `init()`, in tiles of `zoom`: `options.grid`, else the
   * `nTiles × nTiles` square around `location`.
   */
  get grid(): TileGrid {
    const { zoom, nTiles, grid } = this.options
    if (grid) return { ...grid, zoom }
    const offset = Math.floor(nTiles / 2)
    const minX = this.center.x - offset
    const minY = this.center.y - offset
    return {
      zoom,
      minX,
      minY,
      maxX: minX + nTiles - 1,
      maxY: minY + nTiles - 1
    }
  }

  /** Geographic bounds of the grid: `[west, south, east, north]` in degrees. */
  get bounds(): [west: number, south: number, east: number, north: number] {
    const { zoom, minX, minY, maxX, maxY } = this.grid
    const [west, , , north] = Utils.tile2bbox([minX, minY, zoom])
    const [, south, east] = Utils.tile2bbox([maxX, maxY, zoom])
    return [west, south, east, north]
  }

  /**
   * Replaces the imagery — `{ api: 'none' }` turns it off — and reloads the
   * textures of the loaded tiles; each keeps its current one until then.
   */
  setSource(source: Source | SourceProps) {
    const previous = this.source
    this.source = source instanceof Source ? source : new Source(source)
    // from no imagery to no imagery: nothing to reload
    if (previous.api === 'none' && this.source.api === 'none') return
    for (const tile of this.placedTiles()) void tile.loadTexture()
  }

  /**
   * Changes the material options of the terrain — the look, `process`,
   * `create` — and of the layers that follow its look (buildings, roads,
   * base). The materials are made again on the same textures; only a new
   * `process` reloads the imagery.
   */
  setMaterial(options: Partial<TerrainMaterialOptions>) {
    const previous = this.materialOptions
    this.materialOptions = { ...previous, ...options }
    const reload =
      this.materialOptions.process !== previous.process &&
      this.source.api !== 'none'
    for (const tile of this.placedTiles()) {
      if (reload) void tile.loadTexture()
      else tile.restyle()
    }
    for (const layer of this.mapLayers) {
      try {
        layer.materialChanged?.(this)
      } catch (error) {
        console.error(error)
      }
    }
  }

  /**
   * Resolves once everything is loaded: the grid (as `init()`), tiles loaded
   * since, their textures and the content of the layers (e.g. buildings).
   */
  async whenReady(): Promise<void> {
    await this.loading
    await Promise.all(Object.values(this.loads))
    await Promise.all(
      Object.values(this.tileCache).map((tile) => tile.whenTextured())
    )
    await Promise.all(
      this.mapLayers.map((layer) => layer.whenReady?.() ?? Promise.resolve())
    )
  }

  /**
   * Exports the terrain with its imagery and layers as a 3D model file —
   * `glb` (default), `gltf`, `obj`, `stl` (3D printing) or `usdz` (AR) — once
   * everything is loaded. Save the blob, e.g. with a download link.
   */
  async export(
    format: ModelFormat = 'glb',
    { units = 'meters', layers = true, ...options }: MapExportOptions = {}
  ): Promise<Blob> {
    await this.whenReady()
    const { zoom, tileSize } = this.options
    const tiles = new Set<unknown>(this.placedTiles().map((tile) => tile.mesh))
    return exportModel(this.terrain, format, {
      ...options,
      scale:
        units === 'meters'
          ? Utils.tileWidth(this.geoLocation.lat, zoom) / tileSize
          : 1,
      // the tiles; the rest of map.terrain is the layers'
      filter: (object) =>
        object.parent !== this.terrain || tiles.has(object) || layers
    })
  }

  /** Removes all tiles, aborts pending requests and frees GPU resources. */
  clean() {
    for (const tile of Object.values(this.tileCache)) this.removeTile(tile)
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
    const { zScale, baseAltitude = 0 } = options

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

    return {
      x: xStart + xOffset,
      y: yStart + yOffset,
      z: (alt - baseAltitude) * zScale
    }
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
   * `map.terrain` coordinates; `alt` is `z / zScale + baseAltitude` (meters).
   */
  getLocation({ x, y, z }: { x: number; y: number; z: number }): GeoLocation {
    const { center } = this
    const { zoom, tileSize, zScale, baseAltitude = 0 } = this.options
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
      alt: z / zScale + baseAltitude
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

  /**
   * Places `terrain` so that this map lines up with another one: every
   * place, and every altitude, at the same point of the scene — whatever
   * the zooms, tile sizes and vertical scales. E.g. a coarser map around a
   * detailed one (levels of detail: remove the tiles the detailed one
   * covers, give both a `skirt`), or a second area at another zoom. Sets
   * the position, rotation and scale of `terrain` from the other's world
   * transform (and its own parent's, if it has one): call it again after
   * moving the other map.
   */
  alignTo(other: Map) {
    const [mine, theirs] = [this.frame(), other.frame()]
    const { zScale, baseAltitude = 0 } = this.options
    const { zScale: otherZScale, baseAltitude: otherBase = 0 } = other.options
    const scale = theirs.units / mine.units
    const transform = new Matrix4()
      .makeScale(scale, scale, zScale === 0 ? 1 : otherZScale / zScale)
      .setPosition(
        (mine.x - theirs.x) * theirs.units,
        (theirs.y - mine.y) * theirs.units,
        (baseAltitude - otherBase) * otherZScale
      )

    other.terrain.updateWorldMatrix(true, false)
    transform.premultiply(other.terrain.matrixWorld)
    const parent = this.terrain.parent
    if (parent) {
      parent.updateWorldMatrix(true, false)
      transform.premultiply(parent.matrixWorld.clone().invert())
    }
    const { position, quaternion, scale: size } = this.terrain
    transform.decompose(position, quaternion, size)
  }

  private async loadGrid() {
    this.center = this.getCenter()
    const { minX, minY, maxX, maxY } = this.grid

    const pending: Promise<Tile | undefined>[] = []
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const tile = this.createTile(x, y)
        if (tile) pending.push(this.loadTile(tile))
      }
    }

    await Promise.all(pending)
  }

  /** Loaded tiles that are in `terrain` (the ones layers know about). */
  private placedTiles() {
    return Object.values(this.tileCache).filter(
      (tile) => tile.loaded && tile.mesh.parent === this.terrain
    )
  }

  /** Disposes a tile; layers forget it first if they know it. */
  private removeTile(tile: Tile) {
    if (tile.loaded && tile.mesh.parent === this.terrain) {
      for (const layer of this.mapLayers) notify(layer, 'tileRemoved', tile)
    }
    tile.dispose()
  }

  /**
   * Where the origin of `terrain` lies on the Web Mercator square (`x` east,
   * `y` south, 0–1), and how many units of `terrain` the square is wide.
   */
  private frame() {
    const { center } = this
    const { zoom, tileSize } = this.options
    // tiles lie on a regular grid around the center tile
    const origin = Utils.tile2position(
      zoom,
      center.x,
      center.y,
      center,
      tileSize
    )
    const tiles = 2 ** zoom
    return {
      x: (center.x + 0.5 - origin.x / tileSize) / tiles,
      y: (center.y + 0.5 + origin.y / tileSize) / tiles,
      units: tileSize * tiles
    }
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
    const changed = this.stitchAround(tile)
    this.terrain.add(tile.mesh)
    for (const layer of this.mapLayers) {
      notify(layer, 'tileLoaded', tile)
      for (const neighbour of changed) {
        if (neighbour !== tile && neighbour.mesh.parent === this.terrain) {
          notify(layer, 'tileChanged', neighbour)
        }
      }
    }
    return tile
  }

  /**
   * Stitches a freshly loaded tile into the already loaded ones, so that no
   * crack is ever visible. The tile shares edges with its east/south
   * neighbours (its own seams) and with its west, north and north-west
   * neighbours (their seams). A tile copies its edges from its east/south
   * neighbours, so those are stitched first: descending `x + y` order.
   * Returns the tiles whose heights it changed.
   */
  private stitchAround({ x, y }: Tile): Set<Tile> {
    const tiles = [
      this.cachedTile(x, y),
      this.cachedTile(x - 1, y),
      this.cachedTile(x, y - 1),
      this.cachedTile(x - 1, y - 1)
    ].filter((tile): tile is Tile => tile?.loaded === true)

    tiles.sort((a, b) => b.x + b.y - (a.x + a.y))
    for (const tile of tiles) tile.resolveSeams(this.tileCache)

    // the corner vertices changed, by tile
    const touched = new globalThis.Map<Tile, number[]>()
    for (const [cx, cy] of [
      [x, y],
      [x + 1, y],
      [x, y + 1],
      [x + 1, y + 1]
    ]) {
      this.syncCorner(cx, cy, touched)
    }
    const row = this.options.tileSegments + 1
    for (const [tile, corners] of touched) {
      for (const index of corners) {
        const [r, c] = [Math.floor(index / row), index % row]
        tile.updateGeometry([r, r], [c, c])
      }
    }
    return new Set([...tiles, ...touched.keys()])
  }

  /**
   * Edges alone cannot agree on a point shared by four tiles while the
   * diagonal tile is missing: each side holds its own approximation. Give the
   * point (the top-left corner of tile `x`, `y`) one value from the best
   * loaded source — the exact pixel of tile `x`, `y` first — in every tile.
   */
  private syncCorner(
    x: number,
    y: number,
    touched: globalThis.Map<Tile, number[]>
  ) {
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
      touched.set(tile, [...(touched.get(tile) ?? []), index])
    }
  }
}
