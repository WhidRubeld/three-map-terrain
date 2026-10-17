import './App.css'

import { MapControls, PerspectiveCamera } from '@react-three/drei'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Map, Source } from 'three-map-terrain'

const location = { lat: 46.57634, lon: 7.9904 }

export default function App() {
  const map = useMemo(
    () => new Map({ source: new Source({ api: 'eox' }), location }),
    []
  )

  const marker = useMemo(() => {
    const { x, y, z } = map.getPosition(
      { ...location, alt: 3e3 },
      { loadTile: false }
    )
    // with sphere radius offset
    return [x, y, z + 8] as const
  }, [map])

  useEffect(() => {
    void map.init(() => {
      console.log('Map is ready')
    })
    // StrictMode mounts twice in development: clean() aborts pending
    // requests and frees GPU resources so the second init() starts fresh
    return () => {
      map.clean()
    }
  }, [map])

  return (
    <Canvas className='scene' flat>
      <color attach='background' args={[0x222222]} />
      <ambientLight intensity={1.5} />
      <directionalLight intensity={2.5} position={[1e4, 1e4, 1e4]} />
      <PerspectiveCamera
        makeDefault
        position={[0, -1.25e3, 1e3]}
        fov={75}
        far={1e6}
        up={[0, 0, 1]}
      />
      <MapControls />
      <primitive
        object={map.terrain}
        onClick={(event: ThreeEvent<MouseEvent>) => {
          event.stopPropagation()
          // event.point is in world space; getLocation expects terrain space
          const { lat, lon, alt } = map.getLocation(
            map.terrain.worldToLocal(event.point.clone())
          )
          console.log(
            `${lat.toFixed(5)}, ${lon.toFixed(5)}, ${Math.round(alt)} m`
          )
        }}
      />
      <mesh position={marker}>
        <sphereGeometry args={[8, 24, 12]} />
        <meshBasicMaterial color={0xf04040} />
      </mesh>
    </Canvas>
  )
}
