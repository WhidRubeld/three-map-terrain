import { createStore } from '@tanstack/react-store'
import type { GeoLocation, Map } from 'three-map-terrain'

import { GpxError, parseGpx } from '../gpx/parse'
import { buildTrack, type Track } from '../gpx/track'
import type { TerrainFit } from '../lib/fit'

// ------------------------------------------------------------ track

export type TrackSource =
  | { kind: 'preset'; id: PresetId }
  | { kind: 'file'; name: string; size: number }

export interface ViewerState {
  source: TrackSource | null
  track: Track | null
  loading: boolean
  error: string | null
}

export const viewerStore = createStore<ViewerState>({
  source: null,
  track: null,
  loading: false,
  error: null
})

export const PRESETS = [
  {
    id: 'eiger-trail',
    name: 'Eiger Trail',
    region: 'CH · Bernese Oberland',
    activity: 'Hike'
  },
  {
    id: 'stelvio',
    name: 'Stelvio Pass',
    region: 'IT · South Tyrol',
    activity: 'Ride'
  },
  {
    id: 'bright-angel',
    name: 'Bright Angel',
    region: 'US · Grand Canyon',
    activity: 'Hike'
  }
] as const

export type PresetId = (typeof PRESETS)[number]['id']

export const isPresetId = (id: string | null): id is PresetId =>
  PRESETS.some((preset) => preset.id === id)

const MAX_FILE_SIZE = 64 * 1024 ** 2
let request = 0

function show(
  text: string,
  source: TrackSource,
  fallbackName: string,
  id: number
) {
  if (id !== request) return
  try {
    const track = buildTrack(parseGpx(text), fallbackName)
    viewerStore.setState(() => ({ source, track, loading: false, error: null }))
    hoverStore.setState(() => ({ index: null, waypoint: null, cursor: null }))
    playbackStore.setState((s) => ({ ...s, playing: false, progress: 1 }))
    const url = new URL(window.location.href)
    if (source.kind === 'preset') url.searchParams.set('track', source.id)
    else url.searchParams.delete('track')
    window.history.replaceState(null, '', url)
  } catch (error) {
    fail(error, id)
  }
}

function fail(error: unknown, id: number) {
  if (id !== request) return
  const message =
    error instanceof GpxError
      ? error.message
      : error instanceof Error
        ? `Could not load the track: ${error.message}`
        : 'Could not load the track.'
  viewerStore.setState((s) => ({ ...s, loading: false, error: message }))
}

export async function loadPreset(id: PresetId) {
  const current = ++request
  viewerStore.setState((s) => ({ ...s, loading: true, error: null }))
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}presets/${id}.gpx`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const preset = PRESETS.find((p) => p.id === id)
    show(
      await response.text(),
      { kind: 'preset', id },
      preset?.name ?? id,
      current
    )
  } catch (error) {
    fail(error, current)
  }
}

export async function loadFile(file: File) {
  const current = ++request
  if (file.size > MAX_FILE_SIZE) {
    fail(new GpxError('The file is larger than 64 MB.'), current)
    return
  }
  viewerStore.setState((s) => ({ ...s, loading: true, error: null }))
  try {
    const name = file.name.replace(/\.gpx$/i, '')
    show(
      await file.text(),
      { kind: 'file', name: file.name, size: file.size },
      name,
      current
    )
  } catch (error) {
    fail(error, current)
  }
}

export function dismissError() {
  viewerStore.setState((s) => ({ ...s, error: null }))
}

// ------------------------------------------------------------ terrain

export interface Drape {
  /** terrain-space position (x, y, z) of every track point, on the surface */
  points: Float32Array
  /** the rendered polyline: track points densified to the mesh resolution */
  line: Float32Array
  /** fractional track point index of every polyline vertex (non-decreasing) */
  lineIndex: Float32Array
}

export interface TerrainState {
  map: Map | null
  fit: TerrainFit | null
  /** the grid has loaded, or enough of it after a timeout (see `Terrain`) */
  ready: boolean
  /** `performance.now()` when the grid became ready: t = 0 of the intro */
  readyAt: number | null
  /** bumped whenever more terrain became ready: derived geometry is rebuilt */
  revision: number
  /** tiles with elevation / with their texture / in the grid */
  loaded: number
  textured: number
  total: number
  /** lowest and highest vertex, scene units (before exaggeration) */
  heights: { min: number; max: number } | null
  drape: Drape | null
}

export const terrainStore = createStore<TerrainState>({
  map: null,
  fit: null,
  ready: false,
  readyAt: null,
  revision: 0,
  loaded: 0,
  textured: 0,
  total: 0,
  heights: null,
  drape: null
})

// ------------------------------------------------------------ hover

export interface HoverState {
  /** fractional track point index under the pointer (scene or profile) */
  index: number | null
  /** waypoint under the pointer or keyboard focus */
  waypoint: number | null
  /** terrain under the pointer */
  cursor: GeoLocation | null
}

export const hoverStore = createStore<HoverState>({
  index: null,
  waypoint: null,
  cursor: null
})

export const setHoverIndex = (index: number | null) =>
  hoverStore.setState((s) => (s.index === index ? s : { ...s, index }))

export const setHoverWaypoint = (waypoint: number | null) =>
  hoverStore.setState((s) => (s.waypoint === waypoint ? s : { ...s, waypoint }))

// ------------------------------------------------------------ playback

/** Seconds to play the whole track at ×1. */
export const PLAYBACK_SECONDS = 40
export const SPEED_OPTIONS = [0.5, 1, 2, 4] as const

export interface PlaybackState {
  playing: boolean
  /** 0…1 of the track duration (of the distance without timestamps) */
  progress: number
  speed: number
}

export const playbackStore = createStore<PlaybackState>({
  playing: false,
  progress: 1,
  speed: 1
})

export function togglePlayback() {
  playbackStore.setState((s) =>
    s.playing
      ? { ...s, playing: false }
      : { ...s, playing: true, progress: s.progress >= 1 ? 0 : s.progress }
  )
}

export function restartPlayback() {
  playbackStore.setState((s) => ({ ...s, progress: 0, playing: true }))
}

export function seek(progress: number) {
  playbackStore.setState((s) => ({
    ...s,
    progress: Math.min(1, Math.max(0, progress))
  }))
}

export function setSpeed(speed: number) {
  playbackStore.setState((s) => ({ ...s, speed }))
}

// ------------------------------------------------------------ ui

export interface UiState {
  help: boolean
  /** first-visit hint with the basic controls */
  hint: boolean
  dragging: boolean
  /** resolved theme */
  theme: 'dark' | 'light'
  /** how far the panels cover the canvas from each side, CSS px */
  insets: Insets
  /** `compact`: phones and short screens, panels open one at a time as a sheet */
  layout: 'regular' | 'compact'
  sheet: SheetId | null
}

export type SheetId = 'track' | 'view' | 'legend' | 'perf'

/** Phones and short landscape screens get the compact layout. */
export const COMPACT_QUERY = '(max-width: 899px), (max-height: 559px)'

export function toggleSheet(sheet: SheetId) {
  uiStore.setState((s) => ({ ...s, sheet: s.sheet === sheet ? null : sheet }))
}

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

const HINT_KEY = 'three-map-terrain/gpx-viewer/hint-seen'

function hintSeen() {
  try {
    return localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return false
  }
}

export const uiStore = createStore<UiState>({
  help: false,
  hint: !hintSeen(),
  dragging: false,
  theme: 'dark',
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  layout:
    typeof matchMedia === 'function' && matchMedia(COMPACT_QUERY).matches
      ? 'compact'
      : 'regular',
  sheet: null
})

export function setHelp(help: boolean) {
  uiStore.setState((s) => ({ ...s, help }))
  if (help) dismissHint()
}

export function dismissHint() {
  uiStore.setState((s) => (s.hint ? { ...s, hint: false } : s))
  try {
    localStorage.setItem(HINT_KEY, '1')
  } catch {
    // not remembered
  }
}

// ------------------------------------------------------------ commands

/** One-off requests from the UI to the scene (camera moves, file dialog). */
export const commands = new EventTarget()

export type FocusTarget = { lat: number; lon: number } | null

export const resetView = () => commands.dispatchEvent(new Event('reset-view'))
export const requestFile = () => commands.dispatchEvent(new Event('open-file'))
export const focusOn = (target: FocusTarget) =>
  commands.dispatchEvent(
    new CustomEvent<FocusTarget>('focus', { detail: target })
  )
