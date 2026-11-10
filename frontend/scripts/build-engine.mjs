#!/usr/bin/env node
/**
 * Build the Rust engine for wasm32-unknown-unknown and generate the
 * wasm-bindgen web bindings used by the static frontend.
 *
 * Usage:
 *   node frontend/scripts/build-engine.mjs
 *
 * No shell is used. Commands are spawned directly with spawnSync, and every
 * path is resolved from import.meta.url so the script works from any cwd.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REQUIRED_WASM_BINDGEN = "0.2.130";
const CRATE_BINARY = "cinemind_engine";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(frontendDir, "..");

const engineDir = path.join(repoRoot, "engine");
const manifestPath = path.join(engineDir, "Cargo.toml");
const targetDir = path.join(engineDir, "target");
const wasmPath = path.join(
  targetDir,
  "wasm32-unknown-unknown",
  "release",
  `${CRATE_BINARY}.wasm`,
);
const generatedDir = path.join(frontendDir, "src", "generated");

const isWindows = process.platform === "win32";
const cargo = isWindows ? "cargo.exe" : "cargo";
const wasmBindgen = isWindows ? "wasm-bindgen.exe" : "wasm-bindgen";

function fail(message) {
  console.error(`\n[build-engine] ${message}`);
  process.exit(1);
}

function printCommand(label, command, args) {
  const renderedArgs = args.map((arg) =>
    /\s/.test(arg) ? JSON.stringify(arg) : arg,
  );
  console.log(`\n[build-engine] ${label}`);
  console.log(`  ${command} ${renderedArgs.join(" ")}`);
}

function run(label, command, args, options = {}) {
  const { hint, ...spawnOptions } = options;
  printCommand(label, command, args);

  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...spawnOptions,
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      fail(`Could not start "${command}". Make sure it is installed and on PATH.`);
    }
    fail(`Could not run "${command}": ${result.error.message}`);
  }

  if (result.signal) {
    fail(`"${command}" was terminated by signal ${result.signal}.`);
  }

  if (result.status !== 0) {
    if (hint) {
      console.error(`\n[build-engine] Hint: ${hint}`);
    }
    fail(`"${command}" exited with code ${result.status}.`);
  }

  return result;
}

function readVersion(command, label) {
  const result = spawnSync(command, ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      fail(`Could not start "${command}". Make sure it is installed and on PATH.`);
    }
    fail(`Could not run "${command} --version": ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    fail(
      `"${command} --version" failed with code ${result.status}.` +
        (detail ? `\n${detail}` : ""),
    );
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const match = output.match(/(\d+\.\d+\.\d+)/);
  if (!match) {
    fail(`Could not read the ${label} version from:\n${output}`);
  }

  return match[1];
}

function checkWasmBindgen() {
  const found = readVersion(wasmBindgen, "wasm-bindgen");
  if (found !== REQUIRED_WASM_BINDGEN) {
    fail(
      `wasm-bindgen ${REQUIRED_WASM_BINDGEN} is required, but ${found} was found.\n` +
        `Install the exact version with:\n` +
        `  cargo install wasm-bindgen-cli --version ${REQUIRED_WASM_BINDGEN} --locked\n` +
        `Then make sure that CLI is the one first on PATH.`,
    );
  }
}

function main() {
  if (!existsSync(manifestPath)) {
    fail(
      `Engine manifest not found:\n  ${manifestPath}\n` +
        `Run this helper from a complete checkout of the project.`,
    );
  }

  readVersion(cargo, "cargo");
  checkWasmBindgen();

  if (process.env.CARGO_TARGET_DIR) {
    console.log(
      `\n[build-engine] Replacing inherited CARGO_TARGET_DIR ` +
        `(${process.env.CARGO_TARGET_DIR}) with ${targetDir}.`,
    );
  }

  const buildEnv = {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
  };

  run(
    "Building the Rust engine for wasm32-unknown-unknown",
    cargo,
    [
      "build",
      "--locked",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "--manifest-path",
      manifestPath,
    ],
    {
      env: buildEnv,
      hint:
        "If the target is missing, run: rustup target add wasm32-unknown-unknown. " +
        "If the lockfile is missing, restore engine/Cargo.lock.",
    },
  );

  if (!existsSync(wasmPath)) {
    fail(
      `Cargo completed, but the expected artifact was not found:\n  ${wasmPath}\n` +
        `Check the engine crate's library name and wasm target configuration.`,
    );
  }

  mkdirSync(generatedDir, { recursive: true });

  run(
    "Generating wasm-bindgen web bindings",
    wasmBindgen,
    [
      "--target",
      "web",
      "--out-dir",
      generatedDir,
      "--out-name",
      CRATE_BINARY,
      wasmPath,
    ],
    {
      env: buildEnv,
      hint:
        `Install the exact CLI with: cargo install wasm-bindgen-cli ` +
        `--version ${REQUIRED_WASM_BINDGEN} --locked`,
    },
  );

  const generatedJs = path.join(generatedDir, `${CRATE_BINARY}.js`);
  const generatedWasm = path.join(generatedDir, `${CRATE_BINARY}_bg.wasm`);
  if (!existsSync(generatedJs) || !existsSync(generatedWasm)) {
    fail(
      `wasm-bindgen finished, but the expected web bindings were not found in:\n` +
        `  ${generatedDir}\n` +
        `Expected ${path.basename(generatedJs)} and ${path.basename(generatedWasm)}.`,
    );
  }

  console.log("\n[build-engine] Done.");
  console.log(`  wasm artifact: ${wasmPath}`);
  console.log(`  web bindings: ${generatedDir}`);
}

main();
