import { useFrame } from '@react-three/fiber'
import { useSelector } from '@tanstack/react-store'
import { useEffect, useMemo, useRef } from 'react'
import type { Group } from 'three'

import { withTerrainElevation } from '../gpx/track'
import { fitTerrain } from '../lib/fit'
import { settingsStore } from '../state/settings'
import { terrainStore, viewerStore } from '../state/viewer'
import { Base } from './Base'
import { drapeTrack } from './drape'
import { Graticule } from './Graticule'
import { easeOutCubic, INTRO, introPhase } from './look'
import { Markers } from './Markers'
import { HoverProbe, Playhead, TerrainCursor } from './Probes'
import { sceneRefs } from './refs'
import { Route } from './Route'
import { Terrain } from './Terrain'

/** Flat while loading, so the intro can raise the relief. */
const FLAT = 0.02

/**
 * Terrain and everything placed on it, in terrain coordinates. `scale.z` is
 * the vertical exaggeration (times the intro "rise"), so changing it costs
 * nothing: no tile is rebuilt.
 */
export function World() {
  const group = useRef<Group>(null)
  const track = useSelector(viewerStore, (s) => s.track)
  const tiles = useSelector(settingsStore, (s) => s.tiles)
  const segments = useSelector(settingsStore, (s) => s.segments)
  const map = useSelector(terrainStore, (s) => s.map)
  const ready = useSelector(terrainStore, (s) => s.ready)
  const revision = useSelector(terrainStore, (s) => s.revision)

  // `bounds` keeps its identity when only elevations change
  const bounds = track?.bounds
  const fit = useMemo(
    () => (bounds ? fitTerrain(bounds, tiles) : null),
    [bounds, tiles]
  )

  useEffect(() => {
    sceneRefs.world = group.current
    return () => {
      sceneRefs.world = null
    }
  }, [])

  // once the grid is loaded: DEM elevations for tracks without them, then the drape
  useEffect(() => {
    // the store may already hold the next map (this render's one is being cleaned)
    if (!map || !ready || !track || terrainStore.state.map !== map) return
    if (track.elevationSource === 'none') {
      const zScale = map.options.zScale
      viewerStore.setState((s) =>
        s.track === track
          ? {
              ...s,
              track: withTerrainElevation(track, (p) => {
                const position = map.getTerrainPositionSync(p, {
                  loadTile: false
                })
                return position ? position.z / zScale : undefined
              })
            }
          : s
      )
      return
    }
    const cell = map.options.tileSize / map.options.tileSegments
    const drape = drapeTrack(map, track, cell, cell * 0.3)
    terrainStore.setState((s) => (s.map === map ? { ...s, drape } : s))
  }, [map, ready, revision, track])

  useFrame((_, delta) => {
    const node = group.current
    if (!node) return
    const { exaggeration, animations } = settingsStore.state
    const { ready: loaded } = terrainStore.state
    const rise = loaded
      ? Math.max(FLAT, easeOutCubic(introPhase(INTRO.rise)))
      : animations
        ? FLAT
        : 1
    const target = exaggeration * rise
    // slider changes ease in; the intro curve is already smooth
    const k = animations ? 1 - Math.exp(-delta * 12) : 1
    node.scale.z += (target - node.scale.z) * k
    if (Math.abs(target - node.scale.z) < 1e-4) node.scale.z = target
  })

  return (
    <group ref={group} name='world'>
      {fit && (
        <Terrain key={`${fit.key}:${segments}`} fit={fit} segments={segments} />
      )}
      <Base />
      <Graticule />
      <Route />
      <Markers />
      <Playhead />
      <HoverProbe />
      <TerrainCursor />
    </group>
  )
}
