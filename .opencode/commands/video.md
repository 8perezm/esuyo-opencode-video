---
description: Send video to vision model (auto-resize <1000x1000, 10fps)
---

Video to analyze: $ARGUMENTS

You have a tool `send_video` that will:
1. Check dimensions via ffprobe, resize to <1000x1000 if needed
2. Transcode to 10fps and save as new file (e.g. `*_1000_10fps.mp4`)
3. Send that file as `input_video` to the model

Call `send_video` with:
- `videoPath`: first argument of `$ARGUMENTS`, handling quoted paths with spaces. If `$ARGUMENTS` starts with `"` or `'`, the video path is the entire quoted string (strip the surrounding quotes). Otherwise it is the first whitespace-separated token. For example if user ran `/video "videos/Screen Recording 2026-09-01 211638.mp4" Describe the UI` use `videos/Screen Recording 2026-09-01 211638.mp4`, if `/video ./screen_3s_10fps.mp4 hello world` use first token as path and rest as prompt. Always strip surrounding quotes from videoPath.
- `prompt`: **ONLY** the remaining arguments after the videoPath (after stripping quotes). This is the *only* text sent to the vision model — do NOT prepend "Video to analyze:" or append any other instructions. If no remaining arguments, omit prompt to use the default "Describe what's happening in this video in detail. Include actions, text on screen, and sequence of events."
- `model`: DO NOT hardcode - use the model currently selected in OpenCode. If user explicitly passes a model id as last argument (contains `/`), use that. Otherwise omit `model` param so the tool uses the session's current model.

Example: `/video screen.mp4 Describe the UI` -> `send_video({videoPath:"screen.mp4", prompt:"Describe the UI"})`
Example: `/video screen.mp4` -> `send_video({videoPath:"screen.mp4"})`
Example: `/video "videos/Screen Recording 2026-09-01 211638.mp4" Describe the UI` -> `send_video({videoPath:"videos/Screen Recording 2026-09-01 211638.mp4", prompt:"Describe the UI"})`
