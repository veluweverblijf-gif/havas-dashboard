# CLAUDE.md: Havas Uren & Planning

This is the dashboard for Havas Houttransport (Elspeet), a timber-transport company running Volvo trucks. It covers hours, planning, fuel, technical status and cost price.

- **Users:** Dutch. All UI text and commit messages are in **Dutch**.
- **Priority:** the owner's guiding principle is "dit project gaat om nauwkeurigheid". Salary and overtime calculations must be exact.

## Architecture
The project is a static web app with no build step, plus Supabase.

### `web/index.html`
- This is the entire dashboard: HTML, CSS and one big inline script.
- It was originally a Claude artifact. It talks to its environment **only** through `window.claude.use('db' | 'user' | 'downloads' | 'assets' | 'sample')`.

### `web/js/platform.js`
Implements those capabilities on Supabase:
- **db:** Firestore-like `collection(col).onSnapshot/get` and `doc(path).onSnapshot/get/set/update/delete`. It runs on table `public.docs(path, parent, data jsonb)` and uses Realtime to refresh subscriptions.
- **user:** `id()`, `canEdit()` (rol = beheerder), `me()`, `profiles(ids)`.
- **assets:** upload to the Storage bucket `fotos` at path `<uid>/<id>.<ext>`. Photos are referenced in the page as `_blob/<id>`, and `web/sw.js` serves them with the user's token.
- **sample:** calls the Edge Function `claude`, which proxies the Anthropic Messages API with streaming. `sample.json` parses the reply tolerantly.
- **Other:** login screen, wait screen for unapproved accounts, the "Gebruikers" dialog (roles, backup now/download/restore) and logout.

### `supabase/migrations/001_init.sql`
- Tables `profiles` and `docs`, with RLS. The first account becomes beheerder; later accounts get `wacht`.
- `doc_merge` RPC.
- Storage buckets `fotos` and `backups`.

### `supabase/functions/`
- `claude`: proxy to the Claude API.
- `backup`: nightly JSON backup to the `backups` bucket, emailed via Resend, with status written to `beheer/backup`.

## Data paths (docs.path)
| Path | Contents |
|---|---|
| `stam/lijsten` | `{chauffeurs[], wagens[]}` |
| `ritten/<id>` | planned rides |
| `uren/<key>` | `{chauffeurId, tvt}`; `<key>` = auth uid (chauffeur's own) or `ch-<chauffeurId>` (entered by a beheerder) |
| `uren/<key>/weken/<jaar>-W<nn>` | week sheet (ma–za) |
| `uren/<key>/declaraties/<id>` | expense claims |
| `uren/<key>/maandfotos/<id>` | photos of monthly paper registrations |
| `beheer/loon` | pay scales |
| `beheer/nmbrs` | Nmbrs export settings |
| `beheer/backup` | backup e-mail and status |
| `beheer/kostprijs` | cost-price settings |
| `beheer/planning` | planning rules; sub-collections `beschik`, `vast` |
| `beheer/vloot/(tank\|onderhoud\|wagens)/<id>` | fuel, maintenance, vehicles |

## Business rules (do not change without the owner's explicit consent)
- **CAO Beroepsgoederenvervoer 2026:**
  - pauzestaffel (bijlage III);
  - verblijfkosten art. 40 (eendaags/meerdaags; evening and early-morning hours at a different rate);
  - km-vergoeding art. 39a: €0.23/km, first 10 km excluded, max 35 km one way, ×2;
  - loonschalen per 1-1-2026, default D6;
  - zaterdag 150%;
  - oproepkracht +8%.
- **Havas overtime:** per worked day ma–vr, overtime = werkuren − dagnorm (contract/5; oproep 8 u).
  - Non-worked days do **not** reduce overtime.
  - Netting happens within a week, and within the month part of a week that spans two months; the result is never below 0.
- **Tijd-voor-tijd:** 1 overuur = 1 uur vrij. Each week has a field for hours moved to TvT, plus a cumulative year balance.
- **Monthly salary export:** everything per calendar day. The "Controle weken" sheet must match the week results, otherwise the export is aborted.
- **Erwin Kuijt (kantoor: true):** has a kantooruren column. On a kantoor day there is no verblijfkosten and no km-vergoeding.

## Testing
- **Database rights:** run 001_init.sql against a local Postgres with stubs for `auth.users`, `auth.uid()` and `storage.*`, then test RLS as chauffeur, wacht and beheerder.
- **Browser:**
  - Serve `web/` and load it with Playwright.
  - Route the supabase-js CDN URL to an in-memory fake client.
  - Check login, the beheerder and chauffeur views, saving, the photo service worker and the Claude stream.
