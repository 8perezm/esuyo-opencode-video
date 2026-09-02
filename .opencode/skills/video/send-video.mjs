#!/usr/bin/env node
// Standalone version of the @esuyo/esuyo-opencode-video plugin's send_video tool.
// Preprocesses video (ffprobe probe, resize <1000x1000, force 10fps) with ffmpeg,
// then sends it as raw input_video to an OpenAI-compatible /v1/chat/completions endpoint.
// Falls back to extracted image frames if the gateway drops raw video.
//
// Usage:
//   node send-video.mjs <videoPath> [prompt] [--model <id>] [--keep-original-fps]
//
// Config: reads .opencode/video-plugin.json from the current directory (same file and
// defaults as the plugin). Environment for endpoint/model:
//   MULTIMODAL_API_URL  (base URL, e.g. http://localhost:8080/v1)
//   MULTIMODAL_API_KEY  (API key, optional)
//   MULTIMODAL_MODEL    (fallback model id)
import fs from "node:fs/promises"
import fssync from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const log = (...a) => console.error("[send-video]", ...a)
const fail = (msg) => {
  console.error(`[send-video] ERROR: ${msg}`)
  process.exit(1)
}

// --- args ---
const argv = process.argv.slice(2)
const flags = { model: undefined, keepOriginalFps: false }
const positional = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--model") {
    if (!argv[i + 1]) fail("--model requires a value")
    flags.model = argv[++i]
  } else if (a === "--keep-original-fps") {
    flags.keepOriginalFps = true
  } else if (a === "--help" || a === "-h") {
    console.log("Usage: node send-video.mjs <videoPath> [prompt] [--model <id>] [--keep-original-fps]")
    process.exit(0)
  } else {
    positional.push(a)
  }
}
const videoArg = positional[0]
if (!videoArg) fail("missing <videoPath>. Usage: node send-video.mjs <videoPath> [prompt] [--model <id>] [--keep-original-fps]")
const prompt = positional.slice(1).join(" ").trim() || "Describe what's happening in this video in detail. Include actions, text on screen, and sequence of events."

// Strip surrounding quotes if a quoted path with spaces was passed as one argument
let rawPath = videoArg.trim()
if ((rawPath.startsWith('"') && rawPath.endsWith('"')) || (rawPath.startsWith("'") && rawPath.endsWith("'"))) {
  rawPath = rawPath.slice(1, -1)
}
const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath)
if (!fssync.existsSync(resolved)) fail(`Video not found: ${resolved} (original: ${rawPath})`)

// --- config (.opencode/video-plugin.json, same defaults as the plugin) ---
const defaultCfg = {
  resize: { maxWidth: 1000, maxHeight: 1000, enabled: true },
  transcode: { fps: 10, crf: 23, preset: "veryfast", codec: "libx264", pixFmt: "yuv420p", removeAudio: true },
  framesFallback: { enabled: true, fps: 0.2, width: 640, maxFrames: 6 },
  naming: { suffix: "_1000_10fps" },
}
let cfg = defaultCfg
try {
  const cfgPath = path.resolve(process.cwd(), ".opencode", "video-plugin.json")
  if (fssync.existsSync(cfgPath)) {
    const parsed = JSON.parse((await fs.readFile(cfgPath, "utf8")).trim() || "{}")
    cfg = {
      resize: { ...defaultCfg.resize, ...parsed.resize },
      transcode: { ...defaultCfg.transcode, ...parsed.transcode },
      framesFallback: { ...defaultCfg.framesFallback, ...parsed.framesFallback },
      naming: { ...defaultCfg.naming, ...parsed.naming },
    }
    log(`loaded config ${cfgPath}`)
  }
} catch (e) {
  log(`failed to load video-plugin.json, using defaults: ${e.message}`)
}

// --- model + endpoint ---
let model = flags.model ?? process.env.MULTIMODAL_MODEL
if (!model) {
  fail('No model configured. Pass --model <id>, or set MULTIMODAL_MODEL. The model must support video (e.g. qwen3-vl, gpt-4o, gemini-*).')
}
const baseRaw = process.env.MULTIMODAL_API_URL
if (!baseRaw) {
  fail("No endpoint configured. Set MULTIMODAL_API_URL (base URL of your OpenAI-compatible gateway, e.g. http://localhost:8080/v1).")
}
const apiKey = process.env.MULTIMODAL_API_KEY
const baseUrl = baseRaw.replace(/\/$/, "")
const chatUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`
log(`video: ${resolved}`)
log(`endpoint: ${chatUrl}`)
log(`model: ${model}`)

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
} catch (e) {
  log(`ffprobe failed, assuming resize needed: ${e.message}`)
  width = 1920; height = 1080
}

const maxW = cfg.resize.maxWidth ?? 1000
const maxH = cfg.resize.maxHeight ?? 1000
const resizeEnabled = cfg.resize.enabled !== false
const needsResize = resizeEnabled && (width > maxW || height > maxH)
const targetFps = cfg.transcode.fps ?? 10
const forceFps = !flags.keepOriginalFps
log(`probe ${path.basename(resolved)}: ${width}x${height}, needsResize=${needsResize} (max ${maxW}x${maxH}), fps=${targetFps}`)

// --- 2. ffmpeg filters ---
const filters = []
if (forceFps) filters.push(`fps=${targetFps}`)
if (needsResize) filters.push(`scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease`)
filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2")
const vf = filters.join(",")

// --- 3. transcode to new file next to the source ---
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
  "-r", forceFps ? String(targetFps) : "30",
  "-crf", String(cfg.transcode.crf ?? 23),
  "-preset", cfg.transcode.preset ?? "veryfast",
  tmpPath,
]

log(`transcoding to ${outName} with vf=${vf}`)
try {
  await execFileAsync("ffmpeg", ffmpegArgs)
} catch (e) {
  try { await fs.unlink(tmpPath) } catch {}
  fail(`ffmpeg failed (vf=${vf}): ${e.message} - is ffmpeg installed and on PATH?`)
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

await fs.copyFile(tmpPath, outPath)
try { await fs.unlink(tmpPath) } catch {}
const outStat = await fs.stat(outPath)
log(`saved preprocessed video ${outName} ${outW}x${outH} ${outFps} ${Math.round(outStat.size / 1024)}KB`)

// --- 4. send as raw input_video ---
const bytes = await fs.readFile(outPath)
const b64 = bytes.toString("base64")
const outExt = path.extname(outPath).toLowerCase().replace(".", "") || "mp4"

const headers = { "Content-Type": "application/json" }
if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`

const payload = {
  model,
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

let res
try {
  res = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify(payload) })
} catch (e) {
  fail(`fetch ${chatUrl} failed: ${e.message}`)
}
const text = await res.text()
if (!res.ok) fail(`${res.status} ${text.slice(0, 2000)}`)
let json
try {
  json = JSON.parse(text)
} catch {
  fail(`endpoint returned non-JSON response: ${text.slice(0, 2000)}`)
}
const promptTokens = json?.usage?.prompt_tokens ?? 0

// Detect dropped video (gateway strips unknown content types)
const reply = json?.choices?.[0]?.message?.content ?? ""
const dropped = promptTokens < 100 && /no video was.*attached/i.test(reply)

// --- 5. frames fallback if the gateway dropped the raw video ---
if (dropped) {
  const fallbackEnabled = cfg.framesFallback?.enabled !== false
  if (!fallbackEnabled) {
    fail(`Raw video was dropped by gateway (prompt_tokens=${promptTokens}, reply: "${reply.slice(0, 200)}"). Frames fallback is disabled (set framesFallback.enabled=true in .opencode/video-plugin.json). Preprocessed video kept at ${outPath}.`)
  }
  log("raw video dropped by gateway, falling back to frames from preprocessed file", { promptTokens })
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-video-frames-"))
  try {
    const fbFps = cfg.framesFallback.fps ?? 0.2
    const fbW = cfg.framesFallback.width ?? 640
    const fbMax = cfg.framesFallback.maxFrames ?? 6
    await execFileAsync("ffmpeg", ["-y", "-i", outPath, "-vf", `fps=${fbFps},scale=${fbW}:-2`, "-frames:v", String(fbMax), path.join(tmpDir, "frame%02d.jpg")])
    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".jpg")).sort()
    const b64s = []
    for (const f of files) b64s.push((await fs.readFile(path.join(tmpDir, f))).toString("base64"))
    const content = [
      { type: "text", text: `${prompt}\n\nThese are ${b64s.length} frames from preprocessed video (${outW}x${outH}, ${targetFps}fps).` },
      ...b64s.map((b) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b}` } })),
    ]
    const payload2 = { model, messages: [{ role: "user", content }], max_tokens: 2048, temperature: 0.2 }
    let res2
    try {
      res2 = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify(payload2) })
    } catch (e) {
      fail(`fetch ${chatUrl} failed (frames fallback): ${e.message}`)
    }
    const t2 = await res2.text()
    if (!res2.ok) fail(t2.slice(0, 2000))
    let j2
    try {
      j2 = JSON.parse(t2)
    } catch {
      fail(`endpoint returned non-JSON response (frames fallback): ${t2.slice(0, 2000)}`)
    }
    const m2 = j2?.choices?.[0]?.message
    const out2 = typeof m2?.content === "string" && m2.content.trim() !== ""
      ? m2.content
      : (typeof m2?.reasoning_content === "string" && m2.reasoning_content.trim() !== "" ? `[model returned reasoning only]\n${m2.reasoning_content}` : JSON.stringify(j2, null, 2))
    console.log(`Preprocessed video saved to ${outPath} (${outW}x${outH}, ${targetFps}fps, ${Math.round(outStat.size / 1024)}KB) but raw video was dropped by the gateway, so sent as ${b64s.length} frames. Model output:\n\n${out2}`)
  } finally {
    try {
      const files = await fs.readdir(tmpDir)
      await Promise.all(files.map((f) => fs.unlink(path.join(tmpDir, f))))
      await fs.rmdir(tmpDir)
    } catch {}
  }
} else {
  const content = json?.choices?.[0]?.message?.content
  const reasoning = json?.choices?.[0]?.message?.reasoning_content
  const result = typeof content === "string" && content.trim() !== ""
    ? content
    : (typeof reasoning === "string" && reasoning.trim() !== "" ? `[model returned reasoning only]\n${reasoning}` : JSON.stringify(json, null, 2))
  console.log(`Preprocessed video saved to ${outPath} (${outW}x${outH}, ${targetFps}fps, ${Math.round(outStat.size / 1024)}KB, prompt_tokens=${promptTokens}). Model output:\n\n${result}`)
}
