import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
// This is a contract assertion, not a PowerShell startup benchmark. Hosted
// Linux runners cold-start pwsh while API/PGlite suites compete for CPU. Keep
// a finite process deadline without mistaking that contention for bad JSON.
const processTimeoutMs = 30_000;
const available = spawnSync(
  "pwsh",
  ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
  {
    cwd: root,
    timeout: processTimeoutMs,
    encoding: "utf8",
  },
);

it.skipIf(available.error?.code === "ENOENT")(
  "validates the real parity JSON parsing path across PowerShell timestamp coercion",
  () => {
    // Extract only the pure validator: never execute the Docker/DB operations in
    // the script body. CI already requires pwsh for the full container gate.
    const command = `
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts/verify-docker-staging-parity.ps1'), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'Parity script syntax error' }
    $validator = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-ParityReadiness' }, $true)
    Invoke-Expression $validator.Extent.Text
    $script:expectedBuildSha = $null
    $response = @{ StatusCode = 200; Body = ('{"status":"ready","database":"reachable","release":{"sha":null,"builtAt":"2026-10-01T12:34:56.789Z","environment":"test"}}' | ConvertFrom-Json) }
    Assert-ParityReadiness $response $true
    $script:expectedBuildSha = 'a' * 40
    $response.Body.release.sha = $script:expectedBuildSha
    Assert-ParityReadiness $response $true
    $response.StatusCode = 503; $response.Body.status = 'not_ready'; $response.Body.database = 'unavailable'
    Assert-ParityReadiness $response $false
    $response.Body.release.builtAt = 'not-a-timestamp'
    $rejected = $false
    try { Assert-ParityReadiness $response $false } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid timestamp was accepted' }
    $response.Body.release.builtAt = '2026-10-01T12:34:56.789Z'
    $response.Body | Add-Member -NotePropertyName privateData -NotePropertyValue 'synthetic'
    $rejected = $false
    try { Assert-ParityReadiness $response $false } catch { $rejected = $true }
    if (-not $rejected) { throw 'Unexpected public field was accepted' }
    Write-Output 'PARITY_CONTRACT_VALIDATOR_PASSED'
  `;
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd: root,
        timeout: processTimeoutMs,
        encoding: "utf8",
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PARITY_CONTRACT_VALIDATOR_PASSED");
  },
  processTimeoutMs + 5_000,
);
