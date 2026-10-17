import { useSelector } from '@tanstack/react-store'
import type { ReactNode } from 'react'

import { cycleSetting, settingsStore } from '../state/settings'
import {
  loadPreset,
  PRESETS,
  setHelp,
  type SheetId,
  toggleSheet,
  uiStore,
  viewerStore
} from '../state/viewer'
import { cx, useMedia } from './controls'
import { Icon, type IconName } from './Icon'
import { LegendBody } from './LegendPanel'
import { Hint } from './Overlays'
import { PerfBody } from './PerfPanel'
import { PlaybackControls, Profile } from './ProfilePanel'
import { FileButton, REPOSITORY, THEME_LABEL, THEMES } from './TopBar'
import { TrackBody } from './TrackPanel'
import { ViewBody } from './ViewPanel'

const SHEETS: {
  id: SheetId
  title: string
  icon: IconName
  body: () => ReactNode
}[] = [
  { id: 'track', title: 'Track', icon: 'flag', body: () => <TrackBody /> },
  { id: 'view', title: 'View', icon: 'sliders', body: () => <ViewBody /> },
  { id: 'legend', title: 'Legend', icon: 'legend', body: () => <LegendBody /> },
  { id: 'perf', title: 'Perf', icon: 'gauge', body: () => <PerfBody /> }
]

function CompactTopBar() {
  const source = useSelector(viewerStore, (s) => s.source)
  const theme = useSelector(settingsStore, (s) => s.theme)
  return (
    <header className='panel ticks pointer-events-auto flex h-11 items-center gap-1 px-1.5'>
      <a
        href={REPOSITORY}
        target='_blank'
        rel='noreferrer'
        className='btn btn-icon h-8 w-10! flex-none border-transparent'
        aria-label={`three-map-terrain ${__LIBRARY_VERSION__} on GitHub`}
      >
        <Icon name='logo' cell={2} />
      </a>
      <nav
        className='flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]'
        aria-label='Tracks'
      >
        {PRESETS.map((preset) => {
          const active = source?.kind === 'preset' && source.id === preset.id
          return (
            <button
              key={preset.id}
              type='button'
              className='btn h-8 flex-none px-2'
              aria-current={active}
              onClick={() => void loadPreset(preset.id)}
            >
              {preset.name}
            </button>
          )
        })}
        {source?.kind === 'file' && (
          <span
            className='btn pointer-events-none h-8 max-w-32 flex-none border-fg'
            aria-current
          >
            <span className='truncate'>{source.name}</span>
          </span>
        )}
      </nav>
      <FileButton compact />
      <button
        type='button'
        className='btn btn-icon h-8 flex-none'
        onClick={() => cycleSetting('theme', THEMES)}
        aria-label={`Theme: ${THEME_LABEL[theme]}`}
      >
        <Icon name='contrast' cell={1} />
      </button>
      <button
        type='button'
        className='btn btn-icon h-8 flex-none'
        onClick={() => setHelp(true)}
        aria-label='Controls'
      >
        <Icon name='help' cell={1} />
      </button>
    </header>
  )
}

function Sheet({ id }: { id: SheetId }) {
  const sheet = SHEETS.find((s) => s.id === id)
  if (!sheet) return null
  return (
    <section
      className='panel ticks pointer-events-auto flex max-h-[min(48dvh,26rem)] min-h-0 flex-col bg-panel-solid'
      aria-label={sheet.title}
    >
      <header className='flex h-8 flex-none items-center gap-2 pl-2.5 pr-1'>
        <Icon name={sheet.icon} cell={1} className='text-muted' />
        <h2 className='hud-label text-fg!'>{sheet.title}</h2>
        <span className='rule' />
        <button
          type='button'
          className='btn btn-icon h-6! w-6! border-transparent'
          onClick={() => toggleSheet(id)}
          aria-label={`Close ${sheet.title}`}
        >
          <Icon name='close' cell={1} />
        </button>
      </header>
      <div className='appear min-h-0 overflow-y-auto overscroll-contain border-t border-line px-2.5 pb-2.5 pt-2'>
        {sheet.body()}
      </div>
    </section>
  )
}

function CompactProfile({ short }: { short: boolean }) {
  const track = useSelector(viewerStore, (s) => s.track)
  const preset = useSelector(viewerStore, (s) => s.source?.kind === 'preset')
  return (
    <section
      className='panel ticks pointer-events-auto grid min-w-0 gap-1.5 px-2 pb-1 pt-1.5'
      aria-label='Profile'
    >
      {track && (
        <>
          <div className='flex min-w-0 items-center justify-between gap-2'>
            <span className='hud-label min-w-0 truncate text-fg!'>
              {track.name}
            </span>
            <PlaybackControls track={track} compact />
          </div>
          <Profile track={track} height={short ? 28 : 44} />
        </>
      )}
      <p className='truncate text-3xs uppercase tracking-[0.08em] text-muted'>
        © EOX Sentinel-2 cloudless 2016 · AWS Terrain Tiles
        {preset && ' · Routes © OpenStreetMap'}
      </p>
    </section>
  )
}

function TabBar({ short }: { short: boolean }) {
  const active = useSelector(uiStore, (s) => s.sheet)
  return (
    <nav
      className='panel pointer-events-auto grid grid-cols-4'
      aria-label='Panels'
    >
      {SHEETS.map(({ id, title, icon }) => (
        <button
          key={id}
          type='button'
          className={cx(
            'btn tab border-0 text-3xs',
            short ? 'h-8 gap-2' : 'h-11 flex-col gap-1',
            active === id && 'bg-fg text-bg'
          )}
          aria-pressed={active === id}
          onClick={() => toggleSheet(id)}
        >
          <Icon name={icon} cell={1} />
          {title}
        </button>
      ))}
    </nav>
  )
}

/**
 * Phones and short screens: the scene gets the middle, the panels share one
 * sheet above the profile, opened from the tab bar.
 */
export function CompactLayout() {
  const sheet = useSelector(uiStore, (s) => s.sheet)
  // landscape phones: every pixel of height goes to the scene
  const short = useMedia('(max-height: 559px)')
  return (
    <div className='pointer-events-none fixed inset-0 z-10 flex flex-col justify-between gap-2 px-[max(0.5rem,env(safe-area-inset-left))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))]'>
      <div data-inset='top'>
        <CompactTopBar />
      </div>
      <div data-inset='bottom' className='flex min-h-0 flex-col gap-2'>
        {!short && !sheet && (
          <div className='flex justify-center empty:hidden'>
            <Hint />
          </div>
        )}
        {sheet && <Sheet id={sheet} />}
        <CompactProfile short={short} />
        <TabBar short={short} />
      </div>
    </div>
  )
}
