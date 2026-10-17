import { useFrame } from '@react-three/fiber'
import { useSelector } from '@tanstack/react-store'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  LineBasicMaterial,
  type Points
} from 'three'

import { progressAtIndex, type Track, type TrackWaypoint } from '../gpx/track'
import {
  distanceParts,
  elevationParts,
  formatClock,
  formatLat,
  formatLon,
  joinParts
} from '../lib/format'
import { fractionalIndex, niceStep } from '../lib/geo'
import { settingsStore } from '../state/settings'
import {
  focusOn,
  hoverStore,
  seek,
  setHoverWaypoint,
  terrainStore,
  uiStore,
  viewerStore
} from '../state/viewer'
import { lineAt, surfacePoint } from './drape'
import { Glyphs, Label } from './Glyphs'
import { easeInOutCubic, INTRO, introPhase, PALETTE } from './look'

/** Spacing of the distance marks: about six along the route. */
export const markStep = (total: number) => Math.max(100, niceStep(total / 6))

/** How far along the route the intro has drawn it, in meters. */
function revealedDistance(track: Track) {
  return easeInOutCubic(introPhase(INTRO.route)) * track.stats.distance
}

/** The start/finish waypoint of a file, if it has one near the track end. */
function endpoint(track: Track, type: 'start' | 'finish') {
  return track.waypoints.find((w) => w.type === type && w.offset < 150)
}

export function Markers() {
  const drape = useSelector(terrainStore, (s) => s.drape)
  const map = useSelector(terrainStore, (s) => s.map)
  const fit = useSelector(terrainStore, (s) => s.fit)
  const track = useSelector(viewerStore, (s) => s.track)
  const showWaypoints = useSelector(settingsStore, (s) => s.waypoints)
  const showMarks = useSelector(settingsStore, (s) => s.distanceMarks)
  const theme = useSelector(uiStore, (s) => s.theme)

  const layout = useMemo(() => {
    if (!drape || !track || !map || !fit) return null
    const stem = fit.tileSize * 0.06
    const last = track.points.length - 1
    const start = lineAt(drape, 0)
    const finish = lineAt(drape, last)
    const startWaypoint = endpoint(track, 'start')
    const finishWaypoint = endpoint(track, 'finish')

    const waypoints = track.waypoints
      .filter((w) => w !== startWaypoint && w !== finishWaypoint)
      .sort((a, b) => a.distance - b.distance)
      .map((waypoint) => {
        const p = surfacePoint(
          map,
          waypoint.lat,
          waypoint.lon,
          waypoint.ele ?? 0
        )
        return { waypoint, index: track.waypoints.indexOf(waypoint), ...p }
      })

    const total = track.stats.distance
    const step = markStep(total)
    const marks = []
    for (let d = step; d < total - step * 0.3; d += step) {
      marks.push({
        distance: d,
        ...lineAt(drape, fractionalIndex(track.distance, d))
      })
    }

    return {
      stem,
      step,
      start,
      finish,
      startWaypoint,
      finishWaypoint,
      waypoints,
      marks,
      endpoints: Float32Array.from([start.x, start.y, start.z]),
      finishes: Float32Array.from([finish.x, finish.y, finish.z]),
      waypointPositions: Float32Array.from(
        waypoints.flatMap((w) => [w.x, w.y, w.z])
      ),
      markPositions: Float32Array.from(marks.flatMap((m) => [m.x, m.y, m.z]))
    }
  }, [drape, track, map, fit])

  // vertical stems from the ground to the labels: start, waypoints, finish
  const stems = useMemo(() => {
    if (!layout) return null
    const anchors = [
      layout.start,
      ...(showWaypoints ? layout.waypoints : []),
      layout.finish
    ]
    const positions = new Float32Array(anchors.length * 6)
    anchors.forEach((p, i) =>
      positions.set([p.x, p.y, p.z, p.x, p.y, p.z + layout.stem], i * 6)
    )
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    return geometry
  }, [layout, showWaypoints])
  const stemMaterial = useMemo(
    () =>
      new LineBasicMaterial({
        color: PALETTE[theme].fg,
        transparent: true,
        opacity: 0.7,
        depthTest: false
      }),
    [theme]
  )
  useEffect(() => () => stems?.dispose(), [stems])
  useEffect(() => () => stemMaterial.dispose(), [stemMaterial])

  // the intro reveals markers as the route is drawn past them
  const waypointGlyphs = useRef<Points>(null)
  const markGlyphs = useRef<Points>(null)
  const finishGlyph = useRef<Points>(null)
  useFrame(() => {
    if (!layout || !track) return
    const revealed = revealedDistance(track)
    const done = revealed >= track.stats.distance - 1
    const waypoints = layout.waypoints.filter(
      (w) => w.waypoint.distance <= revealed
    ).length
    const marks = layout.marks.filter((m) => m.distance <= revealed).length
    waypointGlyphs.current?.geometry.setDrawRange(0, waypoints)
    markGlyphs.current?.geometry.setDrawRange(0, marks)
    if (finishGlyph.current) finishGlyph.current.visible = done
    stems?.setDrawRange(
      0,
      2 + (showWaypoints ? waypoints * 2 : 0) + (done ? 2 : 0)
    )
  })

  if (!layout || !track) return null
  const { stem } = layout
  const revealedPast = (d: number) => () => revealedDistance(track) >= d
  const startTime = track.times ? track.times[0] : null
  const finishTime = track.times ? track.times[track.times.length - 1] : null

  return (
    <group name='markers'>
      {stems && (
        <lineSegments
          geometry={stems}
          material={stemMaterial}
          renderOrder={25}
        />
      )}
      <Glyphs name='start' positions={layout.endpoints} />
      <Glyphs ref={finishGlyph} name='finish' positions={layout.finishes} />
      <Label position={[layout.start.x, layout.start.y, layout.start.z + stem]}>
        <span className='tag tag-strong'>
          <span className='tag-key'>Start</span>
          {layout.startWaypoint && <span>{layout.startWaypoint.name}</span>}
          {startTime !== null && (
            <span className='tag-dim'>{formatClock(startTime, false)}</span>
          )}
        </span>
      </Label>
      <Label
        position={[layout.finish.x, layout.finish.y, layout.finish.z + stem]}
        visible={revealedPast(track.stats.distance - 1)}
      >
        <span className='tag tag-strong'>
          <span className='tag-key'>Finish</span>
          {layout.finishWaypoint && <span>{layout.finishWaypoint.name}</span>}
          {finishTime !== null && (
            <span className='tag-dim'>{formatClock(finishTime, false)}</span>
          )}
        </span>
      </Label>

      {showWaypoints && layout.waypoints.length > 0 && (
        <>
          <Glyphs
            ref={waypointGlyphs}
            name='waypoint'
            positions={layout.waypointPositions}
          />
          {layout.waypoints.map(({ waypoint, index, x, y, z }, order) => (
            <Label
              key={index}
              position={[x, y, z + stem]}
              visible={revealedPast(waypoint.distance)}
              interactive
            >
              <WaypointTag
                track={track}
                waypoint={waypoint}
                index={index}
                order={order}
              />
            </Label>
          ))}
        </>
      )}

      {showMarks && layout.marks.length > 0 && (
        <>
          <Glyphs
            ref={markGlyphs}
            name='mark'
            positions={layout.markPositions}
          />
          {layout.marks.map((mark) => (
            <Label
              key={mark.distance}
              position={[mark.x, mark.y, mark.z + stem * 0.25]}
              visible={revealedPast(mark.distance)}
            >
              <span className='tag tag-mark'>
                {joinParts(distanceParts(mark.distance))}
              </span>
            </Label>
          ))}
        </>
      )}
    </group>
  )
}

function WaypointTag({
  track,
  waypoint,
  index,
  order
}: {
  track: Track
  waypoint: TrackWaypoint
  index: number
  order: number
}) {
  const active = useSelector(hoverStore, (s) => s.waypoint === index)
  return (
    <div className='relative flex flex-col items-center'>
      {active && <WaypointCard waypoint={waypoint} />}
      <button
        type='button'
        className='tag tag-button'
        aria-label={`Waypoint ${waypoint.name}`}
        onPointerEnter={() => setHoverWaypoint(index)}
        onPointerLeave={() => setHoverWaypoint(null)}
        onFocus={() => setHoverWaypoint(index)}
        onBlur={() => setHoverWaypoint(null)}
        onClick={() => {
          seek(progressAtIndex(track, waypoint.index))
          focusOn({ lat: waypoint.lat, lon: waypoint.lon })
        }}
      >
        <span className='tag-key'>{String(order + 1).padStart(2, '0')}</span>
        <span className='max-w-32 truncate'>{waypoint.name}</span>
      </button>
    </div>
  )
}

export function WaypointCard({ waypoint }: { waypoint: TrackWaypoint }) {
  const rows: [string, string][] = [
    ['Type', waypoint.type ?? waypoint.sym ?? 'Waypoint'],
    ['Elev', joinParts(elevationParts(waypoint.ele))],
    ['At', joinParts(distanceParts(waypoint.distance))],
    ['Time', formatClock(waypoint.time)],
    ['Lat', formatLat(waypoint.lat)],
    ['Lon', formatLon(waypoint.lon)]
  ]
  return (
    <div className='card absolute bottom-full mb-2 w-56 text-left'>
      <div className='card-title'>{waypoint.name}</div>
      {waypoint.desc && waypoint.desc !== waypoint.type && (
        <p className='mb-2 line-clamp-3 text-muted normal-case'>
          {waypoint.desc}
        </p>
      )}
      <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5'>
        {rows.map(([key, value]) => (
          <div key={key} className='contents'>
            <dt className='text-muted'>{key}</dt>
            <dd className='text-right tabular-nums'>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
