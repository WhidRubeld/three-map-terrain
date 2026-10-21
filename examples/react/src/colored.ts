// A colored model: the layers' parts each in a color of its own — on the
// beige terrain, white buildings, gray roads, olive bushes; the water and
// the trees keep their own blue and green.

import { LineBasicMaterial, type Material, MeshLambertMaterial } from 'three'

// faces under edges are pushed back, draped ones pulled in front
const underEdges = {
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1
}
const draped = {
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -4
}

/** Materials by part, for `Buildings`, `Roads` and the bushes of `Trees`. */
export const COLORED: Readonly<Record<string, Material>> = {
  walls: new MeshLambertMaterial({ color: '#f7f4ee', ...underEdges }),
  roofs: new MeshLambertMaterial({ color: '#fbfaf7', ...underEdges }),
  floors: new MeshLambertMaterial({ color: '#f7f4ee' }),
  edges: new LineBasicMaterial({ color: '#a9a296' }),
  surface: new MeshLambertMaterial({ color: '#9d9b97', ...draped }),
  rails: new MeshLambertMaterial({ color: '#7d7872', ...draped }),
  deck: new MeshLambertMaterial({ color: '#9d9b97' }),
  structure: new MeshLambertMaterial({ color: '#d8d1c4' }),
  shrubs: new MeshLambertMaterial({ color: '#8f9a55' })
}
