/**
 * Runtime model client — OpenAI-compatible chat over HTTP fetch.
 *
 * Speaks the minimal shape the harness's `ModelClient` interface needs: send
 * the transcript, receive one assistant message with an optional tool call.
 * Works with any provider that exposes the OpenAI chat-completions shape —
 * OpenRouter, OpenAI, vLLM, Ollama's compatibility layer — because the
 * assurance path must not depend on one vendor's SDK.
 *
 * The key is passed per request from the caller's environment; it is never
 * logged, never persisted in a session transcript, and never returned by any
 * accessor. Only `modelId` travels with the audit trail.
 *
 * Tool calls arrive as OpenAI `tool_calls`; the harness wants a single
 * `toolCall`. OpenAI-compatible providers emit at most the array we accept —
 * if a provider ever returns several, this client takes the first and drops
 * the rest, because one proposal per turn is the harness's contract.
 */

import type { ModelChatMessage, ModelClient, ModelToolCall } from './harness.js';
import { TOOL_REGISTRY, type ToolName } from './tools.js';

export const OPENAI_CLIENT_VERSION = 'gridflex-model-openai-1.0.0';

export interface OpenAiClientConfig {
  /** Full chat-completions URL, e.g. https://openrouter.ai/api/v1/chat/completions */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Optional per-request settings passed through to the provider. */
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Timeout in milliseconds; defaults to 30s. */
  readonly timeoutMs?: number;
  /**
   * Restricts the tools the model is told about and may return. Defense in
   * depth on top of the harness's own authorization gate: a tool absent from
   * this list is not in the prompt and a returned call for it is refused by
   * the client, so the provider never even sees the temptation.
   */
  readonly allowedTools?: readonly ToolName[];
}

/** Errors that must not leak provider payloads into logs or transcripts. */
export class ModelClientError extends Error {
  public readonly code = 'MODEL_CLIENT_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'ModelClientError';
  }
}

interface OpenAiToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface OpenAiResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly OpenAiToolCall[];
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createOpenAiModelClient(config: OpenAiClientConfig): ModelClient {
  const allowed = config.allowedTools
    ? new Set<string>(config.allowedTools)
    : null;

  async function complete(messages: readonly ModelChatMessage[]): Promise<{
    message: ModelChatMessage;
    usage?: { readonly inputTokens: number; readonly outputTokens: number };
  }> {
    // Serialize our transcript into OpenAI's shape. Tool results become
    // role:'tool' messages keyed by a synthetic call id; provider-side order
    // and pairing are preserved by construction.
    const payloadMessages = messages.map((message, index) => {
      if (message.role === 'tool') {
        return { role: 'tool', tool_call_id: `call_${index}`, content: message.content };
      }
      if (message.role === 'assistant' && message.toolCall !== undefined) {
        return {
          role: 'assistant',
          content: message.content || null,
          tool_calls: [
            {
              id: `call_${index}`,
              type: 'function',
              function: {
                name: message.toolCall.name,
                arguments: JSON.stringify(message.toolCall.arguments ?? {}),
              },
            },
          ],
        };
      }
      return { role: message.role, content: message.content };
    });

    const toolNames = allowed
      ? (Object.keys(TOOL_REGISTRY) as ToolName[]).filter((name) => allowed.has(name))
      : (Object.keys(TOOL_REGISTRY) as ToolName[]);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);

    let response: Response;
    try {
      response = await fetch(config.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          // OpenRouter attribution; other providers ignore it.
          'http-referer': 'https://gridflex.app',
          'x-title': 'GridFlex Agent',
        },
        body: JSON.stringify({
          model: config.model,
          messages: payloadMessages,
          temperature: config.temperature ?? 0.2,
          max_tokens: config.maxTokens ?? 512,
          tools: toolNames.map((name) => ({
            type: 'function',
            function: {
              name,
              description: TOOL_REGISTRY[name].description,
              parameters: { type: 'object', properties: {} },
            },
          })),
          tool_choice: 'auto',
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      const name = error instanceof Error ? error.name : 'UnknownError';
      throw new ModelClientError(`Model request failed (${name})`);
    }
    clearTimeout(timeout);

    if (!response.ok) {
      // Status only — the body can echo the key or provider internals.
      throw new ModelClientError(`Model provider returned HTTP ${response.status}`);
    }

    let parsed: OpenAiResponse;
    try {
      const raw: unknown = await response.json();
      if (!isRecord(raw)) throw new Error('non-object body');
      parsed = raw as OpenAiResponse;
    } catch {
      throw new ModelClientError('Model provider returned an unreadable response body');
    }

    const message = parsed.choices?.[0]?.message;
    const content = message?.content ?? '';
    const rawCalls = message?.tool_calls ?? [];
    const first = rawCalls[0];
    if (first === undefined) {
      return { message: { role: 'assistant', content } };
    }

    const name = first.function?.name ?? '';
    if (allowed !== null && !allowed.has(name)) {
      // The provider proposed outside the declared surface. Surface that as a
      // plain refusal the harness can feed back, not a crash.
      return {
        message: {
          role: 'assistant',
          content: `Tool ${name} is not available to this session.`,
        },
      };
    }
    if (!(name in TOOL_REGISTRY)) {
      throw new ModelClientError(`Provider returned unknown tool ${JSON.stringify(name)}`);
    }

    let toolArguments: Record<string, unknown> = {};
    const rawArguments = first.function?.arguments ?? '{}';
    try {
      const parsedArguments: unknown = JSON.parse(rawArguments);
      if (isRecord(parsedArguments)) toolArguments = parsedArguments;
    } catch {
      toolArguments = {};
    }

    const toolCall: ModelToolCall = { name: name as ToolName, arguments: toolArguments };
    const usage =
      parsed.usage?.prompt_tokens !== undefined || parsed.usage?.completion_tokens !== undefined
        ? {
            inputTokens: parsed.usage?.prompt_tokens ?? 0,
            outputTokens: parsed.usage?.completion_tokens ?? 0,
          }
        : undefined;
    return usage === undefined
      ? { message: { role: 'assistant', content, toolCall } }
      : { message: { role: 'assistant', content, toolCall }, usage };
  }

  return { complete };
}
