import { useSelector } from '@tanstack/react-store'
import type { ReactNode } from 'react'

import { distanceParts, elevationParts, joinParts } from '../lib/format'
import { settingsStore } from '../state/settings'
import { terrainStore, viewerStore } from '../state/viewer'
import { graticuleStep } from '../scene/Graticule'
import { GLYPHS, type GlyphName } from '../scene/look'
import { markStep } from '../scene/Markers'
import { Panel } from './controls'

/** The scene's marker glyph, from the same pixel pattern. */
function Glyph({ name }: { name: GlyphName }) {
  const rows = GLYPHS[name]
  return (
    <svg
      viewBox={`0 0 ${rows[0].length} ${rows.length}`}
      width={rows[0].length * 2}
      height={rows.length * 2}
      shapeRendering='crispEdges'
      fill='currentColor'
      aria-hidden
    >
      {rows.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === '#' ? (
            <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />
          ) : null
        )
      )}
    </svg>
  )
}

function Line({
  width,
  opacity = 1,
  dashed = false
}: {
  width: number
  opacity?: number
  dashed?: boolean
}) {
  return (
    <svg width={28} height={8} aria-hidden>
      <line
        x1={0}
        x2={28}
        y1={4}
        y2={4}
        stroke='currentColor'
        strokeWidth={width}
        strokeOpacity={opacity}
        strokeDasharray={dashed ? '2 2' : undefined}
        shapeRendering='crispEdges'
      />
    </svg>
  )
}

function Row({
  symbol,
  label,
  detail
}: {
  symbol: ReactNode
  label: string
  detail?: string
}) {
  return (
    <li className='grid h-5 grid-cols-[32px_1fr_auto] items-center gap-2 text-2xs uppercase tracking-[0.08em]'>
      <span className='grid place-items-center'>{symbol}</span>
      <span className='truncate'>{label}</span>
      {detail && <span className='text-muted tabular-nums'>{detail}</span>}
    </li>
  )
}

export function LegendPanel({ className }: { className?: string }) {
  return (
    <Panel
      id='legend'
      index='03'
      title='Legend'
      icon='legend'
      className={className}
    >
      <LegendBody />
    </Panel>
  )
}

export function LegendBody() {
  const track = useSelector(viewerStore, (s) => s.track)
  const fit = useSelector(terrainStore, (s) => s.fit)
  const heights = useSelector(terrainStore, (s) => s.heights)
  const exaggeration = useSelector(settingsStore, (s) => s.exaggeration)
  const step = fit ? graticuleStep(fit) : null

  return (
    <>
      <ul className='grid gap-0.5'>
        <Row symbol={<Line width={3} />} label='Route · travelled' />
        <Row symbol={<Line width={2} opacity={0.5} />} label='Route · ahead' />
        <Row
          symbol={<Line width={1} opacity={0.4} dashed />}
          label='Behind terrain'
        />
        <Row symbol={<Glyph name='start' />} label='Start' />
        <Row symbol={<Glyph name='finish' />} label='Finish' />
        <Row
          symbol={<Glyph name='waypoint' />}
          label='Waypoint'
          detail={track ? String(track.waypoints.length) : undefined}
        />
        <Row
          symbol={<Glyph name='mark' />}
          label='Distance mark'
          detail={
            track
              ? `every ${joinParts(distanceParts(markStep(track.stats.distance)))}`
              : undefined
          }
        />
        <Row symbol={<Glyph name='playhead' />} label='Playhead' />
        <Row symbol={<Glyph name='hover' />} label='Point under cursor' />
        <Row symbol={<Glyph name='cursor' />} label='Terrain under cursor' />
        <Row
          symbol={<Line width={1} opacity={0.4} />}
          label='Coordinate grid'
          detail={step ? `${step}°` : undefined}
        />
      </ul>

      {fit && (
        <dl className='mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-line pt-2 text-2xs uppercase tracking-[0.06em]'>
          <dt className='text-muted'>Zoom</dt>
          <dd className='text-right tabular-nums'>
            Z{fit.zoom} · imagery Z{fit.zoom + 1}
          </dd>
          <dt className='text-muted'>Grid</dt>
          <dd className='text-right tabular-nums'>
            {fit.nTiles}×{fit.nTiles} ·{' '}
            {joinParts(distanceParts(fit.metersPerUnit * fit.tileSize))} / tile
          </dd>
          <dt className='text-muted'>Scale</dt>
          <dd className='text-right tabular-nums'>
            1 unit = {fit.metersPerUnit.toFixed(1)} m
          </dd>
          {heights && (
            <>
              <dt className='text-muted'>Terrain</dt>
              <dd className='text-right tabular-nums'>
                {joinParts(elevationParts(heights.min / fit.zScale))} –{' '}
                {joinParts(elevationParts(heights.max / fit.zScale))}
              </dd>
            </>
          )}
          <dt className='text-muted'>Vertical</dt>
          <dd className='text-right tabular-nums'>
            ×{exaggeration.toFixed(2)}
          </dd>
        </dl>
      )}
    </>
  )
}
