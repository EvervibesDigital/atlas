import type { FetchLike } from "./token-exchange";

export interface Comment {
  id: string;
  text: string;
  timestamp: string;
}

/** Verified against Meta's current docs: GET /{ig-media-id}/comments. */
export async function fetchComments(igMediaId: string, pageAccessToken: string, fetcher: FetchLike): Promise<Comment[]> {
  const params = new URLSearchParams({ access_token: pageAccessToken });
  const res = await fetcher(`https://graph.facebook.com/v25.0/${igMediaId}/comments?${params.toString()}`);
  const data = (await res.json()) as { data?: Comment[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`fetching comments failed: HTTP ${res.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  return data.data ?? [];
}

/** Reply to a specific comment (not a new top-level comment) via its /replies edge. */
export async function replyToComment(commentId: string, message: string, pageAccessToken: string, fetcher: FetchLike): Promise<{ replyId: string }> {
  const params = new URLSearchParams({ message, access_token: pageAccessToken });
  const res = await fetcher(`https://graph.facebook.com/v25.0/${commentId}/replies?${params.toString()}`, { method: "POST" });
  const data = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`replying to comment failed: HTTP ${res.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  if (!data.id) throw new Error(`reply returned no id: ${JSON.stringify(data).slice(0, 200)}`);
  return { replyId: data.id };
}

export interface InboxMessage {
  id: string;
  text: string;
  fromId: string;
  timestamp: string;
}

/**
 * Flattens each conversation's latest message. Field-expansion shape
 * (`messages{...}`) matches Meta's documented pattern for the conversations
 * edge — not yet run against a real account with real messages; watch this
 * specific call the first time it polls something real.
 */
export async function fetchConversationMessages(pageId: string, pageAccessToken: string, fetcher: FetchLike): Promise<InboxMessage[]> {
  const params = new URLSearchParams({ platform: "INSTAGRAM", fields: "messages{message,from,created_time}", access_token: pageAccessToken });
  const res = await fetcher(`https://graph.facebook.com/v25.0/${pageId}/conversations?${params.toString()}`);
  const data = (await res.json()) as {
    data?: Array<{ id: string; messages?: { data?: Array<{ id: string; message: string; from: { id: string }; created_time: string }> } }>;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`fetching conversations failed: HTTP ${res.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  const messages: InboxMessage[] = [];
  for (const conv of data.data ?? []) {
    const latest = conv.messages?.data?.[0];
    if (latest) messages.push({ id: latest.id, text: latest.message, fromId: latest.from.id, timestamp: latest.created_time });
  }
  return messages;
}

export async function sendDirectMessage(pageId: string, recipientIgsid: string, text: string, pageAccessToken: string, fetcher: FetchLike): Promise<{ messageId: string }> {
  const params = new URLSearchParams({ access_token: pageAccessToken });
  const res = await fetcher(`https://graph.facebook.com/v25.0/${pageId}/messages?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientIgsid }, message: { text } }),
  });
  const data = (await res.json()) as { message_id?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`sending DM failed: HTTP ${res.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  if (!data.message_id) throw new Error(`DM send returned no message_id: ${JSON.stringify(data).slice(0, 200)}`);
  return { messageId: data.message_id };
}
