---
name: release
description: Prepare and publish a new three-map-terrain version to npm — choose the semver bump, update version and docs, verify, tag and create the GitHub release that triggers the publish workflow. Use when asked to release, publish, cut a version, or bump the package version.
---

# Release

Publishing is automated: publishing a **GitHub release** runs
`.github/workflows/publish-package.yml` (`yarn validate` → `npm publish --provenance`).
Never run `npm publish` locally.

There is no npm token. npm **trusted publishing** authorizes that workflow by
its filename (npmjs.com → `three-map-terrain` → Settings → Trusted publishing,
direct `npm publish` allowed) through GitHub's OIDC token, and adds provenance.
Renaming the workflow file breaks publishing until the trusted publisher is
updated on npmjs.com.

## 1. Pick the bump

Compare with the last tag (`git describe --tags --abbrev=0`, `git log <tag>..HEAD`).

- **major** — changed/removed public exports, changed behaviour of `Map`,
  `Tile`, `Source`, `Utils`, `QuadTextureMaterial`, or raised the `three` peer floor;
- **minor** — new options/exports, backwards compatible;
- **patch** — fixes only.

The public API is everything exported from `src/index.ts`.

## 2. Prepare (on a branch, then PR to `master`)

1. `package.json` → `version`.
2. `README.md` — documentation for any changed API, install/peer notes.
3. `yarn validate && yarn test:e2e`, then build both examples (see the
   `upgrade-dependencies` skill, step 5).
4. If the examples look different, refresh the README images:
   `yarn screenshots` (Google Chrome for GPU rendering, `cwebp`; 1280×800
   at 2×) and look at `docs/*.webp`.
5. Check the package contents: `npm pack --dry-run` — only `dist/` and
   `src/` (with their folders), `README.md`, `LICENSE`, `package.json`.

## 3. Publish (needs the user's go-ahead — it is public and irreversible)

After the PR is merged to `master`:

```bash
gh release create v<version> --target master --title "v<version>" --notes-file <notes.md>
```

`--target master` creates the tag on GitHub's `master`. For a major, start the
notes with the breaking changes and link the README's upgrade section;
`--generate-notes` alone only lists the commits.

Then watch the workflow: `gh run watch` and confirm
`npm view three-map-terrain version` shows the new version.

If the publish fails, nothing reached npm and the version is still free: fix
the cause and rerun the run (`gh run rerun <id>`) or start the workflow on the
tag (`gh workflow run publish-package.yml --ref v<version>`). A rerun uses the
workflow file of the tagged commit; if the fix is in the workflow itself, move
the tag: `gh release delete v<version> --cleanup-tag --yes`, then create the
release again. Pushing to
`master` also redeploys the live example on GitHub Pages (`examples/react`).

## 4. After the release

GPX Terrain ([whidrubeld/gpx-terrain](https://github.com/whidrubeld/gpx-terrain))
uses the published package and appears in the README's Examples section
(its own `docs/hero.webp`): bump `three-map-terrain` there (its `release`
skill) and, if the app looks different, refresh its screenshots.
