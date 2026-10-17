import { type Material, Mesh, MeshNormalMaterial, PlaneGeometry } from 'three'

import { loadImageData } from './image'
import type { Map } from './Map.class'
import { disposeMaterial, QuadTextureMaterial } from './quad-texture-material'
import { Utils } from './Utils.class'

/** Shown until the tile texture has been loaded. Shared, never disposed. */
const placeholderMaterial = new MeshNormalMaterial({ wireframe: true })

/** RGBA pixels of a terrarium-encoded elevation tile (e.g. `ImageData`). */
export interface ElevationPixels {
  readonly width: number
  readonly height: number
  readonly data: ArrayLike<number>
}

export class Tile {
  readonly map: Map
  readonly x: number
  readonly y: number
  readonly z: number

  baseURL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

  shape: number[] | null = null
  elevation: Float32Array | null = null

  seamX = false
  seamY = false

  private _mesh: Mesh<PlaneGeometry, Material> | undefined
  private readonly abortController = new AbortController()
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

  url() {
    return `${this.baseURL}/${this.z}/${this.x}/${this.y}.png`
  }

  /** Decodes terrarium RGB into meters: `R * 256 + G + B / 256 - 32768`. */
  computeElevation({ width, height, data }: ElevationPixels) {
    this.shape = [width, height, 4]
    const elevation = new Float32Array(width * height)
    for (let i = 0; i < elevation.length; i++) {
      const rgba = i * 4
      elevation[i] =
        data[rgba] * 256 + data[rgba + 1] + data[rgba + 2] / 256 - 32768
    }
    this.elevation = elevation
  }

  buildGeometry() {
    const { elevation, shape } = this
    if (!elevation || !shape) return

    const [width, height] = shape
    const { tileSegments, zScale } = this.map.options
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
        position.setZ(row * rowSize + col, elevation[offset + x] * zScale)
      }
    }

    position.needsUpdate = true
    this.geometry.computeVertexNormals()
  }

  childrens() {
    return [
      new Tile(this.map, this.z + 1, this.x * 2, this.y * 2),
      new Tile(this.map, this.z + 1, this.x * 2, this.y * 2 + 1),
      new Tile(this.map, this.z + 1, this.x * 2 + 1, this.y * 2),
      new Tile(this.map, this.z + 1, this.x * 2 + 1, this.y * 2 + 1)
    ] as const
  }

  buildMaterial() {
    const [nw, sw, ne, se] = this.childrens().map((tile) => tile.mapUrl())
    return QuadTextureMaterial(
      [nw, sw, ne, se],
      this.map.materialOptions,
      this.abortController.signal
    )
  }

  /** Swaps the placeholder material for the textured one once it is loaded. */
  async buildmesh() {
    try {
      const material = await this.buildMaterial()
      if (this.disposed) disposeMaterial(material)
      else this.mesh.material = material
    } catch (error) {
      if (!this.disposed) console.error(error)
    }
  }

  async fetch() {
    const pixels = await loadImageData(this.url(), this.abortController.signal)
    if (this.disposed) return this
    this.computeElevation(pixels)
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

    this.geometry.attributes.position.needsUpdate = true
    this.geometry.computeVertexNormals()
  }

  /** Aborts pending requests and releases GPU resources. */
  dispose() {
    this.disposed = true
    this.abortController.abort()

    if (!this._mesh) return
    this._mesh.removeFromParent()
    this._mesh.geometry.dispose()
    if (this._mesh.material !== placeholderMaterial) {
      disposeMaterial(this._mesh.material)
    }
  }
}
