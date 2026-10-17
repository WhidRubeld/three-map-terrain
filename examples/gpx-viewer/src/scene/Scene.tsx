import { Canvas } from '@react-three/fiber'
import { useSelector } from '@tanstack/react-store'

import { settingsStore } from '../state/settings'
import { CameraRig } from './CameraRig'
import { Environment, PerfProbe, PlaybackDriver } from './Environment'
import { PointerProbe } from './Probes'
import { World } from './World'

export function Scene() {
  const pixelSize = useSelector(settingsStore, (s) => s.pixelSize)
  // pixel mode renders fewer pixels and lets CSS scale them up without smoothing
  const dpr =
    pixelSize > 1 ? 1 / pixelSize : Math.min(window.devicePixelRatio, 2)

  return (
    <Canvas
      className='scene'
      data-pixelated={pixelSize > 1}
      dpr={dpr}
      flat
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      camera={{
        fov: 45,
        near: 1,
        far: 1e5,
        up: [0, 0, 1],
        position: [0, -1800, 2400]
      }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0)
        // focusable, so that arrow keys reach the controls
        gl.domElement.tabIndex = 0
        gl.domElement.setAttribute('aria-label', '3D terrain view')
      }}
    >
      <Environment />
      <CameraRig />
      <World />
      <PointerProbe />
      <PlaybackDriver />
      <PerfProbe />
    </Canvas>
  )
}
