import './App.css'
import { useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { MapControls, PerspectiveCamera } from '@react-three/drei'
import { Map, Source } from 'three-geo-map'
import { Vector3 } from 'three'

function App() {
  const [map, setMap] = useState<Map>()
  const [objectCoords, setObjectCoords] = useState<{
    x: number
    y: number
    z: number
  }>()

  const objectPosition = useMemo(() => {
    if (!objectCoords) return undefined
    return new Vector3(objectCoords.x, objectCoords.y, objectCoords.z + 8)
  }, [objectCoords])

  useEffect(() => {
    setMap(
      new Map({
        source: new Source({ api: 'eox' }),
        location: { lat: 45.916216, lon: 6.860973 },
        material: { wireframe: true }
      })
    )
  }, [])

  useEffect(() => {
    if (map) {
      map.init(() => console.log('Map is ready'))
      setObjectCoords(
        map.getPosition({
          lat: 45.916216,
          lon: 6.860973,
          alt: 1027
        })
      )
    }
  }, [map])

  return (
    <Canvas
      className='scene'
      onCreated={(state) => state.gl.setClearColor(0x222222)}
    >
      <ambientLight color={0x404040} intensity={2.5} />
      <directionalLight
        castShadow
        color={0xffffff}
        intensity={0.75}
        position={[1e4, 1e4, 1e4]}
      />
      <PerspectiveCamera
        makeDefault
        position={[0, -1.25e3, 10e2]}
        fov={75}
        far={1e6}
        up={[0, 0, 1]}
      />
      <MapControls />
      {map && <primitive object={map.terrain} position={[0, 0, 0]} />}
      {objectPosition && (
        <mesh position={objectPosition}>
          <sphereBufferGeometry args={[8, 24, 12]} />
          <meshStandardMaterial color={0xf04040} />
        </mesh>
      )}
    </Canvas>
  )
}

export default App
