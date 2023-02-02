import './index.css'
import {
  Scene,
  GridHelper,
  PerspectiveCamera,
  Vector3,
  WebGLRenderer,
  AxesHelper,
  LinearEncoding,
  PCFSoftShadowMap,
  AmbientLight,
  DirectionalLight,
  Color,
  FogExp2,
  SphereGeometry,
  MeshBasicMaterial,
  Mesh
} from 'three'
import { MapControls } from 'three/examples/jsm/controls/OrbitControls.js'

import { Map, Source } from 'three-geo-terrain'

// create the scene
const scene = new Scene()
const camera = new PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  1,
  1e6
)

camera.up = new Vector3(0, 0, 1)
camera.position.set(0, -1e3, 7e2)
// camera.rollAngle = 0
camera.updateMatrixWorld()
camera.updateProjectionMatrix()

const renderer = new WebGLRenderer({
  antialias: true,
  alpha: true,
  logarithmicDepthBuffer: false
})

renderer.outputEncoding = LinearEncoding
renderer.shadowMap.enabled = true
// renderer.shadowMap.bias = 0.001
renderer.shadowMap.type = PCFSoftShadowMap
renderer.shadowMap.autoUpdate = true
renderer.physicallyCorrectLights = true
renderer.setSize(window.innerWidth, window.innerHeight)

const controls = new MapControls(camera, renderer.domElement)
controls.autoRotate = true
controls.maxPolarAngle = Math.PI * 0.3

const axisHelper = new AxesHelper(2e3)

const gridHelper = new GridHelper(3e3, 20, 'white')
gridHelper.rotateX(Math.PI / 2)

const ambientLight = new AmbientLight(0x404040, 2.5) // soft white light
const dirLight = new DirectionalLight(0xffffff, 3.5)
dirLight.castShadow = true
dirLight.position.set(1e4, 1e4, 1e4)

scene.add(axisHelper)
scene.add(ambientLight)
scene.add(dirLight)
scene.add(gridHelper)

scene.background = new Color(0x222222)
scene.fog = new FogExp2(0x222222, 0.0000001)

const source = new Source({ api: 'eox' })
const map = new Map({
  source: source,
  // location: [27.986065, 86.922623],
  location: [45.916216, 6.860973]
})
scene.add(map.terrain)
map.init()

// add object by coords
const geometry = new SphereGeometry(8, 24, 12)
const material = new MeshBasicMaterial({ color: 0xf04040 })
const sphere = new Mesh(geometry, material)
const spherePosition = map.getPosition({
  lat: 45.916216,
  lon: 6.860973,
  alt: 1027
})
sphere.position.set(spherePosition.x, spherePosition.y, spherePosition.z + 8)
scene.add(sphere)

document.body.appendChild(renderer.domElement)

function mainLoop(): void {
  requestAnimationFrame(mainLoop)
  renderer.render(scene, camera)
  controls.update()
}

mainLoop()
