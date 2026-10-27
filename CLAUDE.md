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
| `uren/<key>/declaraties/<id>` | expense claims `{weekKey, datum, soort, oms, bedrag, foto, bron?}` |
| `uren/<key>/bekeuringen/<id>` | traffic fines, same fields; informational only, not settled in pay |
| `uren/<key>/maandfotos/<id>` | photos of monthly paper registrations |
| `beheer/loon` | pay scales |
| `beheer/nmbrs` | Nmbrs export settings |
| `beheer/backup` | backup e-mail and status |
| `beheer/kostprijs` | cost-price settings |
| `beheer/planning` | planning rules `{kraanNodig, derden[], openingstijden[{plaats, soort, dagen[], van, tot}]}`; sub-collections `beschik`, `vast` |
| `beheer/planning/vrachten/<id>` | order book per week `{week, aantal, soort, lading, van, naar, dag, wagen, opm, volgorde}`; rides link via `ritten/<id>.vrachtId` |
| `beheer/planning/weken/<jaar-Wnn>` | `{afspraken[], regels{…}, regelsVragen[], regelsOnbegrepen[]}`: free-text constraints and the structured rules the planning engine uses |
| `beheer/planning/plaatsen/<norm naam>` | `{naam, lat, lon, zeker, bron:'claude'|'handmatig'}`: place coordinates for distance estimates |
| `beheer/vloot/(tank\|onderhoud\|wagens)/<id>` | fuel, maintenance, vehicles |
| `beheer/vloot/maandstaat/<norm kenteken>-<YYYY-MM>` | handwritten monthly fuel sheet read by Claude `{kenteken, wagen, maand, rijen[{dag, kmBegin, kmEinde, liters, station, adblue, zeker, opmerking}], fotos[]}`; weekly km/l per kenteken is computed on display (tab "Maandoverzichten brandstof") |

## Planning engine
The planningsvoorstel no longer asks Claude to write the whole schedule; that does not scale to 100+ loads.
- `maakPlanner()` / `planWeek()` (inline in `web/index.html`, copy in `test/planmotor.js`) is a randomized greedy scheduler over kraan+trailer teams.
- It respects the rij- en rusttijden (EU 561/2006 + Arbeidstijdenbesluit vervoer):
  - 9 u driving per day, 10 u twice a week;
  - 45 min pause after 4.5 u driving, and after 6 u work (driving + loading/unloading); a wait of 45 min or more counts as a pause;
  - daily rest 11 u, or 9 u three times a week (duty max 13 u or 15 u);
  - 56 u driving and 60 u working time per week.
- It also respects: vroegste start, laad/los windows per place and per day (fixed ones in Planregels → Laad- en lostijden; week-specific ones take precedence; days not listed = closed), max per day per place, wagen appointments (place from–to), fixed day/wagen per load, and being back at the end place.
- Every day drivers keep going until their driving/working time is used up, except that the week ends at a fixed moment. The default is `eind: 'vr 15:30'` (owner's wish: Friday 15:30 back in Uddel). `eind: 'vr'` without a time is possible, but only if the owner asks for it.
- It keeps the best of hundreds of variants: most loads first, then fewest empty km.
- An independent validator re-checks the winning schedule.
- Claude is only used to turn free-text afspraken into the `regels` object, and to look up coordinates of places.
- Distances are haversine × `wegfactor` (default 1.3).
- Test with `node test/planmotor.test.js`. The user's real scenario must give 53/55; the bound is 30 unloads in Uddel per week.

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
