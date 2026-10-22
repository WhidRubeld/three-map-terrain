// What the page shows, and its URL: an area (a preset place or any other),
// the relief, the look and the layers. Each preset is one link —
// `?place=lausanne` — and any other area too: `?lat=…&lon=…&z=14&n=5`;
// the rest is added when it differs from the area's defaults.

import { Utils } from 'three-map-terrain'

import { LAYER_NAMES, type LayerName } from './layers'
import { IMAGERY, type ImageryName, LOOKS, type LookName } from './looks'

/** An `n × n` grid of tiles at `zoom` around a location: `new Map()`'s. */
export interface Area {
  lat: number
  lon: number
  zoom: number
  /** Tiles along a side: 3 or 5. */
  size: number
}

export interface View {
  area: Area
  /** Vertical exaggeration; 1 is true to scale. */
  exaggeration: number
  look: LookName
  imagery: ImageryName
  layers: readonly LayerName[]
}

export const ZOOMS = { min: 8, max: 16 }
export const EXAGGERATIONS = ['1', '1.5', '2', '3']

export const PLACES = {
  lausanne: {
    title: 'Lausanne',
    // from Lake Geneva up to the cathedral, true to scale; bridges span
    // the Flon valley
    area: { lat: 46.515, lon: 6.632, zoom: 15, size: 3 },
    exaggeration: 1,
    look: 'plain',
    imagery: 'swisstopo',
    layers: LAYER_NAMES
  },
  alps: {
    title: 'Bernese Alps',
    // from Lake Brienz to the Aletsch Glacier
    area: { lat: 46.57634, lon: 7.9904, zoom: 11, size: 3 },
    exaggeration: 1,
    look: 'textured',
    imagery: 'swisstopo',
    layers: ['base']
  }
} satisfies Record<string, View & { title: string }>

export type PlaceName = keyof typeof PLACES

/** Areas picked on the map start out like this. */
const DEFAULTS: Omit<View, 'area'> = {
  exaggeration: 1,
  look: 'plain',
  imagery: 'sentinel',
  layers: LAYER_NAMES
}

const tileOf = ({ lat, lon, zoom }: Area) => Utils.position2tile(lat, lon, zoom)

/** The preset place whose grid the area is. */
export function placeOf(area: Area): PlaceName | undefined {
  const tile = tileOf(area)
  return (Object.keys(PLACES) as PlaceName[]).find((name) => {
    const place = PLACES[name].area
    const other = tileOf(place)
    return (
      place.zoom === area.zoom &&
      place.size === area.size &&
      other.x === tile.x &&
      other.y === tile.y
    )
  })
}

const defaultsOf = (area: Area): Omit<View, 'area'> => {
  const place = placeOf(area)
  return place ? PLACES[place] : DEFAULTS
}

/** The area's width in kilometers, to a tenth below 10. */
export function kilometers({ lat, zoom, size }: Area) {
  const km = (size * Utils.tileWidth(lat, zoom)) / 1000
  return km < 10 ? km.toFixed(1) : String(Math.round(km))
}

/** Roughly: swisstopo has photos of Switzerland and a little around it. */
export const inSwitzerland = ({ lat, lon }: Area) =>
  lat > 45.8 && lat < 47.8 && lon > 5.95 && lon < 10.5

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const oneOf = <T extends string>(
  value: string | null,
  options: Record<T, unknown>
): T | undefined =>
  value !== null && Object.hasOwn(options, value) ? (value as T) : undefined

/** The view of a URL's query; whatever it leaves out, from the area's defaults. */
export function readView(search: string): View {
  const params = new URLSearchParams(search)
  const number = (key: string) => {
    const value = Number(params.get(key) ?? NaN)
    return Number.isFinite(value) ? value : undefined
  }
  const base = PLACES[oneOf(params.get('place'), PLACES) ?? 'lausanne'].area
  const area: Area = {
    lat: clamp(number('lat') ?? base.lat, -85, 85),
    lon: clamp(number('lon') ?? base.lon, -180, 180),
    zoom: Math.round(clamp(number('z') ?? base.zoom, ZOOMS.min, ZOOMS.max)),
    size: (number('n') ?? base.size) >= 5 ? 5 : 3
  }
  const defaults = defaultsOf(area)
  const layers = params.get('layers')
  return {
    area,
    exaggeration: clamp(number('ex') ?? defaults.exaggeration, 0.5, 5),
    look: oneOf(params.get('look'), LOOKS) ?? defaults.look,
    imagery: oneOf(params.get('imagery'), IMAGERY) ?? defaults.imagery,
    layers:
      layers === null
        ? defaults.layers
        : LAYER_NAMES.filter((name) => layers.split(',').includes(name))
  }
}

/** The query of a view: `readView()` reads it back. */
export function writeView(view: View, picking: boolean): string {
  const { area } = view
  const place = placeOf(area)
  const defaults = defaultsOf(area)
  const round = (degrees: number) => Number(degrees.toFixed(5))
  const params: [string, string | number][] = place
    ? [['place', place]]
    : [
        ['lat', round(area.lat)],
        ['lon', round(area.lon)],
        ['z', area.zoom],
        ['n', area.size]
      ]
  if (view.exaggeration !== defaults.exaggeration) {
    params.push(['ex', view.exaggeration])
  }
  if (view.look !== defaults.look) params.push(['look', view.look])
  if (view.imagery !== defaults.imagery) params.push(['imagery', view.imagery])
  if (view.layers.join() !== defaults.layers.join()) {
    params.push(['layers', view.layers.join()])
  }
  const query = params.map(([key, value]) => `${key}=${value}`)
  if (picking) query.push('pick')
  return `?${query.join('&')}`
}
