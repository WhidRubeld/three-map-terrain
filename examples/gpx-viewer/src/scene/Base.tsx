import { useSelector } from '@tanstack/react-store'
import { useEffect, useMemo } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  RepeatWrapping,
  SRGBColorSpace
} from 'three'
import type { Map } from 'three-map-terrain'

import { settingsStore } from '../state/settings'
import { terrainStore, uiStore } from '../state/viewer'
import { PALETTE, type Palette } from './look'

/** A 4 × 4 tile with one ink pixel: the dotted fill of the walls. */
function dotTexture(palette: Palette) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 4
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D canvas context is not available')
  context.fillStyle = palette.wall
  context.fillRect(0, 0, 4, 4)
  context.fillStyle = palette.edge
  context.fillRect(1, 1, 1, 1)
  const texture = new CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.magFilter = texture.minFilter = NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** Local extent of the loaded tile grid. */
function gridRect(map: Map) {
  const half = map.options.tileSize / 2
  const meshes = map.terrain.children.filter(
    (c): c is Mesh => c instanceof Mesh
  )
  return {
    minX: Math.min(...meshes.map((m) => m.position.x)) - half,
    maxX: Math.max(...meshes.map((m) => m.position.x)) + half,
    minY: Math.min(...meshes.map((m) => m.position.y)) - half,
    maxY: Math.max(...meshes.map((m) => m.position.y)) + half
  }
}

/**
 * Walls around the terrain grid down to a common floor, so the map reads as a
 * cut-out block (a diorama) instead of a floating sheet.
 */
export function Base() {
  const visible = useSelector(settingsStore, (s) => s.base)
  const segments = useSelector(settingsStore, (s) => s.segments)
  const map = useSelector(terrainStore, (s) => s.map)
  const ready = useSelector(terrainStore, (s) => s.ready)
  const heights = useSelector(terrainStore, (s) => s.heights)
  const theme = useSelector(uiStore, (s) => s.theme)

  const geometry = useMemo(() => {
    if (!map || !ready || !heights) return null
    const { tileSize, nTiles } = map.options
    const rect = gridRect(map)
    const floor =
      heights.min -
      Math.max((heights.max - heights.min) * 0.12, tileSize * 0.04)
    const inset = 1e-3
    const samples = nTiles * segments

    const height = (x: number, y: number) => {
      const { lat, lon } = map.getLocation({ x, y, z: 0 })
      return (
        map.getTerrainPositionSync({ lat, lon }, { loadTile: false })?.z ??
        floor
      )
    }
    const corners = [
      [rect.minX + inset, rect.maxY - inset],
      [rect.maxX - inset, rect.maxY - inset],
      [rect.maxX - inset, rect.minY + inset],
      [rect.minX + inset, rect.minY + inset]
    ] as const

    const walls: number[] = []
    const uvs: number[] = []
    const edges: number[] = []
    // the dot pattern: one texel per 2 scene units horizontally and vertically
    const texel = 8
    let run = 0
    corners.forEach(([ax, ay], side) => {
      const [bx, by] = corners[(side + 1) % 4]
      let px = ax
      let py = ay
      let pz = height(ax, ay)
      for (let k = 1; k <= samples; k++) {
        const t = k / samples
        const x = ax + (bx - ax) * t
        const y = ay + (by - ay) * t
        const z = height(x, y)
        const step = Math.hypot(x - px, y - py)
        const u0 = run / texel
        const u1 = (run + step) / texel
        walls.push(
          px,
          py,
          pz,
          x,
          y,
          z,
          x,
          y,
          floor,
          px,
          py,
          pz,
          x,
          y,
          floor,
          px,
          py,
          floor
        )
        uvs.push(
          u0,
          pz / texel,
          u1,
          z / texel,
          u1,
          floor / texel,
          u0,
          pz / texel,
          u1,
          floor / texel,
          u0,
          floor / texel
        )
        edges.push(px, py, pz, x, y, z, px, py, floor, x, y, floor)
        run += step
        px = x
        py = y
        pz = z
      }
      edges.push(ax, ay, height(ax, ay), ax, ay, floor)
    })

    const wall = new BufferGeometry()
    wall.setAttribute(
      'position',
      new BufferAttribute(Float32Array.from(walls), 3)
    )
    wall.setAttribute('uv', new BufferAttribute(Float32Array.from(uvs), 2))
    const edge = new BufferGeometry()
    edge.setAttribute(
      'position',
      new BufferAttribute(Float32Array.from(edges), 3)
    )
    return { wall, edge }
  }, [map, ready, heights, segments])

  const materials = useMemo(() => {
    const palette = PALETTE[theme]
    return {
      wall: new MeshBasicMaterial({
        map: dotTexture(palette),
        side: DoubleSide
      }),
      edge: new LineBasicMaterial({
        color: palette.edge,
        transparent: true,
        opacity: 0.8
      })
    }
  }, [theme])

  useEffect(
    () => () => {
      geometry?.wall.dispose()
      geometry?.edge.dispose()
    },
    [geometry]
  )
  useEffect(
    () => () => {
      materials.wall.map?.dispose()
      materials.wall.dispose()
      materials.edge.dispose()
    },
    [materials]
  )

  if (!geometry || !visible) return null
  return (
    <group name='base'>
      <mesh
        geometry={geometry.wall}
        material={materials.wall}
        raycast={() => undefined}
      />
      <lineSegments
        geometry={geometry.edge}
        material={materials.edge}
        raycast={() => undefined}
      />
    </group>
  )
}
