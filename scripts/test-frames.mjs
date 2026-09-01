import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execSync } from "node:child_process"

// Usage: LLAMA_SERVER_URL=https://your-gateway/v1 LLAMA_API_KEY=... node scripts/test-frames.mjs [videoPath]
// Defaults to ./screen.mp4 if exists, otherwise requires path argument.

const video = process.argv[2] ?? "./screen.mp4"
const resolved = path.isAbsolute(video) ? video : path.resolve(process.cwd(), video)
if (!fs.existsSync(resolved)) {
  console.error(`[error] video not found: ${resolved}. Pass path as first arg.`)
  process.exit(1)
}
const baseRaw = process.env.LLAMA_SERVER_URL ?? process.env.AI_GATEWAY_URL ?? "http://localhost:8080"
const baseUrl = baseRaw.replace(/\/$/, "").endsWith("/v1") ? baseRaw.replace(/\/$/, "") : baseRaw.replace(/\/$/, "") + "/v1"
const apiKey = process.env.LLAMA_API_KEY ?? process.env.AI_GATEWAY_KEY ?? process.env.OPENCODE_API_KEY ?? ""
if (!apiKey) {
  console.error("[error] no API key set. Export LLAMA_API_KEY / AI_GATEWAY_KEY / OPENCODE_API_KEY")
  process.exit(1)
}
const model = process.env.OPENCODE_MODEL ?? process.env.LLAMA_MODEL ?? "qwen3-vl-8b"

const tmp = path.join(os.tmpdir(), "opencode-frames-" + Date.now())
fs.mkdirSync(tmp, { recursive: true })
console.log("[frames] tmp", tmp)
execSync(`ffmpeg -y -i "${resolved}" -vf "fps=0.2,scale=640:-1" -frames:v 4 "${tmp}/frame%02d.jpg"`, { stdio: "ignore" })
const files = fs.readdirSync(tmp).filter(f => f.endsWith(".jpg")).sort().slice(0, 4)
console.log("[frames] files", files)
const b64s = files.map(f => fs.readFileSync(path.join(tmp, f)).toString("base64"))
console.log("[frames] b64 sizes", b64s.map(b => b.length))

const payload = {
  model,
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "These are 4 consecutive frames from a screen recording (ordered). Describe what app is shown and what actions occur. Be specific about UI elements." },
      ...b64s.map(b => ({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + b } }))
    ]
  }],
  max_tokens: 1024,
  temperature: 0.2
}

console.log(`[request] POST ${baseUrl}/chat/completions`)
const res = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`
  },
  body: JSON.stringify(payload)
})
const text = await res.text()
console.log("status", res.status)
console.log(text.slice(0, 5000))
if (res.ok) {
  const j = JSON.parse(text)
  console.log("\n=== OUTPUT ===")
  console.log(j.choices[0].message.content)
  console.log(j.choices[0].message.reasoning_content?.slice(0, 1000))
}
