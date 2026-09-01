# Build and Deployment

Purpose: how the package is built and published to npm.

## Build

- `tsconfig.json:1` - `target ES2022`, `module ESNext`, `moduleResolution bundler`, `strict`, `declaration`, `outDir dist`, `rootDir src`
- `npm run build` (`package.json:47` `tsc -p tsconfig.json`) emits `dist/index.js`, `dist/index.d.ts`, maps.

No bundler - `dist/` is plain ESM re-exporting `@opencode-ai/plugin` helpers.

## Publish Workflow

`.github/workflows/publish.yml:1` runs on `push` to `main`/`master` and manual `workflow_dispatch`:

1. `actions/checkout@v6` + `actions/setup-node@v6` (node 22, registry `https://registry.npmjs.org`)
2. `npm ci` -> `npm run build` -> `npm run typecheck` -> `npm test`
3. Determine bump from commit message (`BREAKING CHANGE`/`major:` -> major, `feat`/`feature`/`minor:` -> minor, else patch)
4. `npm version $BUMP --no-git-tag-version`, commit `package.json`/`package-lock.json` as `chore: bump version to X [skip ci]`, tag `vX`, push
5. `npm publish --access public` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` (`package.json:53` `publishConfig.access public` for scoped `@esuyo/esuyo-opencode-video`)
6. `gh release create vX`

Requires repo secret `NPM_TOKEN` (npm access token with publish) and `GITHUB_TOKEN` (default).

## Local Publish Check

```bash
npm run build && npm pack --dry-run
# should list: README.md, LICENSE, dist/index.js, dist/index.d.ts, etc., no scripts or .opencode, size ~11KB
```

Tarball respects `package.json:18` `files`.

## Versioning

`package.json:3` current `0.1.0`. Workflow auto-bumps on every push to main. For manual release, use conventional commits.

## Git History

Local history is clean (`git log --all:1` single `eb293df`). No secrets in history after purge. If a secret was ever pushed to a remote, rotate the key and force-push clean history (`git push --force --mirror`).
