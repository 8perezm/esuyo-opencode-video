# Project Structure

Purpose: directory layout and where to find or add code.

```
.
├── src/
│   └── index.ts              # Plugin entry, VideoPlugin + send_video tool (src/index.ts:1)
├── dist/                     # Build output (tsc -> dist/index.js + index.d.ts), published, gitignored
├── examples/
│   ├── video-plugin.json     # Example config for .opencode/video-plugin.json (examples/video-plugin.json:1)
│   └── video-command.md      # Slash command template for .opencode/commands/video.md (examples/video-command.md:1)
├── scripts/
│   ├── test-video.mjs        # Dev probe for raw input_video (env-only, no secrets)
│   ├── test-frames.mjs       # Dev probe for image_url frames fallback
│   └── test-video.ps1        # PowerShell raw video probe
├── .github/
│   └── workflows/publish.yml # npm publish on push to main/master, version bump, tag, release
├── package.json              # Package manifest, @esuyo/esuyo-opencode-video, exports "." and "./server" -> dist/index.js
├── tsconfig.json             # Strict TS, target ES2022, module ESNext, outDir dist, rootDir src
├── .gitignore                # node_modules, dist, *.mp4, .opencode/node_modules
├── README.md                 # User-facing docs (install, config, usage)
└── LICENSE                   # MIT
```

## Conventions

- **Source:** single file `src/index.ts` keeps the plugin simple; split only if adding multiple tools.
- **Build:** `npm run build` (`tsc -p tsconfig.json:1`) emits to `dist/`. `package.json:18` `files` ships only `dist` + `README.md` + `LICENSE`.
- **Config (user project):** `.opencode/video-plugin.json` is not in this repo; plugin creates it as `{}` on first load (`src/index.ts:16-21`). Users copy `examples/video-plugin.json` if they want overrides.
- **Commands (user project):** `.opencode/commands/video.md` is not shipped; users copy `examples/video-command.md`.
- **Scripts:** dev helpers, not published, all env-based (see `scripts/test-video.mjs:10`).
- **No .opencode in repo:** intentionally removed after npm migration; the consumed package is `@esuyo/esuyo-opencode-video` via `opencode.json:19` `plugin` array.
