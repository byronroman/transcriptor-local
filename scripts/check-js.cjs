const { spawnSync } = require("node:child_process");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

function jsFiles(root) {
  const entries = readdirSync(root);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...jsFiles(fullPath));
    } else if (entry.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = jsFiles(path.join(process.cwd(), "static", "js"));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    cwd: process.cwd(),
    input: readFileSync(file),
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
