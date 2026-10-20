// Supabase Edge Function "claude"
// Stuurt vragen en foto's door naar de Claude API (Anthropic). De API-sleutel blijft op de server.
// Alleen goedgekeurde gebruikers (beheerder of chauffeur) mogen dit gebruiken.
//
// Geheimen (supabase secrets set ...):
//   ANTHROPIC_API_KEY      verplicht
//   CLAUDE_MODEL_COMPLEX   optioneel (standaard claude-opus-5-5)  → uitlezen foto's, planningsvoorstel
//   CLAUDE_MODEL_QUICK     optioneel (standaard claude-haiku-5-5) → "Stel je vraag"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_IMAGES = 20;
const MODELS: Record<string, string> = {
  complex: Deno.env.get("CLAUDE_MODEL_COMPLEX") ?? "claude-opus-5-5",
  default: Deno.env.get("CLAUDE_MODEL_COMPLEX") ?? "claude-opus-5-5",
  quick: Deno.env.get("CLAUDE_MODEL_QUICK") ?? "claude-haiku-5-5",
};

function fout(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type Img = { media_type: string; data: string };
type Msg = { role: "user" | "assistant"; content: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fout(405, "invalid_request", "Alleen POST");

  // wie vraagt dit?
  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: u } = await sb.auth.getUser();
  if (!u?.user) return fout(401, "not_granted", "Niet ingelogd");
  const { data: prof } = await sb.from("profiles").select("rol").eq("id", u.user.id).maybeSingle();
  if (!prof || prof.rol === "wacht") return fout(403, "not_granted", "Account nog niet goedgekeurd");

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return fout(500, "unavailable", "ANTHROPIC_API_KEY ontbreekt op de server");

  let body: { messages?: Msg[]; images?: Img[]; tier?: string; json?: boolean; maxTokens?: number };
  try { body = await req.json(); } catch { return fout(400, "invalid_request", "Ongeldige aanvraag"); }
  const messages = (body.messages ?? []).filter((m) => m && typeof m.content === "string" && m.content);
  if (!messages.length) return fout(400, "invalid_request", "Lege vraag");
  const images = (body.images ?? []).slice(0, MAX_IMAGES);

  // foto's gaan mee in het laatste gebruikersbericht
  const apiMessages = messages.map((m, i) => {
    if (i === messages.length - 1 && m.role === "user" && images.length) {
      return {
        role: "user",
        content: [
          ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
          { type: "text", text: m.content },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

  const system = body.json
    ? "Je antwoord wordt door software ingelezen. Antwoord met precies één geldige JSON-waarde, zonder uitleg of Markdown eromheen."
    : "Je bent de hulpassistent van het dashboard van Havas Houttransport. Antwoord in het Nederlands, kort en duidelijk.";

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODELS[body.tier ?? "default"] ?? MODELS.default,
      max_tokens: Math.min(Math.max(body.maxTokens ?? 16000, 256), 32000),
      system,
      messages: apiMessages,
      stream: true,
    }),
  });
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => "");
    const code = r.status === 429 || r.status === 529 ? "rate_limited" : r.status === 400 && /image/i.test(t) ? "image_rejected" : "unavailable";
    return fout(r.status === 400 ? 400 : 502, code, t.slice(0, 500));
  }
  // de stream van Anthropic (server-sent events) direct doorgeven
  return new Response(r.body, { headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
});
