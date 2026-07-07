const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const port = process.env.PORT || "18765";
const host = process.env.HOST || "127.0.0.1";
const localPython = process.platform === "win32"
  ? path.join(root, ".venv", "Scripts", "python.exe")
  : path.join(root, ".venv", "bin", "python");
const python = existsSync(localPython) ? localPython : process.platform === "win32" ? "python" : "python3";

const server = spawn(
  python,
  ["-m", "uvicorn", "app.main:app", "--host", host, "--port", port, "--no-access-log"],
  {
    cwd: root,
    env: {
      ...process.env,
      TRANSCRIPTOR_NO_BROWSER: "1",
    },
    stdio: "inherit",
    windowsHide: true,
  }
);

function stop() {
  if (!server.killed) server.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);

server.on("exit", (code, signal) => {
  if (signal) process.exit(0);
  process.exit(code || 0);
});
