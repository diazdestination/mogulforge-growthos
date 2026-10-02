// A fixed normal-mode HTTP matrix in the existing disposable, credential-stripped
// PGlite harness. No URL, provider key, hosted target or extra test can be supplied.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 2) {
  throw new Error("This isolated acceptance runner takes no arguments.");
}
const runner = fileURLToPath(
  new URL("./test-scheduler-isolated.mjs", import.meta.url),
);
const status = await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [runner, "src/routes/v1/normal-mode-tenant-acceptance.test.ts"],
    {
      stdio: "inherit",
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(key),
        ),
      ),
    },
  );
  child.on("error", reject);
  child.on("exit", (code) => resolve(code ?? 1));
});
if (status !== 0) process.exitCode = 1;
else
  console.log(
    "PASS: local normal-mode tenant matrix only. Hosted P0-8 and real provider acceptance remain separate gates.",
  );
