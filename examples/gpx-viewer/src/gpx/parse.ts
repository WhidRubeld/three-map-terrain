// GPX 1.0 / 1.1 reader. Elements are matched by local name, so files with
// any (or no) namespace and vendor extensions (Garmin, Strava …) work.
// Everything read here is untrusted text: render it as text, never as HTML.

export class GpxError extends Error {}

export interface GpxPoint {
  lat: number
  lon: number
  /** meters */
  ele: number | null
  /** ms since epoch */
  time: number | null
  hr: number | null
  cad: number | null
  temp: number | null
  power: number | null
}

export interface GpxWaypoint {
  lat: number
  lon: number
  ele: number | null
  time: number | null
  name: string
  desc: string | null
  type: string | null
  sym: string | null
  link: string | null
}

export interface GpxMetadata {
  name: string | null
  desc: string | null
  author: string | null
  creator: string | null
  time: number | null
  link: string | null
  keywords: string | null
  copyright: string | null
  version: string | null
}

export interface GpxDocument {
  metadata: GpxMetadata
  /** name and type of the first track (or route) */
  name: string | null
  type: string | null
  segments: GpxPoint[][]
  waypoints: GpxWaypoint[]
}

const childrenNamed = (parent: Element | null, name: string) =>
  parent ? Array.from(parent.children).filter((c) => c.localName === name) : []

const firstChild = (parent: Element | null, name: string) =>
  parent
    ? (Array.from(parent.children).find((c) => c.localName === name) ?? null)
    : null

function textOf(parent: Element | null, name: string): string | null {
  const text = firstChild(parent, name)?.textContent?.trim()
  return text ? text : null
}

function numberOf(parent: Element | null, name: string): number | null {
  const text = textOf(parent, name)
  if (text === null) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

function timeOf(parent: Element | null): number | null {
  const text = textOf(parent, 'time')
  if (text === null) return null
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : null
}

/** Only http(s) links are kept: they end up in `href` attributes. */
function safeLink(href: string | null | undefined): string | null {
  if (!href) return null
  try {
    const url = new URL(href)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null
  } catch {
    return null
  }
}

const EXTENSIONS = {
  hr: ['hr', 'heartrate'],
  cad: ['cad', 'cadence'],
  temp: ['atemp', 'temp', 'wtemp'],
  power: ['power', 'watts']
} as const

function readExtensions(point: Element) {
  const result = { hr: null, cad: null, temp: null, power: null } as Record<
    keyof typeof EXTENSIONS,
    number | null
  >
  const extensions = firstChild(point, 'extensions')
  if (!extensions) return result
  for (const element of Array.from(extensions.getElementsByTagName('*'))) {
    const name = element.localName.toLowerCase()
    for (const [key, names] of Object.entries(EXTENSIONS) as [
      keyof typeof EXTENSIONS,
      readonly string[]
    ][]) {
      if (result[key] !== null || !names.includes(name)) continue
      const value = Number(element.textContent)
      if (element.textContent?.trim() && Number.isFinite(value))
        result[key] = value
    }
  }
  return result
}

function readLatLon(element: Element) {
  const lat = Number(element.getAttribute('lat'))
  const lon = Number(element.getAttribute('lon'))
  const valid =
    element.hasAttribute('lat') &&
    element.hasAttribute('lon') &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  return valid ? { lat, lon } : null
}

function readPoint(element: Element): GpxPoint | null {
  const position = readLatLon(element)
  if (!position) return null
  return {
    ...position,
    ele: numberOf(element, 'ele'),
    time: timeOf(element),
    ...readExtensions(element)
  }
}

function readWaypoint(element: Element, index: number): GpxWaypoint | null {
  const position = readLatLon(element)
  if (!position) return null
  return {
    ...position,
    ele: numberOf(element, 'ele'),
    time: timeOf(element),
    name: textOf(element, 'name') ?? `Waypoint ${index + 1}`,
    desc: textOf(element, 'desc') ?? textOf(element, 'cmt'),
    type: textOf(element, 'type'),
    sym: textOf(element, 'sym'),
    link: safeLink(firstChild(element, 'link')?.getAttribute('href'))
  }
}

const isDefined = <T>(value: T | null): value is T => value !== null

export function parseGpx(text: string): GpxDocument {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new GpxError('The file is not valid XML.')
  }
  const root = doc.documentElement
  if (root.localName !== 'gpx') {
    throw new GpxError('The file is not a GPX document.')
  }

  // GPX 1.1 keeps these in <metadata>, GPX 1.0 directly in <gpx>
  const meta = firstChild(root, 'metadata')
  const author = firstChild(meta, 'author')
  const metadata: GpxMetadata = {
    name: textOf(meta, 'name') ?? textOf(root, 'name'),
    desc: textOf(meta, 'desc') ?? textOf(root, 'desc'),
    author:
      textOf(author, 'name') ??
      author?.textContent?.trim() ??
      textOf(root, 'author'),
    creator: root.getAttribute('creator')?.trim() || null,
    time: timeOf(meta) ?? timeOf(root),
    link: safeLink(
      firstChild(meta, 'link')?.getAttribute('href') ?? textOf(root, 'url')
    ),
    keywords: textOf(meta, 'keywords') ?? textOf(root, 'keywords'),
    copyright:
      firstChild(meta, 'copyright')?.getAttribute('author')?.trim() || null,
    version: root.getAttribute('version')
  }
  if (metadata.author === '') metadata.author = null

  const tracks = childrenNamed(root, 'trk')
  const routes = childrenNamed(root, 'rte')
  const segments: GpxPoint[][] = []
  for (const track of tracks) {
    for (const segment of childrenNamed(track, 'trkseg')) {
      const points = childrenNamed(segment, 'trkpt')
        .map(readPoint)
        .filter(isDefined)
      if (points.length) segments.push(points)
    }
  }
  if (!segments.length) {
    for (const route of routes) {
      const points = childrenNamed(route, 'rtept')
        .map(readPoint)
        .filter(isDefined)
      if (points.length) segments.push(points)
    }
  }

  const count = segments.reduce((sum, segment) => sum + segment.length, 0)
  if (count < 2) {
    throw new GpxError(
      'The GPX file has no track or route with at least two points.'
    )
  }

  const first = tracks[0] ?? routes[0] ?? null
  return {
    metadata,
    name: textOf(first, 'name'),
    type: textOf(first, 'type'),
    segments,
    waypoints: childrenNamed(root, 'wpt').map(readWaypoint).filter(isDefined)
  }
}
