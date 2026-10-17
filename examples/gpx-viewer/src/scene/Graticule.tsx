import { useSelector } from '@tanstack/react-store'
import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, LineBasicMaterial } from 'three'

import type { TerrainFit } from '../lib/fit'
import { formatLat, formatLon } from '../lib/format'
import { niceStep } from '../lib/geo'
import { settingsStore } from '../state/settings'
import { terrainStore, uiStore } from '../state/viewer'
import { surfacePoint } from './drape'
import { Label } from './Glyphs'
import { PALETTE } from './look'

/** Spacing of the coordinate grid in degrees: about seven lines across. */
export function graticuleStep(fit: TerrainFit) {
  const { extent } = fit
  return niceStep(
    Math.max(extent.east - extent.west, extent.north - extent.south) / 7
  )
}

const decimalsFor = (step: number) =>
  Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))

/**
 * Parallels and meridians draped on the terrain. In Web Mercator they are
 * straight lines of the tile grid; only their heights follow the relief.
 */
export function Graticule() {
  const visible = useSelector(settingsStore, (s) => s.graticule)
  const segments = useSelector(settingsStore, (s) => s.segments)
  const map = useSelector(terrainStore, (s) => s.map)
  const ready = useSelector(terrainStore, (s) => s.ready)
  const revision = useSelector(terrainStore, (s) => s.revision)
  const fit = useSelector(terrainStore, (s) => s.fit)
  const theme = useSelector(uiStore, (s) => s.theme)

  const grid = useMemo(() => {
    if (!map || !ready || !fit) return null
    const { extent } = fit
    const step = graticuleStep(fit)
    const decimals = decimalsFor(step)
    const samples = fit.nTiles * Math.min(segments, 96)
    const lift = (fit.tileSize / segments) * 0.2
    // stay inside the grid: points exactly on its edge belong to unloaded tiles
    const inset = (extent.north - extent.south) * 1e-5
    const south = extent.south + inset
    const north = extent.north - inset
    const west = extent.west + inset
    const east = extent.east - inset

    const positions: number[] = []
    const line = (
      from: { lat: number; lon: number },
      to: { lat: number; lon: number }
    ) => {
      let previous = surfacePoint(map, from.lat, from.lon)
      for (let k = 1; k <= samples; k++) {
        const t = k / samples
        const p = surfacePoint(
          map,
          from.lat + (to.lat - from.lat) * t,
          from.lon + (to.lon - from.lon) * t
        )
        positions.push(
          previous.x,
          previous.y,
          previous.z + lift,
          p.x,
          p.y,
          p.z + lift
        )
        previous = p
      }
    }

    const labels: {
      key: string
      text: string
      position: [number, number, number]
    }[] = []
    for (let i = Math.ceil(west / step); i * step < east; i++) {
      const lon = i * step
      line({ lat: south, lon }, { lat: north, lon })
      const p = surfacePoint(map, south, lon)
      labels.push({
        key: `lon${i}`,
        text: formatLon(lon, decimals),
        position: [p.x, p.y, p.z + lift]
      })
    }
    for (let i = Math.ceil(south / step); i * step < north; i++) {
      const lat = i * step
      line({ lat, lon: west }, { lat, lon: east })
      const p = surfacePoint(map, lat, west)
      labels.push({
        key: `lat${i}`,
        text: formatLat(lat, decimals),
        position: [p.x, p.y, p.z + lift]
      })
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute(
      'position',
      new BufferAttribute(Float32Array.from(positions), 3)
    )
    return { geometry, labels }
  }, [map, ready, revision, fit, segments])

  const material = useMemo(
    () =>
      new LineBasicMaterial({
        color: PALETTE[theme].fg,
        transparent: true,
        opacity: theme === 'dark' ? 0.3 : 0.38,
        depthWrite: false
      }),
    [theme]
  )
  useEffect(() => () => grid?.geometry.dispose(), [grid])
  useEffect(() => () => material.dispose(), [material])

  if (!grid || !visible) return null
  return (
    <group name='graticule'>
      <lineSegments
        geometry={grid.geometry}
        material={material}
        renderOrder={5}
        raycast={() => undefined}
      />
      {grid.labels.map(({ key, text, position }) => (
        <Label key={key} position={position}>
          <span className='tag tag-grid'>{text}</span>
        </Label>
      ))}
    </group>
  )
}
