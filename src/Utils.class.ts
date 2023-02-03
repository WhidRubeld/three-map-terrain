export class Utils {
  static long2tile(lon: number, zoom: number) {
    return ((lon + 180) / 360) * Math.pow(2, zoom)
  }

  static lat2tile(lat: number, zoom: number) {
    return (
      ((1 -
        Math.log(
          Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)
        ) /
          Math.PI) /
        2) *
      Math.pow(2, zoom)
    )
  }

  static tile2lat(y: number, z: number) {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z)
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  }

  static tile2lon(x: number, z: number) {
    return (x / Math.pow(2, z)) * 360 - 180
  }

  static tile2bbox(tile: number[]) {
    const e = this.tile2lon(tile[0] + 1, tile[2])
    const w = this.tile2lon(tile[0], tile[2])
    const s = this.tile2lat(tile[1] + 1, tile[2])
    const n = this.tile2lat(tile[1], tile[2])
    return [w, s, e, n]
  }

  static tile2position(
    z: number,
    x: number,
    y: number,
    center: { x: number; y: number },
    tileSize: number
  ) {
    const offset = {
      x: center.x / Math.pow(2, 10 - z),
      y: center.y / Math.pow(2, 10 - z)
    }

    return {
      x: (x - center.x - (offset.x % 1) + (center.x % 1)) * tileSize,
      y: (-y + center.y + (offset.y % 1) - (center.y % 1)) * tileSize,
      z: 0
    }
  }

  static position2tileFraction(lat: number, lon: number, z: number) {
    const sin = Math.sin(lat * (Math.PI / 180))
    const z2 = Math.pow(2, z)
    let x = z2 * (lon / 360 + 0.5)
    const y = z2 * (0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI)

    // Wrap Tile X
    x = x % z2
    if (x < 0) x = x + z2

    return { x, y, z }
  }

  static position2tile(lat: number, lon: number, z: number) {
    const tile = this.position2tileFraction(lat, lon, z)
    tile.x = Math.floor(tile.x)
    tile.y = Math.floor(tile.y)

    return tile
  }

  static getTileKey(z: number, x: number, y: number) {
    return `${z}/${x}/${y}`
  }
}
