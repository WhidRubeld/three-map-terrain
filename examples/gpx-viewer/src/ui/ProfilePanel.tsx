import { useSelector } from '@tanstack/react-store'
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'

import {
  indexAtProgress,
  progressAtIndex,
  sampleTrack,
  type Track
} from '../gpx/track'
import {
  distanceParts,
  elevationParts,
  formatClock,
  formatDuration,
  gradeParts,
  joinParts,
  speedParts
} from '../lib/format'
import { fractionalIndex, niceStep } from '../lib/geo'
import {
  hoverStore,
  playbackStore,
  restartPlayback,
  seek,
  setHoverIndex,
  setSpeed,
  SPEED_OPTIONS,
  togglePlayback,
  viewerStore
} from '../state/viewer'
import { cx, Kbd, Panel, useMedia } from './controls'
import { Icon } from './Icon'

/** 2 px bar + 1 px gap */
const PITCH = 3

interface ProfileModel {
  bars: string
  caps: string
  min: number
  max: number
}

/** The highest point per 3 px column, as one path of bars (and one of their tops). */
function buildProfile(
  track: Track,
  width: number,
  HEIGHT: number
): ProfileModel | null {
  const { elevation, distance } = track
  if (track.elevationSource === 'none' || width <= 0) return null
  const columns = Math.max(1, Math.floor(width / PITCH))
  const total = track.stats.distance || 1
  const values = new Float32Array(columns).fill(Number.NaN)
  for (let i = 0; i < elevation.length; i++) {
    const c = Math.min(columns - 1, Math.floor((distance[i] / total) * columns))
    values[c] = Number.isNaN(values[c])
      ? elevation[i]
      : Math.max(values[c], elevation[i])
  }
  for (let c = 1; c < columns; c++)
    if (Number.isNaN(values[c])) values[c] = values[c - 1]

  const min = track.stats.minEle ?? 0
  const max = track.stats.maxEle ?? 1
  const pad = Math.max((max - min) * 0.12, 5)
  const low = min - pad
  const high = max + pad * 0.4
  let bars = ''
  let caps = ''
  for (let c = 0; c < columns; c++) {
    const top = Math.round(HEIGHT - ((values[c] - low) / (high - low)) * HEIGHT)
    const x = c * PITCH
    bars += `M${x} ${top}h2v${HEIGHT - top}h-2z`
    caps += `M${x} ${top}h2v1h-2z`
  }
  return { bars, caps, min, max }
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry.contentRect.width))
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

export function ProfilePanel({ className }: { className?: string }) {
  const track = useSelector(viewerStore, (s) => s.track)
  const tall = useMedia('(min-height: 820px)')
  return (
    <Panel
      id='profile'
      index='05'
      title='Profile'
      icon='gauge'
      className={className}
      actions={track && <PlaybackControls track={track} />}
    >
      {track && <Profile track={track} height={tall ? 72 : 52} />}
    </Panel>
  )
}

export function PlaybackControls({
  track,
  compact = false
}: {
  track: Track
  compact?: boolean
}) {
  const playing = useSelector(playbackStore, (s) => s.playing)
  const speed = useSelector(playbackStore, (s) => s.speed)
  const name = useId()
  return (
    <div className='flex flex-none items-center gap-1'>
      <PlayClock track={track} compact={compact} />
      <button
        type='button'
        className={cx('btn h-6 gap-1.5', compact ? 'btn-icon w-6!' : 'px-2')}
        onClick={togglePlayback}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        <Icon name={playing ? 'pause' : 'play'} cell={1} />
        {!compact && <Kbd>Space</Kbd>}
      </button>
      <button
        type='button'
        className='btn btn-icon h-6! w-6!'
        onClick={restartPlayback}
        aria-label='Restart'
      >
        <Icon name='restart' cell={1} />
      </button>
      <div
        className={cx('segmented', compact ? 'hidden' : 'hidden sm:grid')}
        role='radiogroup'
        aria-label='Playback speed'
      >
        {SPEED_OPTIONS.map((option) => (
          <label key={option} className='h-6!'>
            <input
              type='radio'
              className='sr-only'
              name={name}
              checked={speed === option}
              onChange={() => setSpeed(option)}
            />
            <span>×{option}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

function PlayClock({ track, compact }: { track: Track; compact: boolean }) {
  const progress = useSelector(playbackStore, (s) => s.progress)
  const sample = sampleTrack(track, indexAtProgress(track, progress))
  const start = track.times?.[0] ?? null
  return (
    <span
      className={cx(
        'mr-1 items-baseline gap-2 text-2xs font-semibold uppercase tabular-nums tracking-[0.08em]',
        compact ? 'flex' : 'hidden md:flex'
      )}
    >
      {sample.time !== null && start !== null ? (
        <>
          <span>{formatClock(sample.time)}</span>
          <span className='text-muted'>
            +{formatDuration(sample.time - start)}
          </span>
        </>
      ) : (
        <span>{joinParts(distanceParts(sample.distance))}</span>
      )}
    </span>
  )
}

function Readout({ track, index }: { track: Track; index: number }) {
  const sample = sampleTrack(track, index)
  const items = [
    joinParts(distanceParts(sample.distance)),
    joinParts(elevationParts(sample.ele)),
    joinParts(gradeParts(sample.grade)),
    sample.time !== null ? formatClock(sample.time) : null,
    sample.speed !== null ? joinParts(speedParts(sample.speed)) : null
  ].filter(Boolean)
  return (
    <div className='pointer-events-none absolute left-1 top-0 flex gap-3 bg-panel-solid px-1 text-2xs font-semibold uppercase tabular-nums tracking-[0.06em]'>
      {items.map((item, i) => (
        <span key={i} className={i ? 'text-muted' : undefined}>
          {item}
        </span>
      ))}
    </div>
  )
}

export function Profile({
  track,
  height: HEIGHT = 72
}: {
  track: Track
  height?: number
}) {
  const [box, width] = useWidth()
  const model = useMemo(
    () => buildProfile(track, width, HEIGHT),
    [track, width, HEIGHT]
  )
  const hover = useSelector(hoverStore, (s) => s.index)
  const progress = useSelector(playbackStore, (s) => s.progress)
  const dragging = useRef(false)
  const id = useId().replace(/[^\w-]/g, '')
  const total = track.stats.distance || 1

  const xOf = (index: number) => {
    const i = Math.min(Math.max(index, 0), track.points.length - 1)
    const low = Math.floor(i)
    const high = Math.min(low + 1, track.points.length - 1)
    const d =
      track.distance[low] +
      (track.distance[high] - track.distance[low]) * (i - low)
    return Math.round((d / total) * width)
  }
  const indexAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    return fractionalIndex(track.distance, t * total)
  }

  const playhead = indexAtProgress(track, progress)
  const playheadX = xOf(playhead)
  const step = niceStep(total / Math.max(2, Math.floor(width / 110)))
  const ticks: number[] = []
  for (let d = 0; d <= total; d += step) ticks.push(d)
  const waypoints = track.waypoints.filter(
    (w) => w.type !== 'start' && w.type !== 'finish'
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === 'ArrowLeft' ? -0.01 : event.key === 'ArrowRight' ? 0.01 : 0
    if (!delta) return
    event.preventDefault()
    seek(progress + delta * (event.shiftKey ? 10 : 1))
  }

  return (
    <div className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2'>
      <div className='flex flex-col justify-between py-0.5 text-right text-3xs font-semibold tabular-nums text-muted'>
        <span>{model ? joinParts(elevationParts(model.max)) : ''}</span>
        <span>{model ? joinParts(elevationParts(model.min)) : ''}</span>
      </div>
      <div
        ref={box}
        className='relative min-w-0 cursor-crosshair touch-none select-none overflow-hidden outline-offset-2'
        style={{ height: HEIGHT }}
        role='slider'
        tabIndex={0}
        aria-label='Elevation profile and playhead'
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        onKeyDown={onKeyDown}
        onPointerMove={(event) => {
          const index = indexAt(event)
          setHoverIndex(index)
          if (dragging.current) seek(progressAtIndex(track, index))
        }}
        onPointerLeave={() => setHoverIndex(null)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          dragging.current = true
          seek(progressAtIndex(track, indexAt(event)))
        }}
        onPointerUp={() => {
          dragging.current = false
        }}
      >
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            shapeRendering='crispEdges'
            className='block text-fg'
            aria-hidden
          >
            <defs>
              <pattern
                id={`${id}dots`}
                width={PITCH}
                height={PITCH}
                patternUnits='userSpaceOnUse'
              >
                <rect width={2} height={2} fill='currentColor' />
              </pattern>
              <pattern
                id={`${id}sparse`}
                width={PITCH}
                height={PITCH}
                patternUnits='userSpaceOnUse'
              >
                <rect width={2} height={1} fill='currentColor' />
              </pattern>
              <clipPath id={`${id}done`}>
                <rect width={playheadX} height={HEIGHT} />
              </clipPath>
            </defs>
            {model ? (
              <>
                <path d={model.bars} fill={`url(#${id}sparse)`} opacity={0.6} />
                <path
                  d={model.bars}
                  fill={`url(#${id}dots)`}
                  clipPath={`url(#${id}done)`}
                />
                <path d={model.caps} fill='currentColor' />
              </>
            ) : (
              <text
                x={4}
                y={HEIGHT / 2}
                fill='currentColor'
                className='text-2xs uppercase tracking-[0.12em] opacity-60'
              >
                No elevation data yet: waiting for the terrain
              </text>
            )}
            {waypoints.map((w, i) => {
              const x = Math.round((w.distance / total) * width)
              return (
                <rect
                  key={i}
                  x={x - 1}
                  y={HEIGHT - 4}
                  width={3}
                  height={3}
                  fill='currentColor'
                  className='opacity-80'
                />
              )
            })}
            {progress < 1 && (
              <rect
                x={playheadX}
                y={0}
                width={1}
                height={HEIGHT}
                fill='currentColor'
              />
            )}
            {hover !== null && (
              <rect
                x={xOf(hover)}
                y={0}
                width={1}
                height={HEIGHT}
                fill='currentColor'
                opacity={0.7}
              />
            )}
          </svg>
        )}
        {(hover !== null || progress < 1) && (
          <Readout track={track} index={hover ?? playhead} />
        )}
      </div>
      <span />
      <div className='relative h-4 text-3xs font-semibold tabular-nums text-muted'>
        {ticks.map((d) => {
          const at = d / total
          // labels near the ends align inwards instead of overflowing
          const shift =
            at < 0.04
              ? 'translate-x-0'
              : at > 0.94
                ? '-translate-x-full'
                : '-translate-x-1/2'
          return (
            <span
              key={d}
              className={cx('absolute top-0.5 whitespace-nowrap', shift)}
              style={{ left: `${at * 100}%` }}
            >
              {joinParts(distanceParts(d))}
            </span>
          )
        })}
      </div>
    </div>
  )
}
