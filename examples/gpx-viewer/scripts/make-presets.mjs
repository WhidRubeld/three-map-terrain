#!/usr/bin/env node
// Builds the demo GPX files in public/presets/ from open data:
//
// - route geometry: OpenStreetMap (Overpass API), © OpenStreetMap
//   contributors, ODbL — the shortest path through the ways of each route
// - elevations: AWS Terrain Tiles (terrarium, zoom 14), the same DEM the map uses
// - timestamps: synthesized — Tobler's hiking function for hikes, a constant
//   power model for rides — with GPS jitter and a few rest stops. These are not
//   real recordings; every file says so in its metadata.
//
// Usage: node scripts/make-presets.mjs [preset id …]
// Downloads are cached in scripts/.cache/ (git-ignored). Output is deterministic.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'

const ROOT = new URL('..', import.meta.url)
const CACHE = new URL('scripts/.cache/', ROOT)
const OUT = new URL('public/presets/', ROOT)
const USER_AGENT =
  'three-map-terrain-presets/1.0 (+https://github.com/whidrubeld/three-map-terrain)'

/** @typedef {{ lat: number, lon: number }} LatLon */

const PRESETS = [
  {
    id: 'eiger-trail',
    name: 'Eiger Trail',
    desc: 'Eigergletscher to Alpiglen along the foot of the Eiger north face, Bernese Oberland, Switzerland.',
    type: 'hiking',
    osm: { type: 'relation', id: 19465820 },
    query: 'relation(19465820);way(r)',
    from: { name: 'Eigergletscher', lat: 46.5753, lon: 7.9739 },
    to: { name: 'Alpiglen', lat: 46.6187, lon: 8.0013 },
    start: '2025-07-19T06:24:00Z',
    interval: 5,
    model: 'hike',
    pace: 0.92,
    stops: [{ at: 0.38, minutes: 14 }]
  },
  {
    id: 'stelvio',
    name: 'Passo dello Stelvio',
    desc: 'The eastern ramp of the Stelvio Pass road from Prato allo Stelvio: 48 hairpins up to 2757 m, South Tyrol, Italy.',
    type: 'cycling',
    osm: { type: 'relation', id: 15523244 },
    query: 'relation(15523244);way(r)',
    from: { name: 'Prato allo Stelvio', lat: 46.6195, lon: 10.5905 },
    to: 'highest',
    toName: 'Passo dello Stelvio',
    start: '2025-08-23T05:40:00Z',
    interval: 3,
    model: 'ride',
    power: 235,
    stops: [{ at: 0.47, minutes: 5 }]
  },
  {
    id: 'bright-angel',
    name: 'Bright Angel Trail',
    desc: 'From the South Rim trailhead down to the Colorado River, Grand Canyon, Arizona, USA.',
    type: 'hiking',
    osm: { type: 'way', id: 1181890945 },
    query:
      'way["highway"]["name"="Bright Angel Trail"](35.95,-112.25,36.15,-112.05)',
    from: { name: 'Bright Angel Trailhead', lat: 36.0575, lon: -112.1437 },
    to: { name: 'Colorado River', lat: 36.0984, lon: -112.1102 },
    start: '2025-04-12T13:05:00Z',
    interval: 6,
    model: 'hike',
    pace: 0.88,
    stops: [
      { at: 0.3, minutes: 9 },
      { at: 0.62, minutes: 22 }
    ]
  }
]

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Deterministic PRNG (mulberry32). */
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash(text) {
  let h = 2166136261
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619)
  return h >>> 0
}

/** Smooth noise: a damped random walk in [-1, 1]. */
function walker(rand, damping = 0.92) {
  let value = 0
  return () => {
    value = value * damping + (rand() * 2 - 1) * (1 - damping) * 2.2
    return Math.max(-1, Math.min(1, value))
  }
}

const R = 6371008.8
const toRad = (deg) => (deg * Math.PI) / 180

function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Moves `meters` east and north of `p`. */
function offset(p, east, north) {
  return {
    lat: p.lat + (north / R) * (180 / Math.PI),
    lon: p.lon + (east / (R * Math.cos(toRad(p.lat)))) * (180 / Math.PI)
  }
}

async function cached(name, load) {
  const file = new URL(name, CACHE)
  try {
    return await readFile(file)
  } catch {
    const data = await load()
    await mkdir(new URL('.', file), { recursive: true })
    await writeFile(file, data)
    return data
  }
}

// ---------------------------------------------------------------- Overpass

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
]

async function overpass(query) {
  const body = `[out:json][timeout:120];${query}`
  const data = await cached(
    `overpass-${hash(body).toString(16)}.json`,
    async () => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const url = OVERPASS[attempt % OVERPASS.length]
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'User-Agent': USER_AGENT,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `data=${encodeURIComponent(body)}`
          })
          const text = await response.text()
          if (response.ok && text.trimStart().startsWith('{')) return text
          console.warn(`  overpass ${response.status} from ${url}, retrying`)
        } catch (error) {
          console.warn(`  overpass ${error.message} from ${url}, retrying`)
        }
        await sleep(2500 * (attempt + 1))
      }
      throw new Error('Overpass API unavailable')
    }
  )
  return JSON.parse(data.toString())
}

// ---------------------------------------------------------------- elevation

const DEM_ZOOM = 14

/** Minimal PNG decoder (8-bit, non-interlaced, gray/RGB/RGBA). */
function decodePng(buffer) {
  let position = 8
  let width = 0
  let height = 0
  let channels = 0
  const chunks = []
  while (position < buffer.length) {
    const length = buffer.readUInt32BE(position)
    const type = buffer.toString('ascii', position + 4, position + 8)
    const data = buffer.subarray(position + 8, position + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const [bitDepth, colorType, , , interlace] = data.subarray(8, 13)
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
      if (bitDepth !== 8 || interlace !== 0 || !channels) {
        throw new Error(
          `Unsupported PNG (depth ${bitDepth}, type ${colorType})`
        )
      }
    } else if (type === 'IDAT') chunks.push(data)
    else if (type === 'IEND') break
    position += 12 + length
  }

  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels] : 0
      const b = y > 0 ? pixels[row - stride + x] : 0
      const c = x >= channels && y > 0 ? pixels[row - stride + x - channels] : 0
      let value = raw[line + x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      pixels[row + x] = value & 255
    }
  }
  return { width, height, channels, pixels }
}

const demTiles = new Map()

/** Runs at most 6 downloads at a time. */
let running = 0
const queue = []
async function limited(task) {
  if (running >= 6) await new Promise((resolve) => queue.push(resolve))
  running++
  try {
    return await task()
  } finally {
    running--
    queue.shift()?.()
  }
}

async function demTile(x, y) {
  const key = `${x}/${y}`
  if (!demTiles.has(key)) {
    demTiles.set(
      key,
      (async () => {
        const png = await cached(`terrarium-${DEM_ZOOM}-${x}-${y}.png`, () =>
          limited(async () => {
            const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${DEM_ZOOM}/${x}/${y}.png`
            for (let attempt = 1; ; attempt++) {
              try {
                const response = await fetch(url, {
                  headers: { 'User-Agent': USER_AGENT },
                  signal: AbortSignal.timeout(30_000)
                })
                if (!response.ok) throw new Error(`${url}: ${response.status}`)
                return Buffer.from(await response.arrayBuffer())
              } catch (error) {
                if (attempt >= 5) throw error
                await sleep(1000 * attempt)
              }
            }
          })
        )
        const { width, height, channels, pixels } = decodePng(png)
        const meters = new Float32Array(width * height)
        for (let i = 0; i < meters.length; i++) {
          const p = i * channels
          meters[i] =
            pixels[p] * 256 + pixels[p + 1] + pixels[p + 2] / 256 - 32768
        }
        return { width, height, meters }
      })()
    )
  }
  return demTiles.get(key)
}

function tileFraction({ lat, lon }, zoom) {
  const n = 2 ** zoom
  const sin = Math.sin(toRad(lat))
  return {
    x: n * (lon / 360 + 0.5),
    y: n * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI))
  }
}

/** Bilinear DEM elevation in meters. */
async function elevation(point) {
  const f = tileFraction(point, DEM_ZOOM)
  const tx = Math.floor(f.x)
  const ty = Math.floor(f.y)
  const { width, height, meters } = await demTile(tx, ty)
  const px = Math.min(Math.max((f.x - tx) * width - 0.5, 0), width - 1.001)
  const py = Math.min(Math.max((f.y - ty) * height - 0.5, 0), height - 1.001)
  const x0 = Math.floor(px)
  const y0 = Math.floor(py)
  const fx = px - x0
  const fy = py - y0
  const at = (x, y) => meters[y * width + x]
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x0 + 1, y0) * fx * (1 - fy) +
    at(x0, y0 + 1) * (1 - fx) * fy +
    at(x0 + 1, y0 + 1) * fx * fy
  )
}

// ---------------------------------------------------------------- geometry

/** Graph of every OSM node of the ways; edges follow the ways. */
function buildGraph(ways) {
  const nodes = new Map()
  const node = (id, point) => {
    if (!nodes.has(id)) nodes.set(id, { id, ...point, edges: [] })
    return nodes.get(id)
  }
  for (const way of ways) {
    const ids = way.nodes ?? way.geometry.map((p) => `${p.lat},${p.lon}`)
    for (let i = 1; i < way.geometry.length; i++) {
      const a = node(ids[i - 1], way.geometry[i - 1])
      const b = node(ids[i], way.geometry[i])
      const length = haversine(a, b)
      a.edges.push({ to: b, length })
      b.edges.push({ to: a, length })
    }
  }
  const all = [...nodes.values()]
  bridgeGaps(all, 80)
  return all
}

/** Route relations often have small gaps: link dead ends to nearby other parts. */
function bridgeGaps(nodes, maxGap) {
  const component = new Map()
  for (const start of nodes) {
    if (component.has(start)) continue
    const stack = [start]
    component.set(start, start)
    while (stack.length) {
      for (const { to } of stack.pop().edges) {
        if (component.has(to)) continue
        component.set(to, start)
        stack.push(to)
      }
    }
  }
  for (const end of nodes.filter((node) => node.edges.length === 1)) {
    const others = nodes.filter(
      (node) => component.get(node) !== component.get(end)
    )
    if (!others.length) continue
    const target = nearest(others, end)
    const length = haversine(end, target)
    if (length > maxGap) continue
    end.edges.push({ to: target, length })
    target.edges.push({ to: end, length })
  }
}

function nearest(nodes, point) {
  let best = nodes[0]
  let bestDistance = Infinity
  for (const node of nodes) {
    const distance = haversine(node, point)
    if (distance < bestDistance) {
      best = node
      bestDistance = distance
    }
  }
  return best
}

function shortestPath(nodes, from, to) {
  const distance = new Map([[from, 0]])
  const previous = new Map()
  const open = new Set([from])
  while (open.size) {
    let current
    let best = Infinity
    for (const node of open) {
      const d = distance.get(node)
      if (d < best) {
        best = d
        current = node
      }
    }
    open.delete(current)
    if (current === to) break
    for (const { to: next, length } of current.edges) {
      const d = best + length
      if (d < (distance.get(next) ?? Infinity)) {
        distance.set(next, d)
        previous.set(next, current)
        open.add(next)
      }
    }
  }
  if (!previous.has(to) && from !== to)
    throw new Error('Route is not connected')
  const path = [to]
  while (path[0] !== from) path.unshift(previous.get(path[0]))
  return path.map(({ lat, lon }) => ({ lat, lon }))
}

/** Splits segments so that no two consecutive points are more than `step` m apart. */
function densify(points, step) {
  const result = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const parts = Math.ceil(haversine(a, b) / step)
    for (let k = 1; k <= parts; k++) {
      const t = k / parts
      result.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t
      })
    }
  }
  return result
}

// ---------------------------------------------------------------- motion

/** Walking speed in m/s on a grade (rise/run), Tobler's hiking function. */
const hikeSpeed = (grade, pace) =>
  ((6 * Math.exp(-3.5 * Math.abs(grade + 0.05)) * 1000) / 3600) * pace

/** Riding speed in m/s at constant power on a grade (Newton on the power balance). */
function rideSpeed(grade, power) {
  const mass = 82
  const crr = 0.005
  const cda = 0.34
  const rho = 1.05
  const theta = Math.atan(grade)
  const force = mass * 9.81 * (Math.sin(theta) + crr * Math.cos(theta))
  let v = 6
  for (let i = 0; i < 30; i++) {
    const f = force * v + 0.5 * rho * cda * v ** 3 - power * 0.97
    const df = force + 1.5 * rho * cda * v ** 2
    v = Math.max(0.8, v - f / df)
  }
  return Math.min(v, 16)
}

/**
 * Samples a GPS logger moving along `path` (with DEM elevations): one fix
 * every `interval` s, speed from the activity model, rest stops, jitter.
 */
async function record(preset, path) {
  const rand = random(hash(preset.id))
  const pace = walker(rand, 0.995)
  const jitterE = walker(rand, 0.9)
  const jitterN = walker(rand, 0.9)
  const baro = walker(rand, 0.97)

  const distance = [0]
  for (let i = 1; i < path.length; i++) {
    distance.push(distance[i - 1] + haversine(path[i - 1], path[i]))
  }

  // elevation smoothed like a barometric altimeter: a ~30 m DEM sampled along
  // switchbacks jumps between the slope above and below the road
  const window = preset.model === 'ride' ? 150 : 80
  const raw = await Promise.all(path.map((p) => elevation(p)))
  const ele = raw.map((_, i) => {
    let sum = 0
    let n = 0
    for (let k = i; k >= 0 && distance[i] - distance[k] <= window; k--) {
      sum += raw[k]
      n++
    }
    for (
      let k = i + 1;
      k < raw.length && distance[k] - distance[i] <= window;
      k++
    ) {
      sum += raw[k]
      n++
    }
    return sum / n
  })

  const total = distance.at(-1)
  const stops = preset.stops.map((stop) => ({
    ...stop,
    distance: stop.at * total
  }))

  const fixes = []
  const startTime = Date.parse(preset.start)
  let t = 0
  let s = 0
  let i = 1
  let nextFix = 0
  const fix = (point, time, meters) => {
    const sigma = preset.model === 'ride' ? 1.8 : 2.6
    const p = offset(point, jitterE() * sigma, jitterN() * sigma)
    fixes.push({
      ...p,
      ele: meters + baro() * 0.8,
      time: startTime + time * 1000
    })
  }

  while (i < path.length) {
    const segment = distance[i] - distance[i - 1]
    const grade = segment > 0 ? (ele[i] - ele[i - 1]) / segment : 0
    const base =
      preset.model === 'ride'
        ? rideSpeed(grade, preset.power)
        : hikeSpeed(grade, preset.pace)
    const speed = base * (1 + pace() * 0.12)

    // advance to the next fix or the end of the segment, whichever comes first
    const remaining = distance[i] - s
    const dt = Math.min(nextFix - t, remaining / speed)
    if (nextFix - t <= remaining / speed) {
      s += speed * dt
      t = nextFix
      const k = (s - distance[i - 1]) / (segment || 1)
      const a = path[i - 1]
      const b = path[i]
      fix(
        { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k },
        t,
        ele[i - 1] + (ele[i] - ele[i - 1]) * k
      )
      nextFix += preset.interval

      const stop = stops.find((x) => !x.done && s >= x.distance)
      if (stop) {
        stop.done = true
        const resume = t + stop.minutes * 60
        const here = fixes.at(-1)
        while (nextFix < resume) {
          fix(offset(here, jitterE() * 1.5, jitterN() * 1.5), nextFix, here.ele)
          nextFix += preset.interval
        }
        t = resume
      }
    } else {
      s = distance[i]
      t += dt
      i++
    }
  }
  fix(path.at(-1), t, ele.at(-1))
  return { fixes, distance: total }
}

// ---------------------------------------------------------------- points of interest

const POI_KINDS = [
  { key: 'mountain_pass', value: 'yes', label: 'Pass', sym: 'Summit', rank: 4 },
  { key: 'natural', value: 'peak', label: 'Peak', sym: 'Summit', rank: 4 },
  { key: 'natural', value: 'saddle', label: 'Saddle', sym: 'Summit', rank: 3 },
  {
    key: 'railway',
    value: 'station',
    label: 'Station',
    sym: 'Ground Transportation',
    rank: 3
  },
  {
    key: 'railway',
    value: 'halt',
    label: 'Station',
    sym: 'Ground Transportation',
    rank: 3
  },
  {
    key: 'place',
    value: 'village',
    label: 'Village',
    sym: 'City (Small)',
    rank: 3,
    radius: 450
  },
  {
    key: 'place',
    value: 'hamlet',
    label: 'Hamlet',
    sym: 'City (Small)',
    rank: 3,
    radius: 300
  },
  {
    key: 'place',
    value: 'locality',
    label: 'Locality',
    sym: 'Crossing',
    rank: 2,
    radius: 250
  },
  { key: 'tourism', value: 'alpine_hut', label: 'Hut', sym: 'Lodge', rank: 3 },
  {
    key: 'tourism',
    value: 'wilderness_hut',
    label: 'Hut',
    sym: 'Lodge',
    rank: 3
  },
  { key: 'tourism', value: 'hotel', label: 'Hotel', sym: 'Lodging', rank: 2 },
  {
    key: 'tourism',
    value: 'camp_site',
    label: 'Campground',
    sym: 'Campground',
    rank: 3
  },
  {
    key: 'tourism',
    value: 'viewpoint',
    label: 'Viewpoint',
    sym: 'Scenic Area',
    rank: 2
  },
  {
    key: 'natural',
    value: 'waterfall',
    label: 'Waterfall',
    sym: 'Scenic Area',
    rank: 2
  },
  {
    key: 'amenity',
    value: 'restaurant',
    label: 'Restaurant',
    sym: 'Restaurant',
    rank: 2
  },
  {
    key: 'amenity',
    value: 'shelter',
    label: 'Shelter',
    sym: 'Building',
    rank: 2
  },
  {
    key: 'amenity',
    value: 'drinking_water',
    label: 'Water',
    sym: 'Drinking Water',
    rank: 1
  },
  {
    key: 'amenity',
    value: 'toilets',
    label: 'Toilets',
    sym: 'Restroom',
    rank: 0
  }
]

function poiKind(tags) {
  return POI_KINDS.find((kind) => tags[kind.key] === kind.value)
}

async function pointsOfInterest(preset, path, total) {
  const filters = POI_KINDS.map(
    ({ key, value, radius = 100 }) =>
      `nwr(around.route:${radius})["${key}"="${value}"];`
  ).join('')
  const { elements } = await overpass(
    `${preset.query}->.route;(${filters});out center tags;`
  )

  // position along the route of each candidate
  const along = [0]
  for (let i = 1; i < path.length; i++)
    along.push(along[i - 1] + haversine(path[i - 1], path[i]))
  const candidates = elements
    .map((element) => {
      const kind = poiKind(element.tags)
      if (!kind) return undefined
      const at = element.center ?? element
      let best = 0
      let bestDistance = Infinity
      for (let i = 0; i < path.length; i += 2) {
        const d = haversine(path[i], at)
        if (d < bestDistance) {
          bestDistance = d
          best = i
        }
      }
      if (bestDistance > (kind.radius ?? 90)) return undefined
      const named = Boolean(element.tags.name)
      return {
        element: { ...element, lat: at.lat, lon: at.lon },
        kind,
        at: along[best],
        score: kind.rank + (named ? 3 : 0) - bestDistance / (kind.radius ?? 100)
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)

  const chosen = []
  for (const candidate of candidates) {
    if (chosen.length >= 7) break
    if (candidate.at < total * 0.04 || candidate.at > total * 0.96) continue
    if (chosen.some((c) => Math.abs(c.at - candidate.at) < total * 0.07))
      continue
    chosen.push(candidate)
  }
  return chosen.sort((a, b) => a.at - b.at)
}

// ---------------------------------------------------------------- GPX

const xml = (text) =>
  String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const iso = (time) =>
  new Date(Math.round(time / 1000) * 1000).toISOString().replace('.000Z', 'Z')
const coord = (p) => `lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"`

function timeAt(fixes, along, meters) {
  const index = along.findIndex((d) => d >= meters)
  return fixes[index === -1 ? fixes.length - 1 : index].time
}

function gpx(preset, { fixes, waypoints }) {
  const lats = fixes.map((p) => p.lat)
  const lons = fixes.map((p) => p.lon)
  const end = fixes.at(-1).time
  const osmUrl = `https://www.openstreetmap.org/${preset.osm.type}/${preset.osm.id}`
  const synthetic =
    preset.model === 'ride'
      ? 'Timestamps are synthesized with a constant-power cycling model'
      : "Timestamps are synthesized with Tobler's hiking function"

  const wpt = waypoints
    .map(
      (w) => `  <wpt ${coord(w)}>
    <ele>${w.ele.toFixed(1)}</ele>
    <time>${iso(w.time)}</time>
    <name>${xml(w.name)}</name>${w.desc ? `\n    <desc>${xml(w.desc)}</desc>` : ''}${w.link ? `\n    <link href="${xml(w.link)}"><text>OpenStreetMap</text></link>` : ''}
    <sym>${xml(w.sym)}</sym>
    <type>${xml(w.type)}</type>
  </wpt>`
    )
    .join('\n')

  const trkpt = fixes
    .map(
      (p) =>
        `      <trkpt ${coord(p)}><ele>${p.ele.toFixed(1)}</ele><time>${iso(p.time)}</time></trkpt>`
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="three-map-terrain gpx-viewer (scripts/make-presets.mjs)" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${xml(preset.name)}</name>
    <desc>${xml(`${preset.desc} Demo track: geometry from OpenStreetMap, elevations from AWS Terrain Tiles. ${synthetic}; this is not a real recording.`)}</desc>
    <author>
      <name>three-map-terrain</name>
      <link href="https://github.com/whidrubeld/three-map-terrain"><text>three-map-terrain</text></link>
    </author>
    <copyright author="OpenStreetMap contributors">
      <year>${new Date(end).getUTCFullYear()}</year>
      <license>https://opendatacommons.org/licenses/odbl/1-0/</license>
    </copyright>
    <link href="${osmUrl}"><text>OpenStreetMap ${preset.osm.type} ${preset.osm.id}</text></link>
    <time>${iso(end + 4 * 60 * 1000)}</time>
    <keywords>${preset.type}, demo, synthetic timing</keywords>
    <bounds minlat="${Math.min(...lats).toFixed(7)}" minlon="${Math.min(...lons).toFixed(7)}" maxlat="${Math.max(...lats).toFixed(7)}" maxlon="${Math.max(...lons).toFixed(7)}"/>
  </metadata>
${wpt}
  <trk>
    <name>${xml(preset.name)}</name>
    <type>${preset.type}</type>
    <trkseg>
${trkpt}
    </trkseg>
  </trk>
</gpx>
`
}

// ---------------------------------------------------------------- main

async function build(preset) {
  console.log(`${preset.id}: fetching ${preset.osm.type} ${preset.osm.id}`)
  const { elements } = await overpass(`${preset.query};out geom;`)
  const ways = elements.filter((e) => e.type === 'way' && e.geometry)
  const nodes = buildGraph(ways)

  const from = nearest(nodes, preset.from)
  let to
  if (preset.to === 'highest') {
    const heights = await Promise.all(nodes.map((n) => elevation(n)))
    to = nodes[heights.indexOf(Math.max(...heights))]
  } else {
    to = nearest(nodes, preset.to)
  }

  const path = densify(shortestPath(nodes, from, to), 4)
  const { fixes, distance } = await record(preset, path)

  const along = [0]
  for (let i = 1; i < fixes.length; i++)
    along.push(along[i - 1] + haversine(fixes[i - 1], fixes[i]))
  const scale = along.at(-1) / distance

  const pois = await pointsOfInterest(preset, path, distance)
  const endpoint = (point, name, time, type) => ({
    ...point,
    name,
    time,
    sym: type === 'start' ? 'Trailhead' : 'Flag, Red',
    type
  })
  const waypoints = [
    endpoint(fixes[0], preset.from.name, fixes[0].time, 'start'),
    ...pois.map(({ element, kind, at }) => ({
      lat: element.lat,
      lon: element.lon,
      name: element.tags.name ?? kind.label,
      desc: [
        kind.label,
        element.tags.ele && `${element.tags.ele} m`,
        element.tags.description
      ]
        .filter(Boolean)
        .join(' · '),
      link: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      sym: kind.sym,
      type: kind.label.toLowerCase(),
      time: timeAt(fixes, along, at * scale)
    })),
    endpoint(
      fixes.at(-1),
      preset.toName ?? preset.to.name,
      fixes.at(-1).time,
      'finish'
    )
  ]
  for (const w of waypoints) w.ele = await elevation(w)

  const file = new URL(`${preset.id}.gpx`, OUT)
  await mkdir(OUT, { recursive: true })
  await writeFile(file, gpx(preset, { fixes, waypoints }))

  const hours = (fixes.at(-1).time - fixes[0].time) / 3.6e6
  console.log(
    `  ${(distance / 1000).toFixed(2)} km, ${fixes.length} fixes, ${hours.toFixed(2)} h, ` +
      `${waypoints.length} waypoints (${pois.map((p) => p.element.tags.name ?? p.kind.label).join(', ')})`
  )
}

const only = process.argv.slice(2)
for (const preset of PRESETS) {
  if (only.length && !only.includes(preset.id)) continue
  await build(preset)
}
