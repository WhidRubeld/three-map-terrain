export class Utils {
  static tile2position(
    z: number,
    x: number,
    y: number,
    center: { x: number; y: number },
    tileSize: number
  ) {
    const offsetAtZ = (z: number) => {
      return {
        x: center.x / Math.pow(2, 10 - z),
        y: center.y / Math.pow(2, 10 - z)
      }
    }
    const offset = offsetAtZ(z)
    return {
      x: (x - center.x - (offset.x % 1) + (center.x % 1)) * tileSize,
      y: (-y + center.y + (offset.y % 1) - (center.y % 1)) * tileSize,
      z: 0
    }
  }

  static getTileKey(z: number, x: number, y: number) {
    return `${z}/${x}/${y}`
  }
}
