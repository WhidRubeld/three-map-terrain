export class Utils {
  static d2r = Math.PI / 180
  static r2d = 180 / Math.PI

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
    return this.r2d * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
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

  static geo2tile(geoLocation: { lat: number, lon: number }, zoom: number) {
    const maxTile = Math.pow(2, zoom)
    return {
      x: Math.abs(Math.floor(Utils.long2tile(geoLocation.lon, zoom)) % maxTile),
      y: Math.abs(Math.floor(Utils.lat2tile(geoLocation.lat, zoom)) % maxTile)
    }
  }

  static offsetAtZ = (z: number, center: { x: number; y: number }) => {
    return {
      x: center.x / Math.pow(2, 10 - z),
      y: center.y / Math.pow(2, 10 - z)
    }
  }

  static tile2position(
    z: number,
    x: number,
    y: number,
    center: { x: number; y: number },
    tileSize: number
  ) {
    const offset = this.offsetAtZ(z, center)

    return {
      x: (x - center.x - (offset.x % 1) + (center.x % 1)) * tileSize,
      y: (-y + center.y + (offset.y % 1) - (center.y % 1)) * tileSize,
      z: 0
    }
  }

  static position2tile(
    z: number,
    x: number,
    y: number,
    center: { x: number; y: number },
    tileSize: number
  ) {
    const centerPosition = Utils.tile2position(
      z,
      center.x,
      center.y,
      center,
      tileSize
    )
    const deltaX = Math.round((x - centerPosition.x) / tileSize)
    const deltaY = Math.round(-(y - centerPosition.y) / tileSize)
    return { x: deltaX + center.x, y: deltaY + center.y, z }
  }

  static getTileKey(z: number, x: number, y: number) {
    return `${z}/${x}/${y}`
  }
}
