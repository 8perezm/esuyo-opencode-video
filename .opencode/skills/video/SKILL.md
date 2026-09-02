---
name: video
description: Send a video file (mp4, mov, webm, mkv, ...) to a video-enabled vision model to describe, summarize, or analyze it. Use when the user asks to "describe this video", "analyze this screen recording", "send the video to the vision model", or similar. Preprocesses with ffprobe/ffmpeg (resize <1000x1000, force 10fps), sends as raw input_video to an OpenAI-compatible endpoint, and automatically falls back to extracted frames if the gateway drops the video.
---

# Video to Vision Model

Analyzes a video file with a vision model. This is the standalone equivalent of the
`send_video` tool from the `@esuyo/esuyo-opencode-video` plugin (same pipeline, same
config file, no slash command).

## Workflow

1. Get the video path from the user. Resolve it against the project root. If the path
   contains spaces, keep it as a single quoted argument in the shell command.
2. Build the prompt from the user's request (e.g. "Summarize the actions in order,
   including on-screen text"). If the user gave no instruction, pass no prompt — the
   script defaults to "Describe what's happening in this video in detail. Include
   actions, text on screen, and sequence of events."
3. Model selection:
   - If the user named a specific model, pass `--model <id>`.
   - Otherwise, if `MULTIMODAL_MODEL` is set in the environment, pass nothing.
   - Otherwise, pass `--model <id>` with the model currently selected in this OpenCode
     session (you know it from your own context). The model must support video
     (e.g. `qwen3-vl`, `gpt-4o`, `gemini-*`, local `llama.cpp` with `--mmproj`).
4. Run the helper script (use a generous bash timeout, e.g. 600000 ms — transcode +
   inference can be slow for long videos):

   ```bash
   node .opencode/skills/video/send-video.mjs <videoPath> [prompt] [--model <id>] [--keep-original-fps]
   ```

   On PowerShell, quote paths and prompts that contain spaces:

   ```powershell
   node .opencode/skills/video/send-video.mjs "videos/Screen Recording 2026-09-01.mp4" "Describe the UI actions in order" --model qwen3-vl-8b
   ```

5. The script prints `[send-video]` progress lines on stderr and the final result on
   stdout. Report the model's output to the user, and mention where the preprocessed
   file was saved (e.g. `videos/demo_1000_10fps.mp4`, next to the source).

## What the script does

1. Probes dimensions via `ffprobe` (assumes 1920x1080 if ffprobe fails).
2. Builds ffmpeg filters: force `10fps` (unless `--keep-original-fps`), resize to
   `<1000x1000` if larger (`scale=1000:1000:force_original_aspect_ratio=decrease`),
   force even dimensions (`scale=trunc(iw/2)*2:trunc(ih/2)*2`).
3. Transcodes to `<name>_1000_10fps.mp4` next to the source (suffix configurable).
4. Sends it as `input_video` to `POST {baseUrl}/v1/chat/completions`
   (`max_tokens: 2048`, `temperature: 0.2`).
5. If the gateway drops raw video (200 OK but `prompt_tokens` < 100 and the reply says
   "no video was attached"), retries automatically as `image_url` JPEG frames
   (0.2 fps, 640px wide, max 6 frames).

## Configuration

- Reads `.opencode/video-plugin.json` from the project root — the **same file** the
  plugin uses, so both behave identically. `{}` or missing = defaults:

  ```json
  {
    "resize": { "maxWidth": 1000, "maxHeight": 1000, "enabled": true },
    "transcode": { "fps": 10, "crf": 23, "preset": "veryfast", "codec": "libx264", "pixFmt": "yuv420p", "removeAudio": true },
    "framesFallback": { "enabled": true, "fps": 0.2, "width": 640, "maxFrames": 6 },
    "naming": { "suffix": "_1000_10fps" }
  }
  ```

- Environment variables (endpoint/model resolution, same names as the plugin):

  | Variable | Purpose |
  |---|---|
  | `MULTIMODAL_API_URL` | Base URL of your OpenAI-compatible gateway (e.g. `http://localhost:8080/v1`) |
  | `MULTIMODAL_API_KEY` | API key for the gateway |
  | `MULTIMODAL_MODEL` | Fallback model ID if `--model` is not passed |

  Unlike the plugin, this script cannot see the OpenCode session's providers, so the
  endpoint and key come only from these env vars (or the `--model` flag for the model).

## Prerequisites

- Node.js >= 18
- `ffmpeg` and `ffprobe` on `PATH` (`ffmpeg -version`)
- A video-enabled vision model behind an OpenAI-compatible `POST /v1/chat/completions`

## Troubleshooting

- `ffmpeg failed (vf=...) - is ffmpeg installed and on PATH?` — install ffmpeg/ffprobe.
- `No model configured` — pass `--model` or set `MULTIMODAL_MODEL`.
- `No endpoint configured` — set `MULTIMODAL_API_URL`.
- 200 OK but the reply says "no video was attached" (`prompt_tokens` ~16) — the model
  only accepts `text,image`. The script falls back to frames automatically; for native
  raw video use a model with `input_modalities` including `video`
  (e.g. `qwen3-vl`, `gemini-2.5-flash`).
- Output too large / too many tokens — lower `transcode.fps` or `resize.maxWidth` in
  `.opencode/video-plugin.json`.
