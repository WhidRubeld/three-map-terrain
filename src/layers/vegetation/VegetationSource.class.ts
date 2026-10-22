import {
  mapboxStreetsVegetationProperties,
  openMapTilesVegetationProperties,
  protomapsVegetationProperties,
  readVegetation,
  shortbreadVegetationProperties,
  type VegetationFeature,
  type VegetationProperties
} from './features'
import { overpassVegetationQuery, vegetationFromOverpass } from './osm'
import {
  type FeatureSchema,
  type FeatureSourceProps,
  TileFeatureSource
} from '../../sources/feature-source'

export type VegetationSourceProps = FeatureSourceProps<
  VegetationFeature,
  VegetationProperties
>

/** How the woods, the scrub and single plants are read from each source. */
export const vegetationSchema: FeatureSchema<
  VegetationFeature,
  VegetationProperties
> = {
  name: 'VegetationSource',
  vectorTiles: {
    openmaptiles: {
      layers: 'landcover',
      properties: openMapTilesVegetationProperties,
      minZoom: 12
    },
    shortbread: {
      layers: 'land',
      properties: shortbreadVegetationProperties,
      minZoom: 12
    },
    mapbox: {
      layers: 'landuse',
      properties: mapboxStreetsVegetationProperties,
      minZoom: 12
    },
    protomaps: {
      layers: ['landcover', 'landuse'],
      properties: protomapsVegetationProperties,
      minZoom: 12
    }
  },
  read: readVegetation,
  overpass: { query: overpassVegetationQuery, parse: vegetationFromOverpass }
}

/**
 * Where the vegetation comes from: a basemap preset `api` (its woods and
 * scrub, shared with the other layers using it), Overpass (woods, scrub,
 * single trees and bushes), vector tiles (`tiles`, `url`, `tilejson`) or a
 * `load` function returning single plants (points) and woods or scrub
 * (polygons) of a tile.
 */
export class VegetationSource extends TileFeatureSource<
  VegetationFeature,
  VegetationProperties
> {
  constructor(props: VegetationSourceProps) {
    super(props, vegetationSchema)
  }
}
