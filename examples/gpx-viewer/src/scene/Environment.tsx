import { useFrame, useThree } from '@react-three/fiber'
import { useSelector } from '@tanstack/react-store'
import { useEffect } from 'react'
import { FogExp2 } from 'three'

import { settingsStore } from '../state/settings'
import {
  PLAYBACK_SECONDS,
  playbackStore,
  terrainStore,
  uiStore,
  viewerStore
} from '../state/viewer'
import { PALETTE } from './look'
import { perf } from './perf'

/** Lights (sun from the north-west, the cartographic convention) and fog. */
export function Environment() {
  const scene = useThree((s) => s.scene)
  const theme = useSelector(uiStore, (s) => s.theme)
  const fog = useSelector(settingsStore, (s) => s.fog)
  const fit = useSelector(terrainStore, (s) => s.fit)
  const extent = fit ? fit.tileSize * fit.nTiles : 1800

  useEffect(() => {
    // the canvas is transparent: fog fades the terrain into the page color
    scene.fog = fog ? new FogExp2(PALETTE[theme].bg, 0.3 / extent) : null
    return () => {
      scene.fog = null
    }
  }, [scene, theme, fog, extent])

  return (
    <>
      <ambientLight intensity={1.15} />
      <directionalLight position={[-1e4, 1e4, 1.3e4]} intensity={2.6} />
    </>
  )
}

export function PerfProbe() {
  useFrame((state, delta) => {
    perf.frames[perf.head] = delta * 1000
    perf.head = (perf.head + 1) % perf.frames.length
    perf.count = Math.min(perf.count + 1, perf.frames.length)
    // read before this frame renders: the numbers of the previous frame
    const { render, memory, programs } = state.gl.info
    perf.calls = render.calls
    perf.triangles = render.triangles
    perf.points = render.points
    perf.lines = render.lines
    perf.geometries = memory.geometries
    perf.textures = memory.textures
    perf.programs = programs?.length ?? 0
    perf.dpr = state.viewport.dpr
    perf.width = state.size.width
    perf.height = state.size.height
  })
  return null
}

/** Advances the playhead: the whole track takes `PLAYBACK_SECONDS / speed`. */
export function PlaybackDriver() {
  useFrame((_, delta) => {
    const { playing, progress, speed } = playbackStore.state
    if (!playing || !viewerStore.state.track) return
    const next = Math.min(
      1,
      progress + (Math.min(delta, 0.1) * speed) / PLAYBACK_SECONDS
    )
    playbackStore.setState((s) => ({ ...s, progress: next, playing: next < 1 }))
  })
  return null
}
