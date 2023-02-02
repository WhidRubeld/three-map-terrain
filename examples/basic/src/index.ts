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

import { Map, Source } from 'three-geo-map'

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
camera.up = new Vector3(0, 0, 1)
camera.position.set(0, -1e3, 7e2)
// camera.rollAngle = 0
camera.updateMatrixWorld()
camera.updateProjectionMatrix()

// WebGL
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

// controls
const controls = new MapControls(camera, renderer.domElement)
controls.autoRotate = true
controls.maxPolarAngle = Math.PI * 0.3

// axis
const axisHelper = new AxesHelper(2e3)
scene.add(axisHelper)

// grid
const gridHelper = new GridHelper(3e3, 20, 'white')
gridHelper.rotateX(Math.PI / 2)
scene.add(gridHelper)

// light
const ambientLight = new AmbientLight(0x404040, 2.5) // soft white light
const dirLight = new DirectionalLight(0xffffff, 3.5)
dirLight.castShadow = true
dirLight.position.set(1e4, 1e4, 1e4)
scene.add(ambientLight)
scene.add(dirLight)

// map
const source = new Source({ api: 'eox' })
const location = { lat: 45.916216, lon: 6.860973 }
const map = new Map({ source, location })

scene.add(map.terrain)
map.init()

// object by coords
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

//
document.body.appendChild(renderer.domElement)

function mainLoop(): void {
  requestAnimationFrame(mainLoop)
  renderer.render(scene, camera)
  controls.update()
}

mainLoop()
