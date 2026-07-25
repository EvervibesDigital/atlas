// Ported from the same repo — Gemini's built-in Google Maps grounding tool
// finds real local businesses by niche + city without needing a separate
// Google Places API key. Uses GEMINI_API_KEY, already in ATLAS's vault.
//
// Known risk, noted rather than silently guessed around: the model id below
// (gemini-2.5-flash) is what the original app used and is unverified as
// still-current — this session already found one Gemini model (2.0-flash)
// retired mid-use. If lead-finding starts failing with a 404, check
// aistudio.google.com for the current model list before assuming the code
// is broken.
const MODEL = "gemini-2.5-flash";

export interface FoundLead {
  businessName: string;
  website: string;
  phone?: string;
  email?: string;
}

export async function findLeads(niche: string, city: string, apiKey: string, fetcher: typeof fetch = fetch): Promise<FoundLead[]> {
  const prompt = `Find 5 real businesses in the ${niche} industry located in ${city} that DO have a website.
Return them as a JSON array of objects with these fields: businessName, website (full URL), phone (if known, else null), email (if known, else null).
Only return the JSON array, no other text.`;

  const r = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ googleMaps: {} }],
    }),
  });
  if (!r.ok) throw new Error(`findLeads: Gemini HTTP ${r.status}`);
  const data = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as FoundLead[];
  } catch {
    return [];
  }
}
