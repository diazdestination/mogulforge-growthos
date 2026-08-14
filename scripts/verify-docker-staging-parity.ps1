[CmdletBinding()]
param(
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot 'docker-compose.parity.yml'
$projectName = "growthos-parity-$PID"
$baseUrl = 'http://127.0.0.1:18080'
$composePrefix = @(
  'compose',
  '--project-name', $projectName,
  '--file', $composeFile
)

function Invoke-Checked {
  param(
    [Parameter(Mandatory)]
    [string]$Label,
    [Parameter(Mandatory)]
    [scriptblock]$Command
  )

  Write-Host "`n== $Label ==" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Invoke-ComposeChecked {
  param(
    [Parameter(Mandatory)]
    [string]$Label,
    [Parameter(Mandatory)]
    [string[]]$Arguments
  )

  Invoke-Checked $Label { & docker @composePrefix @Arguments }
}

if (-not (Test-Path -LiteralPath $composeFile)) {
  throw "Parity Compose file not found at $composeFile."
}

Push-Location $repoRoot
try {
  Invoke-Checked 'Verify Docker engine' { docker version --format '{{.Server.Version}}' }
  Invoke-ComposeChecked 'Start isolated parity database' @('up', '-d', 'db')

  $dbReady = $false
  for ($attempt = 1; $attempt -le 45; $attempt++) {
    & docker @composePrefix exec -T db pg_isready -U postgres -d growthos_parity *> $null
    if ($LASTEXITCODE -eq 0) {
      $dbReady = $true
      break
    }
    Start-Sleep -Seconds 2
  }
  if (-not $dbReady) {
    throw 'The parity database did not become healthy within 90 seconds.'
  }

  Invoke-ComposeChecked 'Build the exact production Docker image' @('build', 'app')
  Invoke-ComposeChecked 'Apply schema as the restricted application role' @('run', '--rm', 'schema')

  $viewOwnerOutput = & docker @composePrefix exec -T db psql -U postgres -d growthos_parity -Atc "SELECT viewowner FROM pg_catalog.pg_views WHERE schemaname = 'public' AND viewname = 'pg_stat_monitor';"
  $viewOwnerExitCode = $LASTEXITCODE
  $viewOwner = ([string]($viewOwnerOutput -join '')).Trim()
  if ($viewOwnerExitCode -ne 0 -or $viewOwner -ne 'fly_provider') {
    throw "Provider-owned monitoring view was not preserved; owner was '$viewOwner'."
  }

  $requiredTablesOutput = & docker @composePrefix exec -T db psql -U postgres -d growthos_parity -Atc "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename IN ('identity_tokens', 'users');"
  $requiredTablesExitCode = $LASTEXITCODE
  $requiredTables = ([string]($requiredTablesOutput -join '')).Trim()
  if ($requiredTablesExitCode -ne 0 -or $requiredTables -ne 'identity_tokens,users') {
    throw "Required identity tables were not created; found '$requiredTables'."
  }

  Invoke-ComposeChecked 'Start production image after schema reconciliation' @('up', '-d', 'app')

  $health = $null
  for ($attempt = 1; $attempt -le 45; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "$baseUrl/api/healthz" -TimeoutSec 5
      if ($health.status -eq 'ok') {
        break
      }
    } catch {
      $health = $null
    }
    Start-Sleep -Seconds 2
  }
  if ($null -eq $health -or $health.status -ne 'ok') {
    throw 'The production image did not return HTTP 200/status ok within 90 seconds.'
  }

  foreach ($route in @('/login', '/signup', '/forgot-password')) {
    $response = Invoke-WebRequest -Uri "$baseUrl$route" -UseBasicParsing -TimeoutSec 10
    if ($response.StatusCode -ne 200) {
      throw "Parity route $route returned HTTP $($response.StatusCode)."
    }
  }

  Write-Host "`nDOCKER_STAGING_PARITY_PASSED" -ForegroundColor Green
  Write-Host 'Schema push succeeded under restricted ownership.'
  Write-Host 'Fly-like pg_stat_monitor ownership was preserved.'
  Write-Host 'Production image health and public identity routes passed.'
} finally {
  Pop-Location
  if (-not $Keep) {
    Write-Host "`n== Remove isolated parity stack ==" -ForegroundColor Cyan
    & docker @composePrefix down --volumes --remove-orphans
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Parity cleanup returned exit code $LASTEXITCODE for project $projectName."
    }
  } else {
    Write-Host "Parity stack kept for inspection: $projectName" -ForegroundColor Yellow
  }
}
