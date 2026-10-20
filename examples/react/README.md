# three-map-terrain · React example

[React Three Fiber](https://r3f.docs.pmnd.rs) + [drei](https://drei.docs.pmnd.rs),
bundled with [Vite](https://vite.dev). It is the
[live example](https://whidrubeld.github.io/three-map-terrain/) on GitHub
Pages; for a full app built with the library see
[GPX Terrain](https://github.com/whidrubeld/gpx-terrain).

What it shows ([src/App.tsx](src/App.tsx)):

- **Bernese Alps** — the terrain with Sentinel-2 imagery: `new Map(...)` in
  `useMemo`, `map.init()` / `map.clean()` in an effect (safe in
  `StrictMode`), a sphere 3000 m up with `map.getPosition`, the geolocation
  of a click (`map.getLocation`) and a sphere put back exactly on the
  surface (`map.getTerrainPositionSync`).
- **Lausanne** — from Lake Geneva up to the cathedral, true to scale
  (`exaggeration: 1`, `baseAltitude: 372`), Mapterhorn elevation,
  OpenFreeMap buildings with their edges and a `TerrainBase`, set up once.
  Three looks switched at runtime with `map.setSource` / `map.setMaterial`
  — plain (no imagery), aerial (swisstopo from a URL template, in
  grayscale), wireframe — which the buildings and the base take on.
  `?place=lausanne&look=aerial` opens one directly.
- Picking a building (`buildings.pickIntersection(event)`) and highlighting it.
- **Download GLB / STL** — `map.export()`: the terrain, imagery, buildings
  and base as a model file.
- The credits of the sources in use, from `map.attributions`.

`three-map-terrain` is linked from the repository root, so build the library first:

```bash
# repository root
yarn && yarn build

# this folder
yarn
yarn dev      # http://localhost:5173
yarn build    # type-check + production build into dist/ (relative paths)
```
