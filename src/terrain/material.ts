import {
  type CanvasTexture,
  type ColorRepresentation,
  type Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Texture
} from 'three'

import type { Canvas2D } from '../io/image'
import type { TileImageSource } from '../sources/Source.class'
import type { TileRegion } from '../sources/tile-source'
import { loadTextureGrid } from './texture'
import type { Tile } from './Tile.class'

/**
 * The look of a surface — the terrain's (the map's `material`) and, by
 * default, its layers': a starting point for the built-in materials. For
 * any other look, give the terrain a material factory (`create`) and the
 * layers their own materials.
 */
export interface MaterialOptions {
  /** `true` → lit `MeshLambertMaterial`, `false` → unlit `MeshBasicMaterial` */
  lights: boolean
  /** Draw lines: the terrain's triangles, the layers' edges. */
  wireframe: boolean
  /**
   * In wireframe, how opaque the layers' faces are under their lines, from
   * 0 (hidden, the default) to 1 — e.g. 0.12 for a light fill. The terrain
   * is lines only.
   */
  fillOpacity?: number
  fog: boolean
  /**
   * The color of the surface. It tints imagery (white leaves it as it is);
   * without imagery (`source: { api: 'none' }`) the terrain has this color.
   * White by default.
   */
  color?: ColorRepresentation
}

/** A 2D canvas context: what `process` draws on. */
export type Context2D = Canvas2D

/**
 * Draws on a tile's imagery once its four children are stitched, before it
 * becomes a texture — on the CPU: tone it (`getImageData` /
 * `putImageData`), blend in a hillshade, render your own data into it.
 */
export type ImageryProcessor = (
  context: Context2D,
  info: {
    readonly width: number
    readonly height: number
    /** The terrain tile. */
    readonly z: number
    readonly x: number
    readonly y: number
  }
) => void | Promise<void>

/** What a terrain tile's material is made of. */
export interface TerrainMaterialInput {
  /**
   * The tile's imagery: its four children at zoom + 1 stitched into one
   * sRGB texture (`NW | NE / SW | SE`, matching the mesh UVs), or `null`
   * without imagery. The tile owns and disposes it.
   */
  texture: Texture | null
  tile: Tile
  /** The map's material options. */
  options: TerrainMaterialOptions
}

/**
 * Makes the material of a terrain tile — any material: PBR maps, a
 * `ShaderMaterial`, a node material for `WebGPURenderer`. Called again for
 * every texture and every `setMaterial()`; the material is the tile's,
 * disposed when replaced (the imagery texture is not: the tile owns it).
 */
export type TerrainMaterialFactory = (input: TerrainMaterialInput) => Material

export interface TerrainMaterialOptions extends MaterialOptions {
  /** Draws on the stitched imagery before it becomes a texture. */
  process?: ImageryProcessor
  /** Makes the material; by default `createTerrainMaterial`, the look. */
  create?: TerrainMaterialFactory
}

export const defaultMaterialOptions: Readonly<TerrainMaterialOptions> =
  Object.freeze({
    lights: true,
    wireframe: false,
    fog: true,
    color: 0xffffff
  })

/** Texture URLs of the four child tiles, in `[NW, SW, NE, SE]` order. */
export type QuadTextureUrls = readonly [
  nw: string,
  sw: string,
  ne: string,
  se: string
]

/** A child texture: an image, or the `region` of an ancestor's image. */
export interface QuadTextureTile {
  image: TileImageSource
  region?: TileRegion
}

/** A child texture by URL, or a function loading it. */
export type QuadTextureInput = string | (() => Promise<QuadTextureTile>)

/** The four child textures, in `[NW, SW, NE, SE]` order. */
export type QuadTextureInputs = readonly [
  nw: QuadTextureInput,
  sw: QuadTextureInput,
  ne: QuadTextureInput,
  se: QuadTextureInput
]

export type QuadTextureCanvas = HTMLCanvasElement | OffscreenCanvas

/**
 * Loads the four child tiles (zoom + 1) and stitches them into a single
 * texture laid out to match the `PlaneGeometry` UVs:
 *
 *     NW | NE
 *     ---+---
 *     SW | SE
 *
 * Built-in materials can then sample it as a regular `map`, so no custom
 * shader code depends on three.js internals.
 */
export function loadQuadTexture(
  inputs: QuadTextureInputs,
  signal?: AbortSignal,
  /** Draws on the stitched canvas (its context, width, height). */
  process?: (
    context: Context2D,
    width: number,
    height: number
  ) => void | Promise<void>
): Promise<CanvasTexture<QuadTextureCanvas>> {
  return loadTextureGrid(inputs, signal, process)
}

/**
 * The built-in terrain material, from the look: lit or unlit, with the
 * imagery as its `map` tinted by `color` (or plain in `color` without
 * imagery), in wireframe if asked.
 */
export function createTerrainMaterial({
  texture,
  options
}: Pick<TerrainMaterialInput, 'texture'> & {
  options: Partial<MaterialOptions>
}): MeshLambertMaterial | MeshBasicMaterial {
  const { lights, wireframe, fog, color } = {
    ...defaultMaterialOptions,
    ...options
  }
  const parameters = { map: texture, color: color ?? 0xffffff, wireframe, fog }
  return lights
    ? new MeshLambertMaterial(parameters)
    : new MeshBasicMaterial(parameters)
}
