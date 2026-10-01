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
$previousBuildSha = $env:GROWTHOS_BUILD_SHA
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

function Get-ParityReadiness {
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  $response = Invoke-WebRequest -Uri "$baseUrl/api/readyz" -SkipHttpErrorCheck -TimeoutSec 5
  $elapsed.Stop()
  if ($elapsed.Elapsed.TotalSeconds -ge 5) {
    throw 'Readiness exceeded the isolated acceptance deadline.'
  }
  return @{ StatusCode = [int]$response.StatusCode; Body = ($response.Content | ConvertFrom-Json) }
}

function Assert-ParityReadiness {
  param($Response, [bool]$Ready)
  $expectedStatus = if ($Ready) { 'ready' } else { 'not_ready' }
  $expectedDatabase = if ($Ready) { 'reachable' } else { 'unavailable' }
  $expectedCode = if ($Ready) { 200 } else { 503 }
  if ($Response.StatusCode -ne $expectedCode -or $Response.Body.status -ne $expectedStatus -or $Response.Body.database -ne $expectedDatabase) {
    throw "Readiness did not return the expected HTTP $expectedCode safe contract."
  }
  if ((($Response.Body.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'database,release,status') {
    throw 'Readiness exposed unexpected public fields.'
  }
  $release = $Response.Body.release
  if ((($release.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'builtAt,environment,sha') {
    throw 'Release identity exposed unexpected public fields.'
  }
  # ConvertFrom-Json materializes ISO timestamps as DateTime on some supported
  # PowerShell versions. Normalize that parsed value before validating it.
  $builtAt = $release.builtAt
  if ($builtAt -is [DateTime] -or $builtAt -is [DateTimeOffset]) {
    $builtAt = $builtAt.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)
  }
  if ($release.environment -ne 'test' -or $release.sha -cne $script:expectedBuildSha -or $builtAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') {
    throw 'Release identity did not match the safe isolated build input.'
  }
}

if (-not (Test-Path -LiteralPath $composeFile)) {
  throw "Parity Compose file not found at $composeFile."
}

Push-Location $repoRoot
try {
  # The actual checkout may be a CI merge commit. Never assume GITHUB_SHA or
  # reuse a caller's build argument. Dirty/unverifiable source stays unknown.
  $sourceShaOutput = & node --input-type=module -e "import { buildIdentity } from './artifacts/api-server/build-identity.mjs'; process.stdout.write(buildIdentity({ env: {} }).sha || '');"
  if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the isolated build source identity.' }
  $sourceSha = ([string]($sourceShaOutput -join '')).Trim()
  if ($sourceSha -and $sourceSha -notmatch '^[a-f0-9]{40}$') { throw 'Unexpected build source identity.' }
  if ($env:CI -eq 'true' -and -not $sourceSha) { throw 'CI parity requires a verifiably clean actual checkout.' }
  $script:expectedBuildSha = if ($sourceSha) { $sourceSha } else { $null }
  $env:GROWTHOS_BUILD_SHA = $sourceSha

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

  Assert-ParityReadiness (Get-ParityReadiness) $true

  # This stack owns its synthetic database. No hosted database or provider is
  # contacted; scheduler startup and all outbound sending are explicitly held.
  Invoke-ComposeChecked 'Stop only the isolated parity database' @('stop', 'db')
  $unavailable = $false
  for ($attempt = 1; $attempt -le 10; $attempt++) {
    $readiness = Get-ParityReadiness
    if ($readiness.StatusCode -eq 503) {
      Assert-ParityReadiness $readiness $false
      $unavailable = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $unavailable) { throw 'Readiness stayed healthy after the isolated database stopped.' }
  $healthWithoutDatabase = Invoke-RestMethod -Uri "$baseUrl/api/healthz" -TimeoutSec 5
  if ($healthWithoutDatabase.status -ne 'ok') { throw 'Liveness failed during the isolated database outage.' }

  Invoke-ComposeChecked 'Restart only the isolated parity database' @('start', 'db')
  $recovered = $false
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    $readiness = Get-ParityReadiness
    if ($readiness.StatusCode -eq 200) {
      Assert-ParityReadiness $readiness $true
      $recovered = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $recovered) { throw 'Readiness did not recover after the isolated database restarted.' }

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
  Write-Host 'Readiness/release identity, isolated database failure, and recovery passed.'
} finally {
  $env:GROWTHOS_BUILD_SHA = $previousBuildSha
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
