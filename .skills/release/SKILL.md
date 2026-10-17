---
name: release
description: Prepare and publish a new three-map-terrain version to npm — choose the semver bump, update version and docs, verify, tag and create the GitHub release that triggers the publish workflow. Use when asked to release, publish, cut a version, or bump the package version.
---

# Release

Publishing is automated: creating a **GitHub release** runs
`.github/workflows/publish-package.yml` (`yarn validate` → `npm publish --provenance`).
Never run `npm publish` locally.

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
3. `yarn validate && yarn test:e2e`, then build both examples
   (see the `upgrade-dependencies` skill, step 5).
4. Check the package contents: `npm pack --dry-run` — only `dist/*`, `src/*`,
   `README.md`, `LICENSE`, `package.json`.

## 3. Publish (needs the user's go-ahead — it is public and irreversible)

After the PR is merged to `master`:

```bash
git checkout master && git pull
git tag v<version> && git push origin v<version>
gh release create v<version> --generate-notes
```

Then watch the workflow: `gh run watch` and confirm
`npm view three-map-terrain version` shows the new version. Pushing to
`master` also redeploys the GitHub Pages demo (`examples/basic`).
