import { safeFetch } from "@/lib/safe-fetch";
import { callTimeoutMs } from "./effective-timeout";
import { extractJsonObject } from "./json-extract";
import type {
  AIProvider,
  AiContentPart,
  AiMessage,
  AiToolCall,
  AiToolDef,
  CompletionParams,
  CompletionResult,
} from "./types";

/**
 * v1.18.9 — Anthropic Messages API content blocks. The text-only path sends a
 * bare string; the vision path (Lab-OCR) sends an array of typed blocks. The
 * uploaded image / PDF is framed strictly as DATA to transcribe by the system
 * prompt — never as instructions (prompt-injection backstop is the human
 * review screen downstream).
 *
 * v1.20.0 — adds the `tool_use` (assistant requests a tool) and `tool_result`
 * (a `role:"user"` turn answering one) blocks so a multi-round tool loop (F1)
 * round-trips natively.
 */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
    };

interface AnthropicWireMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicClientConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

// The only JSON steering on this wire. Current Anthropic models reject an
// assistant-turn prefill (the old `{` trick) with HTTP 400, so the contract
// rides on the instruction and on `extractJsonObject` on the way out.
const JSON_INSTRUCTION =
  "\n\nReply with a single JSON object matching the requested schema and nothing else: no prose, no markdown code fences, no explanation before or after the object.";

/**
 * Map an `AiContentPart[]` body into Anthropic content blocks. The media blocks
 * (image / document) are emitted FIRST and the text blocks LAST so the model
 * reads the report before the instruction — matching the pre-refactor
 * `buildVisionContent` ordering exactly.
 */
function mapParts(parts: AiContentPart[]): AnthropicContentBlock[] {
  const media: AnthropicContentBlock[] = [];
  const text: AnthropicContentBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      text.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      media.push({
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType,
          data: part.dataBase64,
        },
      });
    } else if (part.type === "document") {
      media.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: part.dataBase64,
        },
      });
    }
  }
  return [...media, ...text];
}

/**
 * Map one `AiMessage` to its Anthropic wire turn. A `role:"tool"` turn becomes
 * a `role:"user"` turn carrying a `tool_result` block (Anthropic's convention).
 * An assistant turn with `toolCalls` emits `tool_use` blocks alongside any text.
 */
function mapMessage(m: AiMessage): AnthropicWireMessage {
  if (m.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: typeof m.content === "string" ? m.content : "",
        },
      ],
    };
  }
  const hasToolCalls =
    m.role === "assistant" && !!m.toolCalls && m.toolCalls.length > 0;

  // Plain-string content with no tool calls stays a bare string on the wire —
  // byte-identical to the pre-refactor text-only path. Only build a block array
  // when there are content parts or tool_use blocks to carry.
  if (typeof m.content === "string" && !hasToolCalls) {
    return { role: m.role, content: m.content };
  }

  const blocks: AnthropicContentBlock[] =
    typeof m.content === "string"
      ? m.content.length > 0
        ? [{ type: "text", text: m.content }]
        : []
      : mapParts(m.content);
  if (hasToolCalls) {
    for (const tc of m.toolCalls!) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        input = {};
      }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }
  }
  return { role: m.role, content: blocks };
}

/** Map tool defs into the Anthropic `tools` array. */
function buildAnthropicTools(tools: AiToolDef[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export class AnthropicClient implements AIProvider {
  readonly type = "anthropic" as const;
  /** See `AIProvider.responseTimeoutSeconds`; stamped by the resolver. */
  responseTimeoutSeconds: number | null = null;
  private config: AnthropicClientConfig;

  constructor(config: AnthropicClientConfig) {
    this.config = config;
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const baseUrl = (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    );
    const url = `${baseUrl}/messages`;

    const hasTools = !!params.tools && params.tools.length > 0;
    // Tools imply the tool flow, which returns tool_use blocks rather than a
    // JSON body; the object extraction below stays off that path.
    const wantsJson = params.responseFormat === "json" && !hasTools;

    const wireMessages: AnthropicWireMessage[] =
      params.messages.map(mapMessage);

    // JSON-reliability instruction. The pre-refactor client appended this to
    // the user prompt UNCONDITIONALLY (not gated on `responseFormat`), so every
    // Anthropic caller — including the Coach prose path — saw it. Preserve that
    // exactly by appending to the LAST user turn's text. Tools imply the
    // non-JSON tool flow, so skip the instruction when tools are present.
    if (!hasTools) {
      for (let i = wireMessages.length - 1; i >= 0; i -= 1) {
        if (wireMessages[i].role !== "user") continue;
        const turn = wireMessages[i];
        if (typeof turn.content === "string") {
          turn.content = `${turn.content}${JSON_INSTRUCTION}`;
        } else {
          // Merge into the trailing text block when there is one (vision turns
          // end with the instruction text) so the wire stays a single text
          // block — byte-identical to the pre-refactor `wrapForJson` output.
          const last = turn.content[turn.content.length - 1];
          if (last && last.type === "text") {
            last.text = `${last.text}${JSON_INSTRUCTION}`;
          } else {
            turn.content = [
              ...turn.content,
              { type: "text", text: JSON_INSTRUCTION },
            ];
          }
        }
        break;
      }
    }

    // v1.20.0 — prompt-cache the stable system prefix. Anthropic needs an
    // explicit `cache_control` marker; the system block carries the large
    // brand-free reference grounding + persona, so marking it lets repeated
    // calls (status batch, briefing) read it from cache. Surface
    // `cache_read_input_tokens` for observability.
    const system = [
      {
        type: "text" as const,
        text: params.system,
        cache_control: { type: "ephemeral" as const },
      },
    ];

    const tools = hasTools
      ? buildAnthropicTools(params.tools as AiToolDef[])
      : undefined;
    const toolChoice =
      hasTools && params.toolChoice
        ? params.toolChoice === "none"
          ? { type: "none" as const }
          : { type: "auto" as const }
        : undefined;

    const res = await safeFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        // NOTE: Anthropic's Messages API has no `seed` parameter, so
        // `params.seed` is intentionally not forwarded here — output on this
        // provider is non-deterministic regardless of the pinned seed.
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: params.maxTokens ?? 1000,
          temperature: params.temperature ?? 0.3,
          system,
          messages: wireMessages,
          ...(tools ? { tools } : {}),
          ...(toolChoice ? { tool_choice: toolChoice } : {}),
        }),
      },
      // 60 s ceiling — see openai-client.ts for the rationale.
      // v1.11.2 — base URL is user/admin-overridable; pin the connect-time DNS
      // check so a private/metadata address is rejected (SSRF/rebinding).
      // v1.20.1 — compose the caller's cancel signal (Coach SSE disconnect) so
      // a mid-generation abort tears the upstream call down early.
      // The record owner's response-timeout setting, else the surface value, else 60 s.
      {
        timeoutMs: callTimeoutMs(params, this.responseTimeoutSeconds),
        requirePublicHost: true,
        signal: params.signal,
      },
    );

    if (!res.ok) {
      // Mirror the openai-client body-capture so 4xx/5xx upstream incidents
      // (model-not-found, overloaded, rate limit) are diagnosable from logs
      // instead of surfacing as an opaque "Anthropic request failed (5xx)".
      // Strip anything that looks like an Anthropic API key from the excerpt
      // before logging.
      const rawBody = await res.text().catch(() => "");
      const bodyExcerpt = rawBody
        .slice(0, 500)
        .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***redacted***")
        .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer ***redacted***");
      const err = new Error(`Anthropic request failed (${res.status})`);
      Object.assign(err, {
        httpStatus: res.status,
        upstream: "anthropic",
        model: this.config.model,
        bodyExcerpt,
      });
      throw err;
    }

    const json = (await res.json()) as {
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

    const textBlock = json.content?.find((c) => c.type === "text");
    const rawText = textBlock?.text;

    // v1.20.0 — surface tool_use blocks for F1's loop.
    const toolUseBlocks = (json.content ?? []).filter(
      (c) => c.type === "tool_use",
    );
    const toolCalls: AiToolCall[] | undefined =
      toolUseBlocks.length > 0
        ? toolUseBlocks.map((b) => ({
            id: b.id ?? "",
            name: b.name ?? "",
            arguments: JSON.stringify(b.input ?? {}),
          }))
        : undefined;

    // A tool_use-only reply carries no text — that is valid (F1). Only an empty
    // reply with neither text NOR a tool call is an error.
    if (!rawText && !toolCalls) {
      // v1.20.1 — sentinel httpStatus + kind so the chain classifier can tell
      // an empty 200-OK reply apart from a transport failure. Cascade unchanged
      // (`status <= 0` is already a hard failure).
      const err = new Error("Anthropic returned empty content");
      Object.assign(err, {
        httpStatus: 0,
        kind: "empty_response",
        upstream: "anthropic",
      });
      throw err;
    }

    // Without a prefill the model returns the whole object, sometimes inside
    // a ```json fence or behind a short lead-in sentence; narrow to the
    // object so the caller parses it as-is.
    const content =
      wantsJson && rawText ? extractJsonObject(rawText) : (rawText ?? "");

    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;
    const tokensUsed = inputTokens + outputTokens || null;
    const cachedInputTokens = json.usage?.cache_read_input_tokens ?? null;

    // The presence of tool_use blocks is authoritative for the tool-loop gate:
    // F1's loop continues only when `finishReason === "tool_calls"`. Anthropic
    // normally pairs tool_use blocks with `stop_reason: "tool_use"`, but if it
    // ever returns the blocks under a different (or absent) stop_reason, deriving
    // the reason from `stop_reason` alone would drop the tool request and the
    // loop would surface the empty tool_use-only reply as the final answer.
    const finishReason: CompletionResult["finishReason"] =
      toolCalls && toolCalls.length > 0
        ? "tool_calls"
        : json.stop_reason === "tool_use"
          ? "tool_calls"
          : json.stop_reason === "max_tokens"
            ? "length"
            : json.stop_reason === "end_turn"
              ? "stop"
              : undefined;

    return {
      content,
      tokensUsed,
      cachedInputTokens,
      model: this.config.model,
      providerType: "anthropic",
      ...(toolCalls ? { toolCalls } : {}),
      finishReason,
    };
  }
}
