// The layers, made once: switched on and off by adding them to the map and
// removing them, and moved to the next map with the area. All read the
// OpenFreeMap tiles (one request per tile for all of them).

import {
  Buildings,
  FeatureLayer,
  isBush,
  type MapLayer,
  ROAD_KINDS,
  Roads,
  TerrainBase,
  Vegetation,
  Water
} from 'three-map-terrain'

import { byPart } from './looks'

const buildings = new Buildings({
  source: { api: 'openfreemap' },
  edges: true,
  material: byPart
})
const roads = new Roads({
  source: { api: 'openfreemap' },
  // streets and railways; footpaths would clutter the model
  kinds: ROAD_KINDS.filter((kind) => kind !== 'path'),
  material: byPart
})
const water = new Water({ source: { api: 'openfreemap' }, material: byPart })
// woods and scrub — not in the rivers, on the roads or in the houses the
// woods of the data take in; with those switched off, they grow back
const vegetation = new Vegetation({
  source: { api: 'openfreemap' },
  // twice as far apart a zoom level out
  spacing: (zoom, feature) =>
    (isBush(feature) ? 5 : 9) * 2 ** Math.max(0, 15 - zoom),
  avoid: [water, roads, buildings],
  // trunks are thinner than a pixel from afar: not drawn there
  maxDistance: (part) => (part === 'trunks' ? 1200 : undefined),
  material: byPart
})

export const LAYERS = {
  buildings,
  roads,
  water,
  vegetation,
  // side walls and a bottom: a solid block to print
  base: new TerrainBase()
}

export type LayerName = keyof typeof LAYERS

export const LAYER_NAMES = Object.keys(LAYERS) as LayerName[]

/** The layers draw nothing on terrain below their zoom: buildings from 13… */
export const minZoom = (layer: MapLayer) =>
  layer instanceof FeatureLayer ? layer.minZoom : 0

/** The layers with nothing to draw at a zoom. */
export const layersBelow = (zoom: number) =>
  LAYER_NAMES.filter((name) => zoom < minZoom(LAYERS[name]))
