// 3D model files of the scene, through three.js' exporters (loaded on demand).

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  type InstancedMesh,
  type Material,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Texture,
  Vector3
} from 'three'

export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'usdz'

/** Media types of the exported files. */
export const MODEL_TYPES: Readonly<Record<ModelFormat, string>> = Object.freeze(
  {
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
    obj: 'model/obj',
    stl: 'model/stl',
    usdz: 'model/vnd.usdz+zip'
  }
)

export interface ModelOptions {
  /** Embed the imagery (glTF, GLB, USDZ); default `true`. */
  textures?: boolean
  /** Also lines — building edges (glTF, GLB, OBJ); default `false`. */
  lines?: boolean
  /** Factor from scene units to the file's units, e.g. meters; default 1. */
  scale?: number
  /**
   * Leaves out the objects (with their children) it returns `false` for, as
   * well as those with `userData.export === false`.
   */
  filter?: (object: Object3D) => boolean
}

/** Formats that keep an `InstancedMesh` as such. */
const INSTANCING: ReadonlySet<ModelFormat> = new Set(['glb', 'gltf'])

/**
 * Replaces every `InstancedMesh` under `root` by a mesh of all its copies,
 * the copies' colors as vertex colors (times the geometry's).
 */
function expandInstances(root: Object3D, created: BufferGeometry[]) {
  const instanced: InstancedMesh[] = []
  root.traverse((child) => {
    if ((child as Partial<InstancedMesh>).isInstancedMesh) {
      instanced.push(child as InstancedMesh)
    }
  })
  for (const mesh of instanced) {
    const source = mesh.geometry.index
      ? mesh.geometry.toNonIndexed()
      : mesh.geometry
    const position = source.getAttribute('position')
    const normal = source.getAttribute('normal') as BufferAttribute | undefined
    const color = source.getAttribute('color') as BufferAttribute | undefined
    const n = position.count
    const positions = new Float32Array(n * mesh.count * 3)
    const normals = new Float32Array(n * mesh.count * 3)
    const colors = new Float32Array(n * mesh.count * 3)
    const matrix = new Matrix4()
    const normalMatrix = new Matrix3()
    const v = new Vector3()
    const tint = new Color()
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix)
      normalMatrix.getNormalMatrix(matrix)
      if (mesh.instanceColor) mesh.getColorAt(i, tint)
      else tint.setRGB(1, 1, 1)
      for (let k = 0; k < n; k++) {
        const at = (i * n + k) * 3
        v.fromBufferAttribute(position, k).applyMatrix4(matrix)
        positions.set([v.x, v.y, v.z], at)
        if (normal) {
          v.fromBufferAttribute(normal, k)
            .applyMatrix3(normalMatrix)
            .normalize()
          normals.set([v.x, v.y, v.z], at)
        }
        const [r, g, b] = color
          ? [color.getX(k), color.getY(k), color.getZ(k)]
          : [1, 1, 1]
        colors.set([r * tint.r, g * tint.g, b * tint.b], at)
      }
    }
    if (source !== mesh.geometry) source.dispose()
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    if (normal) geometry.setAttribute('normal', new BufferAttribute(normals, 3))
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    created.push(geometry)
    const copies = new Mesh(geometry, mesh.material)
    copies.name = mesh.name
    copies.position.copy(mesh.position)
    copies.quaternion.copy(mesh.quaternion)
    copies.scale.copy(mesh.scale)
    // the copies' colors are vertex colors now
    copies.userData.vertexColors = true
    mesh.parent?.add(copies)
    mesh.removeFromParent()
  }
}

/** Formats that are Y-up by convention; STL stays Z-up, as slicers expect. */
const Y_UP: ReadonlySet<ModelFormat> = new Set(['glb', 'gltf', 'obj', 'usdz'])

const isLine = (object: Object3D) =>
  'isLine' in object && object.isLine === true

/** A copy sharing geometries; kept objects only, all visible. */
function copyTree(object: Object3D, keep: (object: Object3D) => boolean) {
  const copy = object.clone(false)
  copy.visible = true
  for (const child of object.children) {
    if (keep(child)) copy.add(copyTree(child, keep))
  }
  return copy
}

/**
 * The material as every format reads it: `MeshStandardMaterial` (USDZ needs
 * it, glTF prefers it) with the color, the texture and the vertex colors.
 */
function portable(material: Material, textures: boolean): MeshStandardMaterial {
  const { color, map, vertexColors } = material as Material & {
    color?: Color
    map?: Texture | null
  }
  return new MeshStandardMaterial({
    color: color instanceof Color ? color : 0xffffff,
    map: textures && map instanceof Texture ? map : null,
    vertexColors,
    side: material.side,
    roughness: 1,
    metalness: 0
  })
}

/**
 * Exports a Z-up three.js object — `map.terrain` or any part of the scene —
 * as a model file: `glb`, `gltf`, `obj`, `stl` or `usdz`. It is exported in
 * its own frame (its transform is left out), turned Y-up for the formats
 * whose convention that is. Materials become `MeshStandardMaterial`s.
 */
export async function exportModel(
  object: Object3D,
  format: ModelFormat,
  { textures = true, lines = false, scale = 1, filter }: ModelOptions = {}
): Promise<Blob> {
  // objects marked `userData.export = false`, e.g. highlights, stay out
  const keep = (child: Object3D) =>
    child.userData.export !== false &&
    (lines || !isLine(child)) &&
    (filter?.(child) ?? true)
  const copy = copyTree(object, keep)
  copy.position.set(0, 0, 0)
  copy.quaternion.identity()
  copy.scale.set(1, 1, 1)
  // glTF has instancing (EXT_mesh_gpu_instancing); the others get the copies
  const expanded: BufferGeometry[] = []
  if (!INSTANCING.has(format)) expandInstances(copy, expanded)

  const materials: Material[] = []
  copy.traverse((child) => {
    if (!(child as Partial<Mesh>).isMesh) return
    const mesh = child as Mesh
    const convert = (material: Material) => {
      const converted = portable(material, textures)
      if (mesh.userData.vertexColors === true) converted.vertexColors = true
      materials.push(converted)
      return converted
    }
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(convert)
      : convert(mesh.material)
  })

  const root = new Group()
  root.add(copy)
  if (Y_UP.has(format)) root.rotation.x = -Math.PI / 2
  root.scale.setScalar(scale)
  root.updateMatrixWorld(true)

  try {
    return new Blob([await write(root, format)], { type: MODEL_TYPES[format] })
  } finally {
    for (const material of materials) material.dispose()
    for (const geometry of expanded) geometry.dispose()
  }
}

async function write(root: Object3D, format: ModelFormat): Promise<BlobPart> {
  switch (format) {
    case 'glb':
    case 'gltf': {
      const { GLTFExporter } =
        await import('three/addons/exporters/GLTFExporter.js')
      const result = await new GLTFExporter().parseAsync(root, {
        binary: format === 'glb',
        onlyVisible: false
      })
      return result instanceof ArrayBuffer ? result : JSON.stringify(result)
    }
    case 'obj': {
      const { OBJExporter } =
        await import('three/addons/exporters/OBJExporter.js')
      return new OBJExporter().parse(root)
    }
    case 'stl': {
      const { STLExporter } =
        await import('three/addons/exporters/STLExporter.js')
      const view = new STLExporter().parse(root, { binary: true })
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    }
    case 'usdz': {
      const { USDZExporter } =
        await import('three/addons/exporters/USDZExporter.js')
      const exporter = new USDZExporter()
      // three before r155: parse() itself returns the promise
      const legacy = exporter as unknown as {
        parse: (scene: Object3D) => Promise<Uint8Array>
      }
      const data =
        'parseAsync' in exporter
          ? await exporter.parseAsync(root)
          : await legacy.parse(root)
      return new Uint8Array(data)
    }
  }
}
