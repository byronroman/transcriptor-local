const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

function pythonCommand() {
  const localPython = process.platform === "win32"
    ? path.join(process.cwd(), ".venv", "Scripts", "python.exe")
    : path.join(process.cwd(), ".venv", "bin", "python");
  if (existsSync(localPython)) return localPython;
  return process.platform === "win32" ? "python" : "python3";
}

const result = spawnSync(pythonCommand(), ["-m", "unittest", "tests.test_app_core"], {
  cwd: process.cwd(),
  stdio: "inherit",
});

process.exit(result.status || 0);
