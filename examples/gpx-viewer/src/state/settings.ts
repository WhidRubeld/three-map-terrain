import { createStore } from '@tanstack/react-store'

export type ThemeSetting = 'system' | 'dark' | 'light'
export type Imagery = 'color' | 'mono' | 'relief'
export type PanelId = 'track' | 'view' | 'legend' | 'perf' | 'profile'

export interface Settings {
  theme: ThemeSetting
  imagery: Imagery
  wireframe: boolean
  animations: boolean
  autoRotate: boolean
  fog: boolean
  graticule: boolean
  distanceMarks: boolean
  waypoints: boolean
  base: boolean
  follow: boolean
  /** vertical exaggeration, applied as `scale.z` (free, no reload) */
  exaggeration: number
  /** `MapOptions.tileSegments` (rebuilds the map) */
  segments: number
  /** `MapOptions.nTiles` (rebuilds the map) */
  tiles: number
  /** CSS pixels per rendered pixel: > 1 renders a chunky, pixelated scene */
  pixelSize: number
  panels: Record<PanelId, boolean>
}

export const SEGMENT_OPTIONS = [64, 128, 192] as const
export const TILE_OPTIONS = [3, 5] as const
export const PIXEL_OPTIONS = [1, 2, 3, 4] as const
export const IMAGERY_OPTIONS = ['color', 'mono', 'relief'] as const
export const EXAGGERATION = { min: 1, max: 3, step: 0.25 } as const

const STORAGE_KEY = 'three-map-terrain/gpx-viewer/settings@1'

const media = (query: string) =>
  typeof matchMedia === 'function' && matchMedia(query).matches

function defaults(): Settings {
  const compact = media('(max-width: 767px)')
  return {
    theme: 'system',
    imagery: 'color',
    wireframe: false,
    animations: !media('(prefers-reduced-motion: reduce)'),
    autoRotate: false,
    fog: true,
    graticule: true,
    distanceMarks: true,
    waypoints: true,
    base: true,
    follow: false,
    exaggeration: 1.25,
    segments: 128,
    tiles: 3,
    pixelSize: 1,
    panels: {
      track: !compact,
      view: !compact,
      legend: !compact,
      perf: !compact,
      profile: true
    }
  }
}

/** Stored values of the right type override the defaults; anything else is ignored. */
function load(): Settings {
  const base = defaults()
  try {
    const stored = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '{}'
    ) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(base)) {
      if (key === 'panels') continue
      if (typeof stored[key] === typeof value) merged[key] = stored[key]
    }
    const panels = stored.panels as Record<string, unknown> | undefined
    merged.panels = { ...base.panels }
    for (const id of Object.keys(base.panels) as PanelId[]) {
      if (typeof panels?.[id] === 'boolean')
        (merged.panels as Settings['panels'])[id] = panels[id]
    }
    const settings = merged as unknown as Settings
    if (!(SEGMENT_OPTIONS as readonly number[]).includes(settings.segments))
      settings.segments = base.segments
    if (!(TILE_OPTIONS as readonly number[]).includes(settings.tiles))
      settings.tiles = base.tiles
    if (!(PIXEL_OPTIONS as readonly number[]).includes(settings.pixelSize))
      settings.pixelSize = 1
    if (!(IMAGERY_OPTIONS as readonly string[]).includes(settings.imagery))
      settings.imagery = 'color'
    settings.exaggeration = Math.min(
      EXAGGERATION.max,
      Math.max(EXAGGERATION.min, settings.exaggeration)
    )
    return settings
  } catch {
    return base
  }
}

export const settingsStore = createStore<Settings>(load())

settingsStore.subscribe((settings) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // private mode or storage disabled: settings just are not remembered
  }
})

type BooleanKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never
}[keyof Settings]

export function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K]
) {
  settingsStore.setState((s) => (s[key] === value ? s : { ...s, [key]: value }))
}

export function toggleSetting(key: BooleanKey) {
  settingsStore.setState((s) => ({ ...s, [key]: !s[key] }))
}

export function togglePanel(id: PanelId, open?: boolean) {
  settingsStore.setState((s) => ({
    ...s,
    panels: { ...s.panels, [id]: open ?? !s.panels[id] }
  }))
}

/** Steps through a list of options, wrapping around. */
export function cycleSetting<K extends 'imagery' | 'pixelSize' | 'theme'>(
  key: K,
  options: readonly Settings[K][]
) {
  settingsStore.setState((s) => {
    const index = options.indexOf(s[key])
    return { ...s, [key]: options[(index + 1) % options.length] }
  })
}

export function nudgeExaggeration(direction: 1 | -1) {
  settingsStore.setState((s) => ({
    ...s,
    exaggeration: Math.min(
      EXAGGERATION.max,
      Math.max(EXAGGERATION.min, s.exaggeration + direction * EXAGGERATION.step)
    )
  }))
}
