# MogulForge — local dev launcher (Windows / PowerShell)
# Starts Postgres, the API server (:3001), and the frontend (:5173) in
# separate windows. First run only: open http://localhost:5173/api/dev/login
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Write-Host '==> Starting Postgres (docker: mogulforge-db)...' -ForegroundColor Cyan
docker start mogulforge-db | Out-Null

# --- Load API env from artifacts/api-server/.env ------------------------------
$envFile = Join-Path $root 'artifacts\api-server\.env'
$apiEnv = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' -and $_ -notmatch '^\s*#' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  $apiEnv[$k.Trim()] = $v.Trim()
}

# --- API server (new window): build then run ----------------------------------
$setEnv = ($apiEnv.GetEnumerator() | ForEach-Object { "`$env:$($_.Key)='$($_.Value)'" }) -join '; '
$apiCmd = "cd '$root\artifacts\api-server'; $setEnv; pnpm run build; node --enable-source-maps ./dist/index.mjs"
Write-Host '==> Launching API server -> http://localhost:3001' -ForegroundColor Cyan
Start-Process pwsh -ArgumentList '-NoExit', '-Command', $apiCmd

# --- Frontend (new window) ----------------------------------------------------
$feCmd = "cd '$root\artifacts\command-center'; `$env:PORT='5173'; `$env:BASE_PATH='/'; `$env:API_PORT='3001'; `$env:NODE_ENV='development'; pnpm run dev"
Write-Host '==> Launching frontend -> http://localhost:5173' -ForegroundColor Cyan
Start-Process pwsh -ArgumentList '-NoExit', '-Command', $feCmd

Write-Host ''
Write-Host 'Both servers starting in their own windows.' -ForegroundColor Green
Write-Host 'First run: open  http://localhost:5173/api/dev/login  to sign in as OWNER.' -ForegroundColor Yellow
Write-Host 'Then use:        http://localhost:5173' -ForegroundColor Yellow
