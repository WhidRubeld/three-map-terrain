// OpenStreetMap roads: tags → kind, width, bridge; Overpass API JSON → features.

import { parseLength, type Position, toNumber } from '../features'
import { type RoadAttributes, type RoadFeature, roadKind } from './features'

/** Meters per lane, for roads with `lanes` and no `width`. */
export const LANE_WIDTH = 3.5

/** Railways drawn: the tracks of trains, trams and metros. */
const RAILWAYS =
  'rail|light_rail|narrow_gauge|tram|subway|monorail|funicular|preserved'

/** `bridge=*` / `tunnel=*` other than `no`. */
const tagged = (value: string | undefined) =>
  value !== undefined && value !== 'no'

/** Kind, width, bridge and tunnel of an OSM way from its tags. */
export function osmRoadAttributes(
  tags: Readonly<Record<string, string | undefined>>
): RoadAttributes {
  const { highway, railway } = tags
  const lanes = toNumber(tags.lanes)
  return {
    kind:
      roadKind(highway) ??
      (railway !== undefined && new RegExp(`^(${RAILWAYS})$`).test(railway)
        ? 'rail'
        : undefined),
    width:
      parseLength(tags.width) ??
      (lanes !== undefined && lanes > 0 ? lanes * LANE_WIDTH : undefined),
    link: highway?.endsWith('_link') === true,
    bridge: tagged(tags.bridge),
    // a passage through a building is a street on the ground
    tunnel: tagged(tags.tunnel) && tags.tunnel !== 'building_passage',
    layer: toNumber(tags.layer),
    // squares mapped as closed ways, corridors inside buildings
    hidden: tags.area === 'yes' || tagged(tags.indoor)
  }
}

interface OverpassWay {
  type: string
  id: number
  tags?: Record<string, string>
  geometry?: ({ lat: number; lon: number } | null)[]
}

/** Roads and railways from an Overpass API `out body geom` response with ways. */
export function roadsFromOverpass(response: unknown): RoadFeature[] {
  const elements =
    (response as { elements?: OverpassWay[] } | null)?.elements ?? []
  return elements.flatMap((element): RoadFeature[] => {
    if (element.type !== 'way') return []
    const tags = element.tags ?? {}
    const { kind, hidden, ...attributes } = osmRoadAttributes(tags)
    const line = (element.geometry ?? []).flatMap((point): Position[] =>
      point ? [[point.lon, point.lat]] : []
    )
    if (!kind || hidden || line.length < 2) return []
    return [
      {
        ...attributes,
        id: `way/${element.id}`,
        geometry: { type: 'LineString', coordinates: line },
        kind,
        properties: tags
      }
    ]
  })
}

/** The Overpass QL query for the roads and railways in a bounding box. */
export function overpassRoadsQuery([
  west,
  south,
  east,
  north
]: readonly number[]) {
  const bbox = `(${south},${west},${north},${east})`
  return (
    `[out:json][timeout:60];(` +
    `way["highway"]${bbox};way["railway"~"^(${RAILWAYS})$"]${bbox};` +
    `);out body geom qt;`
  )
}
