import {
  BackSide,
  DoubleSide,
  FrontSide,
  Group,
  type Intersection,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Raycaster,
  type Side,
  Vector3
} from 'three'
import { describe, expect, it } from 'vitest'

import { gridBounds, gridNormals, raycastGrid } from '../../src/terrain/grid'

/** A tile-like grid with hills, its bounds computed by `gridBounds`. */
function hills(n = 12, size = 600) {
  const geometry = new PlaneGeometry(size, size, n, n)
  const position = geometry.attributes.position
  for (let i = 0; i < position.count; i++) {
    const [x, y] = [position.getX(i), position.getY(i)]
    position.setZ(
      i,
      80 * Math.sin(x / 70) * Math.cos(y / 90) + 30 * Math.sin((x + y) / 40)
    )
  }
  gridNormals(position, geometry.attributes.normal, n, size / n, [0, n], [0, n])
  gridBounds(geometry)
  return geometry
}

/** Pseudo-random numbers, the same every run. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

describe('gridNormals', () => {
  it('gives the normals computeVertexNormals gives', () => {
    const geometry = hills()
    const expected = geometry.clone()
    expected.computeVertexNormals()

    const [actual, wanted] = [
      geometry.attributes.normal.array,
      expected.attributes.normal.array
    ]
    for (let i = 0; i < wanted.length; i++) {
      expect(actual[i]).toBeCloseTo(wanted[i], 5)
    }
  })

  it('refreshes the vertices of a region only', () => {
    const n = 12
    const geometry = hills(n)
    const normal = geometry.attributes.normal
    const before = Float32Array.from(normal.array)
    geometry.attributes.position.setZ(5 * (n + 1) + 7, 500)
    gridNormals(geometry.attributes.position, normal, n, 50, [4, 6], [6, 8])

    const expected = geometry.clone()
    expected.computeVertexNormals()
    for (let r = 0; r <= n; r++) {
      for (let c = 0; c <= n; c++) {
        const i = r * (n + 1) + c
        const inside = r >= 4 && r <= 6 && c >= 6 && c <= 8
        const wanted = inside ? expected.attributes.normal : undefined
        for (const k of [0, 1, 2]) {
          const value = normal.array[3 * i + k]
          if (wanted) expect(value).toBeCloseTo(wanted.array[3 * i + k], 5)
          else expect(value).toBe(before[3 * i + k])
        }
      }
    }
  })
})

describe('gridBounds', () => {
  it('makes the box and sphere computeBounding* make', () => {
    const geometry = hills()
    const expected = geometry.clone()
    expected.computeBoundingBox()
    expected.computeBoundingSphere()

    expect(geometry.boundingBox).toEqual(expected.boundingBox)
    expect(geometry.boundingSphere?.center).toEqual(
      expected.boundingSphere?.center
    )
    expect(geometry.boundingSphere?.radius).toBeCloseTo(
      expected.boundingSphere?.radius ?? 0,
      9
    )
  })
})

describe('raycastGrid', () => {
  /** The same intersections as Mesh.raycast (in the same order once sorted). */
  const compare = (
    mesh: Mesh<PlaneGeometry, MeshBasicMaterial>,
    raycaster: Raycaster
  ) => {
    mesh.updateWorldMatrix(true, false)
    const fast: Intersection[] = []
    const brute: Intersection[] = []
    raycastGrid.call(mesh, raycaster, fast)
    Mesh.prototype.raycast.call(mesh, raycaster, brute)
    const sort = (hits: Intersection[]) =>
      hits.sort(
        (a, b) =>
          a.distance - b.distance || (a.faceIndex ?? 0) - (b.faceIndex ?? 0)
      )
    sort(fast)
    sort(brute)
    expect(fast.length).toBe(brute.length)
    for (const [i, hit] of fast.entries()) {
      const other = brute[i]
      expect(hit.faceIndex).toBe(other.faceIndex)
      expect(hit.face).toEqual(other.face)
      expect(hit.distance).toBeCloseTo(other.distance, 6)
      expect(hit.point.distanceTo(other.point)).toBeLessThan(1e-6)
      expect(hit.uv?.distanceTo(other.uv ?? hit.uv)).toBeLessThan(1e-9)
      expect(hit.normal?.distanceTo(other.normal ?? hit.normal)).toBeLessThan(
        1e-6
      )
      expect(hit.object).toBe(mesh)
    }
    return fast
  }

  const rays = (count: number, seed: number) => {
    const next = random(seed)
    return Array.from({ length: count }, () => {
      const origin = new Vector3(
        (next() - 0.5) * 1200,
        (next() - 0.5) * 1200,
        50 + next() * 900
      )
      const target = new Vector3(
        (next() - 0.5) * 700,
        (next() - 0.5) * 700,
        (next() - 0.5) * 200
      )
      return new Raycaster(origin, target.sub(origin).normalize())
    })
  }

  for (const [name, side] of [
    ['front', FrontSide],
    ['back', BackSide],
    ['double', DoubleSide]
  ] as [string, Side][]) {
    it(`finds every triangle Mesh.raycast finds (${name} side)`, () => {
      const mesh = new Mesh(hills(), new MeshBasicMaterial({ side }))
      let hits = 0
      for (const raycaster of rays(150, 7 + side)) {
        hits += compare(mesh, raycaster).length
      }
      // from above, back faces show only through the hills
      expect(hits).toBeGreaterThan(side === BackSide ? 5 : 50)
    })
  }

  it('crosses the hills at a grazing angle, hitting every slope', () => {
    const mesh = new Mesh(
      hills(32),
      new MeshBasicMaterial({ side: DoubleSide })
    )
    const raycaster = new Raycaster(
      new Vector3(-400, -350, 20),
      new Vector3(1, 0.93, 0.0001).normalize()
    )
    expect(compare(mesh, raycaster).length).toBeGreaterThan(4)
  })

  it('hits straight down, also on the edges and corners of cells', () => {
    const mesh = new Mesh(hills(), new MeshBasicMaterial())
    const down = new Vector3(0, 0, -1)
    for (const [x, y] of [
      [0, 0],
      [50, 0],
      [0, -100],
      [125, 37],
      [300, 300],
      [-300, -300],
      [-300, 120]
    ]) {
      const hits = compare(mesh, new Raycaster(new Vector3(x, y, 1e3), down))
      expect(hits.length).toBeGreaterThan(0)
    }
  })

  it('works in world space: transformed parents, near and far', () => {
    const group = new Group()
    group.scale.set(0.01, 0.01, 0.02)
    group.rotation.set(-Math.PI / 2, 0, 0.3)
    group.position.set(5, -2, 3)
    const mesh = new Mesh(hills(), new MeshBasicMaterial())
    mesh.position.set(600, 0, 0)
    group.add(mesh)
    group.updateMatrixWorld(true)

    for (const raycaster of rays(60, 3)) {
      // the rays in the group's space, seen from the world
      raycaster.ray.applyMatrix4(group.matrixWorld)
      raycaster.near = 0.5
      raycaster.far = 9
      compare(mesh, raycaster)
    }
  })

  it('falls back to Mesh.raycast for geometry that is not a plain grid', () => {
    const geometry = hills()
    geometry.setDrawRange(0, 30)
    const mesh = new Mesh(geometry, new MeshBasicMaterial())
    for (const raycaster of rays(40, 11)) compare(mesh, raycaster)
  })
})
