# three-map-terrain · React example

The minimal [React Three Fiber](https://r3f.docs.pmnd.rs) +
[drei](https://drei.docs.pmnd.rs) setup, bundled with [Vite](https://vite.dev).
It is the [live example](https://whidrubeld.github.io/three-map-terrain/) on
GitHub Pages; for a full app built with the library see
[GPX Terrain](https://github.com/whidrubeld/gpx-terrain).

What it shows ([src/App.tsx](src/App.tsx)):

- `new Map(...)` in `useMemo`, `map.init()` / `map.clean()` in an effect — safe in `StrictMode`;
- `map.terrain` as a `<primitive>`, lit by the built-in materials;
- `map.getPosition({ lat, lon, alt })` — the red sphere, 3000 m above the center;
- a click: `map.getLocation()` of the hit point, then `map.getTerrainPositionSync()`
  puts the yellow sphere back exactly on the rendered surface;
- the attribution the imagery and elevation data require.

`three-map-terrain` is linked from the repository root, so build the library first:

```bash
# repository root
yarn && yarn build

# this folder
yarn
yarn dev      # http://localhost:5173
yarn build    # type-check + production build into dist/ (relative paths)
```
