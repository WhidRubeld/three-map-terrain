import { useSelector } from '@tanstack/react-store'
import { useEffect, useRef } from 'react'

import {
  cycleSetting,
  settingsStore,
  type ThemeSetting
} from '../state/settings'
import {
  commands,
  loadFile,
  loadPreset,
  PRESETS,
  setHelp,
  viewerStore
} from '../state/viewer'
import { Kbd } from './controls'
import { Icon } from './Icon'

export const REPOSITORY = 'https://github.com/whidrubeld/three-map-terrain'
export const NPM = 'https://www.npmjs.com/package/three-map-terrain'

export const THEMES: readonly ThemeSetting[] = ['system', 'dark', 'light']
export const THEME_LABEL: Record<ThemeSetting, string> = {
  system: 'Auto',
  dark: 'Dark',
  light: 'Light'
}

export function Brand() {
  return (
    <a
      href={REPOSITORY}
      target='_blank'
      rel='noreferrer'
      className='panel ticks pointer-events-auto flex h-11 flex-none items-center gap-3 px-3 hover:bg-panel-solid'
      aria-label={`three-map-terrain ${__LIBRARY_VERSION__} on GitHub`}
    >
      <Icon name='logo' cell={2} />
      <span className='grid leading-none'>
        <span className='dot text-lg'>GPX Terrain</span>
        <span className='text-3xs font-semibold uppercase tracking-hud text-muted'>
          three-map-terrain v{__LIBRARY_VERSION__}
        </span>
      </span>
    </a>
  )
}

export function FileButton({ compact = false }: { compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const open = () => input.current?.click()
    commands.addEventListener('open-file', open)
    return () => commands.removeEventListener('open-file', open)
  }, [])
  return (
    <>
      {compact ? (
        <button
          type='button'
          className='btn btn-icon h-8 flex-none'
          onClick={() => input.current?.click()}
          aria-label='Open GPX'
        >
          <Icon name='upload' cell={1} />
        </button>
      ) : (
        <button
          type='button'
          className='btn h-8'
          onClick={() => input.current?.click()}
        >
          <Icon name='upload' cell={1} />
          Open GPX
          <Kbd>O</Kbd>
        </button>
      )}
      <input
        ref={input}
        type='file'
        accept='.gpx,application/gpx+xml,application/xml,text/xml'
        className='hidden'
        aria-label='GPX file'
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void loadFile(file)
          event.target.value = ''
        }}
      />
    </>
  )
}

export function TopBar() {
  const source = useSelector(viewerStore, (s) => s.source)
  const theme = useSelector(settingsStore, (s) => s.theme)

  return (
    <header className='pointer-events-none flex items-start gap-3'>
      <Brand />

      <nav
        className='panel pointer-events-auto flex h-11 min-w-0 items-center gap-1 overflow-x-auto px-1.5 [scrollbar-width:none]'
        aria-label='Tracks'
      >
        <span className='hud-label hidden px-1.5 xl:inline'>Demo</span>
        {PRESETS.map((preset, i) => {
          const active = source?.kind === 'preset' && source.id === preset.id
          return (
            <button
              key={preset.id}
              type='button'
              className='btn h-8 flex-none gap-2'
              aria-current={active}
              title={`${preset.region} · ${preset.activity}`}
              onClick={() => void loadPreset(preset.id)}
            >
              <span className='opacity-50'>{i + 1}</span>
              {preset.name}
            </button>
          )
        })}
        <span className='mx-1 h-5 w-px flex-none bg-line' />
        {source?.kind === 'file' && (
          <span
            className='btn pointer-events-none h-8 max-w-48 border-fg'
            aria-current
          >
            <span className='truncate'>{source.name}</span>
          </span>
        )}
        <FileButton />
      </nav>

      <div className='panel pointer-events-auto ml-auto flex h-11 flex-none items-center gap-1 px-1.5'>
        <button
          type='button'
          className='btn h-8'
          onClick={() => cycleSetting('theme', THEMES)}
          aria-label={`Theme: ${THEME_LABEL[theme]}`}
        >
          <Icon name='contrast' cell={1} />
          <span className='w-9 text-left'>{THEME_LABEL[theme]}</span>
          <Kbd>T</Kbd>
        </button>
        <button type='button' className='btn h-8' onClick={() => setHelp(true)}>
          <Icon name='keyboard' cell={1} />
          <span className='hidden xl:inline'>Controls</span>
          <Kbd>?</Kbd>
        </button>
        <a
          className='btn btn-icon h-8'
          href={REPOSITORY}
          target='_blank'
          rel='noreferrer'
          aria-label='Source on GitHub'
        >
          <Icon name='external' cell={1} />
        </a>
      </div>
    </header>
  )
}
