// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import bright from '../../public/presets/bright-angel.gpx?raw'
import eiger from '../../public/presets/eiger-trail.gpx?raw'
import stelvio from '../../public/presets/stelvio.gpx?raw'
import { GpxError, parseGpx } from './parse'
import {
  buildTrack,
  indexAtProgress,
  progressAtIndex,
  sampleTrack,
  withTerrainElevation
} from './track'

const gpx10 = `<?xml version="1.0"?>
<gpx version="1.0" creator="Old Logger" xmlns="http://www.topografix.com/GPX/1/0">
  <name>Morning loop</name>
  <time>2020-05-01T06:00:00Z</time>
  <wpt lat="45.0" lon="7.0"><name>Spring</name><sym>Drinking Water</sym></wpt>
  <trk><name>Loop</name><type>running</type>
    <trkseg>
      <trkpt lat="45.000" lon="7.000"><ele>100</ele><time>2020-05-01T06:00:00Z</time>
        <extensions><gpxtpx:TrackPointExtension xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><gpxtpx:hr>120</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
      </trkpt>
      <trkpt lat="45.001" lon="7.000"><ele>110</ele><time>2020-05-01T06:00:40Z</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="45.010" lon="7.000"><ele>90</ele><time>2020-05-01T06:10:00Z</time></trkpt>
      <trkpt lat="45.011" lon="7.000"><ele>95</ele><time>2020-05-01T06:10:40Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`

describe('parseGpx', () => {
  it('reads GPX 1.0 metadata, segments, waypoints and extensions', () => {
    const doc = parseGpx(gpx10)
    expect(doc.metadata).toMatchObject({
      name: 'Morning loop',
      creator: 'Old Logger',
      version: '1.0'
    })
    expect(doc.metadata.time).toBe(Date.parse('2020-05-01T06:00:00Z'))
    expect(doc.type).toBe('running')
    expect(doc.segments.map((s) => s.length)).toEqual([2, 2])
    expect(doc.segments[0][0]).toMatchObject({ ele: 100, hr: 120 })
    expect(doc.waypoints[0]).toMatchObject({
      name: 'Spring',
      sym: 'Drinking Water'
    })
  })

  it('falls back to route points', () => {
    const doc = parseGpx(
      `<gpx><rte><rtept lat="1" lon="2"/><rtept lat="1.1" lon="2"/></rte></gpx>`
    )
    expect(doc.segments[0]).toHaveLength(2)
  })

  it('rejects files that are not GPX tracks', () => {
    expect(() => parseGpx('<gpx><trk>')).toThrow(GpxError)
    expect(() => parseGpx('<kml/>')).toThrow('not a GPX')
    expect(() => parseGpx('<gpx><wpt lat="1" lon="1"/></gpx>')).toThrow(
      'at least two points'
    )
  })

  it('skips points with invalid coordinates and keeps only http(s) links', () => {
    const doc = parseGpx(`<gpx>
      <wpt lat="1" lon="1"><link href="javascript:alert(1)"/></wpt>
      <wpt lat="1" lon="1"><link href="https://example.com/a"/></wpt>
      <trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="x" lon="1"/><trkpt lat="91" lon="1"/><trkpt lat="1.1" lon="1"/></trkseg></trk>
    </gpx>`)
    expect(doc.segments[0]).toHaveLength(2)
    expect(doc.waypoints.map((w) => w.link)).toEqual([
      null,
      'https://example.com/a'
    ])
  })
})

describe('buildTrack', () => {
  it('does not count the gap between segments', () => {
    const track = buildTrack(parseGpx(gpx10), 'file')
    const segment = 111.2 // 0.001° of latitude
    expect(track.stats.distance).toBeCloseTo(2 * segment, 0)
    expect(track.segmentStarts).toEqual([0, 2])
    expect(track.name).toBe('Morning loop')
    expect(track.stats.ascent).toBe(15)
    expect(track.stats.duration).toBe(10 * 60_000 + 40_000)
    expect(track.stats.avgHr).toBe(120)
  })

  it('computes plausible stats for the presets', () => {
    const cases = [
      { text: eiger, km: [5.5, 6.2], descent: [600, 1000], hours: [1.5, 2.5] },
      { text: stelvio, km: [23, 25], ascent: [1700, 2000], hours: [1.8, 3] },
      { text: bright, km: [12, 13], descent: [1200, 1500], hours: [3, 4.5] }
    ]
    for (const { text, km, ascent, descent, hours } of cases) {
      const { stats, waypoints, elevationSource } = buildTrack(
        parseGpx(text),
        'preset'
      )
      expect(elevationSource).toBe('gpx')
      expect(stats.distance / 1000).toBeGreaterThan(km[0])
      expect(stats.distance / 1000).toBeLessThan(km[1])
      expect(stats.duration! / 3.6e6).toBeGreaterThan(hours[0])
      expect(stats.duration! / 3.6e6).toBeLessThan(hours[1])
      expect(stats.movingTime!).toBeLessThan(stats.duration!)
      if (ascent) expect(stats.ascent!).toBeGreaterThan(ascent[0])
      if (ascent) expect(stats.ascent!).toBeLessThan(ascent[1])
      if (descent) expect(stats.descent!).toBeGreaterThan(descent[0])
      if (descent) expect(stats.descent!).toBeLessThan(descent[1])
      expect(waypoints.at(0)?.type).toBe('start')
      expect(waypoints.at(-1)?.type).toBe('finish')
      for (const w of waypoints) expect(w.offset).toBeLessThan(500)
    }
  })

  it('maps playback progress to points and back', () => {
    const track = buildTrack(parseGpx(eiger), 'preset')
    expect(indexAtProgress(track, 0)).toBe(0)
    expect(indexAtProgress(track, 1)).toBe(track.points.length - 1)
    for (const p of [0.1, 0.5, 0.93]) {
      expect(progressAtIndex(track, indexAtProgress(track, p))).toBeCloseTo(
        p,
        6
      )
    }
    const sample = sampleTrack(track, indexAtProgress(track, 0.5))
    expect(sample.time).toBeCloseTo(
      (track.stats.startTime! + track.stats.endTime!) / 2,
      -1
    )
  })

  it('takes elevations from the terrain when the GPX has none', () => {
    const doc = parseGpx(`<gpx><trk><trkseg>
      <trkpt lat="1" lon="1"/><trkpt lat="1.001" lon="1"/><trkpt lat="1.002" lon="1"/>
    </trkseg></trk></gpx>`)
    const track = buildTrack(doc, 'flat')
    expect(track.elevationSource).toBe('none')
    expect(track.stats.ascent).toBeNull()
    expect(track.times).toBeNull()

    const filled = withTerrainElevation(track, (p) => (p.lat - 1) * 1e5)
    expect(filled.elevationSource).toBe('dem')
    expect(filled.stats.ascent).toBeCloseTo(200, 0)
    expect(filled.bounds).toBe(track.bounds)

    // terrain not loaded (yet): keep waiting for it instead of storing gaps
    expect(withTerrainElevation(track, () => undefined)).toBe(track)
  })
})
