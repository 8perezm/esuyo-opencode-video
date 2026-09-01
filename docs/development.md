# Development Guide

Purpose: local setup for contributors.

## Prerequisites

- Node.js >=18, npm 11+
- `ffmpeg` and `ffprobe` on `PATH` (`ffmpeg -version`, `ffprobe -version`)
- Git

## Setup

```bash
npm ci
npm run build        # tsc -p tsconfig.json -> dist/
npm run typecheck    # tsc --noEmit
```

`dist/` is gitignored but included in npm tarball (`package.json:18`).

## Scripts

- `npm run build` - compile `src/index.ts` to `dist/index.js` + declarations
- `npm run typecheck` - typecheck without emit
- `npm test` - placeholder (`echo "No tests"`), workflow runs `npm test || echo skip`
- `npm pack --dry-run` - preview tarball (should list `dist/`, `README.md`, `LICENSE`, `package.json`)

Dev probes (not published, env-only):

```bash
# raw video probe
LLAMA_SERVER_URL=http://localhost:8080/v1 LLAMA_API_KEY=... LLAMA_MODEL=qwen3-vl-8b node scripts/test-video.mjs ./video.mp4 "Describe"

# frames fallback probe
LLAMA_SERVER_URL=http://localhost:8080/v1 LLAMA_API_KEY=... node scripts/test-frames.mjs ./video.mp4

# PowerShell
$env:LLAMA_SERVER_URL="http://localhost:8080"; ./scripts/test-video.ps1 -Video ./video.mp4
```

All scripts require env vars - no hardcoded secrets (see `scripts/test-video.mjs:11`).

## Testing the Plugin in OpenCode

1. Build: `npm run build`
2. In a test project, add to `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/esuyo-opencode-video"]
}
```

3. Restart OpenCode, run `/video ./path/to/video.mp4 Describe` or `send_video` via agent.

Alternative: `npm link` this package and add `"plugin": ["@esuyo/esuyo-opencode-video"]`.

## Debugging

- Plugin logs via `client.app.log` (`src/index.ts:21`, `src/index.ts:31`) appear in OpenCode logs.
- Check `ffprobe`/`ffmpeg` errors: `"ffmpeg failed (vf=...)` (`src/index.ts:195`)
- Verify config loaded: `"Loaded video-plugin.json"` (`src/index.ts:74`)

## Conventions

- Keep `src/index.ts` self-contained; dynamic imports inside `execute` for fs/path/os/child_process.
- Keep model-agnostic - never hardcode model IDs or gateway URLs; resolve via session model or `OPENCODE_*`/`LLAMA_*`/`AI_GATEWAY_*` env (`src/index.ts:84-116`).
- Update `examples/video-plugin.json` when adding config fields, and document in `README.md` + `docs/architecture.md`.
