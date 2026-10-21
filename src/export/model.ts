// 3D model files of the scene, through three.js' exporters (loaded on demand).

import {
  Color,
  Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Texture
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

  const materials: Material[] = []
  copy.traverse((child) => {
    if (!(child as Partial<Mesh>).isMesh) return
    const mesh = child as Mesh
    const convert = (material: Material) => {
      const converted = portable(material, textures)
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
