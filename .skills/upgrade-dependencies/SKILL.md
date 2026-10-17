---
name: upgrade-dependencies
description: Upgrade the npm dependencies of three-map-terrain (library root, examples/basic, examples/react, examples/gpx-viewer) to the latest compatible versions, resolve breaking changes (three.js releases, TypeScript, ESLint, Vite/Vitest, React Three Fiber, Tailwind CSS) and verify that rendering still works. Use when asked to update, bump or upgrade packages, refresh lockfiles, fix outdated or vulnerable dependencies, or move to a new three.js release.
---

# Upgrade dependencies

The repo has **four independent package roots**, each with its own `yarn.lock`
(Yarn classic 1.x):

| Root                  | Bundler        | Notes                                                                                    |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `.`                   | Vite (library) | `three` is a peer + dev dependency                                                       |
| `examples/basic`      | webpack        | links the library via `link:../..`                                                       |
| `examples/react`      | Vite           | React Three Fiber + drei, `link:../..`                                                   |
| `examples/gpx-viewer` | Vite           | the live demo: R3F, drei (`Html` only), TanStack Store, Tailwind 4, Vitest, `link:../..` |

The examples consume the **built** library (`dist/`), so always upgrade and
build the root first.

## 1. Inventory

```bash
yarn outdated
(cd examples/basic && yarn outdated)
(cd examples/react && yarn outdated)
(cd examples/gpx-viewer && yarn outdated)
```

For every major bump, read the peer ranges and engines **before** editing:

```bash
npm view <pkg>@latest version peerDependencies engines --json
```

Also check the pinned tooling outside `package.json`:

- `.mcp.json` — `npm view @playwright/mcp version`, `threejs-devtools-mcp`, `@upstash/context7-mcp`
- `.github/workflows/*.yml` — latest tags of `actions/checkout`, `actions/setup-node`,
  `actions/upload-artifact`, `JamesIves/github-pages-deploy-action`
  (`curl -s https://api.github.com/repos/<owner>/<repo>/releases/latest`)

## 2. Version couplings — check these first

| Coupling                                    | Rule                                                                                                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript` ↔ `typescript-eslint`          | TS must satisfy typescript-eslint's peer range. TS 7 (native compiler) ships no JS compiler API, so TS stays on `~6.0.x` until typescript-eslint supports 7. Keep the same TS line in the examples. |
| `three` ↔ `@types/three`                    | Same minor (`0.186.x` ↔ `0.186.x`) in **all four roots**.                                                                                                                                           |
| `@react-three/fiber` ↔ `react`/`react-dom`  | Fiber pins an upper bound (e.g. `>=19 <19.4`); never bump React past it. `@react-three/drei` major follows fiber's major.                                                                           |
| `vitest` ↔ `vite`, `@vitest/coverage-v8`    | Vitest lists supported Vite majors; coverage-v8 must equal the vitest version.                                                                                                                      |
| `eslint` ↔ `@eslint/js`                     | Same major.                                                                                                                                                                                         |
| `@playwright/test` ↔ browsers               | After a bump run `yarn playwright install chromium`.                                                                                                                                                |
| `tailwindcss` ↔ `@tailwindcss/vite`         | Same version (gpx-viewer); the plugin lists the Vite majors it supports. Tailwind majors change the CSS-first config (`@theme`, `@custom-variant`) in `src/index.css`.                              |
| `@tanstack/react-store` ↔ `@tanstack/store` | Same version; still 0.x, so minors may break (`createStore`, `useSelector`, `subscribe(...).unsubscribe`).                                                                                          |
| `vitest` ↔ `jsdom`                          | gpx-viewer's GPX tests run in jsdom (`// @vitest-environment jsdom`); check vitest's peer range for it.                                                                                             |
| Node                                        | CI runs Node 24. Check `engines` of vite/vitest/eslint before raising requirements.                                                                                                                 |

Record every upgrade you **cannot** do (and why) — it goes into the report and
into the "Version constraints" section of `AGENTS.md`.

## 3. Apply

Edit ranges in `package.json` (caret for most packages, tilde for `typescript`),
then run `yarn install` in that root so the lockfile follows. If the lockfile
fights back, delete `node_modules` + `yarn.lock` for that root and reinstall.

Order: root → `yarn build` → `examples/basic` → `examples/react` → `examples/gpx-viewer`.

## 4. three.js releases

1. Read every section of the [Migration Guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide)
   between the old and the new release (`rOLD` → `rNEW`).
2. The library deliberately uses only stable public API — `Group`, `Mesh`,
   `PlaneGeometry`, `MeshLambertMaterial`, `MeshBasicMaterial`,
   `MeshNormalMaterial`, `CanvasTexture`, `Texture`, `SRGBColorSpace`.
   `grep -rn "from 'three'" src` and check each import against the guide.
3. **Do not** reintroduce `ShaderMaterial` / `onBeforeCompile` / shader chunk
   includes: they break across releases and do not work with `WebGPURenderer`.
4. The examples and `playground/` use more API (controls, lights, renderer
   options) — see [three-migration-notes.md](references/three-migration-notes.md)
   for the changes this project has already gone through.
5. Keep `peerDependencies.three` honest: raise its floor if the library starts
   using a newer API.

## 5. Verify — everything must pass

```bash
yarn validate             # typecheck, lint, format:check, unit tests, build
yarn test:e2e             # real rendering in Chromium: WebGL + WebGPURenderer
(cd examples/basic && yarn install && yarn build)
(cd examples/react && yarn install && yarn build)
(cd examples/gpx-viewer && yarn install && yarn build && yarn test)
```

- After a three.js or Playwright bump, check the `backend` annotation of the
  WebGPU e2e tests: on software adapters (SwiftShader) they run
  `WebGPURenderer` with its WebGL2 backend because three's WebGPU backend
  fails there. If a new release fixes that, drop the `forceWebGL` switch in
  `e2e/render.spec.ts` (`rendererQuery`).
- The library bundle must not contain three.js: `grep -c "REVISION" dist/index.mjs` → `0`.
- Then do a visual pass with the `verify-rendering` skill (real tile servers,
  all examples), because e2e uses synthetic tiles. The GPX viewer touches the
  most three.js API (`Line2`, `Points`, view offset, material swaps at runtime).

## 6. Report

Finish with a table `package | old | new` per root, the list of blocked
upgrades with the reason, and every code change the upgrade required. Update
`AGENTS.md` if a coupling or constraint changed.
