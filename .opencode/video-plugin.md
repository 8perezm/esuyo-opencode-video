# Video Plugin Guide — `@esuyo/esuyo-opencode-video`

This project uses the `send_video` tool and `/video` slash command to send video to any video-enabled vision model (e.g. `qwen3-vl`, `gpt-4o`, `gemini-*`, local `llama.cpp` with `--mmproj`).

## Quick start

Via agent:

```
Use send_video to describe ./demo.mp4
send_video({ videoPath: "./demo.mp4", prompt: "Summarize actions in order, include on-screen text" })
```

Via slash command (TUI):

```
/video ./demo.mp4 Describe the UI actions in order
/video ./demo.mp4
```

## What the plugin does

1. Probes dimensions via `ffprobe`
2. Resizes to `<1000x1000` if larger (`scale=1000:1000:force_original_aspect_ratio=decrease`)
3. Forces `10fps` and even dimensions (`fps=10, scale=trunc(iw/2)*2:trunc(ih/2)*2`)
4. Transcodes to `<name>_1000_10fps.mp4` next to the source and sends as `input_video` to `POST {baseUrl}/v1/chat/completions`
5. If the gateway strips raw video (200 OK but `prompt_tokens` ~16 and reply contains "no video was attached"), retries automatically as `image_url` frames

## Configuration — `.opencode/video-plugin.json`

Optional file (auto-created as `{}` on first run). Override only what you need — defaults in `src/index.ts:56`:

```json
{
  "resize": { "maxWidth": 1000, "maxHeight": 1000, "enabled": true },
  "transcode": { "fps": 10, "crf": 23, "preset": "veryfast", "codec": "libx264", "pixFmt": "yuv420p", "removeAudio": true },
  "framesFallback": { "fps": 0.2, "width": 640, "maxFrames": 6 },
  "naming": { "suffix": "_1000_10fps" }
}
```

Example override (`examples/video-plugin.json`):

```json
{
  "resize": { "maxWidth": 800 },
  "transcode": { "fps": 5, "crf": 28 }
}
```

## Slash command — `/video`

File: `.opencode/commands/video.md` (auto-created on first run; not overwritten if it exists). Maps `$ARGUMENTS` to `send_video`:

- `videoPath`: first token of `$ARGUMENTS`
- `prompt`: remaining tokens, or default detailed description if none
- `model`: omit to use the model currently selected in OpenCode

To restore defaults, delete the file and restart OpenCode, or copy from `examples/video-command.md`.

## Environment / endpoint resolution

Set one of these base URLs (or configure `baseURL` for the provider that matches your selected model in `opencode.json`):

| Variable | Purpose |
|---|---|
| `OPENCODE_API_URL` / `LLAMA_SERVER_URL` / `AI_GATEWAY_URL` | Base URL of your OpenAI-compatible gateway (e.g. `https://your-gateway.example.com/v1` or `http://localhost:8080/v1`) |
| `OPENCODE_API_KEY` / `LLAMA_API_KEY` / `AI_GATEWAY_KEY` | API key for the gateway |
| `OPENCODE_MODEL` / `LLAMA_MODEL` | Fallback model ID if none is selected in the TUI |

If providers are configured in `opencode.json`, the plugin prefers the `baseURL`/`apiKey` of the provider that matches your selected model (`src/index.ts:97`).

## Prerequisites

- Node.js >=18
- `ffmpeg` and `ffprobe` on `PATH` (`ffmpeg -version`)
- A video-enabled vision model exposed via OpenAI-compatible `POST /v1/chat/completions`

## Troubleshooting

- `ffmpeg failed (vf=...) - is ffmpeg installed?` (`src/index.ts:195`) — install ffmpeg/ffprobe and ensure they are on `PATH`.
- `No endpoint configured for model "..."` (`src/index.ts:117`) — set `OPENCODE_API_URL` (or `LLAMA_SERVER_URL`/`AI_GATEWAY_URL`) or configure the provider `baseURL` in `opencode.json`.
- `No model configured` (`src/index.ts:86`) — select a model in the TUI (`/model`) or pass `model` to `send_video`, or set `OPENCODE_MODEL`.
- Video is ignored but 200 OK (`prompt_tokens` ~16, reply "no video was attached") — gateway only advertises `text,image`. Plugin falls back to frames automatically; for native raw video switch to a model with `input_modalities: ["video"]`.

This file is auto-generated on first run and never overwritten. Edit freely.
