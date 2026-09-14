import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function detectSchemaPushFailure(output) {
  const normalized = output.replace(ANSI_PATTERN, "");

  if (/\berror:\s+/i.test(normalized)) {
    return "database error reported by drizzle-kit";
  }

  if (/\bseverity:\s*['\"]ERROR['\"]/i.test(normalized)) {
    return "PostgreSQL reported ERROR severity";
  }

  return null;
}

async function runSchemaPush() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const dbDirectory = resolve(scriptDirectory, "../lib/db");
  const executable = "pnpm";
  const args = [
    "exec",
    "drizzle-kit",
    "push",
    "--force",
    "--config",
    "./drizzle.config.ts",
  ];

  const child = spawn(executable, args, {
    cwd: dbDirectory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });

  if (result.code !== 0) {
    throw new Error(
      `drizzle-kit exited with code ${result.code ?? "unknown"}${
        result.signal ? ` after signal ${result.signal}` : ""
      }`,
    );
  }

  const reportedFailure = detectSchemaPushFailure(output);
  if (reportedFailure) {
    throw new Error(
      `${reportedFailure}; refusing to mark the release command successful`,
    );
  }

  console.log("Schema push completed without reported database errors.");
}

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runSchemaPush().catch((error) => {
    console.error(`Schema release failed: ${error.message}`);
    process.exit(1);
  });
}
