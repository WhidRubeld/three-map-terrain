import './index.css'

import {
  AmbientLight,
  AxesHelper,
  Color,
  DirectionalLight,
  FogExp2,
  GridHelper,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer
} from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { Map, Source } from 'three-map-terrain'

// scene
const scene = new Scene()
scene.background = new Color(0x222222)
scene.fog = new FogExp2(0x222222, 0.0000001)

// camera
const camera = new PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  1,
  1e6
)
camera.up.set(0, 0, 1)
camera.position.set(0, -1e3, 7e2)

// WebGL
const renderer = new WebGLRenderer({ antialias: true, alpha: true })
renderer.shadowMap.enabled = true
renderer.setPixelRatio(window.devicePixelRatio)
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

// controls
const controls = new MapControls(camera, renderer.domElement)
controls.autoRotate = true
controls.maxPolarAngle = Math.PI * 0.3

// axis
scene.add(new AxesHelper(2e3))

// grid
const gridHelper = new GridHelper(3e3, 20, 'white')
gridHelper.rotateX(Math.PI / 2)
scene.add(gridHelper)

// light
const ambientLight = new AmbientLight(0xffffff, 1.5)
const dirLight = new DirectionalLight(0xffffff, 2.5)
dirLight.castShadow = true
dirLight.position.set(1e4, 1e4, 1e4)
scene.add(ambientLight, dirLight)

// map
const source = new Source({ api: 'eox' })
const location = { lat: 46.57634, lon: 7.9904 }
const map = new Map({ source, location })

scene.add(map.terrain)
void map.init(() => {
  console.log('Map is ready')
})

// object by coords
const sphere = new Mesh(
  new SphereGeometry(8, 24, 12),
  new MeshBasicMaterial({ color: 0xf04040 })
)
const spherePosition = map.getPosition({ ...location, alt: 3e3 })
// with sphere radius offset
sphere.position.set(spherePosition.x, spherePosition.y, spherePosition.z + 8)
scene.add(sphere)

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

renderer.setAnimationLoop(() => {
  controls.update()
  renderer.render(scene, camera)
})
