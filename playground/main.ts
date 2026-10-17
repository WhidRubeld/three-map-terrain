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
  REVISION,
  Scene,
  SphereGeometry,
  WebGLRenderer
} from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import type { WebGPURenderer } from 'three/webgpu'

import { Map, Source } from '../src'
import type { Playground } from './types'

const params = new URLSearchParams(window.location.search)
const rendererType = params.get('renderer') === 'webgpu' ? 'webgpu' : 'webgl'
const lights = params.get('lights') !== '0'
const api = params.get('api') === 'osm' ? 'osm' : 'eox'
const nTiles = Number(params.get('nTiles') ?? 3)
const topView = params.get('view') === 'top'

const location = { lat: 46.57634, lon: 7.9904 }

async function createRenderer(): Promise<{
  renderer: WebGLRenderer | WebGPURenderer
  backend: string
}> {
  if (rendererType === 'webgpu') {
    const { WebGPURenderer } = await import('three/webgpu')
    const renderer = new WebGPURenderer({ antialias: true })
    await renderer.init()
    const isWebGPU = 'isWebGPUBackend' in renderer.backend
    return {
      renderer,
      backend: isWebGPU ? 'webgpu' : 'webgpu (webgl2 fallback)'
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
const map = new Map({
  source: new Source({ api }),
  location,
  options: { nTiles },
  material: { lights }
})
scene.add(map.terrain)
const ready = map.init(() => {
  console.info('Map is ready')
})

// camera
const aspect = window.innerWidth / window.innerHeight
let camera: PerspectiveCamera | OrthographicCamera
let controls: MapControls | undefined

if (topView) {
  // Straight down, north up: used to verify the NW/NE/SW/SE texture layout
  const half = (map.options.tileSize * nTiles) / 2
  camera = new OrthographicCamera(-half * aspect, half * aspect, half, -half)
  camera.position.set(0, 0, 1e4)
  camera.far = 2e4
  camera.updateProjectionMatrix()
} else {
  camera = new PerspectiveCamera(60, aspect, 1, 1e6)
  camera.up.set(0, 0, 1)
  camera.position.set(0, -1.2e3, 9e2)
  controls = new MapControls(camera, renderer.domElement)
  controls.maxPolarAngle = Math.PI * 0.4

  scene.add(new AxesHelper(1e3))

  const marker = new Mesh(
    new SphereGeometry(8, 24, 12),
    new MeshBasicMaterial({ color: 0xf04040 })
  )
  const { x, y, z } = map.getPosition({ ...location, alt: 3e3 })
  marker.position.set(x, y, z + 8)
  scene.add(marker)
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  if (camera instanceof PerspectiveCamera) {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  }
})

void renderer.setAnimationLoop(() => {
  controls?.update()
  renderer.render(scene, camera)
})

const info = document.querySelector('#info')
if (info) {
  info.textContent = `r${REVISION} · ${backend} · ${api} · lights ${lights ? 'on' : 'off'}`
}

const playground: Playground = {
  map,
  revision: REVISION,
  backend,
  ready,
  texturedTiles: () =>
    Object.values(map.tileCache).filter(
      ({ mesh }) => 'map' in mesh.material && mesh.material.map !== null
    ).length
}
window.__playground = playground
