import {
  type BuildingFeature,
  type BuildingProperties,
  mapboxStreetsProperties,
  openMapTilesProperties,
  protomapsProperties,
  readBuildings,
  shortbreadProperties
} from './features'
import { buildingsFromOverpass, overpassQuery } from './osm'
import {
  type FeatureSchema,
  type FeatureSourceProps,
  TileFeatureSource
} from '../../sources/feature-source'

export type BuildingSourceProps = FeatureSourceProps<
  BuildingFeature,
  BuildingProperties
>

/** How the buildings are read from each source. */
export const buildingSchema: FeatureSchema<
  BuildingFeature,
  BuildingProperties
> = {
  name: 'BuildingSource',
  vectorTiles: {
    openmaptiles: {
      layers: 'building',
      properties: openMapTilesProperties,
      minZoom: 13
    },
    shortbread: {
      layers: 'buildings',
      properties: shortbreadProperties,
      minZoom: 14
    },
    // all buildings are in the tiles from zoom 16, large ones from 13
    mapbox: {
      layers: 'building',
      properties: mapboxStreetsProperties,
      minZoom: 15
    },
    protomaps: {
      layers: 'buildings',
      properties: protomapsProperties,
      minZoom: 14
    }
  },
  read: readBuildings,
  overpass: { query: overpassQuery, parse: buildingsFromOverpass }
}

/**
 * Where the building footprints come from: a basemap preset `api` (shared
 * with the other layers using it), Overpass, vector tiles (`tiles`, `url`,
 * `tilejson`) or a `load` function.
 */
export class BuildingSource extends TileFeatureSource<
  BuildingFeature,
  BuildingProperties
> {
  constructor(props: BuildingSourceProps) {
    super(props, buildingSchema)
  }
}
