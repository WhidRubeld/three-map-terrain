import {
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  MeshNormalMaterial,
  Texture
} from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { exportModel, MODEL_TYPES } from '../../src'
import { FakeFileReader } from '../support/browser-fakes'

beforeEach(() => {
  vi.stubGlobal('FileReader', FakeFileReader)
})

/** A Z-up scene: a 2 × 4 × 6 box standing at x = 10, and a line. */
const scene = () => {
  const group = new Group()
  const box = new Mesh(
    new BoxGeometry(2, 4, 6),
    new MeshLambertMaterial({ color: 0x336699 })
  )
  box.position.set(10, 0, 3)
  const line = new LineSegments(
    new BufferGeometry().setAttribute(
      'position',
      new Float32BufferAttribute([0, 0, 0, 1, 1, 1], 3)
    ),
    new LineBasicMaterial()
  )
  group.add(box, line)
  // its own transform is left out
  group.position.set(500, 500, 500)
  return group
}

/** The JSON chunk of a GLB. */
const glbJson = async (blob: Blob) => {
  const view = new DataView(await blob.arrayBuffer())
  expect(view.getUint32(0, true)).toBe(0x46546c67) // 'glTF'
  const length = view.getUint32(12, true)
  const json = new TextDecoder().decode(new Uint8Array(view.buffer, 20, length))
  return JSON.parse(json) as {
    nodes: { matrix?: number[] }[]
    meshes: { primitives: { mode?: number }[] }[]
    materials: { pbrMetallicRoughness: { baseColorFactor: number[] } }[]
  }
}

describe('exportModel', () => {
  it('writes GLB, Y-up, scaled, with portable materials', async () => {
    const blob = await exportModel(scene(), 'glb', { scale: 2 })

    expect(blob.type).toBe(MODEL_TYPES.glb)
    const gltf = await glbJson(blob)
    // the root turns Z-up into Y-up and scales (column-major matrix): up
    // (z) becomes +y, north (y) becomes -z
    const matrix = gltf.nodes[0].matrix ?? []
    expect(matrix[0]).toBe(2)
    expect(matrix.slice(4, 7).map((v) => Math.round(v))).toEqual([0, 0, -2])
    expect(matrix.slice(8, 11).map((v) => Math.round(v))).toEqual([0, 2, 0])
    // the line is left out by default
    expect(gltf.meshes).toHaveLength(1)
    expect(
      gltf.materials[0].pbrMetallicRoughness.baseColorFactor[2]
    ).toBeGreaterThan(0)
  })

  it('keeps lines when asked to', async () => {
    const gltf = await glbJson(
      await exportModel(scene(), 'glb', { lines: true })
    )

    expect(
      gltf.meshes.map(({ primitives }) => primitives[0].mode ?? 4)
    ).toEqual([4, 1])
  })

  it('writes glTF JSON', async () => {
    const blob = await exportModel(scene(), 'gltf')

    expect(blob.type).toBe(MODEL_TYPES.gltf)
    const json = JSON.parse(await blob.text()) as { asset: { version: string } }
    expect(json.asset.version).toBe('2.0')
  })

  it('writes STL Z-up, for slicers', async () => {
    const blob = await exportModel(scene(), 'stl')
    const view = new DataView(await blob.arrayBuffer())
    const triangles = view.getUint32(80, true)

    expect(blob.type).toBe(MODEL_TYPES.stl)
    expect(triangles).toBe(12)
    // every z of the box lies in [0, 6]: not turned
    for (let i = 0; i < triangles; i++) {
      for (let v = 0; v < 3; v++) {
        const z = view.getFloat32(84 + i * 50 + 12 + v * 12 + 8, true)
        expect(z).toBeGreaterThanOrEqual(-1e-6)
        expect(z).toBeLessThanOrEqual(6 + 1e-6)
      }
    }
  })

  it('writes OBJ, Y-up', async () => {
    const text = await (await exportModel(scene(), 'obj')).text()
    const ys = [...text.matchAll(/^v (\S+) (\S+) (\S+)/gm)].map((m) =>
      Number(m[2])
    )

    // z (0…6) became y
    expect(Math.min(...ys)).toBeCloseTo(0, 6)
    expect(Math.max(...ys)).toBeCloseTo(6, 6)
  })

  it('writes USDZ', async () => {
    const blob = await exportModel(scene(), 'usdz')
    const bytes = new Uint8Array(await blob.arrayBuffer())

    expect(blob.type).toBe(MODEL_TYPES.usdz)
    expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b]) // a zip
  })

  it('filters objects and leaves the scene untouched', async () => {
    const original = scene()
    const [box] = original.children as [Mesh<BoxGeometry, MeshLambertMaterial>]

    const gltf = await glbJson(
      await exportModel(original, 'glb', {
        lines: true,
        filter: (object) => !(object instanceof LineSegments)
      })
    )

    expect(gltf.meshes).toHaveLength(1)
    expect(box.material).toBeInstanceOf(MeshLambertMaterial)
    expect(original.position.x).toBe(500)
  })

  it('leaves out objects marked userData.export = false, e.g. highlights', async () => {
    const original = scene()
    const [box] = original.children as [Mesh]
    const highlight = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshLambertMaterial()
    )
    highlight.userData.export = false
    box.add(highlight)

    const gltf = await glbJson(await exportModel(original, 'glb'))

    expect(gltf.meshes).toHaveLength(1)
  })

  it('writes the copies of an InstancedMesh where the format has no instancing', async () => {
    const group = new Group()
    const copies = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshLambertMaterial(),
      3
    )
    for (let i = 0; i < 3; i++) {
      copies.setMatrixAt(i, new Matrix4().makeTranslation(i * 10, 0, 0))
    }
    group.add(copies)

    const stl = await exportModel(group, 'stl')
    // binary STL: 80-byte header, the triangle count, 50 bytes a triangle
    const view = new DataView(await stl.arrayBuffer())
    expect(view.getUint32(80, true)).toBe(3 * 12)
    // the scene keeps its instanced mesh
    expect(group.children).toEqual([copies])
  })

  it('drops textures when asked to, and exports placeholder materials', async () => {
    const textured = new Mesh(
      new BoxGeometry(),
      new MeshLambertMaterial({ map: new Texture() })
    )
    const placeholder = new Mesh(new BoxGeometry(), new MeshNormalMaterial())
    const group = new Group().add(textured, placeholder)

    const gltf = await glbJson(
      await exportModel(group, 'glb', { textures: false })
    )

    expect(gltf.materials).toHaveLength(2)
    expect(JSON.stringify(gltf)).not.toContain('"images"')
  })
})
