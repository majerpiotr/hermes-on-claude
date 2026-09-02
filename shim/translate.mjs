// Translation between the OpenAI chat-completions shape and the Claude Code CLI.
//
// The CLI is driven as a stateless completion engine, not as an agent:
// `--tools ""` strips its built-in tools and `--safe-mode` strips project
// configuration, so the only agent in the system is the caller (Hermes).
//
// That creates one problem this module solves. With its own tools stripped,
// the model refuses to emit tool calls if the prompt claims tools are
// "available" to it -- it trusts the runtime over the prompt and answers that
// the tool is not there. Framing it as a planner that only *names* the action
// an external system should take removes the contradiction, and
// `--json-schema` constrains the shape of what comes back. See
// PLANNER_PREAMBLE below.

import { randomUUID } from "node:crypto";

// Aliases the CLI accepts directly; anything else is passed through
// untouched so full model ids (claude-opus-5, claude-haiku-4-5) keep working.
const MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

// Advertised to the caller by GET /v1/models. Hermes picks per task from this.
export const ADVERTISED_MODELS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "opus",
  "sonnet",
  "haiku",
];

const PLANNER_PREAMBLE = `You are the planning stage of an external agent runtime. You never execute anything yourself; the runtime performs every action on your behalf and returns the outcome to you on the next turn.

The runtime can perform these actions:

{tool_list}

Emit action="tool_call" with tool_calls when the request needs one or more of those actions. Emit action="final" with content when you can answer without any action at all. You are not being asked to perform an action, only to name the ones the runtime should run next.

When an earlier action has already run, its output comes back to you as an ordinary user message reporting what it returned. Treat that output as genuine observed data and continue from it.`;

/** Map an incoming model name onto a `claude --model` value. */
export function mapModel(requested) {
  if (!requested) return "sonnet";
  let name = requested.trim();
  // Callers often prefix with a provider, e.g. "anthropic/claude-opus-5".
  if (name.includes("/")) name = name.split("/", 2)[1];
  if (MODEL_ALIASES.has(name)) return name;
  return name;
}

/** Render one OpenAI tool definition as a single prompt line. */
function describeTool(tool) {
  const fn = tool.function ?? tool;
  const name = fn.name ?? "unknown";
  const description = (fn.description ?? "").trim().replace(/\n/g, " ");
  const params = fn.parameters ?? {};
  const props = params.properties ?? {};
  const required = new Set(params.required ?? []);

  const rendered = Object.entries(props).map(([arg, spec]) => {
    const argType = spec?.type ?? "any";
    const marker = required.has(arg) ? "" : "?";
    return `${arg}${marker}: ${argType}`;
  });

  let line = `- ${name}(${rendered.join(", ")})`;
  if (description) line += ` - ${description}`;
  return line;
}

/** Combine the caller's system messages with the planner framing. */
export function buildSystemPrompt(messages, tools) {
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => contentToText(m.content));
  const systemText = systemParts.filter(Boolean).join("\n\n").trim();

  if (!tools || tools.length === 0) return systemText;

  const toolList = tools.map(describeTool).join("\n");
  const planner = PLANNER_PREAMBLE.replace("{tool_list}", toolList);
  return systemText ? `${systemText}\n\n${planner}`.trim() : planner;
}

/**
 * JSON schema constraining the planner's reply.
 *
 * `arguments` is deliberately an unconstrained object: the caller's tools
 * each have their own parameter schema and we cannot express a union of them
 * here.
 */
export function buildDecisionSchema() {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["tool_call", "final"] },
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool_name: { type: "string" },
            arguments: { type: "object" },
          },
          required: ["tool_name", "arguments"],
        },
      },
      content: { type: "string" },
    },
    required: ["action"],
  };
}

/** Flatten OpenAI content (string or block list) into plain text. */
function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object") {
        if (block.type === "text") return block.text ?? "";
        if ("text" in block) return block.text;
      }
      return "";
    });
    return parts.filter(Boolean).join("\n");
  }
  return String(content);
}

function safeJsonParse(raw) {
  if (raw && typeof raw === "object") return raw;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Render the conversation as NDJSON for `--input-format stream-json`.
 *
 * System messages are excluded (they go to --system-prompt). Tool results
 * have no native representation in this input format, so they are folded
 * into user turns with an explicit label -- the planner is told on the next
 * turn what the runtime observed.
 */
export function buildStreamJsonInput(messages, sessionId) {
  const lines = [];

  for (const message of messages) {
    const role = message.role;
    if (role === "system") continue;

    if (role === "assistant") {
      let text = contentToText(message.content);
      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length > 0) {
        // Replay the assistant's own decision so the model sees what it
        // already asked the runtime to do.
        const described = toolCalls.map((tc) => ({
          tool_name: tc.function?.name,
          arguments: safeJsonParse(tc.function?.arguments),
        }));
        text = JSON.stringify({ action: "tool_call", tool_calls: described });
      }
      if (!text) continue;
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text }] },
          parent_tool_use_id: null,
          session_id: sessionId,
        }),
      );
      continue;
    }

    let text;
    if (role === "tool") {
      // Phrased as something the user is telling us, deliberately. An
      // official-looking banner ("RUNTIME RESULT from x:") trips the
      // model's prompt-injection caution and it refuses to trust the
      // content -- it reads as a forged system marker.
      const name = message.name || "the action";
      const body = contentToText(message.content);
      text = `I ran ${name} and it returned:\n\n${body}`;
    } else {
      text = contentToText(message.content);
    }

    if (!text) continue;

    lines.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: sessionId,
      }),
    );
  }

  return lines.join("\n") + "\n";
}

/**
 * Turn the CLI's `result` string into { content, toolCalls }.
 *
 * Without tools the result is plain prose. With tools it is
 * schema-constrained JSON; if it somehow is not, the text is returned as
 * content rather than throwing, so a malformed turn degrades to an answer
 * instead of an error.
 */
export function parseDecision(resultText, hadTools) {
  if (!hadTools) return { content: resultText, toolCalls: [] };

  let decision;
  try {
    decision = JSON.parse(resultText);
  } catch {
    return { content: resultText, toolCalls: [] };
  }

  if (!decision || typeof decision !== "object") {
    return { content: resultText, toolCalls: [] };
  }

  if (decision.action === "tool_call") {
    const calls = decision.tool_calls ?? [];
    const openaiCalls = [];
    for (const call of calls) {
      const name = call.tool_name;
      if (!name) continue;
      openaiCalls.push({
        id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      });
    }
    if (openaiCalls.length > 0) return { content: null, toolCalls: openaiCalls };
  }

  return { content: decision.content ?? "", toolCalls: [] };
}

/**
 * Report a reply that ends with a closing tag it never opened.
 *
 * The model occasionally reaches for Claude's native tool-call syntax inside
 * the free-text `content` the decision schema gives it, and the tail of that
 * block (`</content></invoke>`) arrives as part of the answer.
 *
 * This only reports it. Stripping the tail would corrupt a reply that ends in
 * XML on purpose, an Atom feed's own `</content>` being the obvious case, and
 * would turn a visible artefact into a quietly truncated answer with nothing
 * left to investigate. Requiring the tag to be unopened keeps ordinary
 * generated markup out of the warning.
 */
export function findOrphanClosingTag(text) {
  if (!text) return null;
  const trailing = String(text).match(/(?:\s*<\/[A-Za-z][\w:.-]*>)+\s*$/);
  if (!trailing) return null;

  const body = String(text).slice(0, trailing.index);
  for (const match of trailing[0].matchAll(/<\/([A-Za-z][\w:.-]*)>/g)) {
    const name = match[1];
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`<${escaped}(\\s|/?>)`, "i").test(body)) return name;
  }
  return null;
}

/** Map the CLI's usage block onto the OpenAI usage shape. */
export function buildUsage(cliUsage) {
  const usage = cliUsage ?? {};
  let promptTokens = Number(usage.input_tokens ?? 0);
  promptTokens += Number(usage.cache_read_input_tokens ?? 0);
  promptTokens += Number(usage.cache_creation_input_tokens ?? 0);
  const completionTokens = Number(usage.output_tokens ?? 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}
