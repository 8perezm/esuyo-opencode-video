# Architecture

Purpose: high-level tech stack, data flow, and key modules for the `@esuyo/esuyo-opencode-video` plugin.

## Stack

- **Runtime:** Node.js >=18 (ES2022, ESM `type: module`)
- **Language:** TypeScript 5.8, strict, bundled via `tsc` to `dist/`
- **OpenCode SDK:** `@opencode-ai/plugin ^1.18.25` (`Plugin` type, `tool` helper) and `@opencode-ai/sdk` for `client.app.log`, `client.config.get`
- **External tools:** `ffmpeg` + `ffprobe` (must be on `PATH`) for probing/transcoding, `fetch` for OpenAI-compatible `POST /v1/chat/completions`
- **Package manager / installer:** npm (published), consumed by OpenCode via `bun` into `~/.cache/opencode/node_modules/`

## Plugin Type

A legacy OpenCode plugin (`src/index.ts:10` `export const VideoPlugin: Plugin`). OpenCode loads it via `PluginLoader` (`packages/opencode/src/plugin/index.ts`):

1. `readV1Plugin` checks for `default: { server: Plugin }` - not matched, falls back.
2. `getLegacyPlugins` iterates `Object.values(mod)` where `VideoPlugin` and `default` (same ref, `src/index.ts:296`) dedupe to one `Plugin` instance.
3. `Plugin` is called with `{ client, project, directory, worktree, serverUrl, $ }` and returns `Hooks { tool: { send_video } }`.

Works with both old and new loaders without requiring `Plugin.define`.

## Request Flow

```
User/TUI -> /video "path prompt"  or  agent calls send_video { videoPath, prompt, model }
       |
       v
VideoPlugin send_video.execute (src/index.ts:46)
  1. Load .opencode/video-plugin.json (src/index.ts:63) -> merged with defaults (src/index.ts:56)
  2. Resolve videoPath relative to (ctx.directory ?? cwd) (src/index.ts:81)
  3. Resolve model: args.model ?? client.config.get() -> OPENCODE_MODEL/LLAMA_MODEL (src/index.ts:84)
     Resolve endpoint: provider matching model -> baseRaw, apiKey via client.config.providers() or env
     OPENCODE_API_URL / LLAMA_SERVER_URL / AI_GATEWAY_URL + Authorization Bearer (src/index.ts:97-117)
  4. ffprobe width x height (src/index.ts:130), decide needsResize / targetFps
  5. Build ffmpeg filter chain fps + scale + even-dimension (src/index.ts:162)
  6. Transcode to tmp, ffprobe verify, copy to <base>_1000_10fps.mp4 (src/index.ts:169-226)
  7. POST {base}/v1/chat/completions with input_video { data: base64, format } (src/index.ts:228-249)
  8. If prompt_tokens <100 and reply /no video was.*attached/i -> fallback:
     ffmpeg extract frames fps=0.2 width 640 max 6 -> POST image_url[] (src/index.ts:258-283)
  9. Return formatted string with outPath metadata + model output (src/index.ts:287)
```

## Key Modules

- **src/index.ts** - single plugin file. Contains `VideoPlugin` init (ensures `.opencode/video-plugin.json` exists, logs) and `send_video` tool. All ffmpeg, fs, path, os, child_process are dynamically imported inside `execute` to keep init lightweight.
- **Config:** `.opencode/video-plugin.json` (user project, not package) - optional overrides for resize/transcode/framesFallback/naming. Defaults in `src/index.ts:56`. Example in `examples/video-plugin.json:1`.
- **Command:** `examples/video-command.md:1` - slash command template for `/video` that maps `$ARGUMENTS` to `send_video` params. Not auto-registered by plugin; users copy to `.opencode/commands/video.md`.

## Dependencies & Compatibility

- Works with any OpenAI-compatible gateway that supports `type: "input_video"` (e.g., llama.cpp server with `--mmproj`, vLLM, or hosted providers with video-enabled models like `qwen3-vl`, `gpt-4o`, `gemini-*`). If the model/gateway only advertises `input_modalities: ["text","image"]` and strips video (200 OK but `prompt_tokens` ~16), the plugin's frame fallback ensures a usable result.
- No hardcoded model or URL - all resolved from session model selection or env. See `src/index.ts:84-125`.

## Security

- API keys only via env (`OPENCODE_API_KEY`, `LLAMA_API_KEY`, `AI_GATEWAY_KEY`) or provider config - never hardcoded. See `src/index.ts:97`.
- Base64 video is sent over HTTPS to the configured `baseUrl` only.
