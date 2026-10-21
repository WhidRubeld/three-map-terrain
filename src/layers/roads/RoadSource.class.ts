import {
  mapboxStreetsRoadProperties,
  openMapTilesRoadProperties,
  protomapsRoadProperties,
  readRoads,
  type RoadFeature,
  type RoadProperties,
  shortbreadRoadProperties
} from './features'
import { overpassRoadsQuery, roadsFromOverpass } from './osm'
import {
  type FeatureSchema,
  type FeatureSourceProps,
  TileFeatureSource
} from '../../sources/feature-source'

export type RoadSourceProps = FeatureSourceProps<RoadFeature, RoadProperties>

/** How the roads are read from each source. */
export const roadSchema: FeatureSchema<RoadFeature, RoadProperties> = {
  name: 'RoadSource',
  vectorTiles: {
    openmaptiles: {
      layers: 'transportation',
      properties: openMapTilesRoadProperties,
      minZoom: 12
    },
    shortbread: {
      layers: 'streets',
      properties: shortbreadRoadProperties,
      minZoom: 12
    },
    mapbox: {
      layers: 'road',
      properties: mapboxStreetsRoadProperties,
      minZoom: 12
    },
    protomaps: {
      layers: 'roads',
      properties: protomapsRoadProperties,
      minZoom: 12
    }
  },
  read: readRoads,
  overpass: { query: overpassRoadsQuery, parse: roadsFromOverpass }
}

/**
 * Where the roads come from: a basemap preset `api` (shared with the other
 * layers using it), Overpass, vector tiles (`tiles`, `url`, `tilejson`) or
 * a `load` function returning the roads of a tile, whole or clipped to it.
 */
export class RoadSource extends TileFeatureSource<RoadFeature, RoadProperties> {
  constructor(props: RoadSourceProps) {
    super(props, roadSchema)
  }
}
