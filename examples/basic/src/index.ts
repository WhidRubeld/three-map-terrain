import './index.css'

import {
  AmbientLight,
  Color,
  DirectionalLight,
  FogExp2,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  WebGLRenderer
} from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import {
  Buildings,
  type ImageryProcessor,
  Map,
  type ModelFormat,
  Roads,
  TerrainBase
} from 'three-map-terrain'

import { overture } from './overture'

// scene
const scene = new Scene()
scene.background = new Color(0x1c1d1f)
scene.fog = new FogExp2(0x1c1d1f, 0.00012)

const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 1, 1e6)
camera.up.set(0, 0, 1)
camera.position.set(-700, -1100, 700)

const renderer = new WebGLRenderer({ antialias: true })
renderer.setPixelRatio(devicePixelRatio)
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)

const controls = new MapControls(camera, renderer.domElement)
controls.autoRotate = true
controls.autoRotateSpeed = 0.6
controls.maxPolarAngle = Math.PI * 0.42

scene.add(new AmbientLight(0xffffff, 1.2))
const sun = new DirectionalLight(0xffffff, 2.8)
sun.position.set(-1e4, -6e3, 1e4)
scene.add(sun)

// the map's pixels toned down to the buildings: gray, softer, brighter
const tone: ImageryProcessor = (context, { width, height }) => {
  const image = context.getImageData(0, 0, width, height)
  const { data } = image
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    data[i] = data[i + 1] = data[i + 2] = ((luma - 128) * 0.8 + 128) * 1.12
  }
  context.putImageData(image, 0, 0)
}

// San Francisco at zoom 15, true to scale: the OpenStreetMap map in the
// buildings' tone, AWS elevation (the default), Overture buildings from a
// custom source, OpenFreeMap roads with the freeways' bridges, and a base
// that makes the terrain a solid block
const location = { lat: 37.7955, lon: -122.403 }
const map = new Map({
  source: { api: 'osm' },
  location,
  options: { zoom: 15, exaggeration: 1 },
  material: { color: '#f4f4f4', process: tone }
})
const buildings = map.addLayer(new Buildings({ source: overture, edges: true }))
map.addLayer(new Roads({ source: { api: 'openfreemap' } }))
map.addLayer(new TerrainBase())
scene.add(map.terrain)

const status = document.querySelector<HTMLElement>('#status')
const show = (text: string) => {
  if (status) status.textContent = text
}
const credits = document.querySelector<HTMLElement>('#credits')
if (credits) credits.textContent = map.attributions.join(' · ')

void map.init(() => {
  show('Click a building or the terrain.')
})

// a geolocation at an altitude: a drone at 300 m above the center
const drone = new Mesh(
  new SphereGeometry(6, 24, 12),
  new MeshBasicMaterial({ color: 0xf04040 })
)
const { x, y, z } = map.getPosition(
  { ...location, alt: 300 },
  { loadTile: false }
)
drone.position.set(x, y, z)
scene.add(drone)

// click → the building under the pointer, highlighted; or the geolocation
// of the terrain
const raycaster = new Raycaster()
const pressed = new Vector2()
renderer.domElement.addEventListener('pointerdown', (event) => {
  pressed.set(event.clientX, event.clientY)
})
renderer.domElement.addEventListener('click', (event) => {
  // a drag of the map is not a click
  if (pressed.distanceTo(new Vector2(event.clientX, event.clientY)) > 4) return
  controls.autoRotate = false
  const pointer = new Vector2(
    (event.clientX / innerWidth) * 2 - 1,
    -(event.clientY / innerHeight) * 2 + 1
  )
  raycaster.setFromCamera(pointer, camera)

  const building = buildings.pick(raycaster)
  buildings.highlight(building?.feature)
  if (building) {
    const { height, properties } = building.feature
    const name =
      typeof properties['@name'] === 'string' ? properties['@name'] : 'Building'
    show(
      `${name}${height === undefined ? '' : `, ${Math.round(height)} m high`}`
    )
    return
  }
  const hit = map.pick(raycaster)
  if (hit) {
    show(
      `${hit.lat.toFixed(5)}, ${hit.lon.toFixed(5)} · ${Math.round(hit.alt)} m`
    )
  }
})

// the terrain with its imagery, buildings and base as a 3D model file
for (const button of document.querySelectorAll<HTMLButtonElement>(
  '[data-format]'
)) {
  button.addEventListener('click', () => {
    const format = button.dataset.format as ModelFormat
    button.disabled = true
    void map
      .export(format)
      .then((blob) => {
        const link = document.createElement('a')
        link.href = URL.createObjectURL(blob)
        link.download = `san-francisco.${format}`
        link.click()
        URL.revokeObjectURL(link.href)
      })
      .finally(() => {
        button.disabled = false
      })
  })
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

renderer.setAnimationLoop(() => {
  controls.update()
  renderer.render(scene, camera)
})
