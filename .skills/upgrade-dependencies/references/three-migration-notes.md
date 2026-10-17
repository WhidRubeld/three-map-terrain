# three.js migration notes for this project

Breaking changes this project has already hit (r149 → r186). Source:
[three.js Migration Guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide).

## Why the old `QuadTextureMaterial` (custom `ShaderMaterial`) broke

It was a copy of the r149 Phong shader with four extra samplers. Copied shader
code depends on internal chunk names and defines, which changed:

| Release | Change                                                                                                     | Effect on a copied shader                    |
| ------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| r151    | `uv2_*` chunks removed (`aoMap`/`lightMap` no longer use `uv2`)                                            | `#include <uv2_pars_vertex>` → compile error |
| r151    | per-map UV channels (`USE_MAP` now needs `MAP_UV`, `mapTransform`, `vMapUv`)                               | defining `USE_MAP` by hand → compile error   |
| r152    | `ColorManagement.enabled = true`; `outputEncoding` → `outputColorSpace`, `Texture.encoding` → `colorSpace` | washed-out / too dark colors                 |
| r154    | `encodings_fragment` → `colorspace_fragment`, `output_fragment` → `opaque_fragment`                        | compile error                                |
| r171    | `WebGPURenderer` lives in `three/webgpu`; it has no GLSL `ShaderMaterial` support                          | material cannot work with WebGPU at all      |

The current implementation stitches the four child tiles into one
`CanvasTexture` (`SRGBColorSpace`) and uses built-in `MeshLambertMaterial` /
`MeshBasicMaterial`, so none of the above applies and it runs on both renderers.

## Example / app-level changes

| Release     | Change                                                                                               | What to do                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| r145        | `*BufferGeometry` aliases deprecated, later removed                                                  | `SphereBufferGeometry` → `SphereGeometry`; in R3F JSX `<sphereBufferGeometry>` → `<sphereGeometry>` |
| r150 / r155 | `physicallyCorrectLights` → `useLegacyLights`; physically-correct lighting is the default since r155 | drop the flag; re-tune light intensities (legacy look ≈ intensity × π)                              |
| r151        | `MapControls` moved to its own module                                                                | `import { MapControls } from 'three/addons/controls/MapControls.js'`                                |
| r152        | `renderer.outputEncoding = LinearEncoding` removed                                                   | drop it (default output is sRGB); use `outputColorSpace` if really needed                           |
| r173        | `MeshGouraudMaterial` deprecated in favour of `MeshLambertMaterial`                                  | —                                                                                                   |
| r179 / r180 | `reverseDepthBuffer` → `reversedDepthBuffer`; depth-buffer defines renamed                           | only relevant for custom renderer setups                                                            |

`three/examples/jsm/*` is still published, but prefer the `three/addons/*` alias.
