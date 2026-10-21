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

/**
 * The faces of one part (walls, roofs, road surface…): `position`,
 * `normal`, `uv` (in meters, so that textures repeat per meter), `color`
 * and `featureIndex`, indexed.
 */
export class SurfaceBuilder {
  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly uvs: number[] = []
  private readonly colors: number[] = []
  private readonly features: number[] = []
  private readonly indices: number[] = []

  get vertexCount() {
    return this.positions.length / 3
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
    this.positions.push(x, y, z)
    this.normals.push(nx, ny, nz)
    this.uvs.push(u, v)
    this.colors.push(color.r, color.g, color.b)
    this.features.push(feature)
    return this.positions.length / 3 - 1
  }

  triangle(a: number, b: number, c: number) {
    this.indices.push(a, b, c)
  }

  /** The geometry, or `undefined` if nothing was added. */
  build(): BufferGeometry | undefined {
    if (this.indices.length === 0) return undefined
    const geometry = new BufferGeometry()
    const set = (name: string, values: number[], size: number) =>
      geometry.setAttribute(
        name,
        new BufferAttribute(new Float32Array(values), size)
      )
    set('position', this.positions, 3)
    set('normal', this.normals, 3)
    set('uv', this.uvs, 2)
    set('color', this.colors, 3)
    set(FEATURE_ATTRIBUTE, this.features, 1)
    const Indices = this.vertexCount > 65535 ? Uint32Array : Uint16Array
    geometry.setIndex(new BufferAttribute(new Indices(this.indices), 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }
}

/** The lines of one part (edges, outlines), for `LineSegments`. */
export class LineBuilder {
  private readonly positions: number[] = []
  private readonly colors: number[] = []
  private readonly features: number[] = []

  get vertexCount() {
    return this.positions.length / 3
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
    this.positions.push(ax, ay, az, bx, by, bz)
    this.colors.push(color.r, color.g, color.b, color.r, color.g, color.b)
    this.features.push(feature, feature)
  }

  /** The geometry, or `undefined` if nothing was added. */
  build(): BufferGeometry | undefined {
    if (this.positions.length === 0) return undefined
    const geometry = new BufferGeometry()
    const set = (name: string, values: number[], size: number) =>
      geometry.setAttribute(
        name,
        new BufferAttribute(new Float32Array(values), size)
      )
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
  private readonly matrices: number[] = []
  private readonly colors: number[] = []
  /** Whether a copy has a color of its own: else they have no `instanceColor`. */
  private tinted = false
  /** The feature index of every copy. */
  readonly features: number[] = []

  constructor(readonly geometry: BufferGeometry) {}

  get count() {
    return this.features.length
  }

  add(matrix: Matrix4, color: Color | undefined, feature: number) {
    this.matrices.push(...matrix.elements)
    if (color && (color.r !== 1 || color.g !== 1 || color.b !== 1)) {
      this.tinted = true
      this.colors.push(color.r, color.g, color.b)
    } else this.colors.push(1, 1, 1)
    this.features.push(feature)
  }

  /** The instanced mesh, or `undefined` if nothing was added. */
  build(material: Material): InstancedMesh | undefined {
    if (this.count === 0) return undefined
    const mesh = new InstancedMesh(this.geometry, material, this.count)
    mesh.instanceMatrix.array.set(this.matrices)
    if (this.tinted) {
      mesh.instanceColor = new InstancedBufferAttribute(
        new Float32Array(this.colors),
        3
      )
    }
    mesh.computeBoundingBox()
    mesh.computeBoundingSphere()
    return mesh
  }
}
