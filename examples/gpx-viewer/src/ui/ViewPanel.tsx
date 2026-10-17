import { useSelector } from '@tanstack/react-store'

import {
  EXAGGERATION,
  type Imagery,
  IMAGERY_OPTIONS,
  PIXEL_OPTIONS,
  SEGMENT_OPTIONS,
  setSetting,
  settingsStore,
  TILE_OPTIONS
} from '../state/settings'
import { Panel, Segmented, Slider, Toggle } from './controls'

const IMAGERY_LABEL: Record<Imagery, string> = {
  color: 'Color',
  mono: 'Mono',
  relief: 'Relief'
}

const TOGGLES = [
  { key: 'wireframe', label: 'Wireframe', hotkey: 'W' },
  { key: 'graticule', label: 'Coordinate grid', hotkey: 'G' },
  { key: 'distanceMarks', label: 'Distance marks', hotkey: 'K' },
  { key: 'waypoints', label: 'Waypoints', hotkey: 'M' },
  { key: 'base', label: 'Terrain base', hotkey: 'B' },
  { key: 'fog', label: 'Fog' },
  { key: 'autoRotate', label: 'Auto-rotate', hotkey: 'S' },
  { key: 'follow', label: 'Follow playhead', hotkey: 'F' },
  { key: 'animations', label: 'Animations', hotkey: 'A' }
] as const

export function ViewPanel({ className }: { className?: string }) {
  return (
    <Panel
      id='view'
      index='02'
      title='View'
      icon='sliders'
      className={className}
    >
      <ViewBody />
    </Panel>
  )
}

export function ViewBody() {
  const settings = useSelector(settingsStore, (s) => s)
  return (
    <div className='grid gap-3'>
      <Segmented
        label='Imagery'
        hotkey='I'
        value={settings.imagery}
        options={IMAGERY_OPTIONS}
        format={(value) => IMAGERY_LABEL[value]}
        onChange={(value) => setSetting('imagery', value)}
      />
      <Slider
        label='Exaggeration'
        hotkey='[ ]'
        value={settings.exaggeration}
        display={`×${settings.exaggeration.toFixed(2)}`}
        {...EXAGGERATION}
        onChange={(value) => setSetting('exaggeration', value)}
      />
      <div className='grid'>
        {TOGGLES.map(({ key, label, ...rest }) => (
          <Toggle
            key={key}
            label={label}
            hotkey={'hotkey' in rest ? rest.hotkey : undefined}
            checked={settings[key]}
            onChange={(checked) => setSetting(key, checked)}
          />
        ))}
      </div>
      <Segmented
        label='Pixel size'
        hotkey='X'
        value={settings.pixelSize}
        options={PIXEL_OPTIONS}
        format={(value) => (value === 1 ? 'Off' : `${value}px`)}
        onChange={(value) => setSetting('pixelSize', value)}
      />
      <div className='grid grid-cols-2 gap-2'>
        <Segmented
          label='Tiles'
          value={settings.tiles}
          options={TILE_OPTIONS}
          format={(value) => `${value}²`}
          onChange={(value) => setSetting('tiles', value)}
        />
        <Segmented
          label='Mesh'
          value={settings.segments}
          options={SEGMENT_OPTIONS}
          onChange={(value) => setSetting('segments', value)}
        />
      </div>
      <p className='text-3xs uppercase leading-3 tracking-[0.08em] text-muted'>
        Tiles and mesh rebuild the map. Everything else changes the loaded tiles
        in place.
      </p>
    </div>
  )
}
