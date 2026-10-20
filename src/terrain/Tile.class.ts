import {
  type Material,
  MathUtils,
  Mesh,
  MeshNormalMaterial,
  PlaneGeometry,
  Texture
} from 'three'

import { Utils } from '../geo/Utils.class'
import { isAbortError } from '../io/fetch'
import { loadImageData } from '../io/image'
import {
  decodeTerrarium,
  type ElevationDecoder,
  type ElevationPixels
} from '../sources/ElevationSource.class'
import type { TileImageSource } from '../sources/Source.class'
import { loadWithFallback, type TileRegion } from '../sources/tile-source'
import type { Map } from './Map.class'
import {
  createQuadTextureMaterial,
  disposeMaterial,
  loadQuadTexture,
  type TileMaterial
} from './quad-texture-material'

/** Shown until the tile texture has been loaded. Shared, never disposed. */
const placeholderMaterial = new MeshNormalMaterial({ wireframe: true })

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

export class Tile {
  readonly map: Map
  readonly x: number
  readonly y: number
  readonly z: number

  /**
   * Legacy: pass `elevation` to the `Map` instead. When changed, terrarium
   * tiles are loaded from `${baseURL}/{z}/{x}/{y}.png` instead of the map's
   * elevation source.
   */
  baseURL = TERRARIUM_URL

  shape: number[] | null = null
  elevation: Float32Array | null = null

  seamX = false
  seamY = false

  private _mesh: Mesh<PlaneGeometry, Material> | undefined
  private readonly abortController = new AbortController()
  /** Cancels the texture being loaded; replaced by every `buildmesh()`. */
  private textureController = new AbortController()
  private textureGeneration = 0
  /** Counts `restyle()`s: a material made before one is out of date. */
  private styleGeneration = 0
  private textureLoad: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(map: Map, z: number, x: number, y: number) {
    this.map = map
    this.z = z
    this.x = x
    this.y = y
  }

  /** Created lazily so that throwaway tiles (e.g. `childrens()`) stay cheap. */
  get mesh(): Mesh<PlaneGeometry, Material> {
    if (!this._mesh) {
      const { tileSize, tileSegments } = this.map.options
      this._mesh = new Mesh(
        new PlaneGeometry(tileSize, tileSize, tileSegments, tileSegments),
        placeholderMaterial
      )
    }
    return this._mesh
  }

  get geometry(): PlaneGeometry {
    return this.mesh.geometry
  }

  /** `true` once the elevation data has been applied to the geometry. */
  get loaded(): boolean {
    return this.elevation !== null && !this.disposed
  }

  key() {
    return Utils.getTileKey(this.z, this.x, this.y)
  }

  keyNeighX() {
    return Utils.getTileKey(this.z, this.x + 1, this.y)
  }

  keyNeighY() {
    return Utils.getTileKey(this.z, this.x, this.y + 1)
  }

  mapUrl() {
    return this.map.source.mapUrl(this.z, this.x, this.y)
  }

  /** URL of this tile's elevation (`''` for a source with only a `load`). */
  url() {
    return this.legacyElevation()
      ? `${this.baseURL}/${this.z}/${this.x}/${this.y}.png`
      : this.map.elevation.tileUrl(this.z, this.x, this.y)
  }

  /**
   * Decodes RGB elevation into meters, terrarium by default:
   * `R * 256 + G + B / 256 - 32768`.
   */
  computeElevation(
    { width, height, data }: ElevationPixels,
    decode: ElevationDecoder = decodeTerrarium
  ) {
    this.shape = [width, height, 4]
    const elevation = new Float32Array(width * height)
    for (let i = 0; i < elevation.length; i++) {
      const rgba = i * 4
      elevation[i] = decode(data[rgba], data[rgba + 1], data[rgba + 2])
    }
    this.elevation = elevation
  }

  /**
   * Replaces the elevation of an ancestor tile with this tile's `region` of
   * it, bilinearly upsampled to the same size (smooth instead of terraced).
   * Pixel `i` lies at `i / width` of the tile, as for a tile of its own.
   */
  cropElevation({ left, top, size }: TileRegion) {
    const { elevation, shape } = this
    if (!elevation || !shape) return

    const [width, height] = shape
    const cropped = new Float32Array(width * height)
    for (let row = 0; row < height; row++) {
      const py = top * height + size * row
      const y0 = Math.min(Math.floor(py), height - 1)
      const y1 = Math.min(y0 + 1, height - 1)
      const fy = py - y0
      for (let col = 0; col < width; col++) {
        const px = left * width + size * col
        const x0 = Math.min(Math.floor(px), width - 1)
        const x1 = Math.min(x0 + 1, width - 1)
        const fx = px - x0
        const north =
          elevation[y0 * width + x0] * (1 - fx) +
          elevation[y0 * width + x1] * fx
        const south =
          elevation[y1 * width + x0] * (1 - fx) +
          elevation[y1 * width + x1] * fx
        cropped[row * width + col] = north * (1 - fy) + south * fy
      }
    }
    this.elevation = cropped
  }

  buildGeometry() {
    const { elevation, shape } = this
    if (!elevation || !shape) return

    const [width, height] = shape
    const { tileSegments, zScale, baseAltitude = 0 } = this.map.options
    const position = this.geometry.attributes.position
    const rowSize = tileSegments + 1
    const xRatio = width / tileSegments
    const yRatio = height / tileSegments

    // The last row/column lies on the neighbours' first pixels. Until
    // resolveSeams() copies them, approximate it with this tile's edge pixels
    // so that a tile never shows a wall down to z = 0 while loading.
    for (let row = 0; row <= tileSegments; row++) {
      const offset = Math.min(Math.round(row * yRatio), height - 1) * width
      for (let col = 0; col <= tileSegments; col++) {
        const x = Math.min(Math.round(col * xRatio), width - 1)
        position.setZ(
          row * rowSize + col,
          (elevation[offset + x] - baseAltitude) * zScale
        )
      }
    }

    this.updateGeometry()
  }

  /**
   * Call after changing vertex heights: uploads them and refreshes the normals
   * and the bounding volumes (used by frustum culling and raycasting).
   */
  updateGeometry() {
    const { geometry } = this
    geometry.attributes.position.needsUpdate = true
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
  }

  childrens() {
    return [
      new Tile(this.map, this.z + 1, this.x * 2, this.y * 2),
      new Tile(this.map, this.z + 1, this.x * 2, this.y * 2 + 1),
      new Tile(this.map, this.z + 1, this.x * 2 + 1, this.y * 2),
      new Tile(this.map, this.z + 1, this.x * 2 + 1, this.y * 2 + 1)
    ] as const
  }

  /**
   * Textures the tile with its four children at `zoom + 1`. A child beyond
   * the source's `maxZoom`, or missing, is cut out of its nearest ancestor;
   * children sharing an ancestor load it once.
   */
  async buildMaterial(): Promise<TileMaterial> {
    const { source } = this.map
    // no imagery: nothing to load, the terrain is drawn in its color
    if (source.api === 'none') {
      return createQuadTextureMaterial(null, this.map.materialOptions)
    }
    const { signal } = this.textureController
    const memo = new globalThis.Map<string, Promise<TileImageSource | null>>()
    const [nw, sw, ne, se] = this.childrens().map((child) => async () => {
      const loaded = await loadWithFallback(
        { z: child.z, x: child.x, y: child.y, signal },
        source.maxZoom,
        (tile) => source.load(tile),
        memo
      )
      if (!loaded) {
        throw new Error(`No texture tile at ${child.key()} or its ancestors`)
      }
      return { image: loaded.data, region: loaded.region }
    })
    const texture = await loadQuadTexture(
      [nw, sw, ne, se],
      signal,
      this.map.materialOptions.filter
    )
    // the options as they are now: they may have changed meanwhile
    return createQuadTextureMaterial(texture, this.map.materialOptions)
  }

  /**
   * Loads the texture — again after `map.setSource()` — and swaps it in once
   * it is there; the previous one stays until then. A load still running is
   * cancelled.
   */
  buildmesh(): Promise<void> {
    const generation = ++this.textureGeneration
    this.textureController.abort()
    this.textureController = new AbortController()
    const load = this.applyMaterial(generation)
    this.textureLoad = load
    return load
  }

  /** Resolves once the texture is in place (or failed to load). */
  whenTextured(): Promise<void> {
    return this.textureLoad
  }

  /**
   * Applies the map's material options again (`map.setMaterial()`), keeping
   * the texture. A texture still loading takes them on when it arrives.
   */
  restyle() {
    this.styleGeneration++
    const { mesh } = this
    if (mesh.material === placeholderMaterial) return
    const old = mesh.material
    const map = 'map' in old && old.map instanceof Texture ? old.map : null
    mesh.material = createQuadTextureMaterial(map, this.map.materialOptions)
    old.dispose() // not its texture, which the new material uses
  }

  private async applyMaterial(generation: number) {
    const style = this.styleGeneration
    try {
      let material = await this.buildMaterial()
      if (this.disposed || generation !== this.textureGeneration) {
        disposeMaterial(material)
        return
      }
      // restyled meanwhile (e.g. setSource() then setMaterial()): the
      // options of now, on the texture just loaded
      if (style !== this.styleGeneration) {
        const restyled = createQuadTextureMaterial(
          material.map,
          this.map.materialOptions
        )
        material.dispose()
        material = restyled
      }
      const old = this.mesh.material
      this.mesh.material = material
      if (old !== placeholderMaterial) disposeMaterial(old)
    } catch (error) {
      const current = generation === this.textureGeneration
      if (!this.disposed && current && !isAbortError(error))
        console.error(error)
    }
  }

  /**
   * Loads the elevation from the map's elevation source — or, beyond its
   * `maxZoom` or where the tile is missing, the region of the nearest
   * ancestor — then builds the geometry and starts loading the texture.
   */
  async fetch() {
    const { elevation } = this.map
    const { signal } = this.abortController
    const legacy = this.legacyElevation()
    const loaded = await loadWithFallback(
      { z: this.z, x: this.x, y: this.y, signal },
      legacy ? this.z : elevation.maxZoom,
      legacy
        ? () => loadImageData(this.url(), signal)
        : (tile) => elevation.load(tile)
    )
    if (!loaded) {
      throw new Error(`No elevation tile at ${this.key()} or its ancestors`)
    }
    if (this.disposed) return this
    this.computeElevation(
      loaded.data,
      legacy ? decodeTerrarium : elevation.decode
    )
    if (loaded.z < this.z) this.cropElevation(loaded.region)
    this.buildGeometry()
    void this.buildmesh()
    return this
  }

  setPosition(center: { x: number; y: number }) {
    const { x, y, z } = Utils.tile2position(
      this.z,
      this.x,
      this.y,
      center,
      this.map.options.tileSize
    )
    this.mesh.position.set(x, y, z)
  }

  /**
   * Height (scene units) of the rendered surface at `u`, `v` ∈ [0, 1] — `u`
   * from west to east, `v` from north to south — interpolated over the same
   * triangles as the mesh, so a point placed there sits exactly on it.
   */
  heightAt(u: number, v: number): number {
    const n = this.map.options.tileSegments
    const position = this.geometry.attributes.position
    const col = MathUtils.clamp(u, 0, 1) * n
    const row = MathUtils.clamp(v, 0, 1) * n
    const ix = Math.min(Math.floor(col), n - 1)
    const iy = Math.min(Math.floor(row), n - 1)
    const fc = col - ix
    const fr = row - iy
    const z = (r: number, c: number) =>
      position.getZ((iy + r) * (n + 1) + ix + c)

    // PlaneGeometry splits each cell along its bottom-left → top-right diagonal
    return fr + fc <= 1
      ? z(0, 0) + (z(1, 0) - z(0, 0)) * fr + (z(0, 1) - z(0, 0)) * fc
      : z(1, 1) +
          (z(0, 1) - z(1, 1)) * (1 - fr) +
          (z(1, 0) - z(1, 1)) * (1 - fc)
  }

  /** Copies the first row of the southern neighbour into the last row. */
  resolveSeamY(neighbor?: Tile) {
    const position = this.geometry.attributes.position
    const total = position.count
    const rowSize = Math.sqrt(total)

    if (neighbor && neighbor.geometry.attributes.position.count !== total) {
      console.error('resolveSeamY only implemented for geometries of same size')
      return
    }

    const neighborPosition = neighbor?.geometry.attributes.position
    for (let i = total - rowSize; i < total; i++) {
      const z = neighborPosition
        ? neighborPosition.getZ(i - (total - rowSize))
        : position.getZ(i - rowSize)
      position.setZ(i, z)
    }
  }

  /** Copies the first column of the eastern neighbour into the last column. */
  resolveSeamX(neighbor?: Tile) {
    const position = this.geometry.attributes.position
    const total = position.count
    const rowSize = Math.sqrt(total)

    if (neighbor && neighbor.geometry.attributes.position.count !== total) {
      console.error('resolveSeamX only implemented for geometries of same size')
      return
    }

    const neighborPosition = neighbor?.geometry.attributes.position
    for (let i = rowSize - 1; i < total; i += rowSize) {
      const z = neighborPosition
        ? neighborPosition.getZ(i - rowSize + 1)
        : position.getZ(i - 1)
      position.setZ(i, z)
    }
  }

  /**
   * Stitches the south and east edges to the loaded neighbours in `cache`.
   * An edge without a loaded neighbour keeps this tile's own edge samples;
   * `seamY` / `seamX` tell whether the edge is stitched to a neighbour.
   */
  resolveSeams(cache: Partial<Record<string, Tile>>) {
    const south = cache[this.keyNeighY()]
    const east = cache[this.keyNeighX()]

    this.seamY = south?.loaded === true
    this.seamX = east?.loaded === true
    if (this.seamY) this.resolveSeamY(south)
    if (this.seamX) this.resolveSeamX(east)

    this.updateGeometry()
  }

  /** `baseURL` was changed: it wins over the map's elevation source. */
  private legacyElevation() {
    return this.baseURL !== TERRARIUM_URL
  }

  /** Aborts pending requests and releases GPU resources. */
  dispose() {
    this.disposed = true
    this.abortController.abort()
    this.textureController.abort()

    if (!this._mesh) return
    this._mesh.removeFromParent()
    this._mesh.geometry.dispose()
    if (this._mesh.material !== placeholderMaterial) {
      disposeMaterial(this._mesh.material)
    }
  }
}
