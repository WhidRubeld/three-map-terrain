import { useFrame, useThree } from '@react-three/fiber'
import { useSelector } from '@tanstack/react-store'
import { useEffect, useMemo, useRef } from 'react'
import {
  Box3,
  MathUtils,
  type Mesh,
  type PerspectiveCamera,
  Vector3
} from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import type { Map } from 'three-map-terrain'

import { indexAtProgress } from '../gpx/track'
import { settingsStore } from '../state/settings'
import {
  commands,
  type Drape,
  type FocusTarget,
  type Insets,
  playbackStore,
  terrainStore,
  uiStore,
  viewerStore
} from '../state/viewer'
import { lineAt, surfacePoint } from './drape'
import { easeInOutCubic, INTRO } from './look'
import { sceneRefs } from './refs'

interface Pose {
  position: Vector3
  target: Vector3
}

interface Flight {
  from: Pose
  to: Pose
  start: number
  duration: number
}

/** Preferred view: from the south-south-west, 50° above the horizon. */
const AZIMUTH = MathUtils.degToRad(-18)
const ELEVATION = MathUtils.degToRad(50)
const AZIMUTHS = 12

const viewDirection = (azimuth: number) =>
  new Vector3(
    Math.sin(azimuth) * Math.cos(ELEVATION),
    -Math.cos(azimuth) * Math.cos(ELEVATION),
    Math.sin(ELEVATION)
  )

/** Terrain height (scene units, before exaggeration) at terrain coordinates. */
function heightAt(map: Map, x: number, y: number) {
  const { lat, lon } = map.getLocation({ x, y, z: 0 })
  return map.getTerrainPositionSync({ lat, lon }, { loadTile: false })?.z
}

/**
 * The azimuth from which the relief hides the least of the route: for each
 * candidate, how far the terrain rises above the line of sight from the
 * route's start, middle and end towards the camera. Ties go to `AZIMUTH`.
 */
function clearAzimuth(
  map: Map,
  targets: Vector3[],
  reach: number,
  exaggeration: number
) {
  const slope = Math.tan(ELEVATION)
  let best = AZIMUTH
  let bestScore = Infinity
  for (let i = 0; i < AZIMUTHS; i++) {
    const turn = i <= AZIMUTHS / 2 ? i : i - AZIMUTHS
    const azimuth = AZIMUTH + (turn * 2 * Math.PI) / AZIMUTHS
    const dx = Math.sin(azimuth)
    const dy = -Math.cos(azimuth)
    let hidden = 0
    for (const target of targets) {
      for (let k = 1; k <= 10; k++) {
        const r = (reach * k) / 10
        const ground = heightAt(map, target.x + dx * r, target.y + dy * r)
        if (ground !== undefined)
          hidden += Math.max(0, ground * exaggeration - (target.z + r * slope))
      }
    }
    const score = hidden + Math.abs(turn) * reach * 0.02
    if (score < bestScore) {
      bestScore = score
      best = azimuth
    }
  }
  return best
}

/** Fraction of the free area (per side) kept clear around the route… */
const MARGIN = 0.2
/** …but at least this many CSS px, for the labels around the points. */
const MARGIN_X = 100
const MARGIN_Y = 36

/**
 * Distance along `direction` from which every sample projects into the part
 * of the canvas the panels leave free. The camera's view offset already puts
 * `center` in the middle of that part; the distance is refined by projecting.
 */
function fitDistance(
  camera: PerspectiveCamera,
  center: Vector3,
  direction: Vector3,
  samples: Vector3[],
  insets: Insets,
  initial: number
) {
  // the free area in normalized device coordinates
  const width = camera.view?.fullWidth ?? Infinity
  const height = camera.view?.fullHeight ?? Infinity
  const free = {
    x0: -1 + (2 * insets.left) / width,
    x1: 1 - (2 * insets.right) / width,
    y0: -1 + (2 * insets.bottom) / height,
    y1: 1 - (2 * insets.top) / height
  }
  const cx = (free.x0 + free.x1) / 2
  const cy = (free.y0 + free.y1) / 2
  const halfX = (free.x1 - free.x0) / 2
  const halfY = (free.y1 - free.y0) / 2
  const hx = Math.max(
    halfX * 0.25,
    halfX - Math.max(halfX * MARGIN, (2 * MARGIN_X) / width)
  )
  const hy = Math.max(
    halfY * 0.25,
    halfY - Math.max(halfY * MARGIN, (2 * MARGIN_Y) / height)
  )

  const probe = camera.clone()
  const projected = new Vector3()
  let distance = initial
  for (let i = 0; i < 8; i++) {
    probe.position.copy(center).addScaledVector(direction, distance)
    probe.lookAt(center)
    probe.updateMatrixWorld()
    let ratio = 0
    for (const sample of samples) {
      projected.copy(sample).project(probe)
      if (projected.z > 1) ratio = Math.max(ratio, 2)
      else
        ratio = Math.max(
          ratio,
          Math.abs(projected.x - cx) / hx,
          Math.abs(projected.y - cy) / hy
        )
    }
    if (!Number.isFinite(ratio) || ratio === 0) break
    distance *= ratio
    if (Math.abs(ratio - 1) < 0.02) break
  }
  return distance
}

/**
 * A pose that frames the whole route in the free part of the canvas, from
 * the side the relief hides it the least. Uses the final exaggeration, not
 * the current `world.scale.z`: during the intro the terrain is still rising.
 */
function routePose(
  camera: PerspectiveCamera,
  drape: Drape,
  map: Map | null
): Pose {
  const { exaggeration } = settingsStore.state
  const box = new Box3()
  const p = drape.points
  const count = p.length / 3
  const stride = Math.max(1, Math.floor(count / 240))
  const samples: Vector3[] = []
  for (let i = 0; i < count; i += stride) {
    samples.push(
      new Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2] * exaggeration)
    )
  }
  samples.push(
    new Vector3(
      p[(count - 1) * 3],
      p[(count - 1) * 3 + 1],
      p[(count - 1) * 3 + 2] * exaggeration
    )
  )
  for (const sample of samples) box.expandByPoint(sample)

  const center = box.getCenter(new Vector3())
  const size = box.getSize(new Vector3())
  const initial = Math.max(size.x, size.y, size.z, 50) * 1.5
  // orbit around the ground, not a point in the air above it
  const ground = map ? heightAt(map, center.x, center.y) : undefined
  if (ground !== undefined) center.z = ground * exaggeration

  const targets = [samples[0], center, samples[samples.length - 1]]
  const azimuth = map
    ? clearAzimuth(map, targets, initial * Math.cos(ELEVATION), exaggeration)
    : AZIMUTH
  const direction = viewDirection(azimuth)
  const distance = fitDistance(
    camera,
    center,
    direction,
    samples,
    uiStore.state.insets,
    initial
  )
  return {
    target: center,
    position: center.clone().addScaledVector(direction, distance)
  }
}

/** Straight down onto the grid: where the intro starts while tiles load. */
function overheadPose(extent: number): Pose {
  const tilt = MathUtils.degToRad(8)
  const target = new Vector3()
  return {
    target,
    position: new Vector3(0, -Math.sin(tilt), Math.cos(tilt)).multiplyScalar(
      extent * 1.7
    )
  }
}

/**
 * Keeps the orbit center over the terrain: panning or zooming to the cursor
 * can otherwise carry it off the grid, and every rotation then swings the
 * map out of view. Returns the correction that was applied.
 */
function clampTarget(controls: MapControls, box: Box3, exaggeration: number) {
  const { target } = controls
  const clamped = new Vector3(
    MathUtils.clamp(target.x, box.min.x, box.max.x),
    MathUtils.clamp(target.y, box.min.y, box.max.y),
    MathUtils.clamp(
      target.z,
      box.min.z * exaggeration,
      box.max.z * exaggeration
    )
  )
  const correction = clamped.sub(target)
  if (correction.lengthSq() > 0) {
    target.add(correction)
    controls.object.position.add(correction)
  }
  return correction
}

/** Terrain-space bounds of the loaded tiles, recomputed when tiles are added. */
function useTerrainBox() {
  const cache = useRef<{ map: Map | null; count: number; box: Box3 }>({
    map: null,
    count: -1,
    box: new Box3()
  })
  return () => {
    const { map } = terrainStore.state
    if (!map) return null
    const count = map.terrain.children.length
    const entry = cache.current
    if (entry.map !== map || entry.count !== count) {
      entry.map = map
      entry.count = count
      entry.box.makeEmpty()
      for (const tile of map.terrain.children) {
        const mesh = tile as Mesh
        mesh.geometry.computeBoundingBox()
        const local = mesh.geometry.boundingBox
        if (local) entry.box.union(local.clone().translate(mesh.position))
      }
    }
    return entry.box.isEmpty() ? null : entry.box
  }
}

export function CameraRig() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const gl = useThree((s) => s.gl)
  const set = useThree((s) => s.set)
  const size = useThree((s) => s.size)
  const controlsRef = useRef<MapControls | null>(null)
  const flight = useRef<Flight | null>(null)
  const framed = useRef<unknown>(null)
  const fit = useSelector(terrainStore, (s) => s.fit)
  const drape = useSelector(terrainStore, (s) => s.drape)
  const terrainBox = useTerrainBox()

  // Created in an effect, never during render: the constructor attaches
  // pointer listeners, and a second instance from a discarded render
  // (StrictMode) would rotate the camera too, around its own target.
  useEffect(() => {
    const controls = new MapControls(camera, gl.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1
    controls.rotateSpeed = 0.6
    controls.panSpeed = 0.9
    controls.zoomSpeed = 0.9
    controls.zoomToCursor = true
    controls.minPolarAngle = MathUtils.degToRad(4)
    controls.maxPolarAngle = MathUtils.degToRad(82)
    controls.minDistance = 20
    controls.autoRotateSpeed = 0.5
    controls.keyPanSpeed = 16
    // arrow keys pan once the scene has focus (it takes focus on pointer down)
    controls.listenToKeyEvents(gl.domElement)
    const cancel = () => {
      flight.current = null
    }
    controls.addEventListener('start', cancel)
    controlsRef.current = controls
    sceneRefs.controls = controls
    set({ controls })
    return () => {
      controls.removeEventListener('start', cancel)
      controls.stopListenToKeyEvents()
      controls.dispose()
      controlsRef.current = null
      sceneRefs.controls = null
      set({ controls: null })
    }
  }, [camera, gl, set])

  // The optical center sits in the middle of the area the panels leave free.
  // It glides there when a panel or sheet opens instead of jumping.
  const center = useRef<{
    x: number
    y: number
    width: number
    height: number
  } | null>(null)
  const updateCenter = (delta: number) => {
    const { insets } = uiStore.state
    const { width, height } = size
    const x = (insets.left - insets.right) / 2
    const y = (insets.top - insets.bottom) / 2
    const current = center.current
    let next = { x, y, width, height }
    if (current && settingsStore.state.animations) {
      const k = 1 - Math.exp(-delta * 9)
      next = {
        x: current.x + (x - current.x) * k,
        y: current.y + (y - current.y) * k,
        width,
        height
      }
      if (Math.abs(next.x - x) < 0.25) next.x = x
      if (Math.abs(next.y - y) < 0.25) next.y = y
    }
    const changed =
      !current ||
      current.x !== next.x ||
      current.y !== next.y ||
      current.width !== width ||
      current.height !== height
    if (!changed) return
    center.current = next
    camera.setViewOffset(width, height, -next.x, -next.y, width, height)
    camera.updateProjectionMatrix()
  }

  const flyTo = (to: Pose, seconds: number) => {
    const controls = controlsRef.current
    if (!controls) return
    if (seconds <= 0 || !settingsStore.state.animations) {
      flight.current = null
      camera.position.copy(to.position)
      controls.target.copy(to.target)
      controls.update()
      return
    }
    flight.current = {
      from: {
        position: camera.position.clone(),
        target: controls.target.clone()
      },
      to,
      start: performance.now(),
      duration: seconds * 1000
    }
  }

  // a new grid: clip planes, zoom limits, and the start of the intro
  useEffect(() => {
    const controls = controlsRef.current
    if (!fit || !controls) return
    const extent = fit.tileSize * fit.nTiles
    camera.near = Math.max(0.5, extent / 4000)
    camera.far = extent * 30
    camera.updateProjectionMatrix()
    controls.maxDistance = extent * 3
    if (settingsStore.state.animations) flyTo(overheadPose(extent), 0)
  }, [fit?.key])

  // a new route on the terrain: fly to it (once per track, not per re-drape)
  useEffect(() => {
    const track = viewerStore.state.track
    if (!drape || !track || framed.current === track.points) return
    framed.current = track.points
    flyTo(routePose(camera, drape, terrainStore.state.map), INTRO.camera[1])
  }, [drape])

  useEffect(() => {
    const reset = () => {
      const current = terrainStore.state.drape
      if (current)
        flyTo(routePose(camera, current, terrainStore.state.map), 1.2)
    }
    const focus = (event: Event) => {
      const target = (event as CustomEvent<FocusTarget>).detail
      const { map } = terrainStore.state
      const world = sceneRefs.world
      const controls = controlsRef.current
      if (!target || !map || !world || !controls) return
      const local = surfacePoint(map, target.lat, target.lon)
      const point = world.localToWorld(new Vector3(local.x, local.y, local.z))
      const offset = camera.position.clone().sub(controls.target)
      const distance = Math.min(offset.length(), map.options.tileSize * 0.9)
      flyTo(
        {
          target: point,
          position: point.clone().addScaledVector(offset.normalize(), distance)
        },
        1
      )
    }
    commands.addEventListener('reset-view', reset)
    commands.addEventListener('focus', focus)
    return () => {
      commands.removeEventListener('reset-view', reset)
      commands.removeEventListener('focus', focus)
    }
  })

  const followed = useMemo(() => new Vector3(), [])
  useFrame((_, delta) => {
    updateCenter(delta)
    const controls = controlsRef.current
    if (!controls) return
    const settings = settingsStore.state
    const current = flight.current
    if (current) {
      const t = Math.min(
        1,
        (performance.now() - current.start) / current.duration
      )
      const k = easeInOutCubic(t)
      camera.position.lerpVectors(current.from.position, current.to.position, k)
      controls.target.lerpVectors(current.from.target, current.to.target, k)
      if (t >= 1) flight.current = null
    } else if (settings.follow && playbackStore.state.playing) {
      // keep the playhead centered: move target and camera together
      const track = viewerStore.state.track
      const route = terrainStore.state.drape
      const world = sceneRefs.world
      if (track && route && world) {
        lineAt(
          route,
          indexAtProgress(track, playbackStore.state.progress),
          followed
        )
        world.localToWorld(followed)
        const shift = followed
          .sub(controls.target)
          .multiplyScalar(1 - Math.exp(-delta * 3))
        controls.target.add(shift)
        camera.position.add(shift)
      }
    }
    controls.autoRotate = settings.autoRotate && !current
    controls.update(delta)
    const box = terrainBox()
    if (box && !current) clampTarget(controls, box, settings.exaggeration)
  })

  return null
}
