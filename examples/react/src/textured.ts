// A textured look: the layers' parts with materials of their own. Roads
// have UVs across (0 to 1) and along in meters, walls along and up in
// meters — so these few canvas textures repeat at true size.

import {
  CanvasTexture,
  LineBasicMaterial,
  type Material,
  MeshLambertMaterial,
  RepeatWrapping,
  SRGBColorSpace
} from 'three'

/** A repeating texture drawn on a canvas of `size` pixels. */
function pattern(
  size: number,
  meters: [across: number, along: number],
  draw: (context: CanvasRenderingContext2D) => void
) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d')
  if (context) draw(context)
  const texture = new CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 8
  texture.repeat.set(1 / meters[0], 1 / meters[1])
  return texture
}

// asphalt with a dashed center line: once across, a dash every 9 m
const asphalt = pattern(64, [1, 9], (c) => {
  c.fillStyle = '#5a5b5e'
  c.fillRect(0, 0, 64, 64)
  c.fillStyle = '#f4f1e8'
  c.fillRect(30, 0, 4, 36)
})

// ballast, a sleeper every 0.6 m, two rails
const track = pattern(64, [1, 0.6], (c) => {
  c.fillStyle = '#8a8378'
  c.fillRect(0, 0, 64, 64)
  c.fillStyle = '#5c4a3a'
  c.fillRect(10, 22, 44, 20)
  c.fillStyle = '#c9ccd1'
  c.fillRect(19, 0, 4, 64)
  c.fillRect(41, 0, 4, 64)
})

// a facade: a window every 3.5 m along the walls, a floor every 3 m
const facade = pattern(64, [3.5, 3], (c) => {
  c.fillStyle = '#ece3d3'
  c.fillRect(0, 0, 64, 64)
  c.fillStyle = '#56687a'
  c.fillRect(16, 12, 32, 34)
})

// draped on the terrain: drawn in front of it
const draped = {
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -4
}

/** Materials by part, for `Buildings`, `Roads` and the bushes of `Vegetation`. */
export const TEXTURED: Readonly<Record<string, Material>> = {
  surface: new MeshLambertMaterial({ map: asphalt, ...draped }),
  rails: new MeshLambertMaterial({ map: track, ...draped }),
  deck: new MeshLambertMaterial({ map: asphalt }),
  structure: new MeshLambertMaterial({ color: '#c8c2b6' }),
  walls: new MeshLambertMaterial({ map: facade }),
  roofs: new MeshLambertMaterial({ color: '#9a8f86' }),
  bushes: new MeshLambertMaterial({ color: '#7d8a48' }),
  // no outlines over the textures
  edges: new LineBasicMaterial({ visible: false })
}
