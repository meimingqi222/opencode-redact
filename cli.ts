#!/usr/bin/env bun

/**
 * CLI installer for opencode-redact plugin.
 *
 * Usage:
 *   npx opencode-redact install              # Enable the plugin (auto-install deps)
 *   npx opencode-redact uninstall            # Disable the plugin
 *   npx opencode-redact install --local      # Install from local git clone
 *   npx opencode-redact status               # Show current plugin status
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PLUGIN_NAME = "opencode-redact";
const CONFIG_DIR = join(homedir(), ".config", "opencode");
const PKG_PATH = join(CONFIG_DIR, "package.json");
const OC_PATH = join(CONFIG_DIR, "opencode.json");

function getConfigPath(): string {
  const local = join(process.cwd(), "opencode.json");
  if (existsSync(local)) return local;
  if (existsSync(OC_PATH)) return OC_PATH;
  throw new Error("No opencode.json found. Run: opencode init");
}

function readJsonc(path: string): { data: any; raw: string } {
  if (!existsSync(path)) return { data: {}, raw: "{}" };
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

function hasDep(data: any): boolean {
  return data.dependencies && PLUGIN_NAME in data.dependencies;
}

function runBunInstall(): boolean {
  const r = spawnSync("bun", ["install"], { cwd: CONFIG_DIR, stdio: "inherit", timeout: 60_000 });
  return r.status === 0;
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
  if (!result.plugin.some((p: any) => typeof p === "string" && p === entry)) {
    result.plugin = [entry, ...result.plugin];
  }
  return result;
}

function addDep(data: any): any {
  const result = { ...data };
  if (!result.dependencies) result.dependencies = {};
  result.dependencies[PLUGIN_NAME] = "^1.0.0";
  return result;
}

function uninstallPlugin(data: any): any {
  const result = { ...data };
  if (!Array.isArray(result.plugin)) return result;
  result.plugin = result.plugin.filter((p: any) => {
    if (typeof p === "string") return p !== PLUGIN_NAME;
    if (Array.isArray(p)) return p?.[0] !== PLUGIN_NAME;
    return true;
  });
  return result;
}

function removeDep(data: any): any {
  if (!data.dependencies) return data;
  const { [PLUGIN_NAME]: _, ...rest } = data.dependencies;
  return { ...data, dependencies: rest };
}

function writeJson(path: string, data: any): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function showHelp(): void {
  console.log(`
${PLUGIN_NAME} — OpenCode secret redaction plugin

Usage:
  npx ${PLUGIN_NAME} install              # Install & auto-setup dependencies
  npx ${PLUGIN_NAME} install --local <path> # Install from local directory
  npx ${PLUGIN_NAME} uninstall            # Full cleanup
  npx ${PLUGIN_NAME} status               # Show current status
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
      const { data } = readJsonc(configPath);
      const { data: pkgData } = readJsonc(PKG_PATH);

      if (hasPlugin(data) && hasDep(pkgData)) {
        console.log(`✅ ${PLUGIN_NAME} is ENABLED (npm + deps)`);
      } else if (hasPlugin(data)) {
        console.log(`⚠ ${PLUGIN_NAME} in plugin list but deps missing`);
      } else {
        console.log(`❌ ${PLUGIN_NAME} is NOT installed`);
      }
      console.log(`   opencode.json: ${configPath}`);
      console.log(`   package.json:  ${PKG_PATH}`);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "install") {
    const localIdx = args.indexOf("--local");
    const isLocal = localIdx !== -1;

    try {
      const configPath = getConfigPath();
      const { data } = readJsonc(configPath);
      const { data: pkgData } = readJsonc(PKG_PATH);

      if (hasPlugin(data)) {
        console.log(`⚠ ${PLUGIN_NAME} already in opencode.json`);
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
      }

      // Step 1: write opencode.json
      writeJson(configPath, newConfig);

      // Step 2: add dependency to package.json + install
      if (!isLocal) {
        const newPkg = addDep(pkgData);
        writeJson(PKG_PATH, newPkg);
        console.log(`   Added to ${PKG_PATH}`);
        console.log(`   Running bun install...`);
        if (runBunInstall()) {
          console.log(`✅ ${PLUGIN_NAME} installed successfully`);
        } else {
          console.log(`⚠ bun install failed — run manually: cd ~/.config/opencode && bun install`);
        }
      } else {
        console.log(`✅ ${PLUGIN_NAME} installed (local path)`);
      }
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "uninstall") {
    try {
      const configPath = getConfigPath();
      const { data } = readJsonc(configPath);
      const { data: pkgData } = readJsonc(PKG_PATH);

      if (!hasPlugin(data)) {
        console.log(`⚠ ${PLUGIN_NAME} not found in opencode.json`);
        process.exit(0);
      }

      // Step 1: remove from opencode.json
      const newConfig = uninstallPlugin(data);
      writeJson(configPath, newConfig);
      console.log(`   Removed from opencode.json`);

      // Step 2: remove dependency + reinstall
      if (hasDep(pkgData)) {
        const newPkg = removeDep(pkgData);
        writeJson(PKG_PATH, newPkg);
        console.log(`   Removed from package.json`);
        console.log(`   Running bun install...`);
        runBunInstall();
      }

      console.log(`✅ ${PLUGIN_NAME} uninstalled`);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    return;
  }

  showHelp();
  process.exit(1);
}

main();
