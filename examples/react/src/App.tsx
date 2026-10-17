import './App.css'

import { MapControls, PerspectiveCamera } from '@react-three/drei'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import { type GeoLocation, Map, Source } from 'three-map-terrain'

const location = { lat: 46.57634, lon: 7.9904 } // Bernese Alps

type Point = readonly [x: number, y: number, z: number]

export default function App() {
  const map = useMemo(
    () => new Map({ source: new Source({ api: 'eox' }), location }),
    []
  )
  const [ready, setReady] = useState(false)
  const [picked, setPicked] = useState<{
    location: GeoLocation
    position: Point
  } | null>(null)

  useEffect(() => {
    // resolves once every tile has its elevation; textures keep streaming in
    void map.init(() => setReady(true))
    // StrictMode mounts twice in development: clean() aborts pending
    // requests and frees GPU resources so the second init() starts fresh
    return () => {
      map.clean()
      setReady(false)
    }
  }, [map])

  // a geolocation at an altitude: 3000 m above the center of the map
  const aircraft = useMemo((): Point => {
    const { x, y, z } = map.getPosition(
      { ...location, alt: 3e3 },
      { loadTile: false }
    )
    return [x, y, z + 8] // the sphere's radius above it
  }, [map])

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    // event.point is in world space; getLocation expects terrain space
    const geo = map.getLocation(map.terrain.worldToLocal(event.point.clone()))
    // and back: the point exactly on the rendered surface
    const surface = map.getTerrainPositionSync(geo, { loadTile: false })
    if (surface)
      setPicked({ location: geo, position: [surface.x, surface.y, surface.z] })
  }

  return (
    <>
      <Canvas className='scene' flat>
        <color attach='background' args={[0x161616]} />
        <fog attach='fog' args={[0x161616, 2e3, 6e3]} />
        <ambientLight intensity={1.5} />
        <directionalLight intensity={2.5} position={[-1e4, 1e4, 1e4]} />
        <PerspectiveCamera
          makeDefault
          position={[0, -1.25e3, 1e3]}
          fov={60}
          far={1e6}
          up={[0, 0, 1]}
        />
        <MapControls maxPolarAngle={Math.PI * 0.42} />
        <primitive object={map.terrain} onClick={onClick} />
        <mesh position={aircraft}>
          <sphereGeometry args={[8, 24, 12]} />
          <meshBasicMaterial color={0xf04040} />
        </mesh>
        {picked && (
          <mesh position={picked.position}>
            <sphereGeometry args={[6, 24, 12]} />
            <meshBasicMaterial color={0xf0d040} />
          </mesh>
        )}
      </Canvas>

      <aside className='panel'>
        <h1>three-map-terrain</h1>
        <p className='muted'>
          A minimal React Three Fiber setup. Drag to pan, right-drag to rotate.
        </p>
        <p className='status' role='status'>
          {!ready
            ? 'Loading the terrain…'
            : picked
              ? `${picked.location.lat.toFixed(5)}, ${picked.location.lon.toFixed(5)} · ${Math.round(picked.location.alt)} m`
              : 'Click the terrain: its geolocation shows here.'}
        </p>
        <nav>
          <a href='https://github.com/whidrubeld/three-map-terrain'>GitHub</a>
          <a href='https://www.npmjs.com/package/three-map-terrain'>npm</a>
          <a href='https://whidrubeld.github.io/gpx-terrain/'>
            GPX Terrain — the showcase
          </a>
        </nav>
      </aside>

      <footer className='attribution'>
        Imagery <a href='https://s2maps.eu'>Sentinel-2 cloudless by EOX</a>{' '}
        (Copernicus Sentinel data 2016) · Elevation{' '}
        <a href='https://registry.opendata.aws/terrain-tiles/'>
          AWS Terrain Tiles
        </a>
      </footer>
    </>
  )
}
