# PowerShell quick probe without Node - useful if llama.cpp is on Windows
param(
  [string]$Video = "./screen.mp4",
  [string]$Prompt = "Describe what's happening in this video in detail",
  [string]$Server = $env:LLAMA_SERVER_URL ?? $env:OPENCODE_API_URL ?? "http://localhost:8080",
  [string]$Model = $env:OPENCODE_MODEL ?? $env:LLAMA_MODEL ?? "qwen3-vl-8b"
)
$ErrorActionPreference = "Stop"
$resolved = Resolve-Path $Video -ErrorAction Stop
$bytes = [IO.File]::ReadAllBytes($resolved)
$b64 = [Convert]::ToBase64String($bytes)
$ext = [IO.Path]::GetExtension($resolved).TrimStart('.')
if (-not $ext) { $ext = "mp4" }
Write-Host "[test] $resolved $($bytes.Length) bytes -> b64 $($b64.Length) chars"
Write-Host "[test] POST $Server/v1/chat/completions"

$body = @{
  model = $Model
  messages = @(
    @{
      role = "user"
      content = @(
        @{ type = "text"; text = $Prompt },
        @{ type = "input_video"; input_video = @{ data = $b64; format = $ext } }
      )
    }
  )
  max_tokens = 1024
} | ConvertTo-Json -Depth 10

try {
  $res = Invoke-RestMethod -Uri "$Server/v1/chat/completions" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 120
  $res | ConvertTo-Json -Depth 10 | Write-Host
} catch {
  Write-Host "[error] $($_.Exception.Message)"
  if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message.Substring(0, [Math]::Min(3000, $_.ErrorDetails.Message.Length)) }
}
