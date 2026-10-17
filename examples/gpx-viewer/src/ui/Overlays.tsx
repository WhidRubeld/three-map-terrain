import { useSelector } from '@tanstack/react-store'
import { shallow } from '@tanstack/react-store'
import { useEffect, useState } from 'react'

import {
  dismissError,
  dismissHint,
  loadFile,
  setHelp,
  terrainStore,
  uiStore,
  viewerStore
} from '../state/viewer'
import { cx, Kbd } from './controls'
import { Icon } from './Icon'

/** Tile-by-tile progress while the grid loads: outline → dotted (DEM) → solid (imagery). */
export function LoadingHud() {
  const loading = useSelector(viewerStore, (s) => s.loading)
  const terrain = useSelector(
    terrainStore,
    (s) => ({
      fit: s.fit,
      ready: s.ready,
      loaded: s.loaded,
      textured: s.textured,
      total: s.total
    }),
    { compare: shallow }
  )
  const done = terrain.total > 0 && terrain.textured >= terrain.total
  // imagery may never finish (a tile server failing): give up showing it 8 s after the relief
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    setExpired(false)
    if (!terrain.ready) return
    const timer = setTimeout(() => setExpired(true), 8000)
    return () => clearTimeout(timer)
  }, [terrain.ready, terrain.fit])
  const busy =
    loading || (terrain.fit !== null && (!terrain.ready || (!done && !expired)))
  // stay a moment after the last tile, then step out
  const [linger, setLinger] = useState(true)
  useEffect(() => {
    if (busy) {
      setLinger(true)
      return
    }
    const timer = setTimeout(() => setLinger(false), 800)
    return () => clearTimeout(timer)
  }, [busy])

  if (!busy && !linger) return null
  const n = terrain.fit?.nTiles ?? 3
  const label = loading
    ? 'Reading track'
    : !terrain.ready
      ? 'Building terrain'
      : done
        ? 'Terrain ready'
        : 'Streaming imagery'

  const cells = (size: string) => (
    <div
      className='grid gap-1'
      style={{ gridTemplateColumns: `repeat(${n}, ${size})` }}
      aria-hidden
    >
      {Array.from({ length: n * n }, (_, i) => (
        <span
          key={i}
          className={cx(
            'aspect-square border',
            i < terrain.textured
              ? 'border-fg bg-fg'
              : i < terrain.loaded
                ? 'border-fg bg-[radial-gradient(var(--fg)_1px,transparent_1.2px)] bg-[length:3px_3px]'
                : 'border-line-strong'
          )}
        />
      ))}
    </div>
  )
  const counts = `Dem ${terrain.loaded}/${terrain.total} · Img ${terrain.textured}/${terrain.total}${terrain.fit ? ` · Z${terrain.fit.zoom}` : ''}`

  // once the relief is up, step aside: a compact strip under the top bar
  if (terrain.ready) {
    return (
      <div
        className='pointer-events-none fixed left-1/2 top-[4.25rem] z-20 -translate-x-1/2'
        role='status'
      >
        <div className='panel ticks flex items-center gap-3 px-3 py-2'>
          {cells('6px')}
          <span className={cx('hud-label text-fg!', !done && 'caret')}>
            {label}
          </span>
          <span className='hud-label tabular-nums'>{counts}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className='pointer-events-none fixed left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2'
      role='status'
    >
      <div className='panel ticks grid justify-items-center gap-3 px-6 py-5'>
        {cells('14px')}
        <div className={cx('hud-label text-fg!', !done && 'caret')}>
          {label}
        </div>
        <div className='hud-label tabular-nums'>{counts}</div>
      </div>
    </div>
  )
}

/** Drop a .gpx anywhere on the page. */
export function DropZone() {
  const dragging = useSelector(uiStore, (s) => s.dragging)
  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent) =>
      event.dataTransfer?.types.includes('Files') ?? false
    const set = (value: boolean) =>
      uiStore.setState((s) =>
        s.dragging === value ? s : { ...s, dragging: value }
      )
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth++
      set(true)
    }
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (!depth) set(false)
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      set(false)
      const file = event.dataTransfer?.files[0]
      if (file) void loadFile(file)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  if (!dragging) return null
  return (
    <div className='pointer-events-none fixed inset-3 z-40 grid place-items-center border border-dashed border-fg bg-panel backdrop-blur-sm'>
      <div className='appear grid justify-items-center gap-3'>
        <Icon name='upload' cell={4} />
        <span className='dot text-3xl'>Drop GPX</span>
        <span className='hud-label'>
          Tracks, routes and waypoints · GPX 1.0 / 1.1
        </span>
      </div>
    </div>
  )
}

export function ErrorToast() {
  const error = useSelector(viewerStore, (s) => s.error)
  if (!error) return null
  return (
    <div
      className='fixed left-1/2 top-20 z-30 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2'
      role='alert'
    >
      <div className='panel ticks flex items-start gap-3 bg-panel-solid p-3'>
        <span className='tag tag-strong'>Error</span>
        <p className='flex-1 text-2xs uppercase leading-4 tracking-[0.08em]'>
          {error}
        </p>
        <button
          type='button'
          className='btn btn-icon h-6! w-6!'
          onClick={dismissError}
          aria-label='Dismiss'
        >
          <Icon name='close' cell={1} />
        </button>
      </div>
    </div>
  )
}

/** First visit: how to move the camera. */
export function Hint() {
  const hint = useSelector(uiStore, (s) => s.hint)
  if (!hint) return null
  const touch = matchMedia('(hover: none) and (pointer: coarse)').matches
  const items: [string, string][] = touch
    ? [
        ['1 finger', 'Pan'],
        ['2 fingers', 'Zoom · rotate'],
        ['Tap route', 'Inspect · seek']
      ]
    : [
        ['Drag', 'Pan'],
        ['Right-drag', 'Rotate'],
        ['Scroll', 'Zoom'],
        ['Hover', 'Inspect'],
        ['Click', 'Seek']
      ]
  return (
    <div className='pointer-events-auto panel ticks flex flex-wrap items-center gap-x-4 gap-y-1 bg-panel-solid px-3 py-2'>
      {items.map(([key, action]) => (
        <span
          key={key}
          className='flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.1em]'
        >
          <span className='tag'>{key}</span>
          <span className='text-muted'>{action}</span>
        </span>
      ))}
      <button type='button' className='btn h-6' onClick={() => setHelp(true)}>
        All controls <Kbd>?</Kbd>
      </button>
      <button
        type='button'
        className='btn btn-icon h-6! w-6!'
        onClick={dismissHint}
        aria-label='Dismiss'
      >
        <Icon name='close' cell={1} />
      </button>
    </div>
  )
}
