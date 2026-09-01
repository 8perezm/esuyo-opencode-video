import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

/**
 * Video plugin for opencode-video
 * Pre-processes video to <1000x1000 + 10fps before sending as raw input_video.
 * Includes automatic fallback to extracted frames if the gateway/model drops raw video.
 */
export const VideoPlugin: Plugin = async ({ client }) => {
  // Ensure .opencode/video-plugin.json exists (valid JSON, no comments) and .opencode/video-plugin.md docs exist
  try {
    const fs = await import("node:fs/promises")
    const fssync = await import("node:fs")
    const path = await import("node:path")
    const jsonPath = path.resolve(process.cwd(), ".opencode", "video-plugin.json")
    const mdPath = path.resolve(process.cwd(), ".opencode", "video-plugin.md")
    if (!fssync.existsSync(jsonPath) || (await fs.readFile(jsonPath, "utf8")).trim() === "") {
      await fs.mkdir(path.dirname(jsonPath), { recursive: true })
      await fs.writeFile(jsonPath, "{}\n", "utf8")
      await client.app.log({ body: { service: "video-plugin", level: "info", message: "Created .opencode/video-plugin.json (empty, defaults active)" } })
    }
    if (!fssync.existsSync(mdPath)) {
      // md docs are maintained separately - not auto-overwritten if exists
      await client.app.log({ body: { service: "video-plugin", level: "info", message: "video-plugin.md docs missing - see .opencode/video-plugin.md" } })
    }
  } catch (e: any) {
    await client.app.log({ body: { service: "video-plugin", level: "warn", message: `Could not ensure video-plugin.json: ${e.message}` } })
  }

  await client.app.log({
    body: { service: "video-plugin", level: "info", message: "Video plugin initialized (preprocess <1000x1000 + 10fps)" },
  })

  return {
    tool: {
      send_video: tool({
        description:
          "Send video to any video-enabled vision model after preprocessing: checks dimensions via ffprobe, resizes to <1000x1000 if larger (scale=1000:1000:force_original_aspect_ratio=decrease), transcodes to 10fps and saves to new file, then sends that file as raw input_video. Works with any OpenAI-compatible endpoint that accepts input_video.",
        args: {
          videoPath: tool.schema.string().describe("Path to video, relative to project root or absolute. e.g. ./screen.mp4"),
          prompt: tool.schema.string().optional().describe("Instruction, e.g. 'Describe what happens'"),
          model: tool.schema.string().optional().describe("Model ID to use (must support video, e.g. qwen3-vl-8b, gpt-4o, gemini-2.5-flash). If omitted, uses the model currently selected in OpenCode."),
          keepOriginalFps: tool.schema.boolean().optional().describe("If true, do not force 10fps (default false = force 10fps)"),
        },
        async execute(args, ctx) {
          const fs = await import("node:fs/promises")
          const fssync = await import("node:fs")
          const path = await import("node:path")
          const os = await import("node:os")
          const { execFile } = await import("node:child_process")
          const { promisify } = await import("node:util")
          const execFileAsync = promisify(execFile)

          // Load .opencode/video-plugin.json (resize/fps configurable)
          const defaultCfg = {
            resize: { maxWidth: 1000, maxHeight: 1000, enabled: true },
            transcode: { fps: 10, crf: 23, preset: "veryfast", codec: "libx264", pixFmt: "yuv420p", removeAudio: true },
            framesFallback: { fps: 0.2, width: 640, maxFrames: 6 },
            naming: { suffix: "_1000_10fps" },
          }
          let cfg: typeof defaultCfg = defaultCfg
          try {
            const cfgPath = path.resolve((ctx as any).directory ?? process.cwd(), ".opencode", "video-plugin.json")
            if (fssync.existsSync(cfgPath)) {
              const raw = await fs.readFile(cfgPath, "utf8")
              const parsed = JSON.parse(raw.trim() || "{}")
              cfg = {
                resize: { ...defaultCfg.resize, ...parsed.resize },
                transcode: { ...defaultCfg.transcode, ...parsed.transcode },
                framesFallback: { ...defaultCfg.framesFallback, ...parsed.framesFallback },
                naming: { ...defaultCfg.naming, ...parsed.naming },
              }
              await client.app.log({ body: { service: "video-plugin", level: "info", message: `Loaded video-plugin.json`, extra: cfg as any } })
            }
          } catch (e: any) {
            await client.app.log({ body: { service: "video-plugin", level: "warn", message: `Failed to load video-plugin.json, using defaults: ${e.message}` } })
          }

          const rawPath = args.videoPath
          const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve((ctx as any).directory ?? process.cwd(), rawPath)
          const prompt = args.prompt ?? "Describe what's happening in this video in detail. Include actions, text on screen, and sequence of events."
          // No hardcoded model - use caller's selection. Fall back to env or session model via client.config if not provided.
          let model = args.model
          if (!model) {
            try {
              const cfg: any = await (client as any).config?.get?.()
              model = cfg?.model ?? cfg?.defaultModel ?? process.env.OPENCODE_MODEL
            } catch {}
          }
          if (!model) model = process.env.OPENCODE_MODEL ?? process.env.LLAMA_MODEL
          if (!model) {
            throw new Error(
              `No model configured. Select a video-enabled model in the OpenCode TUI or pass the "model" parameter (e.g. "qwen3-vl-8b", "gpt-4o"). ` +
                `You can also set OPENCODE_MODEL or LLAMA_MODEL env vars.`
            )
          }
          // Support both "provider/model" and bare model id
          const modelForPayload = model

          // Resolve endpoint from provider config for selected model, or env (model-agnostic)
          let baseRaw: string | undefined
          let apiKey: string | undefined = process.env.OPENCODE_API_KEY ?? process.env.LLAMA_API_KEY ?? process.env.AI_GATEWAY_KEY
          try {
            const providers: any = await (client as any).config?.providers?.()
            // providers shape: { providers: [{id, models, ...}], default: {provider:model} } or similar
            const list = providers?.providers ?? providers?.data ?? []
            for (const p of list) {
              const models = p.models ?? p.modelIds ?? []
              if (models.includes?.(model) || p.id === model.split("/")[0] || model.startsWith(p.id + "/")) {
                baseRaw = p.baseURL ?? p.baseUrl ?? p.url ?? p.endpoint
                apiKey = apiKey ?? p.apiKey ?? p.api_key ?? p.key
                break
              }
            }
            // also check env-named provider
            if (!baseRaw) {
              const cfg: any = await (client as any).config?.get?.()
              baseRaw = cfg?.provider?.baseURL ?? cfg?.providers?.[model.split("/")[0]]?.baseURL
            }
          } catch {}
          baseRaw = baseRaw ?? process.env.LLAMA_SERVER_URL ?? process.env.AI_GATEWAY_URL ?? process.env.OPENCODE_API_URL
          if (!baseRaw) {
            throw new Error(
              `No endpoint configured for model "${model}". Set OPENCODE_API_URL, LLAMA_SERVER_URL or AI_GATEWAY_URL env, or configure a provider for this model in opencode.json. ` +
                `Select a video-enabled model in the OpenCode TUI (e.g. qwen3-vl-8b, gpt-4o, gemini-2.5-flash).`
            )
          }
          const baseUrl = baseRaw.replace(/\/$/, "")
          const chatUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`

          if (!fssync.existsSync(resolved)) throw new Error(`Video not found: ${resolved} (original: ${rawPath})`)

          // --- 1. probe dimensions via ffprobe ---
          let width = 0, height = 0
          try {
            const { stdout } = await execFileAsync("ffprobe", [
              "-v", "error",
              "-select_streams", "v:0",
              "-show_entries", "stream=width,height",
              "-of", "csv=p=0:s=x",
              resolved,
            ])
            const m = stdout.trim().match(/(\d+)x(\d+)/)
            if (m) { width = parseInt(m[1], 10); height = parseInt(m[2], 10) }
          } catch (e: any) {
            await client.app.log({ body: { service: "video-plugin", level: "warn", message: `ffprobe failed, assuming resize needed: ${e.message}` } })
            width = 1920; height = 1080 // force resize path
          }

          const maxW = cfg.resize.maxWidth ?? 1000
          const maxH = cfg.resize.maxHeight ?? 1000
          const resizeEnabled = cfg.resize.enabled !== false
          const needsResize = resizeEnabled && (width > maxW || height > maxH)
          const targetFps = cfg.transcode.fps ?? 10
          const force10Fps = !args.keepOriginalFps

          await client.app.log({
            body: {
              service: "video-plugin",
              level: "info",
              message: `Probe ${path.basename(resolved)}: ${width}x${height}, needsResize=${needsResize} (max ${maxW}x${maxH}), fps=${targetFps}`,
              extra: { width, height, maxW, maxH, targetFps },
            },
          })

          // --- 2. build ffmpeg filters from video-plugin.json ---
          const filters: string[] = []
          if (force10Fps) filters.push(`fps=${targetFps}`)
          if (needsResize) filters.push(`scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease`)
          filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2")

          const vf = filters.join(",")

          // --- 3. transcode to new file (naming suffix from video-plugin.json) ---
          const dir = path.dirname(resolved)
          const ext = path.extname(resolved) || ".mp4"
          const base = path.basename(resolved, ext)
          const suffix = cfg.naming.suffix ?? `_${maxW}_${targetFps}fps`
          const outName = `${base}${suffix}${ext}`
          const outPath = path.join(dir, outName)
          const tmpPath = path.join(os.tmpdir(), `opencode-video-${Date.now()}-${outName}`)

          const ffmpegArgs = [
            "-y",
            "-i", resolved,
            "-vf", vf,
            "-c:v", cfg.transcode.codec ?? "libx264",
            "-pix_fmt", cfg.transcode.pixFmt ?? "yuv420p",
            ...(cfg.transcode.removeAudio !== false ? ["-an"] : []),
            "-r", force10Fps ? String(targetFps) : "30",
            "-crf", String(cfg.transcode.crf ?? 23),
            "-preset", cfg.transcode.preset ?? "veryfast",
            tmpPath,
          ]

          await client.app.log({ body: { service: "video-plugin", level: "info", message: `Transcoding to ${outName} with vf=${vf}`, extra: { vf, outName } } })
          try {
            await execFileAsync("ffmpeg", ffmpegArgs)
          } catch (e: any) {
            throw new Error(`ffmpeg failed (vf=${vf}): ${e.message} - is ffmpeg installed?`)
          }

          // Verify output dimensions
          let outW = 0, outH = 0, outFps = ""
          try {
            const { stdout } = await execFileAsync("ffprobe", [
              "-v", "error", "-select_streams", "v:0",
              "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate",
              "-of", "default=nw=1",
              tmpPath,
            ])
            const w = stdout.match(/width=(\d+)/)?.[1]
            const h = stdout.match(/height=(\d+)/)?.[1]
            const fps = stdout.match(/r_frame_rate=([^\s]+)/)?.[1]
            if (w) outW = parseInt(w, 10)
            if (h) outH = parseInt(h, 10)
            if (fps) outFps = fps
          } catch {}

          // Move tmp to final location (overwrite)
          await fs.copyFile(tmpPath, outPath)
          try { await fs.unlink(tmpPath) } catch {}
          const outStat = await fs.stat(outPath)
          await client.app.log({
            body: {
              service: "video-plugin",
              level: "info",
              message: `Saved preprocessed video ${outName} ${outW}x${outH} ${outFps} ${Math.round(outStat.size/1024)}KB`,
              extra: { outW, outH, outFps, size: outStat.size, outPath },
            },
          })

          // --- 4. send new file as raw input_video ---
          const bytes = await fs.readFile(outPath)
          const b64 = bytes.toString("base64")
          const outExt = path.extname(outPath).toLowerCase().replace(".", "") || "mp4"

          const headers: Record<string, string> = { "Content-Type": "application/json" }
          if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`

          const payload = {
            model: modelForPayload,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "input_video", input_video: { data: b64, format: outExt } },
              ],
            }],
            max_tokens: 2048,
            temperature: 0.2,
          }

          const res = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify(payload) })
          const text = await res.text()
          if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 2000)}`)
          const json: any = JSON.parse(text)
          const promptTokens = json?.usage?.prompt_tokens ?? 0

          // Detect dropped video (gateway strips unknown video)
          const reply: string = json?.choices?.[0]?.message?.content ?? ""
          const dropped = promptTokens < 100 && /no video was.*attached/i.test(reply)
          if (dropped) {
            await client.app.log({ body: { service: "video-plugin", level: "warn", message: "Raw video dropped, falling back to frames from preprocessed file", extra: { promptTokens } } })
            const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-video-frames-"))
            try {
              const fbFps = cfg.framesFallback.fps ?? 0.2
              const fbW = cfg.framesFallback.width ?? 640
              const fbMax = cfg.framesFallback.maxFrames ?? 6
              await execFileAsync("ffmpeg", ["-y", "-i", outPath, "-vf", `fps=${fbFps},scale=${fbW}:-2`, "-frames:v", String(fbMax), path.join(tmpDir, "frame%02d.jpg")])
              const files = (await fs.readdir(tmpDir)).filter(f => f.endsWith(".jpg")).sort()
              const b64s: string[] = []
              for (const f of files) b64s.push((await fs.readFile(path.join(tmpDir, f))).toString("base64"))
              const content: any[] = [
                { type: "text", text: `${prompt}\n\nThese are ${b64s.length} frames from preprocessed video (${outW}x${outH}, ${targetFps}fps).` },
                ...b64s.map(b => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b}` } })),
              ]
              const payload2 = { model: modelForPayload, messages: [{ role: "user", content }], max_tokens: 2048, temperature: 0.2 }
              const res2 = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify(payload2) })
              const t2 = await res2.text()
              if (!res2.ok) throw new Error(t2.slice(0, 2000))
              const j2 = JSON.parse(t2)
              const out = j2?.choices?.[0]?.message?.content
              return `Preprocessed video saved to ${outPath} (${outW}x${outH}, ${targetFps}fps, ${Math.round(outStat.size/1024)}KB) but raw was dropped, so sent as ${b64s.length} frames. Result:\n\n${typeof out === "string" ? out : JSON.stringify(j2, null, 2)}`
            } finally {
              try { const files = await fs.readdir(tmpDir); await Promise.all(files.map(f => fs.unlink(path.join(tmpDir, f)))); await fs.rmdir(tmpDir) } catch {}
            }
          }

          const content = json?.choices?.[0]?.message?.content
          const result = typeof content === "string" ? content : JSON.stringify(json, null, 2)
          return `Preprocessed video saved to ${outPath} (${outW}x${outH}, ${targetFps}fps, ${Math.round(outStat.size/1024)}KB, prompt_tokens=${promptTokens}). Model output:\n\n${result}`
        },
      }),
    },
  }
}

// Default export for opencode npm loader (readV1Plugin expects { server }) and legacy loader dedup handling.
// Named export VideoPlugin remains for direct import.
export default VideoPlugin
