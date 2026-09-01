---
description: Send video to vision model (auto-resize <1000x1000, 10fps)
---

Video to analyze: $ARGUMENTS

You have a tool `send_video` that will:
1. Check dimensions via ffprobe, resize to <1000x1000 if needed
2. Transcode to 10fps and save as new file (e.g. `*_1000_10fps.mp4`)
3. Send that file as `input_video` to the model

Call `send_video` with:
- `videoPath`: first argument of `$ARGUMENTS` (e.g. `$1` or the full `$ARGUMENTS` if no space). For example if user ran `/video screen.mp4` use `screen.mp4`, if `/video ./screen_3s_10fps.mp4 hello world` use first token as path and rest as prompt.
- `prompt`: remaining arguments as prompt, or default to "Describe what's happening in this video in detail. Include actions, text on screen, and sequence of events." if none given
- `model`: DO NOT hardcode - use the model currently selected in OpenCode. If user explicitly passes a model id as last argument (contains `/`), use that. Otherwise omit `model` param so the tool uses the session's current model.

Example: `/video screen.mp4 Describe the UI` -> `send_video({videoPath:"screen.mp4", prompt:"Describe the UI"})`
Example: `/video screen.mp4` -> `send_video({videoPath:"screen.mp4"})`

Do not hardcode baseURL or API keys - the tool will resolve the endpoint from the selected model's provider config or from env `LLAMA_SERVER_URL` / `AI_GATEWAY_URL`.

After calling the tool, summarize the model's video description for the user.

# Install

Copy this file to your project's `.opencode/commands/video.md` (create directory if missing):

```bash
mkdir -p .opencode/commands
cp examples/video-command.md .opencode/commands/video.md
```
