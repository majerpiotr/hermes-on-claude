// OpenAI-compatible HTTP surface in front of the Claude Code CLI.
//
// Exists so an agent runtime that speaks the OpenAI chat-completions protocol
// can use a Claude subscription as its model backend, with the CLI doing the
// authenticating. The runtime stays the agent; this only answers model calls.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as backend from "./claude_backend.mjs";
import * as translate from "./translate.mjs";

// Pino (Fastify's logger) has no "warning" level -- map the Python-style
// name from CLAUDE_SHIM_LOG_LEVEL (used by claude_backend.mjs's own debug
// gate too) onto pino's levels, defaulting to "info" same as the old shim.
const PINO_LEVELS = { debug: "debug", info: "info", warning: "warn", warn: "warn", error: "error" };
const LOG_LEVEL = PINO_LEVELS[(process.env.CLAUDE_SHIM_LOG_LEVEL || "INFO").toLowerCase()] || "info";

// Per-request access logs are noise for an internal bridge with one caller;
// the completion log line below already carries what matters per call.
const app = Fastify({
  logger: { level: LOG_LEVEL },
  logController: new Fastify.LogController({ disableRequestLogging: true }),
});
const log = app.log;

// Mirrors the Pydantic ChatRequest model: validates shape, accepts and
// silently ignores fields the CLI has no equivalent knob for (temperature,
// top_p, max_tokens, tool_choice) rather than rejecting requests that set
// them out of habit.
const ChatRequestSchema = z.object({
  model: z.string().nullish(),
  messages: z.array(z.record(z.any())).default([]),
  tools: z.array(z.record(z.any())).nullish(),
  stream: z.boolean().default(false),
  temperature: z.number().nullish(),
  top_p: z.number().nullish(),
  max_tokens: z.number().nullish(),
  tool_choice: z.any().nullish(),
});

app.get("/health", async () => ({ status: "ok" }));

app.get("/v1/models", async () => {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: translate.ADVERTISED_MODELS.map((id) => ({
      id,
      object: "model",
      created: now,
      owned_by: "anthropic",
    })),
  };
});

function completionEnvelope({ model, content, toolCalls, usage }) {
  const message = { role: "assistant" };
  let finishReason;
  if (toolCalls.length > 0) {
    message.content = null;
    message.tool_calls = toolCalls;
    finishReason = "tool_calls";
  } else {
    message.content = content || "";
    finishReason = "stop";
  }

  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

/**
 * Re-shape a finished completion as a minimal SSE stream.
 *
 * The CLI returns a whole turn at once, so there is nothing to stream
 * incrementally; this exists purely so clients that set stream=true work.
 */
function asSseChunks(envelope) {
  const choice = envelope.choices[0];
  const delta = { role: "assistant" };
  if (choice.message.tool_calls) {
    delta.tool_calls = choice.message.tool_calls.map((call, index) => ({
      ...call,
      index,
    }));
  } else {
    delta.content = choice.message.content || "";
  }

  const base = {
    id: envelope.id,
    object: "chat.completion.chunk",
    created: envelope.created,
    model: envelope.model,
  };
  const first = { ...base, choices: [{ index: 0, delta, finish_reason: null }] };
  const last = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
    usage: envelope.usage,
  };
  return [
    `data: ${JSON.stringify(first)}\n\n`,
    `data: ${JSON.stringify(last)}\n\n`,
    "data: [DONE]\n\n",
  ];
}

app.post("/v1/chat/completions", async (request, reply) => {
  const parsed = ChatRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: { message: parsed.error.message, type: "invalid_request" } };
  }
  const body = parsed.data;

  const model = translate.mapModel(body.model);
  const tools = body.tools && body.tools.length > 0 ? body.tools : null;

  const systemPrompt = translate.buildSystemPrompt(body.messages, tools);
  const sessionId = randomUUID();
  const streamInput = translate.buildStreamJsonInput(body.messages, sessionId);
  const schema = tools ? translate.buildDecisionSchema() : null;

  if (!streamInput.trim()) {
    reply.code(400);
    return { error: { message: "no non-system messages in request" } };
  }

  let result;
  try {
    result = await backend.complete({
      model,
      systemPrompt,
      streamJsonInput: streamInput,
      decisionSchema: schema,
    });
  } catch (err) {
    if (err instanceof backend.BackendError) {
      log.error({ err }, "backend failure");
      reply.code(502);
      return { error: { message: err.message, type: "backend_error" } };
    }
    throw err;
  }

  const { content, toolCalls } = translate.parseDecision(result.text, Boolean(tools));
  const usage = translate.buildUsage(result.usage);

  // Reported, never repaired: see findOrphanClosingTag for why trimming the
  // tail would be worse than leaving it visible.
  const orphanTag = translate.findOrphanClosingTag(content);
  if (orphanTag) {
    log.warn(
      { tag: orphanTag, model: result.model || model, tools: (tools || []).length },
      "reply ends with a closing tag it never opened; tool-call syntax may have leaked into the answer",
    );
  }

  log.info(
    {
      requested: body.model,
      mapped: model,
      actual: result.model || model,
      tools: (tools || []).length,
      toolCalls: toolCalls.length,
      tokens: usage.total_tokens,
      costUsd: result.costUsd,
    },
    "completion",
  );

  const envelope = completionEnvelope({
    model: result.model || model,
    content,
    toolCalls,
    usage,
  });

  if (body.stream) {
    reply.type("text/event-stream");
    return asSseChunks(envelope).join("");
  }
  return envelope;
});

const port = Number(process.env.PORT || 8080);
app
  .listen({ host: "0.0.0.0", port })
  .then(() => log.info(`claude-code-shim listening on :${port}`))
  .catch((err) => {
    log.error(err);
    process.exit(1);
  });
