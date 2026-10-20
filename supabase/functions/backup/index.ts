// Supabase Edge Function "backup"
// Maakt een volledige back-up van alle gegevens (uren, planning, brandstof, beheer ...),
// bewaart die in de opslagbak "backups" en mailt hem naar het adres uit Beheer → Back-up.
//
// Aanroepen: dagelijks via Supabase Cron (zie supabase/migrations/002_backup_cron.sql)
// of door een beheerder via de knop "Nu back-up maken".
//
// Geheimen:
//   BACKUP_SECRET    verplicht voor de dagelijkse aanroep (zelf verzonnen lange tekst)
//   RESEND_API_KEY   optioneel: zonder deze sleutel wordt er niet gemaild, alleen bewaard
//   BACKUP_FROM      optioneel afzender, bijv. "Havas dashboard <backup@jouwdomein.nl>"
//                    (standaard onboarding@resend.dev, werkt alleen naar je eigen Resend-adres)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-backup-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // toegang: geheim (cron) of ingelogde beheerder
  const secret = Deno.env.get("BACKUP_SECRET");
  let ok = !!secret && req.headers.get("x-backup-secret") === secret;
  if (!ok) {
    const sb = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: u } = await sb.auth.getUser();
    if (u?.user) {
      const { data: p } = await admin.from("profiles").select("rol").eq("id", u.user.id).maybeSingle();
      ok = p?.rol === "beheerder";
    }
  }
  if (!ok) return json({ error: "geen toegang" }, 403);

  // alle documenten ophalen (in blokken)
  const docs: { path: string; data: unknown; gewijzigd: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("docs").select("path,data,gewijzigd").order("path").range(from, from + 999);
    if (error) return json({ error: error.message }, 500);
    docs.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const { data: profielen } = await admin.from("profiles").select("id,email,naam,rol");

  const tel = (re: RegExp) => docs.filter((d) => re.test(d.path)).length;
  const aantallen = {
    weekstaten: tel(/^uren\/[^/]+\/weken\//),
    declaraties: tel(/^uren\/[^/]+\/declaraties\//),
    ritten: tel(/^ritten\//),
    tankbeurten: tel(/^beheer\/vloot\/tank\//),
  };
  const nu = new Date();
  const stamp = nu.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const inhoud = { gemaakt: nu.toISOString(), versie: 1, aantallen, docs, profielen };
  const bytes = new TextEncoder().encode(JSON.stringify(inhoud));
  const bestand = `havas-backup-${stamp}.json`;

  let status = "ok, bewaard";
  const up = await admin.storage.from("backups").upload(bestand, bytes, { contentType: "application/json", upsert: true });
  if (up.error) status = "fout bij bewaren: " + up.error.message;

  // mailen
  const inst = docs.find((d) => d.path === "beheer/backup")?.data as { email?: string } | undefined;
  const naar = inst?.email;
  const resend = Deno.env.get("RESEND_API_KEY");
  if (naar && resend) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: Deno.env.get("BACKUP_FROM") ?? "Havas dashboard <onboarding@resend.dev>",
        to: [naar],
        subject: `Back-up Havas dashboard ${nu.toLocaleDateString("nl-NL")}`,
        text:
          `Dagelijkse back-up van het Havas dashboard.\n\n` +
          Object.entries(aantallen).map(([k, v]) => `${k}: ${v}`).join("\n") +
          `\n\nTerugzetten: Beheer → Gebruikers & back-up → Back-up terugzetten.`,
        attachments: [{ filename: bestand, content: b64(bytes) }],
      }),
    });
    status = r.ok ? (up.error ? status + ", gemaild" : `ok, gemaild naar ${naar}`) : status + `, mailen mislukt (${r.status})`;
  } else if (naar) {
    status += ", niet gemaild (RESEND_API_KEY ontbreekt)";
  }

  // status terugschrijven voor het dashboard
  const vorig = (inst ?? {}) as Record<string, unknown>;
  await admin.from("docs").upsert({ path: "beheer/backup", data: { ...vorig, laatste: nu.toISOString(), status, aantallen, bestand } });

  return json({ status, bestand, aantallen });
});
