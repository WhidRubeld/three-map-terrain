import {
  mapboxStreetsTreeProperties,
  openMapTilesTreeProperties,
  protomapsTreeProperties,
  readTrees,
  shortbreadTreeProperties,
  type TreeFeature,
  type TreeProperties
} from './features'
import { overpassTreesQuery, treesFromOverpass } from './osm'
import {
  type FeatureSchema,
  type FeatureSourceProps,
  TileFeatureSource
} from '../../sources/feature-source'

export type TreeSourceProps = FeatureSourceProps<TreeFeature, TreeProperties>

/** How the trees are read from each source. */
export const treeSchema: FeatureSchema<TreeFeature, TreeProperties> = {
  name: 'TreeSource',
  vectorTiles: {
    openmaptiles: {
      layers: 'landcover',
      properties: openMapTilesTreeProperties,
      minZoom: 12
    },
    shortbread: {
      layers: 'land',
      properties: shortbreadTreeProperties,
      minZoom: 12
    },
    mapbox: {
      layers: 'landuse',
      properties: mapboxStreetsTreeProperties,
      minZoom: 12
    },
    protomaps: {
      layers: ['landcover', 'landuse'],
      properties: protomapsTreeProperties,
      minZoom: 12
    }
  },
  read: readTrees,
  overpass: { query: overpassTreesQuery, parse: treesFromOverpass }
}

/**
 * Where the trees come from: a basemap preset `api` (its woods, shared with
 * the other layers using it), Overpass (woods and single trees), vector
 * tiles (`tiles`, `url`, `tilejson`) or a `load` function returning trees
 * (points) and woods (polygons) of a tile.
 */
export class TreeSource extends TileFeatureSource<TreeFeature, TreeProperties> {
  constructor(props: TreeSourceProps) {
    super(props, treeSchema)
  }
}
