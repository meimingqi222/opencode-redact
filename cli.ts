#!/usr/bin/env bun

/**
 * CLI installer for opencode-redact plugin.
 *
 * Usage:
 *   npx opencode-redact install              # Enable the plugin
 *   npx opencode-redact uninstall            # Disable the plugin
 *   npx opencode-redact install --local      # Install from local git clone
 *   npx opencode-redact status               # Show current plugin status
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_NAME = "opencode-redact";

function getConfigPath(): string {
  const local = join(process.cwd(), "opencode.json");
  if (existsSync(local)) return local;

  const global = join(homedir(), ".config", "opencode", "opencode.json");
  if (existsSync(global)) return global;

  throw new Error(
    "No opencode.json found. Create one first with: opencode init"
  );
}

function readConfig(path: string): { data: any; raw: string } {
  const raw = readFileSync(path, "utf-8");
  try {
    return { data: JSON.parse(raw), raw };
  } catch {
    const stripped = raw
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\/.*$|\/\*[\s\S]*?\*\//gm, (m) =>
        m.startsWith("//") || m.startsWith("/*") ? "" : m,
      )
      .replace(/,\s*([}\]])/g, "$1");
    return { data: JSON.parse(stripped), raw: stripped };
  }
}

function hasPlugin(data: any): boolean {
  return (
    Array.isArray(data.plugin) &&
    data.plugin.some((p: any) => {
      if (typeof p === "string") return p === PLUGIN_NAME;
      if (Array.isArray(p)) return p[0] === PLUGIN_NAME;
      return false;
    })
  );
}

function installFromNpm(data: any): any {
  const result = { ...data };
  if (!Array.isArray(result.plugin)) result.plugin = [];
  if (!hasPlugin(result)) {
    result.plugin = [PLUGIN_NAME, ...result.plugin];
  }
  return result;
}

function installFromLocal(data: any, localPath: string): any {
  const isDir = existsSync(join(localPath, "index.ts"));
  const entry = isDir
    ? `file:///${localPath.replace(/\\/g, "/")}/index.ts`
    : `file:///${localPath.replace(/\\/g, "/")}`;

  const result = { ...data };
  if (!Array.isArray(result.plugin)) result.plugin = [];

  const existing = result.plugin.findIndex((p: any) => {
    if (typeof p === "string") return p === entry;
    return false;
  });

  if (existing === -1) {
    result.plugin = [entry, ...result.plugin];
  }
  return result;
}

function uninstall(data: any): any {
  const result = { ...data };
  if (!Array.isArray(result.plugin)) return result;

  result.plugin = result.plugin.filter((p: any) => {
    if (typeof p === "string") {
      return p !== PLUGIN_NAME;
    }
    if (Array.isArray(p) && p.length > 0) {
      return p[0] !== PLUGIN_NAME;
    }
    return true;
  });

  return result;
}

function writeConfig(path: string, data: any): void {
  const content = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(path, content, "utf-8");
}

function showHelp(): void {
  console.log(`
${PLUGIN_NAME} — OpenCode secret redaction plugin

Usage:
  npx ${PLUGIN_NAME} install              # Install from npm (recommended)
  npx ${PLUGIN_NAME} install --local <path> # Install from local directory
  npx ${PLUGIN_NAME} uninstall            # Remove from config
  npx ${PLUGIN_NAME} status               # Show current status

Options:
  --local <path>    Use a local plugin path instead of npm
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    showHelp();
    process.exit(0);
  }

  if (cmd === "status") {
    try {
      const configPath = getConfigPath();
      const { data } = readConfig(configPath);
      if (hasPlugin(data)) {
        console.log(`✅ ${PLUGIN_NAME} is ENABLED`);
        console.log(`   Config: ${configPath}`);
      } else {
        console.log(`❌ ${PLUGIN_NAME} is NOT installed`);
        console.log(`   Config: ${configPath}`);
      }
    } catch (err: any) {
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "install") {
    const localIdx = args.indexOf("--local");
    const isLocal = localIdx !== -1;

    try {
      const configPath = getConfigPath();
      const { data } = readConfig(configPath);

      if (hasPlugin(data)) {
        console.log(`⚠ ${PLUGIN_NAME} is already installed in ${configPath}`);
        process.exit(0);
      }

      let newConfig: any;
      if (isLocal) {
        const localPath = args[localIdx + 1] || process.cwd();
        newConfig = installFromLocal(data, localPath);
        console.log(`📦 Installing ${PLUGIN_NAME} from ${localPath}`);
      } else {
        newConfig = installFromNpm(data);
        console.log(`📦 Installing ${PLUGIN_NAME} from npm`);
        console.log(`   OpenCode will auto-install it on next start.`);
        console.log(`   Or run manually: npm install -g ${PLUGIN_NAME}`);
      }

      writeConfig(configPath, newConfig);
      console.log(`✅ ${PLUGIN_NAME} installed to ${configPath}`);
      console.log(`   Restart OpenCode or reload plugins to activate.`);
    } catch (err: any) {
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "uninstall") {
    try {
      const configPath = getConfigPath();
      const { data } = readConfig(configPath);

      if (!hasPlugin(data)) {
        console.log(`⚠ ${PLUGIN_NAME} is not currently installed`);
        process.exit(0);
      }

      const newConfig = uninstall(data);
      writeConfig(configPath, newConfig);
      console.log(`✅ ${PLUGIN_NAME} removed from ${configPath}`);
    } catch (err: any) {
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  showHelp();
  process.exit(1);
}

main();
