import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiModelClient, ModelClientError } from '../src/agent/openai-client.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function jsonHandler(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CONFIG = {
  baseUrl: 'https://provider.example/api/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model',
};

describe('OpenAI-compatible model client', () => {
  it('sends the transcript and parses a tool call', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonHandler({
        choices: [
          {
            message: {
              content: 'Reading telemetry first.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'READ_TELEMETRY', arguments: '{}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      }),
    );

    const client = createOpenAiModelClient(CONFIG);
    const result = await client.complete([
      { role: 'system', content: 'be safe' },
      { role: 'user', content: 'peak in 3h' },
    ]);

    expect(result.message.role).toBe('assistant');
    expect(result.message.toolCall?.name).toBe('READ_TELEMETRY');
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(CONFIG.baseUrl);
    expect(init.headers.authorization).toBe('Bearer test-key');
    const payload = JSON.parse(init.body) as {
      model: string;
      tools: { function: { name: string } }[];
      messages: { role: string }[];
    };
    expect(payload.model).toBe('test-model');
    expect(payload.messages).toHaveLength(2);
    expect(payload.tools.map((tool) => tool.function.name)).toContain('READ_GRID_SIGNALS');
  });

  it('serializes assistant tool calls and tool results into provider shape', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonHandler({
        choices: [{ message: { content: 'done', tool_calls: [] } }],
      }),
    );

    const client = createOpenAiModelClient(CONFIG);
    await client.complete([
      { role: 'assistant', content: 'proposing', toolCall: { name: 'READ_TELEMETRY', arguments: {} } },
      { role: 'tool', content: '{"executed":true}' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    const payload = JSON.parse(init.body) as {
      messages: { role: string; tool_calls?: unknown; tool_call_id?: string }[];
    };
    expect(payload.messages[0]?.tool_calls).toBeDefined();
    expect(payload.messages[1]?.tool_call_id).toBe('call_1');
  });

  it('honours allowedTools: hides the rest from the prompt and refuses out-of-list calls', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonHandler({
          choices: [
            {
              message: {
                content: 'trying a mutation',
                tool_calls: [
                  { function: { name: 'START_DRILL', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonHandler({
          choices: [
            {
              message: {
                content: 'reading instead',
                tool_calls: [{ function: { name: 'READ_TELEMETRY', arguments: '{}' } }],
              },
            },
          ],
        }),
      );

    const client = createOpenAiModelClient({
      ...CONFIG,
      allowedTools: ['READ_TELEMETRY', 'READ_GRID_SIGNALS'],
    });

    const refused = await client.complete([{ role: 'user', content: 'x' }]);
    // START_DRILL is not in the list: no tool call is surfaced for it.
    expect(refused.message.toolCall).toBeUndefined();
    expect(refused.message.content).toContain('not available');

    const permitted = await client.complete([{ role: 'user', content: 'x' }]);
    expect(permitted.message.toolCall?.name).toBe('READ_TELEMETRY');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const tools = (JSON.parse(init.body) as { tools: { function: { name: string } }[] }).tools;
    expect(tools.map((tool) => tool.function.name)).toEqual(['READ_TELEMETRY', 'READ_GRID_SIGNALS']);
  });

  it('parses malformed tool arguments to an empty object without crashing', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonHandler({
        choices: [
          {
            message: {
              content: 'oops',
              tool_calls: [{ function: { name: 'READ_TELEMETRY', arguments: 'not json' } }],
            },
          },
        ],
      }),
    );

    const client = createOpenAiModelClient(CONFIG);
    const result = await client.complete([{ role: 'user', content: 'x' }]);
    expect(result.message.toolCall?.arguments).toEqual({});
  });

  it('throws a sanitized error on HTTP failures', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"internal detail"}', { status: 500 }));

    const client = createOpenAiModelClient(CONFIG);
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'MODEL_CLIENT_FAILED',
    });
    // The message must not include the provider body.
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it('reports the error name, never the payload, on network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: https://secret-url'));

    const client = createOpenAiModelClient(CONFIG);
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
      ModelClientError,
    );
    try {
      await client.complete([{ role: 'user', content: 'x' }]);
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-url');
      expect((error as Error).message).toContain('TypeError');
    }
  });
});
