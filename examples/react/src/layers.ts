// The layers, made once: switched on and off by adding them to the map and
// removing them, and moved to the next map with the area. All read the
// OpenFreeMap tiles (one request per tile for all of them).

import { Matrix4, Quaternion, Vector3 } from 'three'
import {
  Buildings,
  FeatureLayer,
  type MapLayer,
  openMapTilesTreeProperties,
  ROAD_KINDS,
  Roads,
  TerrainBase,
  treeShapes,
  Trees,
  type TreesOptions,
  Water
} from 'three-map-terrain'

import { byPart } from './looks'

const bush = new Matrix4()
const [position, rotation, scale] = [
  new Vector3(),
  new Quaternion(),
  new Vector3()
]

/** Scrub as bushes — the trees' crown, 2 to 4 m high, wider — woods as trees. */
const plant: TreesOptions['plant'] = (ctx, spot, feature, tree) => {
  if (feature.kind !== 'scrub') {
    tree()
    return
  }
  const height = 2 + 2 * spot.random
  const across = 0.7 * height * ctx.unitsPerMeter
  bush.compose(
    position.set(spot.x, spot.y, spot.z + 0.4 * height * ctx.zScale),
    rotation,
    scale.set(across, across, 0.5 * height * ctx.zScale)
  )
  ctx.instances('shrubs', treeShapes().crown).add(bush)
}

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
// woods and their scrub — not in the rivers, on the roads or in the houses
// the woods of the data take in; with those switched off, they grow back
const trees = new Trees({
  source: {
    api: 'openfreemap',
    // the woods, and scrub (in OpenMapTiles' grass)
    properties: (p, layer) =>
      p.subclass === 'scrub' || p.subclass === 'shrubbery'
        ? { kind: 'scrub' }
        : openMapTilesTreeProperties(p, layer)
  },
  // twice as far apart a zoom level out
  spacing: (zoom, feature) =>
    (feature.kind === 'scrub' ? 5 : 9) * 2 ** Math.max(0, 15 - zoom),
  plant,
  avoid: [water, roads, buildings],
  // trunks are thinner than a pixel from afar: not drawn there
  maxDistance: (part) => (part === 'trunks' ? 1200 : undefined),
  material: byPart
})

export const LAYERS = {
  buildings,
  roads,
  water,
  trees,
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
