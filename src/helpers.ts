export const d2r = Math.PI / 180
export const r2d = 180 / Math.PI

export const point2tileFraction = (
  lon: number,
  lat: number,
  z: number
): number[] => {
  const sin = Math.sin(lat * d2r)
  const z2 = Math.pow(2, z)
  let x = z2 * (lon / 360 + 0.5)
  const y = z2 * (0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI)

  x = x % z2
  if (x < 0) x = x + z2
  return [x, y, z]
}

export const point2tile = (lon: number, lat: number, z: number): number[] => {
  const tile = point2tileFraction(lon, lat, z)
  tile[0] = Math.floor(tile[0])
  tile[1] = Math.floor(tile[1])
  return tile
}

export const tile2lon = (x: number, z: number) => {
  return (x / Math.pow(2, z)) * 360 - 180
}

export const tile2lat = (y: number, z: number) => {
  var n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z)
  return r2d * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

export const tile2bbox = (tile: number[]) => {
  const e = tile2lon(tile[0] + 1, tile[2])
  const w = tile2lon(tile[0], tile[2])
  const s = tile2lat(tile[1] + 1, tile[2])
  const n = tile2lat(tile[1], tile[2])
  return [w, s, e, n]
}
