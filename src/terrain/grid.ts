// The regular grid of a tile's PlaneGeometry: normals, bounds and raycasting
// in time proportional to what changed or to what a ray crosses, instead of
// to every triangle. Internal.
//
// Vertex (row, col) is at `row * (n + 1) + col`, rows going south. Cell
// (r, c) is split along its south-west → north-east diagonal into the
// triangles (TL, BL, TR) and (BL, BR, TR), as PlaneGeometry indexes them.

import {
  BackSide,
  Box3,
  type BufferAttribute,
  FrontSide,
  type Intersection,
  type InterleavedBufferAttribute,
  type Material,
  Matrix4,
  Mesh,
  type PlaneGeometry,
  Ray,
  type Raycaster,
  Sphere,
  Triangle,
  Vector2,
  Vector3
} from 'three'

type Attribute = BufferAttribute | InterleavedBufferAttribute

/**
 * Refreshes the vertex normals of rows `r0…r1` and columns `c0…c1` of a
 * grid of `n × n` cells `size` units wide: the sum of the normals of the
 * triangles around each vertex, weighted by their area, normalized — what
 * `computeVertexNormals()` gives, for a part of the grid.
 */
export function gridNormals(
  position: Attribute,
  normal: Attribute,
  n: number,
  size: number,
  [r0, r1]: readonly [number, number],
  [c0, c1]: readonly [number, number]
) {
  const row = n + 1
  const z = (r: number, c: number) => position.getZ(r * row + c)
  for (let r = Math.max(0, r0); r <= Math.min(n, r1); r++) {
    for (let c = Math.max(0, c0); c <= Math.min(n, c1); c++) {
      const h = z(r, c)
      let nx = 0
      let ny = 0
      let nz = 0
      // the triangles of the four cells around it: (TL, BL, TR) of a cell
      // is (z(TL) − z(TR), z(BL) − z(TL), size) × size, (BL, BR, TR) is
      // (z(BL) − z(BR), z(BR) − z(TR), size) × size
      if (r > 0 && c > 0) {
        // the north-west cell: its south-east corner
        nx += z(r, c - 1) - h
        ny += h - z(r - 1, c)
        nz += size
      }
      if (r > 0 && c < n) {
        // the north-east cell: its south-west corner, in both triangles
        const north = z(r - 1, c)
        const northEast = z(r - 1, c + 1)
        const east = z(r, c + 1)
        nx += north - northEast + h - east
        ny += h - north + east - northEast
        nz += 2 * size
      }
      if (r < n && c > 0) {
        // the south-west cell: its north-east corner, in both triangles
        const west = z(r, c - 1)
        const southWest = z(r + 1, c - 1)
        const south = z(r + 1, c)
        nx += west - h + southWest - south
        ny += southWest - west + south - h
        nz += 2 * size
      }
      if (r < n && c < n) {
        // the south-east cell: its north-west corner
        nx += h - z(r, c + 1)
        ny += z(r + 1, c) - h
        nz += size
      }
      const length = Math.hypot(nx, ny, nz)
      normal.setXYZ(r * row + c, nx / length, ny / length, nz / length)
    }
  }
}

/**
 * The bounding box and sphere of a geometry's positions, as
 * `computeBoundingBox()` and `computeBoundingSphere()` make them (the sphere
 * around the box's center), in place.
 */
export function gridBounds(geometry: PlaneGeometry) {
  const position = geometry.attributes.position
  const box = (geometry.boundingBox ??= new Box3())
  box.makeEmpty()
  const point = new Vector3()
  for (let i = 0; i < position.count; i++) {
    box.expandByPoint(point.fromBufferAttribute(position, i))
  }
  const sphere = (geometry.boundingSphere ??= new Sphere())
  box.getCenter(sphere.center)
  let radius = 0
  for (let i = 0; i < position.count; i++) {
    radius = Math.max(
      radius,
      sphere.center.distanceToSquared(point.fromBufferAttribute(position, i))
    )
  }
  sphere.radius = Math.sqrt(radius)
}

const inverse = new Matrix4()
const localRay = new Ray()
const worldSphere = new Sphere()
const sphereHit = new Vector3()
const vA = new Vector3()
const vB = new Vector3()
const vC = new Vector3()
const hit = new Vector3()

/** Cells a ray's path is widened by on each side: hits on cell edges count. */
const EDGE = 1e-6

/**
 * The index and bounds of a mesh whose geometry is an untouched
 * `PlaneGeometry` grid, or `undefined`.
 */
function gridOf({
  geometry,
  material,
  morphTargetInfluences
}: Mesh<PlaneGeometry, Material>) {
  const { widthSegments: n, heightSegments: m } = geometry.parameters
  const { index, drawRange, boundingBox, boundingSphere } = geometry
  const plain =
    !Array.isArray(material) &&
    drawRange.start === 0 &&
    !morphTargetInfluences?.length
  return plain &&
    index?.count === n * m * 6 &&
    drawRange.count >= index.count &&
    boundingBox &&
    boundingSphere
    ? { index, box: boundingBox, sphere: boundingSphere }
    : undefined
}

/**
 * `Mesh.raycast` for a terrain tile: the same intersections, found by
 * testing only the triangles of the cells the ray passes over.
 */
export function raycastGrid(
  this: Mesh<PlaneGeometry, Material>,
  raycaster: Raycaster,
  intersects: Intersection[]
) {
  const grid = gridOf(this)
  if (!grid) {
    Mesh.prototype.raycast.call(this, raycaster, intersects)
    return
  }
  const { geometry, material, matrixWorld } = this
  const { index, box, sphere } = grid

  // the bounding sphere, as Mesh.raycast tests it
  worldSphere.copy(sphere).applyMatrix4(matrixWorld)
  localRay.copy(raycaster.ray).recast(raycaster.near)
  if (!worldSphere.containsPoint(localRay.origin)) {
    if (localRay.intersectSphere(worldSphere, sphereHit) === null) return
    const reach = raycaster.far - raycaster.near
    if (localRay.origin.distanceToSquared(sphereHit) > reach * reach) return
  }
  inverse.copy(matrixWorld).invert()
  localRay.copy(raycaster.ray).applyMatrix4(inverse)

  // where the ray is inside the bounding box
  const { origin, direction } = localRay
  let [t0, t1] = [0, Infinity]
  for (const axis of ['x', 'y', 'z'] as const) {
    const o = origin[axis]
    const d = direction[axis]
    const low = box.min[axis]
    const high = box.max[axis]
    const slack = (high - low) * EDGE + 1e-9
    if (Math.abs(d) < 1e-15) {
      if (o < low - slack || o > high + slack) return
      continue
    }
    let near = (low - slack - o) / d
    let far = (high + slack - o) / d
    if (near > far) [near, far] = [far, near]
    t0 = Math.max(t0, near)
    t1 = Math.min(t1, far)
    if (t0 > t1) return
  }

  const {
    width,
    height,
    widthSegments: n,
    heightSegments: m
  } = geometry.parameters
  const position = geometry.attributes.position
  const uv = geometry.getAttribute('uv') as Attribute | undefined
  const uv1 = geometry.getAttribute('uv1') as Attribute | undefined
  const normal = geometry.getAttribute('normal') as Attribute | undefined
  // the ray's path over the grid, in cells: columns east, rows south
  const col = (t: number) =>
    ((origin.x + direction.x * t + width / 2) / width) * n
  const row = (t: number) =>
    ((height / 2 - (origin.y + direction.y * t)) / height) * m
  const [u0, v0, u1, v1] = [col(t0), row(t0), col(t1), row(t1)]

  const test = (triangle: number) => {
    const a = index.getX(triangle * 3)
    const b = index.getX(triangle * 3 + 1)
    const c = index.getX(triangle * 3 + 2)
    vA.fromBufferAttribute(position, a)
    vB.fromBufferAttribute(position, b)
    vC.fromBufferAttribute(position, c)
    const found =
      material.side === BackSide
        ? localRay.intersectTriangle(vC, vB, vA, true, hit)
        : localRay.intersectTriangle(
            vA,
            vB,
            vC,
            material.side === FrontSide,
            hit
          )
    if (found === null) return
    const point = hit.clone().applyMatrix4(matrixWorld)
    const distance = raycaster.ray.origin.distanceTo(point)
    if (distance < raycaster.near || distance > raycaster.far) return
    const barycoord = Triangle.getBarycoord(hit, vA, vB, vC, new Vector3())
    if (!barycoord) return
    const intersection: Intersection = { distance, point, object: this }
    // the vertex attributes there, as Triangle.getInterpolatedAttribute
    const { x: wa, y: wb, z: wc } = barycoord
    const blend = (attribute: Attribute, get: 'getX' | 'getY' | 'getZ') =>
      attribute[get](a) * wa + attribute[get](b) * wb + attribute[get](c) * wc
    if (uv) intersection.uv = new Vector2(blend(uv, 'getX'), blend(uv, 'getY'))
    if (uv1) {
      intersection.uv1 = new Vector2(blend(uv1, 'getX'), blend(uv1, 'getY'))
    }
    if (normal) {
      const blended = new Vector3(
        blend(normal, 'getX'),
        blend(normal, 'getY'),
        blend(normal, 'getZ')
      )
      if (blended.dot(localRay.direction) > 0) blended.multiplyScalar(-1)
      intersection.normal = blended
    }
    intersection.face = {
      a,
      b,
      c,
      normal: Triangle.getNormal(vA, vB, vC, new Vector3()),
      materialIndex: 0
    }
    ;(intersection as Intersection & { barycoord: Vector3 }).barycoord =
      barycoord
    intersection.faceIndex = triangle
    intersects.push(intersection)
  }

  // row by row, the cells the path crosses there (a little wider)
  const [top, bottom] = [Math.min(v0, v1), Math.max(v0, v1)]
  for (
    let r = Math.max(0, Math.floor(top - EDGE));
    r <= Math.min(m - 1, Math.floor(bottom + EDGE));
    r++
  ) {
    let [from, to] = [Math.min(u0, u1), Math.max(u0, u1)]
    if (Math.abs(v1 - v0) > 1e-12) {
      const at = (v: number) =>
        u0 + (u1 - u0) * Math.min(1, Math.max(0, (v - v0) / (v1 - v0)))
      const [ua, ub] = [at(r - EDGE), at(r + 1 + EDGE)]
      ;[from, to] = [Math.min(ua, ub), Math.max(ua, ub)]
    }
    const last = Math.min(n - 1, Math.floor(to + EDGE))
    for (let c = Math.max(0, Math.floor(from - EDGE)); c <= last; c++) {
      const cell = r * n + c
      test(cell * 2)
      test(cell * 2 + 1)
    }
  }
}
