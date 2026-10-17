import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import {
  CanvasTexture,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshNormalMaterial,
  SRGBColorSpace,
  type Texture
} from 'three'
import { Map, Source } from 'three-map-terrain'

import type { TerrainFit } from '../lib/fit'
import { type Imagery, settingsStore } from '../state/settings'
import { terrainStore, uiStore } from '../state/viewer'
import { PALETTE } from './look'

/**
 * Per-tile state of the runtime look. The library builds one textured
 * material per tile; the viewer only flips properties of that material, so
 * imagery and wireframe switch without reloading anything.
 */
interface LookData {
  key?: string
  /** the library's quad texture */
  source?: Texture | null
  /** grayscale copy, made on demand */
  mono?: CanvasTexture
}

/**
 * Shown instead of the library's (rainbow, wireframe) placeholder while a
 * texture loads: the bare relief, in the scene's grays.
 */
const placeholders = {
  dark: new MeshLambertMaterial({ color: PALETTE.dark.relief }),
  light: new MeshLambertMaterial({ color: PALETTE.light.relief })
}
const isPlaceholder = (material: Material) =>
  material === placeholders.dark || material === placeholders.light

const isTileMaterial = (material: Material) =>
  (material instanceof MeshLambertMaterial ||
    material instanceof MeshBasicMaterial) &&
  !isPlaceholder(material)

function tiles(map: Map) {
  return map.terrain.children.filter(
    (child): child is Mesh => child instanceof Mesh
  )
}

/** Luminance copy of a tile texture, with a little extra contrast. */
function monochrome(texture: Texture): CanvasTexture | undefined {
  const image = texture.image as HTMLCanvasElement | OffscreenCanvas | undefined
  if (!image?.width) return undefined
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return undefined
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = pixels
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    const value = Math.min(255, Math.max(0, (luma - 118) * 1.25 + 128))
    data[i] = data[i + 1] = data[i + 2] = value
  }
  context.putImageData(pixels, 0, 0)
  const mono = new CanvasTexture(canvas)
  mono.colorSpace = SRGBColorSpace
  mono.anisotropy = texture.anisotropy
  return mono
}

/** Start without the tiles that are still loading after this long (ms). */
const PARTIAL_AFTER = 25_000
const PARTIAL_RETRY = 5_000

/** Converting a texture takes a few ms: spread the work over frames. */
const MONO_PER_FRAME = 2

function applyLook(
  map: Map,
  imagery: Imagery,
  wireframe: boolean,
  theme: 'dark' | 'light'
) {
  const key = `${imagery}|${wireframe}|${theme}`
  let budget = MONO_PER_FRAME
  for (const mesh of tiles(map)) {
    const material = mesh.material as Material
    if (material instanceof MeshNormalMaterial || isPlaceholder(material)) {
      // still loading: the library's shared placeholder, or ours of the other theme
      if (material !== placeholders[theme]) mesh.material = placeholders[theme]
      continue
    }
    if (!isTileMaterial(material)) continue

    const tile = material as MeshLambertMaterial | MeshBasicMaterial
    const data = tile.userData as LookData
    if (data.key === key) continue
    if (data.source === undefined) data.source = tile.map

    if (imagery === 'mono' && !data.mono && data.source) {
      if (budget-- <= 0) continue
      data.mono = monochrome(data.source)
    }
    tile.map =
      imagery === 'color'
        ? (data.source ?? null)
        : imagery === 'mono'
          ? (data.mono ?? data.source ?? null)
          : null
    tile.color.set(imagery === 'relief' ? PALETTE[theme].relief : 0xffffff)
    tile.wireframe = wireframe
    tile.needsUpdate = true
    data.key = key
  }
}

/** Hands every tile its own texture back, so that `map.clean()` disposes it. */
function releaseLook(map: Map) {
  for (const mesh of tiles(map)) {
    const material = mesh.material as Material
    if (!isTileMaterial(material)) continue
    const tile = material as MeshLambertMaterial | MeshBasicMaterial
    const data = tile.userData as LookData
    if (data.source !== undefined) tile.map = data.source
    data.mono?.dispose()
    tile.userData = {}
  }
}

function heightRange(map: Map) {
  let min = Infinity
  let max = -Infinity
  for (const mesh of tiles(map)) {
    const position = mesh.geometry.attributes.position
    for (let i = 0; i < position.count; i++) {
      const z = position.getZ(i)
      if (z < min) min = z
      if (z > max) max = z
    }
  }
  return Number.isFinite(min) ? { min, max } : null
}

export function Terrain({
  fit: next,
  segments
}: {
  fit: TerrainFit
  segments: number
}) {
  // another track in the same area keeps the loaded map
  const fit = useMemo(() => next, [next.key])
  const map = useMemo(
    () =>
      new Map({
        source: new Source({ api: 'eox' }),
        location: fit.location,
        options: {
          nTiles: fit.nTiles,
          zoom: fit.zoom,
          tileSize: fit.tileSize,
          tileSegments: segments,
          zScale: fit.zScale
        },
        material: { lights: true, wireframe: false, fog: true }
      }),
    [fit, segments]
  )

  useEffect(() => {
    let active = true
    terrainStore.setState((s) => ({
      ...s,
      map,
      fit,
      ready: false,
      readyAt: null,
      loaded: 0,
      textured: 0,
      total: fit.nTiles ** 2,
      heights: null,
      drape: null
    }))
    const finish = () => {
      if (!active) return
      terrainStore.setState((s) =>
        s.map === map
          ? {
              ...s,
              ready: true,
              readyAt: s.readyAt ?? performance.now(),
              revision: s.revision + 1,
              heights: heightRange(map)
            }
          : s
      )
    }
    void map.init(finish)
    // a single stalled tile request must not hold the whole intro back:
    // go on with the tiles that did load; init() refreshes everything later
    let timer = setTimeout(function partial() {
      if (terrainStore.state.ready) return
      if (map.terrain.children.length > 0) finish()
      else timer = setTimeout(partial, PARTIAL_RETRY)
    }, PARTIAL_AFTER)
    // StrictMode runs this twice in development: clean() aborts the first load
    return () => {
      active = false
      clearTimeout(timer)
      releaseLook(map)
      map.clean()
      terrainStore.setState((s) =>
        s.map === map ? { ...s, map: null, ready: false, drape: null } : s
      )
    }
  }, [map, fit])

  useFrame(() => {
    const { imagery, wireframe } = settingsStore.state
    applyLook(map, imagery, wireframe, uiStore.state.theme)

    const meshes = tiles(map)
    const loaded = meshes.length
    const textured = meshes.filter((m) =>
      isTileMaterial(m.material as Material)
    ).length
    const state = terrainStore.state
    if (
      state.map === map &&
      (state.loaded !== loaded || state.textured !== textured)
    ) {
      terrainStore.setState((s) => ({ ...s, loaded, textured }))
    }
  })

  return <primitive object={map.terrain} />
}
