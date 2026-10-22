import {
  AmbientLight,
  AxesHelper,
  Color,
  DirectionalLight,
  FogExp2,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Raycaster,
  REVISION,
  Scene,
  SphereGeometry,
  Vector2,
  type Vector3,
  WebGLRenderer
} from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import type { WebGPURenderer } from 'three/webgpu'

import {
  type BuildingSourceProps,
  Buildings,
  type ElevationApi,
  type ElevationSourceProps,
  type ImageryProcessor,
  Map,
  type MapOptions,
  type RoadSourceProps,
  Roads,
  type SourceProps,
  type TreeSourceProps,
  Trees,
  Utils,
  Water,
  type WaterSourceProps
} from '../src'
import type { Playground } from './types'

const params = new URLSearchParams(window.location.search)
const rendererType = params.get('renderer') === 'webgpu' ? 'webgpu' : 'webgl'
const lights = params.get('lights') !== '0'
const wireframe = params.get('wireframe') === '1'
const api = params.get('api') ?? 'eox'
const elevationApi = (params.get('elevation') ?? 'aws') as ElevationApi
// openfreemap, versatiles, overpass, maptiler, mapbox, protomaps
const buildingsApi = params.get('buildings')
const roadsApi = params.get('roads')
const waterApi = params.get('water')
const treesApi = params.get('trees')
// for the presets that need one (mapbox, maptiler, protomaps)
const token = params.get('token') ?? ''
const nTiles = Number(params.get('nTiles') ?? 3)
// any rectangle of tiles instead: west,north,east,south in tiles from the
// location's tile, e.g. grid=0,-1,1,1 (2 × 3, the location in the west column)
const gridParam = params.get('grid')?.split(',').map(Number)
const tileSegments = Number(params.get('segments') ?? 100)
const imageryZoomOffset = Number(params.get('imageryZoomOffset') ?? 1)
// meters from the camera beyond which the layers hide their tiles
const maxDistance = params.has('maxDistance')
  ? Number(params.get('maxDistance'))
  : undefined
const topView = params.get('view') === 'top'
// meters the tiles' skirts hang down
const skirt = Number(params.get('skirt') ?? 0)
// levels of detail: the map is the middle tile of a ring this many zooms
// coarser — the ring's tile in 2^lod × 2^lod tiles
const lod = Number(params.get('lod') ?? 0)
// streaming: only the tiles within this many of the controls' target
const stream = params.has('stream') ? Number(params.get('stream')) : undefined
// WebGPURenderer with its WebGL2 backend (for software WebGPU adapters in CI)
const forceWebGL = params.get('forceWebGL') === '1'

// the Bernese Alps at zoom 11 by default; any other place or zoom is drawn
// true to scale
const location = {
  lat: Number(params.get('lat') ?? 46.57634),
  lon: Number(params.get('lon') ?? 7.9904)
}
const zoom = Number(params.get('zoom') ?? 11)
const alps = !params.has('lat') && !params.has('lon') && zoom === 11
const tileSize = 600
const home = Utils.position2tile(location.lat, location.lon, zoom)
const grid = gridParam && {
  minX: home.x + gridParam[0],
  minY: home.y + gridParam[1],
  maxX: home.x + gridParam[2],
  maxY: home.y + gridParam[3]
}

// a hex color without '#' (e.g. color=e9e4da); gray=1 tones the imagery
const color = params.has('color') ? `#${params.get('color') ?? ''}` : undefined
const gray = params.get('gray') === '1'
const edges = params.get('edges') === '1'

/** Imagery in grayscale (Rec. 709 luma), drawn on its stitched canvas. */
const grayscale: ImageryProcessor = (context, { width, height }) => {
  const pixels = context.getImageData(0, 0, width, height)
  const { data } = pixels
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    data[i] = data[i + 1] = data[i + 2] = luma
  }
  context.putImageData(pixels, 0, 0)
}

const imagery: SourceProps =
  api === 'none' || api === 'osm'
    ? { api }
    : api === 'swisstopo'
      ? {
          url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
          maxZoom: 20,
          attribution: '© swisstopo'
        }
      : { api: 'eox' }

async function createRenderer(): Promise<{
  renderer: WebGLRenderer | WebGPURenderer
  backend: string
}> {
  if (rendererType === 'webgpu') {
    const { WebGPURenderer } = await import('three/webgpu')
    const renderer = new WebGPURenderer({ antialias: true, forceWebGL })
    await renderer.init()
    const isWebGPU = 'isWebGPUBackend' in renderer.backend
    return {
      renderer,
      backend: isWebGPU ? 'webgpu' : 'webgpu (webgl2 backend)'
    }
  }
  return { renderer: new WebGLRenderer({ antialias: true }), backend: 'webgl' }
}

const { renderer, backend } = await createRenderer()
renderer.setPixelRatio(window.devicePixelRatio)
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

// scene
const scene = new Scene()
scene.background = new Color(0x222222)
if (!topView) scene.fog = new FogExp2(0x222222, 0.0002)

scene.add(new AmbientLight(0xffffff, 1.5))
const sun = new DirectionalLight(0xffffff, 2.5)
sun.position.set(1e4, 1e4, 1e4)
scene.add(sun)

// map
const createMap = (zoom: number, nTiles: number, grid?: MapOptions['grid']) =>
  new Map({
    source: imagery,
    elevation: { api: elevationApi, token } as ElevationSourceProps,
    location,
    options: {
      nTiles,
      grid,
      tileSegments,
      imageryZoomOffset,
      zoom,
      tileSize,
      ...(alps
        ? {}
        : { exaggeration: Number(params.get('exaggeration') ?? 1) }),
      baseAltitude: Number(params.get('base') ?? 0),
      skirt
    },
    material: {
      lights,
      wireframe,
      ...(color ? { color } : {}),
      ...(gray ? { process: grayscale } : {})
    }
  })
const map = createMap(zoom, lod > 0 ? 0 : nTiles, grid)
// the coarser ring around the map: its tiles but the middle one
const ring = lod > 0 ? createMap(zoom - lod, 0) : undefined
const buildings = buildingsApi
  ? map.addLayer(
      new Buildings({
        source: { api: buildingsApi, token } as BuildingSourceProps,
        edges,
        // the grid of init() is not the edge of a map that streams
        clip: stream === undefined,
        maxDistance
      })
    )
  : undefined
const roads = roadsApi
  ? map.addLayer(
      new Roads({
        source: { api: roadsApi, token } as RoadSourceProps,
        maxDistance
      })
    )
  : undefined
const water = waterApi
  ? map.addLayer(
      new Water({
        source: { api: waterApi, token } as WaterSourceProps,
        maxDistance
      })
    )
  : undefined
// clear of the water, roads and buildings shown
const trees = treesApi
  ? map.addLayer(
      new Trees({
        source: { api: treesApi, token } as TreeSourceProps,
        avoid: [water, roads, buildings].filter((layer) => layer !== undefined),
        maxDistance
      })
    )
  : undefined
scene.add(map.terrain)
if (ring) {
  scene.add(ring.terrain)
  ring.alignTo(map)
  const { x, y } = ring.center
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      if (i !== 0 || j !== 0) void ring.addTileSegment(x + i, y + j)
    }
  }
  const k = 2 ** lod
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) void map.addTileSegment(k * x + i, k * y + j)
  }
}
const ready = Promise.all([map.init(), ring?.whenReady()]).then(() => {
  console.info('Map is ready')
})

// yellow marker resting on the terrain surface
const groundMarker = new Mesh(
  new SphereGeometry(8, 24, 12),
  new MeshBasicMaterial({ color: 0xf0c040 })
)
groundMarker.visible = false
scene.add(groundMarker)

const placeOnGround = (ground: { x: number; y: number; z: number }) => {
  groundMarker.position.set(ground.x, ground.y, ground.z + 8)
  groundMarker.visible = true
}

// camera
const aspect = window.innerWidth / window.innerHeight
let camera: PerspectiveCamera | OrthographicCamera
let controls: MapControls | undefined
// the middle of the view: the grid's, or the location's tile
const middle = grid
  ? Utils.tile2position(
      zoom,
      (grid.minX + grid.maxX) / 2,
      (grid.minY + grid.maxY) / 2,
      map.center,
      tileSize
    )
  : { x: 0, y: 0, z: 0 }
const across = grid
  ? Math.max(grid.maxX - grid.minX, grid.maxY - grid.minY) + 1
  : nTiles

if (topView) {
  // Straight down, north up: used to verify the NW/NE/SW/SE texture layout
  const half = (map.options.tileSize * (ring ? 3 * 2 ** lod : across)) / 2
  camera = new OrthographicCamera(-half * aspect, half * aspect, half, -half)
  camera.position.set(middle.x, middle.y, 1e4)
  camera.far = 2e4
  camera.updateProjectionMatrix()
} else {
  camera = new PerspectiveCamera(60, aspect, 1, 1e6)
  camera.up.set(0, 0, 1)
  camera.position.set(middle.x, middle.y - 1.2e3, 9e2)
  controls = new MapControls(camera, renderer.domElement)
  controls.target.set(middle.x, middle.y, 0)
  controls.maxPolarAngle = Math.PI * 0.4

  scene.add(new AxesHelper(1e3))

  // look at the ground: true to scale, it is far above z = 0
  if (!alps) {
    const ground = grid ? map.getLocation(middle) : location
    void map.getTerrainPosition(ground).then(({ z }) => {
      controls?.target.setZ(z)
      camera.position.z += z
    })
  }

  // the Alps' markers lie outside the middle of a ring, or of a grid
  if (alps && !ring && !grid) {
    const marker = new Mesh(
      new SphereGeometry(8, 24, 12),
      new MeshBasicMaterial({ color: 0xf04040 })
    )
    const { x, y, z } = map.getPosition({ ...location, alt: 3e3 })
    marker.position.set(x, y, z + 8)
    scene.add(marker)

    // down in the Grindelwald valley until something is clicked
    void map
      .getTerrainPosition({ lat: 46.6242, lon: 8.0414 })
      .then(placeOnGround)
  }
}

// the tiles around the controls' target, the others removed
if (stream !== undefined && controls && !ring) {
  const follow = (target: Vector3) => {
    const local = map.terrain.worldToLocal(target.clone())
    const { lat, lon } = map.getLocation(local)
    const { x, y } = Utils.position2tile(lat, lon, map.options.zoom)
    for (const tile of Object.values(map.tileCache)) {
      if (Math.max(Math.abs(tile.x - x), Math.abs(tile.y - y)) > stream) {
        map.removeTileSegment(tile.x, tile.y)
      }
    }
    for (let i = -stream; i <= stream; i++) {
      for (let j = -stream; j <= stream; j++) {
        void map.addTileSegment(x + i, y + j)
      }
    }
  }
  const target = controls.target
  controls.addEventListener('change', () => {
    follow(target)
  })
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  if (camera instanceof PerspectiveCamera) {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  }
})

const frame = () => {
  controls?.update()
  renderer.render(scene, camera)
}
void renderer.setAnimationLoop(frame)

const info = document.querySelector('#info')
const status = [
  `r${REVISION}`,
  backend,
  `z${zoom}`,
  api,
  elevationApi,
  ...(buildingsApi
    ? [`buildings ${buildingsApi}${edges ? ' + edges' : ''}`]
    : []),
  ...(roadsApi ? [`roads ${roadsApi}`] : []),
  ...(waterApi ? [`water ${waterApi}`] : []),
  ...(treesApi ? [`trees ${treesApi}`] : []),
  ...(grid ? [`grid ${String(gridParam)}`] : []),
  ...(lod > 0 ? [`lod z${zoom}/z${zoom - lod}`] : []),
  ...(skirt > 0 ? [`skirt ${skirt} m`] : []),
  ...(stream !== undefined ? [`stream ${stream}`] : []),
  `lights ${lights ? 'on' : 'off'}`,
  ...(wireframe ? ['wireframe'] : []),
  ...(color ? [color] : []),
  ...(gray ? ['gray'] : [])
].join(' · ')
if (info) info.textContent = `${status} · click the terrain`
const credits = document.querySelector('#credits')
const showCredits = () => {
  if (credits) credits.textContent = map.attributions.join(' · ')
}
showCredits()

// click → geolocation (pick) → marker on the surface (getTerrainPositionSync)
const raycaster = new Raycaster()
const pointer = new Vector2()
const pressed = new Vector2()
renderer.domElement.addEventListener('pointerdown', (event) => {
  pressed.set(event.clientX, event.clientY)
})
renderer.domElement.addEventListener('click', (event) => {
  if (pressed.distanceTo(new Vector2(event.clientX, event.clientY)) > 4) return
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  )
  raycaster.setFromCamera(pointer, camera)

  const building = buildings?.pick(raycaster)
  buildings?.highlight(building?.feature)
  playground.lastBuilding = building && {
    id: building.feature.id,
    height: building.feature.height,
    lat: building.lat,
    lon: building.lon
  }
  if (building) {
    roads?.highlight()
    if (info) {
      const height = building.feature.height
      info.textContent = `${status} · building ${String(building.feature.id ?? '')} · ${height === undefined ? '?' : Math.round(height)} m`
    }
    return
  }

  const road = roads?.pick(raycaster)
  roads?.highlight(road?.feature)
  playground.lastRoad = road && {
    id: road.feature.id,
    kind: road.feature.kind,
    bridge: road.feature.bridge === true,
    lat: road.lat,
    lon: road.lon
  }
  if (road) {
    if (info) {
      const { kind, bridge, id } = road.feature
      info.textContent = `${status} · ${kind}${bridge ? ' bridge' : ''} ${String(id ?? '')}`
    }
    return
  }

  const hit = map.pick(raycaster) ?? ring?.pick(raycaster)
  playground.lastPick = hit && { lat: hit.lat, lon: hit.lon, alt: hit.alt }
  if (!hit) return

  // in the map's tiles only: none of its own in the ring
  const ground = map.getTerrainPositionSync(hit, { loadTile: !ring })
  if (ground) placeOnGround(ground)
  if (info) {
    info.textContent = `${status} · ${hit.lat.toFixed(5)}, ${hit.lon.toFixed(5)} · ${Math.round(hit.alt)} m`
  }
})

const playground: Playground = {
  map,
  ring,
  buildings,
  roads,
  water,
  trees,
  renderer,
  camera,
  controls,
  revision: REVISION,
  backend,
  ready,
  lastPick: undefined,
  lastBuilding: undefined,
  lastRoad: undefined,
  // tiles past the placeholder: textured, or plain without imagery
  texturedTiles: () =>
    Object.values(map.tileCache).filter(
      ({ mesh }) =>
        'map' in mesh.material &&
        (mesh.material.map !== null || map.source.api === 'none')
    ).length,
  freeze: async () => {
    await renderer.setAnimationLoop(null)
    frame()
    // two frames: the last render has been presented
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  }
}
window.__playground = playground
