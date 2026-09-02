// Runs the Claude Code CLI as a stateless completion engine.

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

const log = {
  debug: (...args) => {
    if ((process.env.CLAUDE_SHIM_LOG_LEVEL || "INFO").toUpperCase() === "DEBUG") {
      console.debug(new Date().toISOString(), "DEBUG claude_shim.backend", ...args);
    }
  },
};

// Working directory for the CLI. Deliberately empty: with --safe-mode the CLI
// already ignores project config, and an empty cwd means there is nothing to
// discover even if that behaviour changes.
const CLI_CWD = process.env.CLAUDE_SHIM_CWD || "/var/empty-workspace";

const CLI_TIMEOUT_MS = Number(process.env.CLAUDE_SHIM_TIMEOUT || "300") * 1000;
const MAX_BUDGET_USD = (process.env.CLAUDE_SHIM_MAX_BUDGET_USD || "").trim();

export class BackendError extends Error {}

/**
 * Assemble the CLI invocation.
 *
 * Every flag here has a reason:
 *   --tools ""                strip built-in tools; the caller is the agent
 *   --safe-mode               ignore CLAUDE.md, skills, plugins, hooks, MCP
 *   --strict-mcp-config       belt and braces on the MCP side
 *   --no-session-persistence  the caller owns conversation state, not the CLI
 *   --input/--output-format   carry multi-turn history in and structure out
 *
 * Note: --bare is deliberately NOT used. It looks like the right "minimal
 * mode", but it forces auth to ANTHROPIC_API_KEY and never reads OAuth, which
 * would defeat the entire point of running on a subscription.
 */
export function buildArgv({ model, systemPrompt, decisionSchema }) {
  const argv = [
    "-p",
    "--model",
    model,
    "--tools",
    "",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];

  if (systemPrompt) argv.push("--system-prompt", systemPrompt);
  if (decisionSchema != null) argv.push("--json-schema", JSON.stringify(decisionSchema));
  if (MAX_BUDGET_USD) argv.push("--max-budget-usd", MAX_BUDGET_USD);

  return argv;
}

// Only these reach the CLI. An allowlist rather than a blocklist because the
// CLI changes behaviour based on ambient CLAUDE_* variables: inheriting a
// parent's CLAUDECODE=1 / CLAUDE_CODE_CHILD_SESSION=1 makes it treat itself
// as a nested child session and silently ignore --model. An
// ANTHROPIC_API_KEY leaking in would be worse still: billing would move off
// the subscription onto pay-per-token API rates without any visible sign.
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  // Ordinary process identity. Dropping USER breaks macOS keychain lookup
  // ("Not logged in - please run /login"), which matters when running the
  // shim outside the container to debug against a desktop login.
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/** Build a minimal, predictable environment for the CLI. */
function childEnv() {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.CI = "1";
  return env;
}

/**
 * Extract the terminal `result` event and the answering model.
 *
 * The model is read from the last assistant event rather than from
 * `modelUsage`: a turn frequently bills two models (the requested one plus a
 * cheaper one for side duties), and neither "first key" nor "largest output"
 * reliably picks the one that wrote the answer -- on short replies the side
 * model out-generates the primary.
 */
function parseEvents(stdout) {
  let resultEvent = null;
  let answeringModel = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "result") {
      resultEvent = event;
    } else if (event.type === "assistant") {
      const modelName = event.message?.model;
      if (modelName) answeringModel = modelName;
    }
  }

  if (resultEvent === null) {
    throw new BackendError("CLI produced no result event");
  }
  return { resultEvent, answeringModel };
}

function runCli(argv, input, cwd, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new BackendError(`CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new BackendError(
            "claude CLI not found on PATH. The shim image must install @anthropic-ai/claude-code.",
          ),
        );
      } else {
        reject(new BackendError(`Failed to spawn CLI: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });

    child.stdin.write(input, "utf-8");
    child.stdin.end();
  });
}

/** Run one CLI invocation and return its final result. */
export async function complete({ model, systemPrompt, streamJsonInput, decisionSchema }) {
  const argv = buildArgv({ model, systemPrompt, decisionSchema });

  await mkdir(CLI_CWD, { recursive: true });

  log.debug(
    "argv:",
    argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" "),
  );

  const { code, stdout, stderr } = await runCli(
    argv,
    streamJsonInput,
    CLI_CWD,
    childEnv(),
    CLI_TIMEOUT_MS,
  );

  if (code !== 0) {
    // The CLI reports auth and API failures as a result event on stdout and
    // leaves stderr empty, so "exited 1, no stderr" hides the actual cause
    // (e.g. "401 OAuth access token is invalid"). Look there first.
    let detail = stderr.trim();
    try {
      const { resultEvent } = parseEvents(stdout);
      const reported = resultEvent.result || "";
      const status = resultEvent.api_error_status;
      if (reported) detail = `${reported}${status ? ` (HTTP ${status})` : ""}`;
    } catch {
      // fall through with stderr as detail
    }
    throw new BackendError(`CLI exited ${code}: ${detail.slice(0, 800) || "no diagnostics"}`);
  }

  const { resultEvent, answeringModel } = parseEvents(stdout);

  if (resultEvent.is_error) {
    const detail = resultEvent.result || resultEvent.api_error_status || "unknown";
    throw new BackendError(`CLI reported an error: ${detail}`);
  }

  if (stderr.trim()) log.debug("claude stderr:", stderr.trim().slice(0, 500));

  return {
    text: resultEvent.result || "",
    usage: resultEvent.usage || {},
    model: answeringModel || model,
    costUsd: Number(resultEvent.total_cost_usd || 0),
    stopReason: resultEvent.stop_reason || "end_turn",
  };
}
