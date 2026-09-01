# esuyo-opencode-video

> Send video to any video-enabled vision model directly from OpenCode.

A lightweight OpenCode plugin that gives your AI agents eyes for video. It adds a `send_video` tool that automatically optimizes your video with `ffmpeg` and delivers it to any OpenAI-compatible vision model that supports `input_video`. If a model or gateway doesn't yet support raw video, it seamlessly falls back to high-quality frames. Designed for developers and operators who want reliable video understanding without manual transcoding.

## Features

- **One tool, any model** — `send_video` works with any video-enabled model (`qwen3-vl`, `gpt-4o`, `gemini-*`, local `llama.cpp` with `--mmproj`, etc.) via any OpenAI-compatible endpoint
- **Automatic optimization** — probes with `ffprobe` and transcodes with `ffmpeg` to `<1000x1000` at `10fps` (configurable) for fast, token-efficient inference
- **Resilient delivery** — tries raw `input_video` first, automatically retries as `image_url` frames if the endpoint drops video
- **Zero hardcoding** — model and endpoint are resolved from your current OpenCode session or environment variables
- **Slash command ready** — `/video` command is auto-created at `.opencode/commands/video.md` on first run and maps `$ARGUMENTS` to `send_video` for quick TUI use

## Prerequisites

- Node.js >=18
- `ffmpeg` and `ffprobe` on your `PATH` (`ffmpeg -version`)
- OpenCode installed
- A video-enabled vision model exposed via an OpenAI-compatible `POST /v1/chat/completions` endpoint

## Installation

The plugin is published as `@esuyo/esuyo-opencode-video` on npm. OpenCode installs npm plugins automatically with `bun`.

1. Add the plugin to your project's `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@esuyo/esuyo-opencode-video"]
}
```

2. Restart OpenCode. It will install the package into `~/.cache/opencode/node_modules/` - no manual `npm install` needed.

**Local development:**

```jsonc
{
  "plugin": ["file:///absolute/path/to/esuyo-opencode-video"]
}
```

## Configuration

### Environment variables

Set these in your shell or `.env` - the plugin resolves them in order:

| Variable | Purpose |
|---|---|
| `OPENCODE_API_URL` / `LLAMA_SERVER_URL` / `AI_GATEWAY_URL` | Base URL of your OpenAI-compatible gateway (e.g. `https://your-gateway.example.com/v1` or `http://localhost:8080/v1`) |
| `OPENCODE_API_KEY` / `LLAMA_API_KEY` / `AI_GATEWAY_KEY` | API key for the gateway |
| `OPENCODE_MODEL` / `LLAMA_MODEL` | Fallback model ID if none is selected in the TUI |

If you have configured providers in `opencode.json`, the plugin will prefer the `baseURL`/`apiKey` of the provider that matches your selected model (`src/index.ts:97`).

### Plugin config files

On first run in any project (including an empty directory with a global plugin install), the plugin auto-creates:

- `.opencode/video-plugin.json` — `{}` (empty, defaults active)
- `.opencode/video-plugin.md` — markdown guide for this plugin (this file's usage/config docs)
- `.opencode/commands/video.md` — slash command for `/video` (not overwritten if you customize it)

All three are never overwritten if they already exist.

#### `.opencode/video-plugin.json`

Optional file. Override only what you need - defaults are in `src/index.ts:56`:

```json
{
  "resize": { "maxWidth": 1000, "maxHeight": 1000, "enabled": true },
  "transcode": { "fps": 10, "crf": 23, "preset": "veryfast", "codec": "libx264", "pixFmt": "yuv420p", "removeAudio": true },
  "framesFallback": { "fps": 0.2, "width": 640, "maxFrames": 6 },
  "naming": { "suffix": "_1000_10fps" }
}
```

Example override (`examples/video-plugin.json:1`):

```json
{
  "resize": { "maxWidth": 800 },
  "transcode": { "fps": 5, "crf": 28 }
}
```

## Quick Start / Usage

### Via agent

Ask your agent:

```
Use send_video to describe ./demo.mp4
```

Or directly:

```
send_video({ videoPath: "./demo.mp4", prompt: "Summarize the actions in order, including on-screen text" })
```

Tool params (`src/index.ts:37`):

- `videoPath` - absolute or project-relative path (e.g. `./video.mp4`)
- `prompt` - instruction (default: detailed description of actions, text, sequence)
- `model` - video-enabled model ID (e.g. `qwen3-vl-8b`). Defaults to your currently selected model
- `keepOriginalFps` - keep source fps instead of forcing 10fps

The tool will:
1. Probe dimensions, resize if needed, ensure even dimensions
2. Transcode to `<base>_1000_10fps.mp4` and save next to the source
3. Send as `input_video` to `POST {baseUrl}/v1/chat/completions`
4. If the model/gateway drops video, retry automatically with extracted frames

### Via slash command

The plugin auto-creates `.opencode/commands/video.md` on first run (works with a global `opencode.json` install in an empty directory). No manual install needed — restart OpenCode once after the first run if you just installed the plugin.

Then in the TUI:

```
/video ./demo.mp4 Describe the UI actions in order
/video ./demo.mp4
```

Manual install (only if you deleted the auto-created file or want to restore defaults):

```bash
mkdir -p .opencode/commands
cp examples/video-command.md .opencode/commands/video.md
```

### Verify it works

```bash
# Check ffmpeg
ffmpeg -version && ffprobe -version

# Run the plugin's dev probes (requires env vars)
LLAMA_SERVER_URL=http://localhost:8080/v1 LLAMA_API_KEY=... node scripts/test-video.mjs ./demo.mp4
```

You should see a new `<name>_1000_10fps.mp4` next to your source and a model description in the response.

## Troubleshooting / FAQ

**`ffmpeg failed (vf=...) - is ffmpeg installed?`** (`src/index.ts:195`)
Install ffmpeg/ffprobe and ensure they are on `PATH`.

**`No endpoint configured for model "..."`** (`src/index.ts:117`)
Set `OPENCODE_API_URL` (or `LLAMA_SERVER_URL`/`AI_GATEWAY_URL`) or configure the provider `baseURL` in `opencode.json` for that model's prefix.

**`No model configured`** (`src/index.ts:86`)
Select a model in the OpenCode TUI (`/model`) or pass `model` explicitly to `send_video`, or set `OPENCODE_MODEL`.

**Video is ignored but request returns 200 (`prompt_tokens` ~16, reply "no video was attached")**
Your model/gateway only advertises `input_modalities: ["text","image"]`. The plugin detects this and automatically falls back to `image_url` frames (`src/index.ts:258`). For native raw video, switch to a model with `input_modalities` containing `video` (e.g. `qwen3-vl`, `gemini-2.5-flash`).

**Output video is too large / too many tokens**
Lower `transcode.fps` or `resize.maxWidth` in `.opencode/video-plugin.json` (e.g. `fps: 5`, `maxWidth: 800`).

## License

MIT - see [LICENSE](./LICENSE)

## Developer Documentation

- [Architecture](./docs/architecture.md) — Tech stack and system design
- [Project Structure](./docs/project-structure.md) — Folder layout
- [Development Guide](./docs/development.md) — Local setup for contributors
- [Build and Deployment](./docs/build-and-deployment.md) — Build, CI, Docker, deployment steps
