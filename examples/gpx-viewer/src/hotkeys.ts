import {
  cycleSetting,
  IMAGERY_OPTIONS,
  nudgeExaggeration,
  PIXEL_OPTIONS,
  type ThemeSetting,
  toggleSetting,
  togglePanel
} from './state/settings'
import {
  loadPreset,
  PRESETS,
  playbackStore,
  requestFile,
  resetView,
  restartPlayback,
  seek,
  setHelp,
  type SheetId,
  togglePlayback,
  toggleSheet,
  uiStore
} from './state/viewer'

export interface Hotkey {
  /** `KeyboardEvent.code`s: physical keys, so any keyboard layout works */
  codes: readonly string[]
  /** shown in the help dialog */
  keys: readonly string[]
  label: string
  group: 'Playback' | 'View' | 'Layers' | 'Panels' | 'App'
  run: () => void
}

const THEMES: readonly ThemeSetting[] = ['system', 'dark', 'light']

/** Side panels on large screens, the bottom sheet on compact ones. */
const panel = (id: SheetId) => () => {
  if (uiStore.state.layout === 'compact') toggleSheet(id)
  else togglePanel(id)
}

const step = (direction: 1 | -1) => () => {
  playbackStore.setState((s) => ({ ...s, playing: false }))
  seek(playbackStore.state.progress + direction * 0.01)
}

export const HOTKEYS: readonly Hotkey[] = [
  {
    codes: ['Space'],
    keys: ['Space'],
    label: 'Play / pause',
    group: 'Playback',
    run: togglePlayback
  },
  {
    codes: ['Home'],
    keys: ['Home'],
    label: 'Restart',
    group: 'Playback',
    run: restartPlayback
  },
  {
    codes: ['Comma'],
    keys: [','],
    label: 'Step back 1 %',
    group: 'Playback',
    run: step(-1)
  },
  {
    codes: ['Period'],
    keys: ['.'],
    label: 'Step forward 1 %',
    group: 'Playback',
    run: step(1)
  },
  {
    codes: ['KeyF'],
    keys: ['F'],
    label: 'Camera follows playhead',
    group: 'Playback',
    run: () => toggleSetting('follow')
  },

  {
    codes: ['KeyR'],
    keys: ['R'],
    label: 'Frame the route',
    group: 'View',
    run: resetView
  },
  {
    codes: ['KeyS'],
    keys: ['S'],
    label: 'Auto-rotate',
    group: 'View',
    run: () => toggleSetting('autoRotate')
  },
  {
    codes: ['BracketLeft'],
    keys: ['['],
    label: 'Less exaggeration',
    group: 'View',
    run: () => nudgeExaggeration(-1)
  },
  {
    codes: ['BracketRight'],
    keys: [']'],
    label: 'More exaggeration',
    group: 'View',
    run: () => nudgeExaggeration(1)
  },
  {
    codes: ['KeyX'],
    keys: ['X'],
    label: 'Pixel size',
    group: 'View',
    run: () => cycleSetting('pixelSize', PIXEL_OPTIONS)
  },
  {
    codes: ['KeyA'],
    keys: ['A'],
    label: 'Animations',
    group: 'View',
    run: () => toggleSetting('animations')
  },
  {
    codes: ['KeyT'],
    keys: ['T'],
    label: 'Theme: system / dark / light',
    group: 'View',
    run: () => cycleSetting('theme', THEMES)
  },

  {
    codes: ['KeyI'],
    keys: ['I'],
    label: 'Imagery: color / mono / relief',
    group: 'Layers',
    run: () => cycleSetting('imagery', IMAGERY_OPTIONS)
  },
  {
    codes: ['KeyW'],
    keys: ['W'],
    label: 'Wireframe',
    group: 'Layers',
    run: () => toggleSetting('wireframe')
  },
  {
    codes: ['KeyG'],
    keys: ['G'],
    label: 'Coordinate grid',
    group: 'Layers',
    run: () => toggleSetting('graticule')
  },
  {
    codes: ['KeyK'],
    keys: ['K'],
    label: 'Distance marks',
    group: 'Layers',
    run: () => toggleSetting('distanceMarks')
  },
  {
    codes: ['KeyM'],
    keys: ['M'],
    label: 'Waypoints',
    group: 'Layers',
    run: () => toggleSetting('waypoints')
  },
  {
    codes: ['KeyB'],
    keys: ['B'],
    label: 'Terrain base',
    group: 'Layers',
    run: () => toggleSetting('base')
  },

  {
    codes: ['KeyD'],
    keys: ['D'],
    label: 'Track details',
    group: 'Panels',
    run: panel('track')
  },
  {
    codes: ['KeyV'],
    keys: ['V'],
    label: 'View settings',
    group: 'Panels',
    run: panel('view')
  },
  {
    codes: ['KeyL'],
    keys: ['L'],
    label: 'Legend',
    group: 'Panels',
    run: panel('legend')
  },
  {
    codes: ['KeyP'],
    keys: ['P'],
    label: 'Performance',
    group: 'Panels',
    run: panel('perf')
  },

  {
    codes: ['KeyO'],
    keys: ['O'],
    label: 'Open a GPX file',
    group: 'App',
    run: requestFile
  },
  {
    codes: ['Digit1', 'Digit2', 'Digit3'],
    keys: ['1', '2', '3'],
    label: 'Demo tracks',
    group: 'App',
    run: () => undefined
  },
  {
    codes: ['Slash', 'KeyH'],
    keys: ['?', 'H'],
    label: 'This help',
    group: 'App',
    run: () => setHelp(!uiStore.state.help)
  }
]

const TEXT_INPUT =
  'input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select, [contenteditable="true"]'
const ACTIVATES = 'button, a[href], input, label, summary'

/** Runs the hotkey of a key press; returns whether one ran. */
export function handleHotkey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey)
    return false
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest(TEXT_INPUT)) return false
  // Space and Enter keep activating the focused control
  if (
    (event.code === 'Space' || event.code === 'Enter') &&
    target?.closest(ACTIVATES)
  )
    return false

  const digit = /^Digit([1-9])$/.exec(event.code)
  if (digit) {
    const preset = PRESETS[Number(digit[1]) - 1]
    if (!preset) return false
    void loadPreset(preset.id)
    event.preventDefault()
    return true
  }

  const hotkey = HOTKEYS.find((h) => h.codes.includes(event.code))
  if (!hotkey) return false
  hotkey.run()
  event.preventDefault()
  return true
}
