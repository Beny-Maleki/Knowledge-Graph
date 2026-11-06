/**
 * Thin, provider-agnostic LLM layer used by the ingest pipeline.
 *
 * - Claude goes through the official Anthropic TypeScript SDK, called
 *   directly from the browser with the user's own key (`dangerouslyAllowBrowser`).
 *   The SDK is loaded lazily, only when an AI feature is first used.
 * - "OpenAI-compatible" covers local runtimes (Ollama, LM Studio) and other
 *   hosted providers that expose /chat/completions.
 */
import { useSettings, type AISettings } from './settings';

export class AIError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
  }
}

export interface GenOptions {
  system: string;
  prompt: string;
  signal?: AbortSignal;
  maxTokens?: number;
  /** Called with the number of output characters received so far. */
  onProgress?: (chars: number, phase: 'thinking' | 'writing') => void;
}

export async function generateJSON<T>(opts: GenOptions & { schema: Record<string, unknown> }): Promise<T> {
  const ai = useSettings.getState().ai;
  const text = ai.provider === 'anthropic' ? await claude(ai, opts, opts.schema) : await openaiCompat(ai, opts, true);
  return extractJSON<T>(text);
}

export async function generateText(opts: GenOptions): Promise<string> {
  const ai = useSettings.getState().ai;
  const text = ai.provider === 'anthropic' ? await claude(ai, opts) : await openaiCompat(ai, opts, false);
  return stripFences(text).trim();
}

function withCustom(ai: AISettings, system: string) {
  return ai.customInstructions.trim() ? `${system}\n\nAdditional instructions from the user:\n${ai.customInstructions.trim()}` : system;
}

async function claude(ai: AISettings, opts: GenOptions, schema?: Record<string, unknown>): Promise<string> {
  if (!ai.anthropicKey.trim()) throw new AIError('No Anthropic API key set.', 'Open Settings → AI and paste a key from console.anthropic.com.');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ai.anthropicKey.trim(), dangerouslyAllowBrowser: true, maxRetries: 2 });
  try {
    const stream = client.beta.messages.stream(
      {
        model: ai.anthropicModel.trim(),
        max_tokens: opts.maxTokens ?? 64000,
        // Re-run on Anthropic's recommended fallback model if the request is declined by a safety classifier.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: withCustom(ai, opts.system),
        messages: [{ role: 'user', content: opts.prompt }],
        output_config: {
          effort: ai.effort,
          ...(schema ? { format: { type: 'json_schema' as const, schema } } : {}),
        },
      },
      { signal: opts.signal },
    );
    let chars = 0;
    opts.onProgress?.(0, 'thinking');
    stream.on('text', (delta) => {
      chars += delta.length;
      opts.onProgress?.(chars, 'writing');
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') {
      throw new AIError('The model declined this request.', msg.stop_details?.explanation ?? 'Try rephrasing or using different source material.');
    }
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    if (msg.stop_reason === 'max_tokens') {
      throw new AIError('The response was cut off (output limit reached).', 'Try a smaller piece of source material or a coarser granularity.');
    }
    if (!text.trim()) throw new AIError('The model returned an empty response.');
    return text;
  } catch (err) {
    if (err instanceof AIError) throw err;
    if (err instanceof Anthropic.APIUserAbortError) throw new AIError('Cancelled.');
    if (err instanceof Anthropic.AuthenticationError) throw new AIError('Anthropic rejected the API key.', 'Check the key in Settings → AI.');
    if (err instanceof Anthropic.PermissionDeniedError) throw new AIError('This key is not allowed to use that model.', err.message);
    if (err instanceof Anthropic.NotFoundError) throw new AIError(`Model “${ai.anthropicModel}” was not found.`, 'Pick another model in Settings → AI.');
    if (err instanceof Anthropic.RateLimitError) throw new AIError('Rate limited by Anthropic.', 'Wait a moment and try again.');
    if (err instanceof Anthropic.BadRequestError) throw new AIError('Anthropic rejected the request.', err.message);
    if (err instanceof Anthropic.APIConnectionError) throw new AIError('Could not reach api.anthropic.com.', 'Check your connection (or an ad-blocker / firewall).');
    if (err instanceof Anthropic.APIError) throw new AIError(`Anthropic API error ${err.status ?? ''}`.trim(), err.message);
    throw new AIError(err instanceof Error ? err.message : String(err));
  }
}

async function openaiCompat(ai: AISettings, opts: GenOptions, json: boolean): Promise<string> {
  const base = ai.openaiBaseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new AIError('No base URL set for the OpenAI-compatible provider.', 'Open Settings → AI.');
  const body = (withFormat: boolean) =>
    JSON.stringify({
      model: ai.openaiModel.trim(),
      messages: [
        { role: 'system', content: withCustom(ai, opts.system) + (json ? '\n\nRespond with a single JSON object only.' : '') },
        { role: 'user', content: opts.prompt },
      ],
      ...(withFormat ? { response_format: { type: 'json_object' } } : {}),
      stream: false,
    });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ai.openaiKey.trim()) headers.Authorization = `Bearer ${ai.openaiKey.trim()}`;
  opts.onProgress?.(0, 'thinking');
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: body(json), signal: opts.signal });
    if (json && res.status === 400) {
      // Some servers don't support response_format; retry without it.
      res = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: body(false), signal: opts.signal });
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new AIError('Cancelled.');
    throw new AIError(
      `Could not reach ${base}.`,
      /localhost|127\.0\.0\.1/.test(base)
        ? 'Is the local server running? Ollama also needs OLLAMA_ORIGINS set to allow this site (see Settings → AI).'
        : 'The provider may not allow requests from browsers (CORS), or the URL is wrong.',
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      /* ignore */
    }
    throw new AIError(`Provider returned HTTP ${res.status}.`, detail);
  }
  const payload = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  const text = payload.choices?.[0]?.message?.content ?? '';
  if (payload.choices?.[0]?.finish_reason === 'length') throw new AIError('The response was cut off (output limit reached).', 'Try a smaller input.');
  if (!text.trim()) throw new AIError('The model returned an empty response.');
  opts.onProgress?.(text.length, 'writing');
  return text;
}

function stripFences(text: string): string {
  const m = /^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? m[1] : text;
}

export function extractJSON<T>(text: string): T {
  const t = stripFences(text.trim());
  try {
    return JSON.parse(t) as T;
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new AIError('The model did not return valid JSON.', 'Try again, or use a more capable model.');
  }
}
