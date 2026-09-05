# Architecture

Purpose: high-level tech stack, data flow, and key modules for the `@esuyo/esuyo-opencode-video` plugin.

## Stack

- **Runtime:** Node.js >=18 (ES2022, ESM `type: module`)
- **Language:** TypeScript 5.8, strict, bundled via `tsc` to `dist/`
- **OpenCode SDK:** `@opencode-ai/plugin ^1.18.25` (`Plugin` type, `tool` helper) and `@opencode-ai/sdk` for `client.app.log`, `client.config.get`
- **External tools:** `ffmpeg` + `ffprobe` (must be on `PATH`) for probing/transcoding, `fetch` for OpenAI-compatible `POST /v1/chat/completions`
- **Package manager / installer:** npm (published), consumed by OpenCode via `bun` into `~/.cache/opencode/node_modules/`

## Plugin Type

A legacy OpenCode plugin (`src/index.ts` `export const VideoPlugin: Plugin`). OpenCode loads it via `PluginLoader` (`packages/opencode/src/plugin/index.ts`):

1. `readV1Plugin` checks for `default: { server: Plugin }` - not matched, falls back.
2. `getLegacyPlugins` iterates `Object.values(mod)` where `VideoPlugin` and `default` (same ref) dedupe to one `Plugin` instance.
3. `Plugin` is called with `{ client, project, directory, worktree, serverUrl, $ }` and returns `Hooks { tool: { send_video } }`.

Works with both old and new loaders without requiring `Plugin.define`.

## Request Flow

```
User/TUI -> /video "path prompt"  or  agent calls send_video { videoPath, prompt, model }
       |
       v
VideoPlugin send_video.execute (src/index.ts)
  1. Load optional .opencode/video-plugin.json if present -> merged with defaults
  2. Resolve videoPath relative to ctx.directory ?? cwd
  3. Resolve model: args.model ?? session model ?? OPENCODE_MODEL/LLAMA_MODEL
     Resolve endpoint: provider matching model -> baseRaw, apiKey via session provider / provider.list() or env
     OPENCODE_API_URL / LLAMA_SERVER_URL / AI_GATEWAY_URL + Authorization Bearer
  4. ffprobe width x height, decide needsResize / targetFps
  5. Build ffmpeg filter chain fps + scale + even-dimension
  6. Transcode to tmp, ffprobe verify, copy to <base>_1000_10fps.mp4
  7. POST {base}/v1/chat/completions with input_video { data: base64, format }
  8. If prompt_tokens <100 and reply /no video was.*attached/i -> fallback:
     ffmpeg extract frames fps=0.2 width 640 max 6 -> POST image_url[]
  9. Return formatted string with outPath metadata + model output
```

## Key Modules

- **src/index.ts** - single plugin file. Contains `VideoPlugin` init (logs only, never writes to `.opencode/`) and `send_video` tool. All ffmpeg, fs, path, os, child_process are dynamically imported inside `execute` to keep init lightweight.
- **Config:** `.opencode/video-plugin.json` (user project, not package) - optional, never auto-created; missing = defaults. Users copy `examples/video-plugin.json` if they want overrides. Defaults in `src/index.ts` (`defaultCfg`). Example in `examples/video-plugin.json`.
- **Command:** `examples/video-command.md` - slash command template for `/video` that maps `$ARGUMENTS` to `send_video` params. Optional manual copy to `.opencode/commands/video.md`; the plugin never creates it.

## Dependencies & Compatibility

- Works with any OpenAI-compatible gateway that supports `type: "input_video"` (e.g., llama.cpp server with `--mmproj`, vLLM, or hosted providers with video-enabled models like `qwen3-vl`, `gpt-4o`, `gemini-*`). If the model/gateway only advertises `input_modalities: ["text","image"]` and strips video (200 OK but `prompt_tokens` ~16), the plugin's frame fallback ensures a usable result.
- No hardcoded model or URL - all resolved from session model selection or env (see `src/index.ts` `send_video.execute`).

## Security

- API keys only via env (`OPENCODE_API_KEY`, `LLAMA_API_KEY`, `AI_GATEWAY_KEY`) or provider config - never hardcoded.
- Base64 video is sent over HTTPS to the configured `baseUrl` only.
