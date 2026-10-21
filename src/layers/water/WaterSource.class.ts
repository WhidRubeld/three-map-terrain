import {
  mapboxStreetsWaterProperties,
  openMapTilesWaterProperties,
  protomapsWaterProperties,
  readWater,
  shortbreadWaterProperties,
  type WaterFeature,
  type WaterProperties
} from './features'
import { overpassWaterQuery, waterFromOverpass } from './osm'
import {
  type FeatureSchema,
  type FeatureSourceProps,
  TileFeatureSource
} from '../../sources/feature-source'

export type WaterSourceProps = FeatureSourceProps<WaterFeature, WaterProperties>

/** How the water is read from each source. */
export const waterSchema: FeatureSchema<WaterFeature, WaterProperties> = {
  name: 'WaterSource',
  vectorTiles: {
    openmaptiles: {
      layers: ['water', 'waterway'],
      properties: openMapTilesWaterProperties,
      minZoom: 10
    },
    shortbread: {
      layers: ['water_polygons', 'water_lines'],
      properties: shortbreadWaterProperties,
      minZoom: 10
    },
    mapbox: {
      layers: ['water', 'waterway'],
      properties: mapboxStreetsWaterProperties,
      minZoom: 10
    },
    protomaps: {
      layers: 'water',
      properties: protomapsWaterProperties,
      minZoom: 10
    }
  },
  read: readWater,
  overpass: { query: overpassWaterQuery, parse: waterFromOverpass }
}

/**
 * Where the water comes from: a basemap preset `api` (shared with the other
 * layers using it), Overpass, vector tiles (`tiles`, `url`, `tilejson`) or
 * a `load` function returning the water of a tile, whole or clipped to it.
 */
export class WaterSource extends TileFeatureSource<
  WaterFeature,
  WaterProperties
> {
  constructor(props: WaterSourceProps) {
    super(props, waterSchema)
  }
}
