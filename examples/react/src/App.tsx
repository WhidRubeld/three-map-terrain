import './App.css'

import { MapControls, PerspectiveCamera } from '@react-three/drei'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import {
  type BuildingFeature,
  Buildings,
  type GeoLocation,
  Map,
  type ModelFormat,
  type QuadTextureMaterialOptions,
  type SourceProps,
  TerrainBase
} from 'three-map-terrain'

type Point = readonly [x: number, y: number, z: number]

const alps = { lat: 46.57634, lon: 7.9904 }
const lausanne = { lat: 46.515, lon: 6.632 }

const PLACES = {
  alps: {
    title: 'Bernese Alps',
    // satellite imagery on the default elevation (AWS Terrain Tiles)
    create: () => new Map({ source: { api: 'eox' }, location: alps })
  },
  lausanne: {
    title: 'Lausanne',
    // from Lake Geneva (372 m, at z = 0) up to the cathedral, true to scale
    create: () => {
      const map = new Map({
        location: lausanne,
        elevation: { api: 'mapterhorn' },
        // 48 segments: dense enough for the relief, readable in wireframe
        options: {
          zoom: 15,
          exaggeration: 1,
          baseAltitude: 372,
          tileSegments: 48
        },
        material: LOOKS.plain.material
      })
      // set up once: both take on the terrain's look
      map.addLayer(
        new Buildings({ source: { api: 'openfreemap' }, edges: true })
      )
      map.addLayer(new TerrainBase())
      return map
    }
  }
}

type Place = keyof typeof PLACES

/** One look for the terrain — and the layers, which take it on. */
interface Look {
  source: SourceProps
  material: Partial<QuadTextureMaterialOptions>
  background: number
  light: { ambient: number; sun: number }
}

const LOOKS = {
  // no imagery: the relief shows in the light
  plain: {
    source: { api: 'none' },
    material: { color: '#f2ede5', wireframe: false, filter: 'none' },
    background: 0x1d1c1a,
    light: { ambient: 0.9, sun: 3.2 }
  },
  // the photo, in the buildings' tone
  aerial: {
    source: {
      url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
      attribution: '© swisstopo'
    },
    material: {
      color: '#ffffff',
      wireframe: false,
      filter: 'grayscale(1) brightness(1.1)'
    },
    background: 0x161616,
    light: { ambient: 1.4, sun: 2.4 }
  },
  wireframe: {
    source: { api: 'none' },
    material: { color: '#9fb3c8', wireframe: true, filter: 'none' },
    background: 0x0f1216,
    light: { ambient: 1.5, sun: 2.5 }
  }
} satisfies Record<string, Look>

type LookName = keyof typeof LOOKS

const ALPS_LOOK: Pick<Look, 'background' | 'light'> = {
  background: 0x161616,
  light: { ambient: 1.5, sun: 2.5 }
}

const param = (name: string) =>
  new URLSearchParams(window.location.search).get(name)

type Picked =
  | { kind: 'terrain'; location: GeoLocation; position: Point }
  | { kind: 'building'; location: GeoLocation; feature: BuildingFeature }

export default function App() {
  const [place, setPlace] = useState<Place>(
    param('place') === 'lausanne' ? 'lausanne' : 'alps'
  )
  const [lookName, setLookName] = useState<LookName>(() => {
    const name = param('look')
    return name !== null && name in LOOKS ? (name as LookName) : 'plain'
  })
  const map = useMemo(() => PLACES[place].create(), [place])
  const buildings = map.layers.find((layer) => layer instanceof Buildings)
  const look = place === 'alps' ? ALPS_LOOK : LOOKS[lookName]
  const [ready, setReady] = useState(false)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [saving, setSaving] = useState<ModelFormat | null>(null)
  const [credits, setCredits] = useState<string[]>([])

  useEffect(() => {
    // resolves once every tile has its elevation; textures and buildings
    // keep streaming in
    void map.init(() => setReady(true))
    // StrictMode mounts twice in development: clean() aborts pending
    // requests and frees GPU resources so the second init() starts fresh
    return () => {
      map.clean()
      setReady(false)
      setPicked(null)
    }
  }, [map])

  // another look: the same map and buildings, restyled
  useEffect(() => {
    if (place === 'alps') return
    const { source, material } = LOOKS[lookName]
    map.setSource(source)
    map.setMaterial(material)
  }, [map, place, lookName])

  // the credits of the sources in use, once the look is applied
  useEffect(() => {
    setCredits(map.attributions)
  }, [map, place, lookName])

  // a geolocation at an altitude: 3000 m above the center of the Alps
  const aircraft = useMemo((): Point | null => {
    if (place !== 'alps') return null
    const { x, y, z } = map.getPosition(
      { ...alps, alt: 3e3 },
      { loadTile: false }
    )
    return [x, y, z + 8] // the sphere's radius above it
  }, [map, place])

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    // a building: its feature, highlighted
    const building = buildings?.pickIntersection(event)
    buildings?.highlight(building?.feature)
    if (building) {
      setPicked({
        kind: 'building',
        location: building,
        feature: building.feature
      })
      return
    }
    // the terrain: event.point is in world space, getLocation expects
    // terrain space; and back to the point exactly on the rendered surface
    const geo = map.getLocation(map.terrain.worldToLocal(event.point.clone()))
    const surface = map.getTerrainPositionSync(geo, { loadTile: false })
    if (surface) {
      setPicked({
        kind: 'terrain',
        location: geo,
        position: [surface.x, surface.y, surface.z]
      })
    }
  }

  const choose = (next: { place?: Place; look?: LookName }) => {
    const url = new URL(window.location.href)
    if (next.place) url.searchParams.set('place', next.place)
    if (next.look) url.searchParams.set('look', next.look)
    window.history.replaceState(null, '', url)
    if (next.place) setPlace(next.place)
    if (next.look) setLookName(next.look)
  }

  // the terrain, imagery and layers as a 3D model file
  const download = async (format: ModelFormat) => {
    setSaving(format)
    try {
      const blob = await map.export(format)
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${place}.${format}`
      link.click()
      URL.revokeObjectURL(link.href)
    } finally {
      setSaving(null)
    }
  }

  return (
    <>
      <Canvas className='scene' flat>
        <color attach='background' args={[look.background]} />
        <fog attach='fog' args={[look.background, 2e3, 6e3]} />
        <ambientLight intensity={look.light.ambient} />
        <directionalLight
          intensity={look.light.sun}
          position={[-1e4, -4e3, 7e3]}
        />
        <PerspectiveCamera
          makeDefault
          position={[0, -1.25e3, 1e3]}
          fov={60}
          far={1e6}
          up={[0, 0, 1]}
        />
        <MapControls maxPolarAngle={Math.PI * 0.42} />
        <primitive object={map.terrain} onClick={onClick} />
        {aircraft && (
          <mesh position={aircraft}>
            <sphereGeometry args={[8, 24, 12]} />
            <meshBasicMaterial color={0xf04040} />
          </mesh>
        )}
        {picked?.kind === 'terrain' && (
          <mesh position={picked.position}>
            <sphereGeometry args={[6, 24, 12]} />
            <meshBasicMaterial color={0xf0d040} />
          </mesh>
        )}
      </Canvas>

      <aside className='panel'>
        <h1>three-map-terrain</h1>
        <Choice
          label='Place'
          options={Object.keys(PLACES) as Place[]}
          value={place}
          name={(key) => PLACES[key].title}
          onChange={(key) => choose({ place: key })}
        />
        {place !== 'alps' && (
          <Choice
            label='Look'
            options={Object.keys(LOOKS) as LookName[]}
            value={lookName}
            onChange={(key) => choose({ look: key })}
          />
        )}
        <p className='status' role='status'>
          {!ready
            ? 'Loading the terrain…'
            : picked
              ? describe(picked)
              : buildings
                ? 'Click a building or the terrain.'
                : 'Click the terrain: its geolocation shows here.'}
        </p>
        <p className='muted'>Drag to pan, right-drag to rotate.</p>
        <div className='choice'>
          {(['glb', 'stl'] as const).map((format) => (
            <button
              key={format}
              type='button'
              disabled={!ready || saving !== null}
              onClick={() => void download(format)}
            >
              {saving === format
                ? 'Exporting…'
                : `Download ${format.toUpperCase()}`}
            </button>
          ))}
        </div>
        <nav>
          <a href='https://github.com/whidrubeld/three-map-terrain'>GitHub</a>
          <a href='https://www.npmjs.com/package/three-map-terrain'>npm</a>
          <a href='https://whidrubeld.github.io/gpx-terrain/'>
            GPX Terrain — the showcase
          </a>
        </nav>
      </aside>

      {/* the credits every data source asks for */}
      <footer className='attribution'>{credits.join(' · ')}</footer>
    </>
  )
}

function Choice<T extends string>({
  label,
  options,
  value,
  name = (key) => key,
  onChange
}: {
  label: string
  options: readonly T[]
  value: T
  name?: (key: T) => string
  onChange: (key: T) => void
}) {
  return (
    <div className='choice' role='group' aria-label={label}>
      {options.map((key) => (
        <button
          key={key}
          type='button'
          aria-pressed={key === value}
          onClick={() => onChange(key)}
        >
          {name(key)}
        </button>
      ))}
    </div>
  )
}

function describe(picked: Picked) {
  const { lat, lon, alt } = picked.location
  const where = `${lat.toFixed(5)}, ${lon.toFixed(5)}`
  if (picked.kind === 'terrain') return `${where} · ${Math.round(alt)} m`
  const { height } = picked.feature
  return `Building${height === undefined ? '' : `, ${Math.round(height)} m high`} · ${where}`
}
