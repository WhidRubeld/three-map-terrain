// A custom building source: Overture Maps buildings — OpenStreetMap merged
// with Microsoft, Google and Esri footprints — from their PMTiles archive.
// Data without a preset plugs in the same way: a `load` for a tile.

import { PMTiles } from 'pmtiles'
import {
  BuildingSource,
  buildingsFromVectorTile,
  overtureProperties
} from 'three-map-terrain'

const RELEASES = 'https://stac.overturemaps.org/catalog.json'
const TILES =
  'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles'

// the latest release: older ones get removed
const archive = fetch(RELEASES)
  .then((response) => response.json() as Promise<{ latest: string }>)
  .then(({ latest }) => new PMTiles(`${TILES}/${latest}/buildings.pmtiles`))

export const overture = new BuildingSource({
  // the archive goes down to zoom 14; deeper terrain shares its tiles
  minZoom: 14,
  maxZoom: 14,
  attribution: '© OpenStreetMap contributors, © Overture Maps Foundation',
  async load({ z, x, y, signal }) {
    const tile = await (await archive).getZxy(z, x, y, signal)
    if (!tile) return []
    return buildingsFromVectorTile(
      tile.data,
      { z, x, y },
      {
        layers: ['building', 'building_part'],
        properties: overtureProperties
      }
    )
  }
})
