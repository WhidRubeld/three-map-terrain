import './App.css'

import { MapControls, PerspectiveCamera } from '@react-three/drei'
import { Canvas, type ThreeEvent, useThree } from '@react-three/fiber'
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState
} from 'react'
import {
  type PerspectiveCamera as Camera,
  Raycaster,
  type Vector3
} from 'three'
import {
  type FeatureHit,
  type FeatureLayer,
  Map,
  type ModelFormat
} from 'three-map-terrain'

import {
  LAYER_NAMES,
  type LayerName,
  LAYERS,
  layersBelow,
  minZoom
} from './layers'
import {
  applyLook,
  IMAGERY,
  type ImageryName,
  LOOKS,
  type LookName
} from './looks'
import {
  type Area,
  EXAGGERATIONS,
  gridOf,
  inSwitzerland,
  kilometers,
  PLACES,
  type PlaceName,
  placeOf,
  readView,
  type View,
  writeView
} from './view'

// the picker and its map library load once it opens
const Picker = lazy(() =>
  import('./Picker').then(({ Picker }) => ({ default: Picker }))
)

type Point = readonly [x: number, y: number, z: number]

const FORMATS: readonly ModelFormat[] = ['glb', 'stl', 'obj', 'usdz']

/** The terrain of an area, on Mapterhorn's elevation: worldwide, finer where finer data exists. */
function createMap(area: Area, exaggeration: number) {
  const { lat, lon, zoom } = area
  return new Map({
    // the middle of the grid: positions are measured from it
    location: { lat, lon },
    elevation: { api: 'mapterhorn' },
    options: {
      zoom,
      // any rectangle of tiles
      grid: gridOf(area),
      exaggeration,
      // a town's relief is smooth (and readable in wireframe), a mountain's not
      tileSegments: zoom >= 14 ? 48 : 128
    }
  })
}

export default function App() {
  const [view, setView] = useState(() => readView(window.location.search))
  const [picking, setPicking] = useState(() =>
    new URLSearchParams(window.location.search).has('pick')
  )
  const { area, exaggeration } = view
  // a new map for every area; looks and layers change on the same one
  const map = useMemo(() => createMap(area, exaggeration), [area, exaggeration])
  const look = LOOKS[view.look]
  const width = Math.max(area.columns, area.rows) * map.options.tileSize
  const [ready, setReady] = useState(false)
  const [center, setCenter] = useState<Point | null>(null)
  const [picked, setPicked] = useState<{ text: string; point?: Point }>()
  const [saving, setSaving] = useState<ModelFormat | null>(null)
  const [copied, setCopied] = useState(false)
  const [credits, setCredits] = useState<string[]>([])
  const [folded, setFolded] = useState(
    () => window.matchMedia('(max-width: 600px)').matches
  )

  // the URL is the view: copied, it opens the same
  useEffect(() => {
    window.history.replaceState(null, '', writeView(view, picking))
  }, [view, picking])

  useEffect(() => {
    // resolves once every tile has its elevation; textures and layers
    // keep streaming in
    void map.init(() => setReady(true))
    // the camera looks at the middle of the grid, at its height there
    const [west, south, east, north] = map.bounds
    map
      .getTerrainPosition({ lat: (south + north) / 2, lon: (west + east) / 2 })
      .then(({ x, y, z }) => setCenter([x, y, z]))
      .catch(() => undefined)
    // StrictMode mounts twice in development: clean() aborts pending
    // requests and frees GPU resources so the second init() starts fresh
    return () => {
      map.clean()
      setReady(false)
      setPicked(undefined)
    }
  }, [map])

  // another look: the same map and layers, restyled
  useEffect(() => {
    applyLook(map, view.look, view.imagery)
  }, [map, view.look, view.imagery])

  // the layers switched on are on the map, the others not…
  useEffect(() => {
    for (const name of LAYER_NAMES) {
      if (view.layers.includes(name)) map.addLayer(LAYERS[name])
      else map.removeLayer(LAYERS[name])
    }
  }, [map, view.layers])
  // …and none on the map of the area left
  useEffect(
    () => () => {
      for (const layer of Object.values(LAYERS)) map.removeLayer(layer)
    },
    [map]
  )

  // the credits of the sources in use
  useEffect(() => {
    setCredits(map.attributions)
  }, [map, view.look, view.imagery, view.layers])

  const update = (next: Partial<View>) => setView((v) => ({ ...v, ...next }))

  const onPick = (next: Area) => {
    setPicking(false)
    // swisstopo has no photos beyond Switzerland
    setView((v) => ({
      ...v,
      area: next,
      imagery: inSwitzerland(next) ? v.imagery : 'sentinel'
    }))
  }
  const onCancel = useCallback(() => setPicking(false), [])

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    // not at the end of a drag
    if (event.delta > 4) return
    const raycaster = new Raycaster(event.ray.origin, event.ray.direction)
    const feature = pickFeature(raycaster)
    if (feature) {
      setPicked({ text: feature })
      return
    }
    // the terrain: event.point is in world space, getLocation expects
    // terrain space; and back to the point exactly on the rendered surface
    const geo = map.getLocation(map.terrain.worldToLocal(event.point.clone()))
    const surface = map.getTerrainPositionSync(geo, { loadTile: false })
    if (surface) {
      setPicked({
        text: `${where(geo)} · ${Math.round(geo.alt)} m`,
        point: [surface.x, surface.y, surface.z]
      })
    }
  }

  // the terrain, imagery and layers as a 3D model file
  const download = async (format: ModelFormat) => {
    setSaving(format)
    try {
      const blob = await map.export(format)
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      const name =
        placeOf(area) ?? `terrain-${area.lat.toFixed(4)}-${area.lon.toFixed(4)}`
      link.download = `${name}-z${area.zoom}.${format}`
      link.click()
      URL.revokeObjectURL(link.href)
    } finally {
      setSaving(null)
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy the link', window.location.href)
    }
  }

  const closer = layersBelow(area.zoom).filter((name) =>
    view.layers.includes(name)
  )
  return (
    <>
      <Canvas className='scene' flat frameloop={picking ? 'never' : 'always'}>
        <color attach='background' args={[look.background]} />
        <fog attach='fog' args={[look.background, 2 * width, 5 * width]} />
        <ambientLight intensity={look.light.ambient} />
        <directionalLight
          intensity={look.light.sun}
          position={[-1e4, -4e3, 7e3]}
        />
        <PerspectiveCamera
          makeDefault
          position={[0, -0.8 * width, 0.7 * width]}
          fov={60}
          near={1}
          far={1e6}
          up={[0, 0, 1]}
        />
        <MapControls makeDefault maxPolarAngle={Math.PI * 0.42} />
        <Framing center={center} width={width} />
        <primitive object={map.terrain} onClick={onClick} />
        {picked?.point && (
          <mesh position={picked.point}>
            <sphereGeometry args={[width / 300, 24, 12]} />
            <meshBasicMaterial color={0xf0d040} />
          </mesh>
        )}
      </Canvas>

      {picking ? (
        <Suspense>
          <Picker area={area} onPick={onPick} onCancel={onCancel} />
        </Suspense>
      ) : (
        <>
          <aside className='panel'>
            <header>
              <h1>three-map-terrain</h1>
              <button
                type='button'
                className='fold'
                aria-expanded={!folded}
                onClick={() => setFolded(!folded)}
              >
                {folded ? 'Show' : 'Hide'}
              </button>
            </header>
            {!folded && (
              <>
                <p className='muted'>
                  Real-world 3D terrain for three.js, from map tiles: pick an
                  area, style it, export a model.
                </p>
                <Row label='Area'>
                  <Choice
                    label='Area'
                    options={Object.keys(PLACES) as PlaceName[]}
                    value={placeOf(area)}
                    name={(key) => PLACES[key].title}
                    onChange={(key) => setView(PLACES[key])}
                  />
                  <button
                    type='button'
                    className='primary'
                    onClick={() => setPicking(true)}
                  >
                    Pick on map…
                  </button>
                </Row>
                <p className='muted area'>
                  {where(area)} · zoom {area.zoom} · {area.columns} ×{' '}
                  {area.rows} tiles · {kilometers(area)} km
                </p>
                <Row label='Relief'>
                  <Choice
                    label='Relief'
                    options={EXAGGERATIONS}
                    value={String(exaggeration)}
                    name={(key) => `${key}×`}
                    onChange={(key) => update({ exaggeration: Number(key) })}
                  />
                </Row>
                <Row label='Look'>
                  <Choice
                    label='Look'
                    options={Object.keys(LOOKS) as LookName[]}
                    value={view.look}
                    onChange={(key) => update({ look: key })}
                  />
                </Row>
                {look.imagery && inSwitzerland(area) && (
                  <Row label='Photo'>
                    <Choice
                      label='Photo'
                      options={Object.keys(IMAGERY) as ImageryName[]}
                      value={view.imagery}
                      name={(key) => IMAGERY[key].title}
                      onChange={(key) => update({ imagery: key })}
                    />
                  </Row>
                )}
                <Row label='Layers'>
                  <div className='choice' role='group' aria-label='Layers'>
                    {LAYER_NAMES.map((name) => (
                      <button
                        key={name}
                        type='button'
                        aria-pressed={view.layers.includes(name)}
                        className={closer.includes(name) ? 'faint' : undefined}
                        onClick={() =>
                          // this one switched, the others as they are
                          update({
                            layers: LAYER_NAMES.filter(
                              (other) =>
                                (other === name) !== view.layers.includes(other)
                            )
                          })
                        }
                      >
                        {capitalize(name)}
                      </button>
                    ))}
                  </div>
                </Row>
                {closer.length > 0 && (
                  <p className='muted'>
                    Not at this zoom:{' '}
                    {closer
                      .map((name) => `${name} from ${minZoom(LAYERS[name])}`)
                      .join(', ')}
                    .
                  </p>
                )}
                <Row label='Export'>
                  <div className='choice'>
                    {FORMATS.map((format) => (
                      <button
                        key={format}
                        type='button'
                        className='format'
                        disabled={!ready || saving !== null}
                        onClick={() => void download(format)}
                      >
                        {saving === format ? '…' : format}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row label='Share'>
                  <button type='button' onClick={() => void copyLink()}>
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                </Row>
                <p className='status' role='status'>
                  {!ready
                    ? 'Loading the terrain…'
                    : (picked?.text ?? 'Click the terrain or anything on it.')}
                </p>
                <p className='muted'>Drag to pan, right-drag to rotate.</p>
                <nav>
                  <a href='https://github.com/whidrubeld/three-map-terrain'>
                    GitHub
                  </a>
                  <a href='https://www.npmjs.com/package/three-map-terrain'>
                    npm
                  </a>
                  <a href='https://whidrubeld.github.io/gpx-terrain/'>
                    GPX Terrain — the showcase
                  </a>
                </nav>
              </>
            )}
          </aside>

          {/* the credits every data source asks for */}
          <footer className='attribution'>{credits.join(' · ')}</footer>
        </>
      )}
    </>
  )
}

/**
 * Points the camera at the grid's middle from the south, as far as it is
 * wide — farther on a portrait screen.
 */
function Framing({ center, width }: { center: Point | null; width: number }) {
  const camera = useThree((state) => state.camera) as Camera
  const controls = useThree((state) => state.controls) as unknown as {
    target: Vector3
    update(): void
  } | null
  useEffect(() => {
    if (!center || !controls) return
    const [x, y, z] = center
    const distance = width * Math.max(1, 1 / camera.aspect)
    controls.target.set(x, y, z)
    camera.position.set(x, y - 0.8 * distance, z + 0.7 * distance)
    controls.update()
  }, [center, width, camera, controls])
  return null
}

interface Described {
  kind?: string
  height?: number
  bridge?: boolean
  properties: Record<string, unknown>
}

const SINGULAR: Record<LayerName, string> = {
  buildings: 'building',
  roads: 'road',
  water: 'water',
  trees: 'trees',
  base: 'base'
}

/**
 * The nearest feature under a ray, highlighted (the others not), described.
 * Draped layers lie on the terrain and on each other: a hit within a unit
 * of the nearest goes to the first of buildings, trees, roads, water.
 */
function pickFeature(raycaster: Raycaster): string | undefined {
  const { buildings, trees, roads, water } = LAYERS
  const candidates = [
    candidate('buildings', buildings, raycaster),
    candidate('trees', trees, raycaster),
    candidate('roads', roads, raycaster),
    candidate('water', water, raycaster)
  ]
  const nearest = Math.min(...candidates.map(({ distance }) => distance))
  const chosen = candidates.find(
    ({ hit, distance }) => hit && distance <= nearest + 1
  )
  for (const each of candidates) each.highlight(each === chosen)
  if (!chosen?.hit) return undefined
  const { feature } = chosen.hit
  const { kind, height, bridge, properties } = feature
  const name = typeof properties.name === 'string' ? `${properties.name}, ` : ''
  const high =
    chosen.name === 'buildings' && height !== undefined
      ? `, ${Math.round(height)} m high`
      : ''
  return `${name}${kind ?? SINGULAR[chosen.name]}${bridge ? ' bridge' : ''}${high} · ${where(chosen.hit)} · ${Math.round(chosen.hit.alt)} m`
}

interface Candidate {
  name: LayerName
  hit: FeatureHit<Described> | undefined
  distance: number
  highlight: (on: boolean) => void
}

function candidate<F extends Described>(
  name: LayerName,
  layer: FeatureLayer<F>,
  raycaster: Raycaster
): Candidate {
  // none on a layer switched off
  const hit = layer.pick(raycaster)
  return {
    name,
    hit,
    distance: hit?.point.distanceTo(raycaster.ray.origin) ?? Infinity,
    highlight: (on) => layer.highlight(on ? hit?.feature : undefined)
  }
}

const capitalize = (key: string) => key.charAt(0).toUpperCase() + key.slice(1)

const where = ({ lat, lon }: { lat: number; lon: number }) =>
  `${lat.toFixed(5)}, ${lon.toFixed(5)}`

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='row'>
      <span className='label'>{label}</span>
      <div className='controls'>{children}</div>
    </div>
  )
}

function Choice<T extends string>({
  label,
  options,
  value,
  name = capitalize,
  onChange
}: {
  label: string
  options: readonly T[]
  value: T | undefined
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
