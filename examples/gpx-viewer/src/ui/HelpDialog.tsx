import { useSelector } from '@tanstack/react-store'
import { type ReactNode, useEffect, useRef } from 'react'

import { type Hotkey, HOTKEYS } from '../hotkeys'
import { setHelp, uiStore } from '../state/viewer'
import { Kbd } from './controls'
import { Icon } from './Icon'
import { NPM, REPOSITORY } from './TopBar'

const POINTER: [string, string][] = [
  ['Drag', 'Pan'],
  ['Right-drag', 'Rotate · tilt'],
  ['Shift-drag', 'Rotate · tilt'],
  ['Scroll', 'Zoom to cursor'],
  ['Arrows', 'Pan (map focused)'],
  ['Hover route', 'Inspect point'],
  ['Click route', 'Seek there'],
  ['Drag profile', 'Scrub'],
  ['Drop .gpx', 'Load file']
]

const TOUCH: [string, string][] = [
  ['One finger', 'Pan'],
  ['Two fingers', 'Zoom · rotate']
]

const GROUPS = ['Playback', 'View', 'Layers', 'Panels', 'App'] as const

const SNIPPET = `const map = new Map({
  source: new Source({ api: 'eox' }),
  location: { lat, lon },
  options: { zoom: 14, nTiles: 3 }
})
scene.add(map.terrain)
await map.init()

// a track point on the surface
map.getTerrainPositionSync({ lat, lon })

// geolocation under the pointer
map.pick(raycaster) // { lat, lon, alt }`

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='grid content-start gap-2'>
      <div className='flex items-center gap-2'>
        <h3 className='hud-label text-fg!'>{title}</h3>
        <span className='rule' />
      </div>
      {children}
    </section>
  )
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className='grid gap-1 text-2xs uppercase tracking-[0.06em]'>
      {rows.map(([input, action]) => (
        <div key={input} className='flex items-center justify-between gap-3'>
          <dt>
            <span className='tag'>{input}</span>
          </dt>
          <dd className='text-right text-muted'>{action}</dd>
        </div>
      ))}
    </dl>
  )
}

function Keys({ hotkey }: { hotkey: Hotkey }) {
  return (
    <span className='flex gap-1'>
      {hotkey.keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  )
}

export function HelpDialog() {
  const open = useSelector(uiStore, (s) => s.help)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  return (
    <dialog
      ref={dialog}
      aria-labelledby='help-title'
      className='panel ticks m-auto max-h-[calc(100dvh-2rem)] w-[min(60rem,calc(100vw-2rem))] overflow-y-auto border-line bg-panel-solid p-0 text-fg backdrop:bg-black/50 backdrop:backdrop-blur-sm'
      onClose={() => setHelp(false)}
      onClick={(event) => {
        if (event.target === dialog.current) setHelp(false)
      }}
    >
      <header className='sticky top-0 flex h-11 items-center gap-3 border-b border-line bg-panel-solid px-4'>
        <Icon name='keyboard' cell={1} />
        <h2 id='help-title' className='dot text-lg'>
          Controls
        </h2>
        <span className='rule' />
        <Kbd>Esc</Kbd>
        <button
          type='button'
          className='btn btn-icon h-7! w-7!'
          onClick={() => setHelp(false)}
          aria-label='Close'
        >
          <Icon name='close' cell={1} />
        </button>
      </header>

      <div className='grid gap-6 p-4 md:grid-cols-[1fr_1.15fr_1fr]'>
        <div className='grid content-start gap-6'>
          <Section title='Mouse'>
            <Rows rows={POINTER} />
          </Section>
          <Section title='Touch'>
            <Rows rows={TOUCH} />
          </Section>
        </div>

        <Section title='Keyboard'>
          <div className='grid gap-3'>
            {GROUPS.map((group) => (
              <div key={group} className='grid gap-1'>
                <span className='hud-label'>{group}</span>
                {HOTKEYS.filter((h) => h.group === group).map((hotkey) => (
                  <div
                    key={hotkey.label}
                    className='flex items-center justify-between gap-3 text-2xs uppercase tracking-[0.06em]'
                  >
                    <span>{hotkey.label}</span>
                    <Keys hotkey={hotkey} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>

        <Section title='About'>
          <p className='text-2xs leading-4 text-muted'>
            Drop a GPX recording and see it on real relief. Terrain, textures
            and the geolocation math come from{' '}
            <a
              className='text-fg underline decoration-dotted underline-offset-4'
              href={REPOSITORY}
              target='_blank'
              rel='noreferrer'
            >
              three-map-terrain
            </a>{' '}
            v{__LIBRARY_VERSION__}: elevation from AWS Terrain Tiles, imagery
            from Sentinel-2 cloudless by EOX. Files stay in your browser.
          </p>
          <pre className='overflow-x-auto border border-line bg-panel p-2.5 text-3xs leading-4'>
            <code>{SNIPPET}</code>
          </pre>
          <div className='flex flex-wrap gap-2'>
            <a
              className='btn'
              href={REPOSITORY}
              target='_blank'
              rel='noreferrer'
            >
              GitHub <Icon name='external' cell={1} />
            </a>
            <a className='btn' href={NPM} target='_blank' rel='noreferrer'>
              npm <Icon name='external' cell={1} />
            </a>
            <a
              className='btn'
              href={`${REPOSITORY}/tree/master/examples/gpx-viewer`}
              target='_blank'
              rel='noreferrer'
            >
              This demo <Icon name='external' cell={1} />
            </a>
          </div>
          <p className='text-3xs uppercase leading-3 tracking-[0.08em] text-muted'>
            Demo tracks: route geometry © OpenStreetMap contributors (ODbL);
            timing is synthesized.
          </p>
        </Section>
      </div>
    </dialog>
  )
}
