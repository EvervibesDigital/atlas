import type { BrainRequest } from "../types";

/** Build OpenAI-style chat messages (used by Groq + OpenRouter). */
export function openaiMessages(req: BrainRequest): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.prompt });
  return messages;
}

/** POST an OpenAI-compatible chat completion and return the text. */
export async function openaiChat(opts: {
  url: string;
  apiKey: string;
  model: string;
  req: BrainRequest;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
  const res = await fetch(opts.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      ...opts.extraHeaders,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: openaiMessages(opts.req),
      temperature: opts.req.temperature ?? 0.7,
      max_tokens: opts.req.maxTokens ?? 1024,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${opts.url} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}
