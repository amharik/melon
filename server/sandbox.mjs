import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec as execCb, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);
const execFile = promisify(execFileCb);

const SECRET_PATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".kube",
  ".config/gh",
  ".docker/config.json",
];

function allowedDomainsFromEnv(value = process.env.MELON_SANDBOX_ALLOW_DOMAINS) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 100);
}

function settingsFor(cwd) {
  const home = os.homedir();
  const denied = SECRET_PATHS.map((item) => path.join(home, item));
  return {
    network: {
      allowedDomains: allowedDomainsFromEnv(),
      deniedDomains: [],
    },
    filesystem: {
      denyRead: denied,
      allowWrite: [path.resolve(cwd), os.tmpdir()],
      denyWrite: denied,
    },
  };
}

function writeSettings(dir, cwd) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const key = crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
  const file = path.join(dir, `sandbox-${key}.json`);
  fs.writeFileSync(file, `${JSON.stringify(settingsFor(cwd), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function customSettingsFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("sandbox settings must be a regular file, not a symlink");
  }
  return file;
}

export function createSandbox({
  mode = process.env.MELON_SANDBOX || "auto",
  command = process.env.SRT_CMD || "srt",
  root = process.cwd(),
  settingsDir = path.join(root, ".melon", "sandbox"),
  settingsFile = process.env.MELON_SANDBOX_SETTINGS || "",
} = {}) {
  const normalized = ["auto", "required", "off"].includes(mode) ? mode : "auto";
  let probeResult = normalized === "off" ? { available: false, disabled: true } : null;

  async function probe() {
    if (normalized === "off") return probeResult;
    try {
      const { stdout } = await execFile(command, ["--version"], { timeout: 5000, maxBuffer: 64 * 1024 });
      probeResult = { available: true, version: String(stdout).trim().slice(0, 120) };
    } catch (err) {
      probeResult = {
        available: false,
        error: String(err.stderr || err.message || err).trim().slice(0, 300),
      };
    }
    return probeResult;
  }

  function status() {
    const current = probeResult || { available: null };
    return {
      mode: normalized,
      enabled: normalized !== "off",
      command,
      ...current,
    };
  }

  function settingsPath(cwd) {
    if (settingsFile) return customSettingsFile(settingsFile);
    return writeSettings(settingsDir, cwd);
  }

  async function run(commandLine, options = {}) {
    const execOptions = {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      env: options.env,
      killSignal: "SIGKILL",
    };

    if (normalized === "off") {
      try {
        return { result: await exec(commandLine, { ...execOptions, shell: "/bin/sh" }), sandbox: "none" };
      } catch (err) {
        err.sandbox = "none";
        throw err;
      }
    }

    const current = await (probeResult ? Promise.resolve(probeResult) : probe());
    if (!current.available) {
      if (normalized === "required") {
        throw new Error(`sandbox required but srt is unavailable: ${current.error || "not installed"}`);
      }
      try {
        return {
          result: await exec(commandLine, { ...execOptions, shell: "/bin/sh" }),
          sandbox: "none",
          sandboxError: current.error || "srt is not installed",
        };
      } catch (err) {
        err.sandbox = "none";
        err.sandboxError = current.error || "srt is not installed";
        throw err;
      }
    }

    const file = settingsPath(options.cwd);
    try {
      const result = await execFile(command, ["--settings", file, "--", "/bin/sh", "-c", commandLine], execOptions);
      return { result, sandbox: "srt" };
    } catch (err) {
      if (err?.code === "ENOENT" || String(err?.syscall || "").startsWith("spawn")) {
        probeResult = { available: false, error: String(err.message || err).slice(0, 300) };
        if (normalized === "required") {
          throw new Error(`sandbox required but srt failed to start: ${probeResult.error}`);
        }
        try {
          return {
            result: await exec(commandLine, { ...execOptions, shell: "/bin/sh" }),
            sandbox: "none",
            sandboxError: probeResult.error,
          };
        } catch (fallbackError) {
          fallbackError.sandbox = "none";
          fallbackError.sandboxError = probeResult.error;
          throw fallbackError;
        }
      }
      err.sandbox = "srt";
      throw err;
    }
  }

  return { run, probe, status, settingsFor };
}
