#!/usr/bin/env node
// Standalone test for llama.cpp raw video ingestion (input_video)
// Usage: node scripts/test-video.mjs [path/to/video.mp4] [prompt]
// Defaults to ./screen.mp4 and checks http://localhost:8080
import fs from "node:fs/promises"
import path from "node:path"

const videoPath = process.argv[2] ?? "./screen.mp4"
const prompt = process.argv[3] ?? "Describe what's happening in this video. Include on-screen text and actions in order."
const baseRaw = process.env.LLAMA_SERVER_URL ?? process.env.AI_GATEWAY_URL ?? process.env.OPENCODE_API_URL ?? "http://localhost:8080"
const baseUrl = baseRaw.replace(/\/$/, "").endsWith("/v1") ? baseRaw.replace(/\/$/, "") : baseRaw.replace(/\/$/, "") + "/v1"
const apiKey = process.env.LLAMA_API_KEY ?? process.env.AI_GATEWAY_KEY ?? process.env.OPENCODE_API_KEY ?? ""
const model = process.env.OPENCODE_MODEL ?? process.env.LLAMA_MODEL ?? "qwen3-vl-8b"
if (!apiKey) console.warn("[warn] no API key set (OPENCODE_API_KEY / LLAMA_API_KEY / AI_GATEWAY_KEY)")

async function main() {
  const resolved = path.isAbsolute(videoPath) ? videoPath : path.resolve(process.cwd(), videoPath)
  console.log(`[test-video] video: ${resolved}`)
  console.log(`[test-video] server: ${baseUrl}/chat/completions`)
  console.log(`[test-video] model: ${model}`)

  let bytes
  try {
    bytes = await fs.readFile(resolved)
  } catch (e) {
    console.error(`[error] cannot read ${resolved}: ${e.message}`)
    process.exit(1)
  }
  const sizeMB = bytes.length / (1024 * 1024)
  console.log(`[test-video] size: ${bytes.length} bytes (${sizeMB.toFixed(2)} MB)`)
  console.log(`[test-video] base64 len: ${(bytes.length * 1.333).toFixed(0)} chars (~33% overhead)`)

  if (sizeMB > 20) console.warn("[warn] >20MB may OOM / timeout on llama.cpp ffmpeg decode")

  const ext = path.extname(resolved).toLowerCase().replace(".", "") || "mp4"
  const b64 = bytes.toString("base64")

  // Try input_video.data first (llama.cpp b9758+), fallback probe with url variant
  const payloads = [
    {
      name: "input_video.data (raw base64)",
      body: {
        model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "input_video", input_video: { data: b64, format: ext } }] }],
        max_tokens: 1024,
        temperature: 0.2,
      },
    },
    {
      name: "input_video.url (data URI)",
      body: {
        model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "input_video", input_video: { url: `data:video/${ext};base64,${b64}` } }] }],
        max_tokens: 1024,
        temperature: 0.2,
      },
    },
  ]

  for (const p of payloads) {
    console.log(`\n=== Trying: ${p.name} ===`)
    const url = `${baseUrl}/chat/completions`
    const start = Date.now()
    try {
      const headers = { "Content-Type": "application/json" }
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(p.body),
      })
      const text = await res.text()
      const ms = Date.now() - start
      console.log(`[response] status: ${res.status} in ${ms}ms`)
      if (!res.ok) {
        console.log(text.slice(0, 2000))
        if (text.includes("input_video") || res.status === 400) {
          console.log("[hint] server may not support video (need ffmpeg build + VL model + mmproj)")
        }
        continue
      }
      let json
      try { json = JSON.parse(text) } catch { console.log(text); continue }
      console.log(JSON.stringify(json, null, 2).slice(0, 4000))
      const content = json?.choices?.[0]?.message?.content
      if (content) console.log(`\n[model output]\n${typeof content === "string" ? content : JSON.stringify(content, null, 2)}`)
      // timings if present
      if (json.timings) console.log(`\n[timings]`, json.timings)
      if (json.usage) console.log(`[usage]`, json.usage)
      console.log("\n[success] video accepted with", p.name)
      return
    } catch (e) {
      console.error(`[fetch error] ${e.message}`)
      if (e.cause) console.error(e.cause)
    }
  }

  console.error("\n[failed] both input_video variants rejected")
  console.log("\n[debug] probing server:")
  try {
    const headers = {}
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
    const h = await fetch(`${baseUrl.replace("/v1","")}/health`, { headers }).then(r => r.text()).catch(() => null)
    if (h) console.log(" /health:", h.slice(0, 500))
    const models = await fetch(`${baseUrl}/models`, { headers }).then(r => r.text()).catch(() => null)
    if (models) console.log(" /v1/models:", models.slice(0, 2000))
  } catch {}
}

main()
