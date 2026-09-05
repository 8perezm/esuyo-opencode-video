import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

/**
 * Video plugin for opencode-video
 * Pre-processes video to <1000x1000 + 10fps before sending as raw input_video.
 * Includes automatic fallback to extracted frames if the gateway/model drops raw video.
 */
export const VideoPlugin: Plugin = async ({ client }) => {
  // Session -> model / provider tracking, populated by the chat.message / chat.params hooks.
  // There is no SDK call that returns "the model selected in the TUI", so we capture it per session.
  // NOTE: this plugin never writes to .opencode/ — no video-plugin.json, video-plugin.md,
  // or commands/video.md are auto-created. Missing config = defaults (see README + examples/).
  const sessionModel = new Map<string, { providerID: string; modelID: string }>()
  const sessionProvider = new Map<string, { providerID: string; options: Record<string, any>; key?: string }>()

  await client.app.log({
    body: { service: "video-plugin", level: "info", message: "Video plugin initialized (preprocess <1000x1000 + 10fps)" },
  })

  return {
    // Best-effort tracking hooks: must never throw (a rejection here aborts the user's turn),
    // and must tolerate any provider shape across opencode versions (nested {info} or flat).
    "chat.message": async (input) => {
      try {
        const i: any = input
        const m = i?.model
        if (i?.sessionID && m?.providerID && m?.modelID) {
          sessionModel.set(i.sessionID, { providerID: m.providerID, modelID: m.modelID })
        }
      } catch {}
    },
    "chat.params": async (input) => {
      try {
        const i: any = input
        const sid = i?.sessionID
        if (!sid) return
        const m = i?.model ?? {}
        const p: any = i?.provider ?? {}
        const info: any = p?.info ?? p
        const providerID = m?.providerID ?? info?.id ?? p?.id
        if (m?.id && providerID) sessionModel.set(sid, { providerID, modelID: m.id })
        // model.api.url is the exact baseURL OpenCode will call for this model
        const options: Record<string, any> = { ...(p?.options ?? {}) }
        const url = m?.api?.url
        if (typeof url === "string" && url) options.baseURL = url
        sessionProvider.set(sid, { providerID, options, key: info?.key ?? p?.key })
      } catch {}
    },
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

          // Optional .opencode/video-plugin.json (never auto-created; missing = defaults).
          const defaultCfg = {
            resize: { maxWidth: 1000, maxHeight: 1000, enabled: true },
            transcode: { fps: 10, crf: 23, preset: "veryfast", codec: "libx264", pixFmt: "yuv420p", removeAudio: true },
            framesFallback: { enabled: true, fps: 0.2, width: 640, maxFrames: 6 } as any,
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

          let rawPath = args.videoPath.trim()
          // Strip surrounding quotes if LLM passed a quoted path with spaces (e.g. "\"videos/Screen Recording 2026-09-01 211638.mp4\"")
          if ((rawPath.startsWith('"') && rawPath.endsWith('"')) || (rawPath.startsWith("'") && rawPath.endsWith("'"))) {
            rawPath = rawPath.slice(1, -1)
          }
          const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve((ctx as any).directory ?? process.cwd(), rawPath)
          const prompt = args.prompt ?? "Describe what's happening in this video in detail. Include actions, text on screen, and sequence of events."
          // No hardcoded model: prefer args.model, then the session's currently selected model
          // (tracked via the chat.message hook), then env fallbacks.
          let providerID: string | undefined
          let model: string | undefined = args.model
          const tracked = sessionModel.get(ctx.sessionID)
          if (!model && tracked) {
            providerID = tracked.providerID
            model = tracked.modelID
          }
          if (!model) model = process.env.OPENCODE_MODEL ?? process.env.LLAMA_MODEL
          if (!model) {
            throw new Error(
              `No model configured. Select a model in the OpenCode TUI, pass the "model" parameter, or set OPENCODE_MODEL / LLAMA_MODEL. ` +
                (tracked ? `Tracked session model is ${tracked.providerID}/${tracked.modelID} - provider resolution failed, check the endpoint error.` : `No session model captured yet (chat.message hook has not fired for this session).`)
            )
          }

          // Resolve endpoint + API key, most reliable first:
          // 1) provider options captured for this session by the chat.params hook (exactly what OpenCode uses)
          // 2) client.provider.list() -> { all: [{ id, api, key, models }] } (fully-resolved runtime providers,
          //    including ones injected by other plugins)
          // 3) env vars
          let baseRaw: string | undefined
          let apiKey: string | undefined = process.env.OPENCODE_API_KEY ?? process.env.LLAMA_API_KEY ?? process.env.AI_GATEWAY_KEY
          const knownProviderIds = new Set<string>()
          const sp = sessionProvider.get(ctx.sessionID)
          if (sp) {
            if (!providerID) providerID = sp.providerID
            if (sp.providerID) knownProviderIds.add(sp.providerID)
            const o: any = sp.options
            baseRaw = baseRaw ?? o?.baseURL ?? o?.baseUrl ?? o?.api
            if (typeof o?.apiKey === "string" && o.apiKey && o.apiKey !== "none") apiKey = apiKey ?? o.apiKey
          }
          if (providerID) knownProviderIds.add(providerID)
          try {
            const provResp: any = await (client as any).provider?.list?.()
            const all: any[] = provResp?.data?.all ?? provResp?.all ?? []
            for (const p of all) {
              if (!p?.id) continue
              knownProviderIds.add(p.id)
              const pModelIds = Object.keys(p.models ?? {})
              const prefix = model.split("/")[0]
              if (p.id === providerID || p.id === prefix || pModelIds.includes(model) || pModelIds.includes(prefix)) {
                baseRaw = baseRaw ?? p.api ?? p.options?.baseURL
                if (typeof p.key === "string" && p.key && p.key !== "none") apiKey = apiKey ?? p.key
                if (!providerID) providerID = p.id
                break
              }
            }
          } catch (e: any) {
            await client.app.log({ body: { service: "video-plugin", level: "warn", message: `provider.list() failed: ${e.message}` } })
          }
          baseRaw = baseRaw ?? process.env.LLAMA_SERVER_URL ?? process.env.AI_GATEWAY_URL ?? process.env.OPENCODE_API_URL
          if (!baseRaw) {
            throw new Error(
              `No endpoint configured for model "${model}" (provider: ${providerID ?? "unknown"}). Set OPENCODE_API_URL, LLAMA_SERVER_URL or AI_GATEWAY_URL env, or configure a provider with a baseURL for this model in opencode.json. ` +
                `Select a video-enabled model in the OpenCode TUI.`
            )
          }
          const baseUrl = baseRaw.replace(/\/$/, "")
          const chatUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`

          // Accept both "provider/model" and bare model id; strip the provider prefix when it matches
          // a known provider (router aliases like "unsloth/Qwen3.8-27B-GGUF" must be sent as-is).
          let modelForPayload = model
          if (model.includes("/")) {
            const idx = model.indexOf("/")
            const prefix = model.slice(0, idx)
            const rest = model.slice(idx + 1)
            if (rest && knownProviderIds.has(prefix)) modelForPayload = rest
          }

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

          const res = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify(payload), signal: ctx.abort })
          const text = await res.text()
          if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 2000)}`)
          const json: any = JSON.parse(text)
          const promptTokens = json?.usage?.prompt_tokens ?? 0

          // Detect dropped video (gateway strips unknown video) – video-only mode if framesFallback disabled
          const reply: string = json?.choices?.[0]?.message?.content ?? ""
          const dropped = promptTokens < 100 && /no video was.*attached/i.test(reply)
          if (dropped) {
            const fallbackEnabled = (cfg as any).framesFallback?.enabled !== false
            if (!fallbackEnabled) {
              throw new Error(`Raw video was dropped by gateway (prompt_tokens=${promptTokens}, reply: "${reply.slice(0,200)}"). Fallback to frames is disabled (set .opencode/video-plugin.json framesFallback.enabled=true to allow pictures). Use a video-capable model (qwen3-vl, gpt-4o, gemini-*) or enable fallback. Preprocessed video kept at ${outPath}.`)
            }
            await client.app.log({ body: { service: "video-plugin", level: "warn", message: "Raw video dropped, falling back to frames from preprocessed file", extra: { promptTokens } } })
            const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-video-frames-"))
            try {
              const fbFps = cfg.framesFallback.fps ?? 0.2
              const fbW = (cfg as any).framesFallback.width ?? 640
              const fbMax = (cfg as any).framesFallback.maxFrames ?? 6
              await execFileAsync("ffmpeg", ["-y", "-i", outPath, "-vf", `fps=${fbFps},scale=${fbW}:-2`, "-frames:v", String(fbMax), path.join(tmpDir, "frame%02d.jpg")])
              const files = (await fs.readdir(tmpDir)).filter(f => f.endsWith(".jpg")).sort()
              const b64s: string[] = []
              for (const f of files) b64s.push((await fs.readFile(path.join(tmpDir, f))).toString("base64"))
              const content: any[] = [
                { type: "text", text: `${prompt}\n\nThese are ${b64s.length} frames from preprocessed video (${outW}x${outH}, ${targetFps}fps).` },
                ...b64s.map(b => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b}` } })),
              ]
              const payload2 = { model: modelForPayload, messages: [{ role: "user", content }], max_tokens: 2048, temperature: 0.2 }
              const res2 = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify(payload2), signal: ctx.abort })
              const t2 = await res2.text()
              if (!res2.ok) throw new Error(t2.slice(0, 2000))
              const j2 = JSON.parse(t2)
              const m2: any = j2?.choices?.[0]?.message
              const out2: string = typeof m2?.content === "string" && m2.content.trim() !== ""
                ? m2.content
                : (typeof m2?.reasoning_content === "string" && m2.reasoning_content.trim() !== "" ? `[model returned reasoning only]\n${m2.reasoning_content}` : JSON.stringify(j2, null, 2))
              return `Preprocessed video saved to ${outPath} (${outW}x${outH}, ${targetFps}fps, ${Math.round(outStat.size/1024)}KB) but raw was dropped, so sent as ${b64s.length} frames. Result:\n\n${out2}`
            } finally {
              try { const files = await fs.readdir(tmpDir); await Promise.all(files.map(f => fs.unlink(path.join(tmpDir, f)))); await fs.rmdir(tmpDir) } catch {}
            }
          }

          const content = json?.choices?.[0]?.message?.content
          const reasoning = json?.choices?.[0]?.message?.reasoning_content
          const result = typeof content === "string" && content.trim() !== ""
            ? content
            : (typeof reasoning === "string" && reasoning.trim() !== "" ? `[model returned reasoning only]\n${reasoning}` : JSON.stringify(json, null, 2))
          return `Preprocessed video saved to ${outPath} (${outW}x${outH}, ${targetFps}fps, ${Math.round(outStat.size/1024)}KB, prompt_tokens=${promptTokens}). Model output:\n\n${result}`
        },
      }),
    },
  }
}

// Default export for opencode npm loader (readV1Plugin expects { server }) and legacy loader dedup handling.
// Named export VideoPlugin remains for direct import.
export default VideoPlugin
