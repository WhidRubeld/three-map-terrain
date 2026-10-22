// The looks: one map and its layers, restyled at runtime with
// `map.setSource()` and `map.setMaterial()`, which the layers take on.

import { type Material, MeshBasicMaterial } from 'three'
import type {
  ImageryProcessor,
  Map,
  SourceProps,
  TerrainMaterialOptions
} from 'three-map-terrain'

import { COLORED } from './colored'
import { TEXTURED } from './textured'

/** The imagery toned down to the buildings: gray, a little brighter. */
const gray: ImageryProcessor = (context, { width, height }) => {
  const image = context.getImageData(0, 0, width, height)
  const { data } = image
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    data[i] = data[i + 1] = data[i + 2] = luma * 1.1
  }
  context.putImageData(image, 0, 0)
}

const HIDDEN = new MeshBasicMaterial({ visible: false })

/** One look for the terrain — and the layers, which take it on. */
export interface Look {
  /** On the imagery; else in the material's color. */
  imagery: boolean
  material: Partial<TerrainMaterialOptions>
  /** The layers' own materials, by part. */
  parts?: Readonly<Record<string, Material>>
  background: number
  light: { ambient: number; sun: number }
}

export const LOOKS = {
  // no imagery: a colored model, the relief shows in the light
  plain: {
    imagery: false,
    material: { color: '#e8dcc3', wireframe: false, process: undefined },
    parts: COLORED,
    background: 0x1d1c1a,
    light: { ambient: 0.9, sun: 3.2 }
  },
  // the photo, in the buildings' tone
  aerial: {
    imagery: true,
    material: { color: '#ffffff', wireframe: false, process: gray },
    // the photo has its water and vegetation
    parts: { water: HIDDEN, crowns: HIDDEN, trunks: HIDDEN, bushes: HIDDEN },
    background: 0x161616,
    light: { ambient: 1.4, sun: 2.4 }
  },
  // the photo in color; roads, railways and facades with textures
  textured: {
    imagery: true,
    material: { color: '#ffffff', wireframe: false, process: undefined },
    parts: TEXTURED,
    background: 0x1b1d20,
    light: { ambient: 1.3, sun: 2.6 }
  },
  // everything in lines — the plants outlined — over a light fill
  wireframe: {
    imagery: false,
    material: {
      color: '#9fb3c8',
      wireframe: true,
      fillOpacity: 0.12,
      process: undefined
    },
    background: 0x0f1216,
    light: { ambient: 1.5, sun: 2.5 }
  }
} satisfies Record<string, Look>

export type LookName = keyof typeof LOOKS

/** Where the photos of `aerial` and `textured` come from. */
export const IMAGERY = {
  // Sentinel-2 cloudless: worldwide, 10 m a pixel
  sentinel: { title: 'Sentinel-2', source: { api: 'eox' } },
  // swisstopo's aerial photos: Switzerland only, 10 cm a pixel
  swisstopo: {
    title: 'swisstopo',
    source: {
      url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
      attribution: '© swisstopo'
    }
  }
} satisfies Record<string, { title: string; source: SourceProps }>

export type ImageryName = keyof typeof IMAGERY

/**
 * The layers' materials by part in the current look — none but its own:
 * the look's. `setMaterial()` makes the layers ask again.
 */
let parts: Readonly<Record<string, Material>> = {}
export const byPart = (part: string): Material | undefined => parts[part]

/** Restyles the map — its tiles, then its layers — in a look. */
export function applyLook(map: Map, name: LookName, imagery: ImageryName) {
  const look: Look = LOOKS[name]
  parts = look.parts ?? {}
  map.setSource(look.imagery ? IMAGERY[imagery].source : { api: 'none' })
  map.setMaterial(look.material)
}
