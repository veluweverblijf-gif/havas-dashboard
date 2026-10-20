# Havas Uren & Planning

Webapp voor Havas Houttransport (Elspeet). Het is hetzelfde dashboard als de Claude-versie, maar dan als eigen app.

De app bevat deze tabbladen:
- **Overzicht**
- **Uren**: weekstaten volgens de cao Beroepsgoederenvervoer 2026, met overuren, tijd-voor-tijd, verblijfkosten, km-vergoeding en declaraties.
- **Planning**: inzien, wijzigen en maken, met planregels, vaste ritten, derden en een planningsvoorstel door Claude.
- **Brandstofverbruik**
- **Technisch overzicht**
- **Kostprijs overzicht**
- **Beheer**: loonschalen, salarisoverzicht in Excel, Nmbrs-export en back-up.

Wat er anders is dan in de Claude-versie:
- Iedereen logt in met e-mailadres en wachtwoord. Chauffeurs hebben **geen Claude-account** nodig.
- De app is te installeren op de telefoon, zowel iPhone als Android.
- Alle gegevens staan in je eigen database (Supabase, servers in de EU).
- Foto's uitlezen en de "Stel je vraag"-box gaan via de Claude API, met een eigen API-sleutel.
- Elke nacht wordt er een back-up gemaakt, die per e-mail kan worden verstuurd.

---

## Zo werkt het

```
web/                      de app zelf (statische bestanden, geen build nodig)
  index.html              het dashboard
  js/platform.js          koppeling met Supabase: inloggen, database, foto's, Claude, downloads
  sw.js                   service worker: installeerbare app + afgeschermde foto's
  config.js               jouw Supabase-adres en publieke sleutel  ← invullen
supabase/
  migrations/001_init.sql database, rechten (wie mag wat zien), opslag voor foto's
  migrations/002_backup_cron.sql  dagelijkse back-up inplannen
  functions/claude/       server-functie die vragen en foto's naar Claude stuurt
  functions/backup/       server-functie voor de dagelijkse back-up
```

**Rechten.** Ze worden afgedwongen in de database zelf, niet alleen in de app:

| Rol | Ziet | Mag wijzigen |
|---|---|---|
| beheerder | alles | alles |
| chauffeur | planning, chauffeurs- en wagenlijst, eigen uren, declaraties en maandfoto's | alleen eigen uren, declaraties en maandfoto's |
| wacht (nieuw account) | niets | niets |

---

## Installeren (eenmalig, ongeveer 30 minuten)

### 1. Supabase-project aanmaken
1. Maak een gratis account op [supabase.com](https://supabase.com).
2. Kies **New project**.
   - Naam: `havas`.
   - Regio: **Central EU (Frankfurt)**.
   - Kies een sterk databasewachtwoord en bewaar het.
3. Ga naar **SQL Editor → New query**.
4. Plak de inhoud van `supabase/migrations/001_init.sql` en klik op **Run**.

### 2. Inloggen instellen
Ga naar **Authentication → URL Configuration**.
- Zet **Site URL** op het adres van je app, bijvoorbeeld `https://havas-dashboard.netlify.app`. Dat adres krijg je in stap 5. Pas het daarna aan.
- Zet bij **Redirect URLs** hetzelfde adres.

Ga daarna naar **Authentication → Providers → Email**. Laat **Confirm email** aan, zodat iemand zijn e-mailadres moet bevestigen.

### 3. Server-functies (Claude en back-up)
Dit kan helemaal in de browser.

1. Haal een API-sleutel op [console.anthropic.com](https://console.anthropic.com) (**API Keys → Create key**). Zet er tegoed op, bijvoorbeeld € 20.
2. Ga in Supabase naar **Edge Functions → Secrets** en voeg deze geheimen toe:
   - `ANTHROPIC_API_KEY`: de sleutel uit stap 1.
   - `BACKUP_SECRET`: een zelfverzonnen lange tekst van minstens 30 tekens.
   - `RESEND_API_KEY`: optioneel, alleen nodig om back-ups te mailen (zie stap 7).
3. Ga naar **Edge Functions → Deploy a new function → Via Editor**.
   - Naam: `claude`.
   - Plak de inhoud van `supabase/functions/claude/index.ts`.
   - Klik op **Deploy**.
4. Herhaal dit voor de functie `backup`, met `supabase/functions/backup/index.ts`.
   - Zet daarna bij die functie onder **Details** de optie **Enforce JWT verification** uit. De back-up controleert zelf het geheim.

Werk je liever met de Supabase CLI? Gebruik dan:

```
supabase link --project-ref <ref>
supabase db push
supabase functions deploy claude
supabase functions deploy backup --no-verify-jwt
```

### 4. App koppelen aan Supabase
1. Zoek in Supabase het adres en de sleutel op via **Project Settings → API**: de **Project URL** en de **anon public**-sleutel.
2. Open op GitHub het bestand `web/config.js` en klik op het potlood om het te bewerken.
3. Vul de URL en de sleutel in en klik op **Commit changes**.

De anon-sleutel mag openbaar zijn. De rechten worden door de database afgedwongen.

### 5. App online zetten (Netlify, gratis)
1. Log in op [netlify.com](https://netlify.com) met je GitHub-account.
2. Kies **Add new site → Import an existing project → GitHub → havas-dashboard**.
3. Netlify leest `netlify.toml` en publiceert de map `web`. Klik op **Deploy**.
4. Optioneel: geef de site een nettere naam via **Site configuration → Change site name**.
5. Zet het adres van je app in Supabase bij stap 2 (Site URL en Redirect URLs).

Na elke wijziging op GitHub zet Netlify de nieuwe versie automatisch online.

### 6. Eerste keer inloggen
1. Open de app en kies **Nieuw account**. **Het eerste account wordt automatisch beheerder.**
2. Gegevens uit de Claude-versie overzetten:
   - Klik op **Gebruikers** (rechtsboven).
   - Kies **Back-up terugzetten…**.
   - Kies het bestand `havas-gegevens-uit-artifact.json`.
3. Laat de andere beheerders en chauffeurs een account aanmaken via **Nieuw account**. Ze staan op **wacht**. Geef ze daarna bij **Gebruikers** de rol *beheerder* of *chauffeur*.
4. Een chauffeur kiest bij de eerste keer zijn eigen naam ("Wie ben je?").

**App op de telefoon zetten:**
- iPhone (Safari): **Delen → Zet op beginscherm**.
- Android (Chrome): **⋮ → App installeren**.

### 7. Dagelijkse back-up
1. Open `supabase/migrations/002_backup_cron.sql` en vul je project-ref en `BACKUP_SECRET` in.
2. Draai het in de **SQL Editor**.
3. Vul in de app bij **Beheer → Dagelijkse back-up** het e-mailadres in.

Er wordt elke nacht een back-up gemaakt, ook zonder e-mail. Die blijft altijd bewaard in Supabase (**Storage → backups**).

Om te mailen is een gratis account bij [resend.com](https://resend.com) nodig:
- Maak een API-sleutel aan en zet die als `RESEND_API_KEY` bij de geheimen.
- Zonder eigen domein kan Resend alleen mailen naar het adres waarmee je bij Resend bent aangemeld.
- Wil je naar een ander adres mailen? Verifieer dan een eigen domein bij Resend en zet `BACKUP_FROM`, bijvoorbeeld `Havas <backup@havas.nl>`.

Met **Gebruikers → Nu back-up maken** test je of de back-up werkt.

---

## Kosten (indicatie)
- **Supabase Free:** € 0.
  - Ruim genoeg voor dit bedrijf: 500 MB database en 1 GB foto's.
  - Let op: een gratis project wordt na een week zonder gebruik gepauzeerd.
  - Wil je zekerheid en automatische database-back-ups van Supabase zelf? Dan is **Pro** ca. $ 25 per maand.
- **Netlify:** € 0.
- **Claude API:** betalen per gebruik. Een maandregistratie uitlezen kost enkele dubbeltjes. "Stel je vraag" kost minder dan een cent per vraag.
- **Resend:** € 0, tot 3.000 mails per maand.

## Verder ontwikkelen
Open deze repository in [Claude Code](https://claude.ai/code) en beschrijf wat er moet veranderen. In `CLAUDE.md` staat hoe het project in elkaar zit.
