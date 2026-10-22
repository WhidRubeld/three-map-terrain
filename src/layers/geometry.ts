// Accumulates the geometry of one part of a layer's tile — faces or lines —
// with the attributes materials and picking read.

import {
  BufferAttribute,
  BufferGeometry,
  type Color,
  InstancedBufferAttribute,
  InstancedMesh,
  type Material,
  type Matrix4
} from 'three'

/**
 * Name of the per-vertex attribute holding the index of the feature a vertex
 * belongs to (in the tile's `features`): picking reads it, and shaders can.
 */
export const FEATURE_ATTRIBUTE = 'featureIndex'

/** A typed array grown as values are written, twice as large each time. */
class Grown<T extends Float32Array | Uint32Array> {
  length = 0

  constructor(
    private array: T,
    private readonly make: (size: number) => T
  ) {}

  /** Room for `count` more values; returns where they go. */
  reserve(count: number): T {
    if (this.length + count > this.array.length) {
      const grown = this.make(
        Math.max(2 * this.array.length, this.length + count)
      )
      grown.set(this.array)
      this.array = grown
    }
    return this.array
  }

  /** The values written, in an array of their own. */
  values(): T {
    return this.array.slice(0, this.length) as T
  }

  /** The values written, in this array. */
  view(): T {
    return this.array.subarray(0, this.length) as T
  }
}

const floats = (size: number) =>
  new Grown(new Float32Array(size), (n) => new Float32Array(n))

/**
 * The faces of one part (walls, roofs, road surface…): `position`,
 * `normal`, `uv` (in meters, so that textures repeat per meter), `color`
 * and `featureIndex`, indexed.
 */
export class SurfaceBuilder {
  private readonly positions = floats(3 * 64)
  private readonly normals = floats(3 * 64)
  private readonly uvs = floats(2 * 64)
  private readonly colors = floats(3 * 64)
  private readonly features = floats(64)
  private readonly indices = new Grown(
    new Uint32Array(3 * 64),
    (n) => new Uint32Array(n)
  )
  private count = 0

  get vertexCount() {
    return this.count
  }

  /** Adds a vertex; returns its index. */
  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    color: Color,
    feature: number
  ): number {
    const i = this.count
    const position = this.positions.reserve(3)
    const normal = this.normals.reserve(3)
    const uv = this.uvs.reserve(2)
    const colors = this.colors.reserve(3)
    const features = this.features.reserve(1)
    position[3 * i] = x
    position[3 * i + 1] = y
    position[3 * i + 2] = z
    normal[3 * i] = nx
    normal[3 * i + 1] = ny
    normal[3 * i + 2] = nz
    uv[2 * i] = u
    uv[2 * i + 1] = v
    colors[3 * i] = color.r
    colors[3 * i + 1] = color.g
    colors[3 * i + 2] = color.b
    features[i] = feature
    this.positions.length += 3
    this.normals.length += 3
    this.uvs.length += 2
    this.colors.length += 3
    this.features.length += 1
    return this.count++
  }

  triangle(a: number, b: number, c: number) {
    const indices = this.indices.reserve(3)
    const at = this.indices.length
    indices[at] = a
    indices[at + 1] = b
    indices[at + 2] = c
    this.indices.length += 3
  }

  /** The geometry, or `undefined` if nothing was added. */
  build(): BufferGeometry | undefined {
    if (this.indices.length === 0) return undefined
    const geometry = new BufferGeometry()
    const set = (name: string, values: Grown<Float32Array>, size: number) =>
      geometry.setAttribute(name, new BufferAttribute(values.values(), size))
    set('position', this.positions, 3)
    set('normal', this.normals, 3)
    set('uv', this.uvs, 2)
    set('color', this.colors, 3)
    set(FEATURE_ATTRIBUTE, this.features, 1)
    const indices = this.indices.values()
    geometry.setIndex(
      new BufferAttribute(
        this.count > 65535 ? indices : Uint16Array.from(indices),
        1
      )
    )
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }
}

/** The lines of one part (edges, outlines), for `LineSegments`. */
export class LineBuilder {
  private readonly positions = floats(6 * 32)
  private readonly colors = floats(6 * 32)
  private readonly features = floats(2 * 32)

  get vertexCount() {
    return this.features.length
  }

  segment(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: Color,
    feature: number
  ) {
    const at = this.positions.length
    const position = this.positions.reserve(6)
    const colors = this.colors.reserve(6)
    const features = this.features.reserve(2)
    position[at] = ax
    position[at + 1] = ay
    position[at + 2] = az
    position[at + 3] = bx
    position[at + 4] = by
    position[at + 5] = bz
    for (let k = 0; k < 6; k += 3) {
      colors[at + k] = color.r
      colors[at + k + 1] = color.g
      colors[at + k + 2] = color.b
    }
    features[this.features.length] = feature
    features[this.features.length + 1] = feature
    this.positions.length += 6
    this.colors.length += 6
    this.features.length += 2
  }

  /** The geometry, or `undefined` if nothing was added. */
  build(): BufferGeometry | undefined {
    if (this.positions.length === 0) return undefined
    const geometry = new BufferGeometry()
    const set = (name: string, values: Grown<Float32Array>, size: number) =>
      geometry.setAttribute(name, new BufferAttribute(values.values(), size))
    set('position', this.positions, 3)
    set('color', this.colors, 3)
    set(FEATURE_ATTRIBUTE, this.features, 1)
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }
}

/**
 * Copies of one geometry — trees, lamps, markers — for an `InstancedMesh`:
 * the matrix, color and feature of each. The geometry is shared: the layer
 * never disposes it.
 */
export class InstanceBuilder {
  private readonly matrices = floats(16 * 64)
  private readonly colors = floats(3 * 64)
  /** Whether a copy has a color of its own: else they have no `instanceColor`. */
  private tinted = false
  /** The feature index of every copy. */
  readonly features: number[] = []

  constructor(readonly geometry: BufferGeometry) {}

  get count() {
    return this.features.length
  }

  add(matrix: Matrix4, color: Color | undefined, feature: number) {
    this.matrices.reserve(16).set(matrix.elements, this.matrices.length)
    this.matrices.length += 16
    const colors = this.colors.reserve(3)
    const at = this.colors.length
    if (color && (color.r !== 1 || color.g !== 1 || color.b !== 1)) {
      this.tinted = true
      colors[at] = color.r
      colors[at + 1] = color.g
      colors[at + 2] = color.b
    } else colors.fill(1, at, at + 3)
    this.colors.length += 3
    this.features.push(feature)
  }

  /** The instanced mesh, or `undefined` if nothing was added. */
  build(material: Material): InstancedMesh | undefined {
    if (this.count === 0) return undefined
    const mesh = new InstancedMesh(this.geometry, material, this.count)
    mesh.instanceMatrix.array.set(this.matrices.view())
    if (this.tinted) {
      mesh.instanceColor = new InstancedBufferAttribute(this.colors.values(), 3)
    }
    mesh.computeBoundingBox()
    mesh.computeBoundingSphere()
    return mesh
  }
}
