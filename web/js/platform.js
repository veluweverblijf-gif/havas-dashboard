/* Havas dashboard — platformlaag
 *
 * Het dashboard (index.html) is oorspronkelijk gebouwd als Claude-artifact en vraagt zijn
 * voorzieningen op via window.claude.use('db' | 'user' | 'downloads' | 'assets' | 'sample').
 * Dit bestand levert precies die voorzieningen, maar dan op eigen hosting:
 *   db        → Supabase-tabel "docs" (live bijgewerkt via Supabase Realtime)
 *   user      → Supabase-inlog + tabel "profiles" (rol beheerder / chauffeur / wacht)
 *   assets    → Supabase Storage, bak "fotos" (afgeschermd; geserveerd via de service worker)
 *   downloads → gewone browserdownload
 *   sample    → Edge Function "claude" (Claude API, sleutel staat op de server)
 * Daarnaast: inlogscherm, wachtscherm voor nieuwe accounts, gebruikersbeheer en back-up.
 */
(function () {
  'use strict';
  const CFG = window.HAVAS_CONFIG || {};
  const SUPA_URL = String(CFG.supabaseUrl || '').replace(/\/+$/, '');
  const SUPA_KEY = CFG.supabaseAnonKey || '';
  const SUPA_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

  let sb = null, session = null, profiel = null;
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const fout = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ───────────── schermen (inloggen / wachten) ───────────── */
  const css = `
  #hv-gate{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;
    background:var(--bg,#f4f1ea);font-family:var(--f-body,'IBM Plex Sans',system-ui,sans-serif);color:var(--ink,#1d1d1b)}
  #hv-gate .kaart{width:100%;max-width:380px;background:var(--surface,#fff);border:1px solid var(--line,#ddd);border-radius:12px;padding:24px}
  #hv-gate h1{font-family:var(--f-display,'Barlow Condensed',sans-serif);font-size:28px;margin:0 0 4px;letter-spacing:.02em}
  #hv-gate p{margin:0 0 16px;color:var(--muted,#666);font-size:14px;line-height:1.45}
  #hv-gate label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}
  #hv-gate input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:10px 12px;border:1px solid var(--line,#ccc);border-radius:8px;background:var(--surface,#fff);color:inherit}
  #hv-gate button{font:inherit;font-weight:600;border-radius:8px;padding:10px 14px;cursor:pointer;border:1px solid var(--line,#ccc);background:transparent;color:inherit}
  #hv-gate button.prim{width:100%;margin-top:16px;background:var(--accent,#1f5c3f);border-color:var(--accent,#1f5c3f);color:#fff}
  #hv-gate .link{border:0;padding:6px 0;background:none;color:var(--accent,#1f5c3f);font-weight:500;text-decoration:underline}
  #hv-gate .msg{min-height:20px;font-size:13px;margin-top:10px}
  #hv-gate .msg.bad{color:var(--bad,#b3261e)} #hv-gate .msg.ok{color:var(--ok,#1f7a3f)}
  #hv-gate .rij{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:8px}
  .hv-dlg{max-width:760px;width:calc(100% - 32px);border:1px solid var(--line,#ddd);border-radius:12px;padding:0;background:var(--surface,#fff);color:var(--ink,#1d1d1b)}
  .hv-dlg::backdrop{background:rgba(0,0,0,.4)}
  .hv-dlg .kop{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line,#ddd)}
  .hv-dlg .kop h2{margin:0;font-family:var(--f-display,'Barlow Condensed',sans-serif);font-size:22px}
  .hv-dlg .body{padding:14px 18px;max-height:70vh;overflow:auto}
  .hv-dlg table{width:100%;border-collapse:collapse;font-size:14px}
  .hv-dlg th,.hv-dlg td{text-align:left;padding:6px 6px;border-bottom:1px solid var(--line,#eee);vertical-align:middle}
  .hv-dlg select{font:inherit;padding:4px 6px}
  .hv-dlg h3{font-size:15px;margin:18px 0 6px}
  .hv-dlg .acties{display:flex;gap:8px;flex-wrap:wrap}
  .hv-dlg .wacht{background:#fff4d6}
  @media (max-width:560px){.hv-dlg td.mail,.hv-dlg th.mail{display:none}}`;
  function stijl() { if (document.getElementById('hv-css')) return; const s = document.createElement('style'); s.id = 'hv-css'; s.textContent = css; document.head.appendChild(s); }

  function gate(html) {
    stijl();
    let g = document.getElementById('hv-gate');
    if (!g) { g = document.createElement('div'); g.id = 'hv-gate'; document.body.appendChild(g); }
    g.innerHTML = `<div class="kaart">${html}</div>`;
    return g;
  }
  const gateWeg = () => { const g = document.getElementById('hv-gate'); if (g) g.remove(); };

  function inlogScherm() {
    return new Promise((resolve) => {
      let modus = 'in'; // in | nieuw | vergeten
      let bewaard = '';
      const teken = (melding, soort) => {
        const oud = document.getElementById('hv-mail'); if (oud && oud.value) bewaard = oud.value;
        const g = gate(`
          <h1>Havas Houttransport</h1>
          <p>${modus === 'in' ? 'Log in met je e-mailadres en wachtwoord.' : modus === 'nieuw' ? 'Maak een account aan. Een beheerder keurt het daarna goed.' : 'Vul je e-mailadres in. Je krijgt een link om een nieuw wachtwoord in te stellen.'}</p>
          <form id="hv-f" novalidate>
            ${modus === 'nieuw' ? '<label for="hv-naam">Je naam</label><input id="hv-naam" autocomplete="name" required>' : ''}
            <label for="hv-mail">E-mailadres</label><input id="hv-mail" type="email" autocomplete="email" inputmode="email" required>
            ${modus !== 'vergeten' ? `<label for="hv-pw">Wachtwoord</label><input id="hv-pw" type="password" autocomplete="${modus === 'nieuw' ? 'new-password' : 'current-password'}" minlength="8" required>` : ''}
            <button class="prim" type="submit">${modus === 'in' ? 'Inloggen' : modus === 'nieuw' ? 'Account aanmaken' : 'Link versturen'}</button>
            <div class="msg ${soort || ''}" role="status">${esc(melding || '')}</div>
          </form>
          <div class="rij">
            ${modus !== 'in' ? '<button class="link" data-m="in">Terug naar inloggen</button>' : '<button class="link" data-m="nieuw">Nieuw account</button><button class="link" data-m="vergeten">Wachtwoord vergeten?</button>'}
          </div>`);
        if (bewaard) g.querySelector('#hv-mail').value = bewaard;
        g.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { modus = b.dataset.m; teken(); }));
        const f = g.querySelector('#hv-f');
        g.querySelector(modus === 'nieuw' ? '#hv-naam' : bewaard && modus === 'in' ? '#hv-pw' : '#hv-mail').focus();
        f.onsubmit = async (e) => {
          e.preventDefault();
          const mail = g.querySelector('#hv-mail').value.trim();
          const pw = g.querySelector('#hv-pw') && g.querySelector('#hv-pw').value;
          const knop = f.querySelector('button[type=submit]');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return teken('Vul een geldig e-mailadres in.', 'bad');
          knop.disabled = true;
          try {
            if (modus === 'in') {
              const { data, error } = await sb.auth.signInWithPassword({ email: mail, password: pw });
              if (error) throw error;
              resolve(data.session);
            } else if (modus === 'nieuw') {
              const naam = g.querySelector('#hv-naam').value.trim();
              if (!naam) { knop.disabled = false; return teken('Vul je naam in.', 'bad'); }
              if (!pw || pw.length < 8) { knop.disabled = false; return teken('Kies een wachtwoord van minstens 8 tekens.', 'bad'); }
              const { data, error } = await sb.auth.signUp({ email: mail, password: pw, options: { data: { naam }, emailRedirectTo: location.href.split('#')[0] } });
              if (error) throw error;
              if (data.session) return resolve(data.session);
              modus = 'in'; teken('Account aangemaakt. Bevestig je e-mailadres via de link in je mail en log daarna in.', 'ok');
            } else {
              const { error } = await sb.auth.resetPasswordForEmail(mail, { redirectTo: location.href.split('#')[0] });
              if (error) throw error;
              modus = 'in'; teken('Als dit adres bekend is, staat er nu een mail met een link in je inbox.', 'ok');
            }
          } catch (err) {
            const m = String((err && err.message) || '');
            teken(/invalid login/i.test(m) ? 'E-mailadres of wachtwoord klopt niet.' : /not confirmed/i.test(m) ? 'Bevestig eerst je e-mailadres via de link in je mail.' : /already registered/i.test(m) ? 'Dit e-mailadres heeft al een account. Log in.' : 'Dat lukte niet: ' + m, 'bad');
          }
        };
      };
      teken();
    });
  }

  function nieuwWachtwoordScherm() {
    return new Promise((resolve) => {
      const g = gate(`<h1>Nieuw wachtwoord</h1><p>Kies een nieuw wachtwoord van minstens 8 tekens.</p>
        <form id="hv-f"><label for="hv-pw">Nieuw wachtwoord</label><input id="hv-pw" type="password" autocomplete="new-password" minlength="8" required>
        <button class="prim" type="submit">Opslaan</button><div class="msg" role="status"></div></form>`);
      g.querySelector('#hv-f').onsubmit = async (e) => {
        e.preventDefault();
        const pw = g.querySelector('#hv-pw').value; const msg = g.querySelector('.msg');
        if (pw.length < 8) { msg.className = 'msg bad'; msg.textContent = 'Minstens 8 tekens.'; return; }
        const { error } = await sb.auth.updateUser({ password: pw });
        if (error) { msg.className = 'msg bad'; msg.textContent = error.message; return; }
        resolve();
      };
    });
  }

  async function laadProfiel() {
    const { data, error } = await sb.from('profiles').select('id,naam,email,rol').eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    return data;
  }

  function wachtScherm() {
    return new Promise((resolve) => {
      const g = gate(`<h1>Bijna klaar</h1>
        <p>Je account (<b>${esc(session.user.email)}</b>) is aangemaakt, maar moet nog worden goedgekeurd door een beheerder van Havas. Daarna kun je direct verder.</p>
        <button class="prim" id="hv-opnieuw">Opnieuw controleren</button>
        <div class="msg" role="status"></div>
        <div class="rij"><button class="link" id="hv-uit">Uitloggen</button></div>`);
      const check = async () => {
        try { profiel = await laadProfiel(); } catch { profiel = null; }
        if (profiel && profiel.rol !== 'wacht') { clearInterval(t); resolve(); return true; }
        return false;
      };
      const t = setInterval(check, 20000);
      g.querySelector('#hv-opnieuw').onclick = async () => { if (!(await check())) { const m = g.querySelector('.msg'); m.className = 'msg'; m.textContent = 'Nog niet goedgekeurd. Vraag een beheerder om je toegang te geven.'; } };
      g.querySelector('#hv-uit').onclick = uitloggen;
    });
  }

  async function uitloggen() {
    try { await sb.auth.signOut(); } catch {}
    try { navigator.serviceWorker && navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage({ type: 'auth', token: null }); } catch {}
    location.reload();
  }

  /* ───────────── service worker (app op telefoon + foto's) ───────────── */
  function authVoorSw() { return { type: 'auth', token: session && session.access_token, base: SUPA_URL, anon: SUPA_KEY }; }
  async function startSw() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'need-auth' && e.ports && e.ports[0]) e.ports[0].postMessage(authVoorSw());
    });
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await Promise.race([new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })), new Promise((r) => setTimeout(r, 3000))]);
      }
      const sw = navigator.serviceWorker.controller || reg.active;
      if (sw) sw.postMessage(authVoorSw());
    } catch (e) { console.warn('Service worker niet gestart', e); }
  }
  function swToken() { try { const c = navigator.serviceWorker && navigator.serviceWorker.controller; if (c) c.postMessage(authVoorSw()); } catch {} }

  /* ───────────── db ───────────── */
  const parentOf = (p) => p.split('/').slice(0, -1).join('/');
  const subs = new Set();
  const dbFout = (e) => {
    const c = e && e.code;
    if (c === '42501' || c === 'PGRST301' || c === 'P0002' || /row-level security/i.test(e && e.message)) return fout('invalid_argument', 'Geen rechten of document bestaat niet');
    if (c === 'PGRST116') return fout('not_found', 'Niet gevonden');
    return fout('unavailable', (e && e.message) || 'Geen verbinding', { oorzaak: e });
  };
  async function haalCol(col) {
    const uit = [];
    for (let van = 0; ; van += 1000) {
      const { data, error } = await sb.from('docs').select('path,data').eq('parent', col).order('path').range(van, van + 999);
      if (error) throw dbFout(error);
      uit.push(...data);
      if (data.length < 1000) break;
    }
    return uit;
  }
  async function haalDoc(path) {
    const { data, error } = await sb.from('docs').select('data').eq('path', path).maybeSingle();
    if (error) throw dbFout(error);
    return data ? data.data : null;
  }
  const colSnap = (rows) => ({ docs: rows.map((r) => ({ id: r.path.split('/').pop(), exists: true, data: () => clone(r.data) })), metadata: { fromCache: false } });
  const docSnap = (d) => ({ exists: d != null, data: () => clone(d) });
  function ververs(sub, direct) {
    clearTimeout(sub.t);
    sub.t = setTimeout(async () => {
      if (!subs.has(sub)) return;
      try {
        if (sub.col != null) { const rows = await haalCol(sub.col); if (subs.has(sub)) sub.cb(colSnap(rows)); }
        else { const d = await haalDoc(sub.doc); if (subs.has(sub)) sub.cb(docSnap(d)); }
      } catch (e) { if (sub.err) try { sub.err(e); } catch {} }
    }, direct ? 0 : 120);
  }
  function geraakt(path) {
    if (!path) return;
    const ouder = parentOf(path);
    for (const s of subs) if ((s.col != null && s.col === ouder) || (s.doc != null && s.doc === path)) ververs(s);
  }
  let kanaal = null, eersteKeer = true;
  function startLive() {
    kanaal = sb.channel('havas-docs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, (p) => geraakt((p.new && p.new.path) || (p.old && p.old.path)))
      .subscribe((st) => {
        if (st === 'SUBSCRIBED') { if (!eersteKeer) subs.forEach((s) => ververs(s)); eersteKeer = false; }
      });
    // na slaapstand of verloren verbinding alles opnieuw ophalen
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') subs.forEach((s) => ververs(s)); });
    window.addEventListener('online', () => subs.forEach((s) => ververs(s)));
  }
  const DB = {
    collection(col) {
      return {
        onSnapshot(cb, err) { const s = { col, cb, err }; subs.add(s); ververs(s, true); return () => subs.delete(s); },
        async get() { return colSnap(await haalCol(col)); },
      };
    },
    doc(path) {
      return {
        onSnapshot(cb, err) { const s = { doc: path, cb, err }; subs.add(s); ververs(s, true); return () => subs.delete(s); },
        async get() { return docSnap(await haalDoc(path)); },
        async set(data) {
          const { error } = await sb.from('docs').upsert({ path, data: clone(data) ?? {} });
          if (error) throw dbFout(error);
          geraakt(path);
        },
        async update(partial) {
          const { error } = await sb.rpc('doc_merge', { p: path, partial: clone(partial) ?? {} });
          if (error) throw dbFout(error);
          geraakt(path);
        },
        async delete() {
          const { error } = await sb.from('docs').delete().eq('path', path);
          if (error) throw dbFout(error);
          geraakt(path);
        },
      };
    },
  };

  /* ───────────── user ───────────── */
  const USER = {
    async id() { return session.user.id; },
    async canEdit() { return !!profiel && profiel.rol === 'beheerder'; },
    async me() { return { id: session.user.id, name: (profiel && profiel.naam) || session.user.email }; },
    async profiles(ids) {
      const uit = {};
      if (!ids || !ids.length) return uit;
      const { data } = await sb.from('profiles').select('id,naam,email').in('id', ids);
      (data || []).forEach((p) => (uit[p.id] = { name: p.naam || p.email }));
      return uit;
    },
  };

  /* ───────────── downloads ───────────── */
  const DOWNLOADS = {
    async save({ filename, data, mimeType }) {
      const type = mimeType || (/\.xlsx$/i.test(filename) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : /\.csv$/i.test(filename) ? 'text/csv;charset=utf-8' : /\.json$/i.test(filename) ? 'application/json' : 'application/octet-stream');
      const blob = data instanceof Blob ? data : new Blob([data], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: 'saved', filename };
    },
  };

  /* ───────────── assets (foto's) ───────────── */
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'application/pdf': 'pdf' };
  const ASSETS = {
    async upload(blob, opts) {
      const type = (opts && opts.type) || blob.type || 'image/jpeg';
      const id = `${session.user.id}/${crypto.randomUUID().replace(/-/g, '')}.${EXT[type] || 'bin'}`;
      const { error } = await sb.storage.from('fotos').upload(id, blob, { contentType: type, upsert: false });
      if (error) throw fout(/exceed|size/i.test(error.message) ? 'too_large' : 'unavailable', error.message);
      return { id, url: '_blob/' + id };
    },
    async delete(id) { const { error } = await sb.storage.from('fotos').remove([id]); if (error) throw fout('unavailable', error.message); },
  };

  /* ───────────── sample (Claude) ───────────── */
  const IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const MAX_IMG = 20;
  async function naarBase64(blob) {
    // Claude verkleint zelf tot ±1568 px; groter sturen heeft geen zin en maakt het verzoek zwaar.
    let b = blob;
    if (!IMG_TYPES.includes(b.type) || b.size > 3.5e6) b = await herschaal(b, 2400);
    else {
      try { const bm = await createImageBitmap(b); const groot = Math.max(bm.width, bm.height) > 2400; bm.close && bm.close(); if (groot) b = await herschaal(b, 2400); } catch {}
    }
    const buf = new Uint8Array(await b.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { media_type: b.type, data: btoa(s) };
  }
  async function herschaal(blob, max) {
    let bm; try { bm = await createImageBitmap(blob); } catch { throw fout('image_rejected', 'Foto kon niet worden gelezen'); }
    const f = Math.min(1, max / Math.max(bm.width, bm.height));
    const c = document.createElement('canvas'); c.width = Math.round(bm.width * f); c.height = Math.round(bm.height * f);
    c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height); bm.close && bm.close();
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  }
  function leesJson(text) {
    const t = String(text || '').trim();
    try { return JSON.parse(t); } catch {}
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (m) { try { return JSON.parse(m[1]); } catch {} }
    const a = t.search(/[[{]/), z = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a >= 0 && z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch {} }
    throw fout('invalid_json', 'Geen geldige JSON', { text });
  }
  async function vraagClaude(input, opts, alsJson) {
    opts = opts || {};
    const messages = typeof input === 'string' ? [{ role: 'user', content: input }]
      : Array.isArray(input) ? input.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? m.text ?? '') })) : [];
    if (!messages.length) throw fout('invalid_request', 'Lege vraag');
    let imgs = opts.images ? (opts.images instanceof Blob ? [opts.images] : Array.from(opts.images)) : [];
    if (imgs.length > MAX_IMG) throw fout('invalid_request', `Maximaal ${MAX_IMG} foto's`);
    let text = '', truncated = false;
    try {
      const images = [];
      for (const b of imgs) images.push(await naarBase64(b));
      if (opts.signal && opts.signal.aborted) throw fout('cancelled', 'Geannuleerd');
      const { data: s } = await sb.auth.getSession();
      const r = await fetch(`${SUPA_URL}/functions/v1/claude`, {
        method: 'POST', signal: opts.signal,
        headers: { Authorization: 'Bearer ' + (s.session ? s.session.access_token : SUPA_KEY), apikey: SUPA_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, images, tier: opts.modelTier || 'default', json: !!alsJson }),
      });
      if (!r.ok) {
        let j = {}; try { j = await r.json(); } catch {}
        throw fout(j.code || (r.status === 429 ? 'rate_limited' : 'unavailable'), j.message || 'Claude niet bereikbaar (' + r.status + ')');
      }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let rest = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += dec.decode(value, { stream: true });
        let i;
        while ((i = rest.indexOf('\n')) >= 0) {
          const regel = rest.slice(0, i).trim(); rest = rest.slice(i + 1);
          if (!regel.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(regel.slice(5)); } catch { continue; }
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
            text += ev.delta.text;
            if (opts.onText) try { opts.onText({ text, delta: ev.delta.text }); } catch (e) { console.error(e); }
          } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'max_tokens') truncated = true;
          else if (ev.type === 'error') throw fout(ev.error && /overloaded|rate/i.test(ev.error.type) ? 'rate_limited' : 'unavailable', (ev.error && ev.error.message) || 'Fout', { text });
        }
      }
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.code === 'cancelled')) throw fout('cancelled', 'Geannuleerd', { text });
      if (e && e.code) { e.text = e.text ?? text; throw e; }
      throw fout('unavailable', (e && e.message) || 'Geen verbinding', { text });
    }
    if (alsJson) { if (truncated) throw fout('invalid_json', 'Antwoord afgekapt', { text }); return leesJson(text); }
    return { text, truncated, modelTierApplied: opts.modelTier || 'default' };
  }
  const SAMPLE = (input, opts) => vraagClaude(input, opts, false);
  SAMPLE.json = (input, opts) => vraagClaude(input, opts, true);
  SAMPLE.limits = async () => ({ maxInputBytes: 900000, images: { maxCount: MAX_IMG, maxBytes: 15 * 1024 * 1024, mediaTypes: IMG_TYPES.concat(['image/heic']) }, tools: false });

  /* ───────────── gebruikersbeheer & back-up (alleen beheerders) ───────────── */
  async function gebruikersDialoog() {
    stijl();
    let d = document.getElementById('hv-users');
    if (!d) {
      d = document.createElement('dialog'); d.id = 'hv-users'; d.className = 'hv-dlg';
      d.innerHTML = `<div class="kop"><h2>Gebruikers &amp; back-up</h2><button class="btn small" data-x aria-label="Sluiten">✕</button></div>
        <div class="body">
          <p class="lead" style="margin-top:0">Nieuwe accounts staan op <b>wacht</b> tot je ze een rol geeft. <b>Chauffeur</b>: alleen eigen uren, declaraties en maandfoto’s, planning inzien. <b>Beheerder</b>: alles.</p>
          <div id="hv-ulijst">Laden…</div>
          <h3>Back-up</h3>
          <p style="margin:0 0 8px;font-size:14px">Elke nacht wordt automatisch een back-up gemaakt en gemaild naar het adres onder Beheer → Back-up. Je kunt hier ook zelf een back-up maken of terugzetten.</p>
          <div class="acties">
            <button class="btn small" id="hv-bk-nu">Nu back-up maken</button>
            <button class="btn small" id="hv-bk-dl">Back-up downloaden</button>
            <label class="btn small filebtn">Back-up terugzetten…<input type="file" id="hv-bk-in" accept="application/json,.json" hidden></label>
          </div>
          <div id="hv-bk-msg" role="status" style="margin-top:8px;font-size:14px"></div>
        </div>`;
      document.body.appendChild(d);
      d.querySelector('[data-x]').onclick = () => d.close();
      d.querySelector('#hv-bk-nu').onclick = backupNu;
      d.querySelector('#hv-bk-dl').onclick = backupDownload;
      d.querySelector('#hv-bk-in').onchange = backupTerug;
    }
    d.showModal();
    await gebruikersLijst();
  }
  async function gebruikersLijst() {
    const el = document.getElementById('hv-ulijst');
    const { data, error } = await sb.from('profiles').select('id,naam,email,rol,aangemaakt').order('rol', { ascending: false }).order('naam');
    if (error) { el.textContent = 'Laden mislukt: ' + error.message; return; }
    const volgorde = { wacht: 0, beheerder: 1, chauffeur: 2 };
    data.sort((a, b) => volgorde[a.rol] - volgorde[b.rol] || String(a.naam).localeCompare(String(b.naam)));
    el.innerHTML = `<table><thead><tr><th>Naam</th><th class="mail">E-mail</th><th>Rol</th><th></th></tr></thead><tbody>${data.map((p) => `
      <tr class="${p.rol === 'wacht' ? 'wacht' : ''}"><td>${esc(p.naam)}</td><td class="mail">${esc(p.email)}</td>
      <td><select data-rol="${p.id}" ${p.id === session.user.id ? 'disabled title="Je eigen rol kun je niet wijzigen"' : ''}>
        ${['wacht', 'chauffeur', 'beheerder'].map((r) => `<option value="${r}" ${p.rol === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td>${p.id === session.user.id ? '<span class="chip">jij</span>' : `<button class="btn small" data-weg="${p.id}" title="Account verwijderen uit het dashboard">Verwijderen</button>`}</td></tr>`).join('')}</tbody></table>`;
    el.querySelectorAll('[data-rol]').forEach((s) => (s.onchange = async () => {
      const { error } = await sb.from('profiles').update({ rol: s.value }).eq('id', s.dataset.rol);
      if (error) alertMsg('Wijzigen mislukt: ' + error.message); else gebruikersLijst();
    }));
    el.querySelectorAll('[data-weg]').forEach((b) => (b.onclick = async () => {
      if (b.dataset.zeker !== '1') { b.dataset.zeker = '1'; b.textContent = 'Zeker?'; setTimeout(() => { b.dataset.zeker = ''; b.textContent = 'Verwijderen'; }, 4000); return; }
      const { error } = await sb.from('profiles').delete().eq('id', b.dataset.weg);
      if (error) alertMsg('Verwijderen mislukt: ' + error.message); else gebruikersLijst();
    }));
  }
  const alertMsg = (t) => { const m = document.getElementById('hv-bk-msg'); if (m) m.textContent = t; };
  async function backupNu() {
    alertMsg('Back-up wordt gemaakt…');
    try {
      const { data, error } = await sb.functions.invoke('backup', { body: {} });
      if (error) throw error;
      alertMsg('Klaar: ' + (data && data.status));
    } catch (e) { alertMsg('Mislukt: ' + ((e && e.message) || e)); }
  }
  async function alleDocs() {
    const uit = [];
    for (let van = 0; ; van += 1000) {
      const { data, error } = await sb.from('docs').select('path,data,gewijzigd').order('path').range(van, van + 999);
      if (error) throw error;
      uit.push(...data); if (data.length < 1000) break;
    }
    return uit;
  }
  async function backupDownload() {
    alertMsg('Ophalen…');
    try {
      const docs = await alleDocs();
      const nu = new Date();
      await DOWNLOADS.save({ filename: `havas-backup-${nu.toISOString().slice(0, 10)}.json`, data: JSON.stringify({ gemaakt: nu.toISOString(), versie: 1, docs }, null, 1) });
      alertMsg(`${docs.length} documenten gedownload.`);
    } catch (e) { alertMsg('Mislukt: ' + ((e && e.message) || e)); }
  }
  async function backupTerug(e) {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    let docs;
    try {
      const j = JSON.parse(await f.text());
      docs = Array.isArray(j) ? j : j.docs;
      if (!Array.isArray(docs)) throw new Error('geen lijst "docs"');
      docs = docs.filter((x) => x && typeof x.path === 'string' && /^[^/]+(\/[^/]+)*$/.test(x.path)).map((x) => ({ path: x.path, data: x.data ?? {} }));
    } catch (err) { alertMsg('Dit is geen geldige back-up: ' + err.message); return; }
    if (!confirm(`${docs.length} documenten terugzetten? Bestaande documenten met hetzelfde pad worden overschreven; andere blijven staan.`)) return;
    try {
      for (let i = 0; i < docs.length; i += 300) {
        const { error } = await sb.from('docs').upsert(docs.slice(i, i + 300));
        if (error) throw error;
        alertMsg(`Terugzetten… ${Math.min(i + 300, docs.length)} / ${docs.length}`);
      }
      alertMsg(`${docs.length} documenten teruggezet. De pagina wordt opnieuw geladen.`);
      setTimeout(() => location.reload(), 1500);
    } catch (err) { alertMsg('Terugzetten mislukt: ' + err.message); }
  }

  function knoppenInKop() {
    const stam = document.getElementById('btn-stam');
    const ouder = stam ? stam.parentNode : document.querySelector('header .wrap');
    if (!ouder || document.getElementById('hv-uit')) return;
    if (profiel.rol === 'beheerder') {
      const u = document.createElement('button'); u.className = 'btn small'; u.id = 'hv-gebr'; u.textContent = 'Gebruikers';
      u.onclick = gebruikersDialoog; ouder.appendChild(u);
      wachtTeller(u);
    }
    const b = document.createElement('button'); b.className = 'btn small'; b.id = 'hv-uit'; b.textContent = 'Uitloggen';
    b.title = 'Ingelogd als ' + session.user.email; b.onclick = uitloggen; ouder.appendChild(b);
  }
  async function wachtTeller(knop) {
    const tel = async () => {
      const { count } = await sb.from('profiles').select('id', { count: 'exact', head: true }).eq('rol', 'wacht');
      knop.textContent = count ? `Gebruikers (${count} nieuw)` : 'Gebruikers';
      knop.classList.toggle('primary', !!count);
    };
    tel(); setInterval(tel, 60000);
  }

  /* ───────────── opstarten ───────────── */
  const klaar = (async () => {
    if (!SUPA_URL || !SUPA_KEY || /JOUW-/.test(SUPA_URL + SUPA_KEY)) {
      await new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r) : r()));
      gate('<h1>Nog niet ingesteld</h1><p>Vul in <code>config.js</code> de Supabase-URL en de publieke (anon) sleutel in. Zie README.md.</p>');
      return new Promise(() => {});
    }
    const mod = await import(SUPA_JS);
    sb = mod.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    window.__havasSupabase = sb;
    let herstel = /type=recovery/.test(location.hash);
    sb.auth.onAuthStateChange((ev, s) => {
      if (ev === 'PASSWORD_RECOVERY') herstel = true;
      if (s) { session = s; swToken(); }
      if (ev === 'SIGNED_OUT') location.reload();
    });
    await new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r) : r()));
    ({ data: { session } } = await sb.auth.getSession());
    if (!session) session = await inlogScherm();
    if (herstel) { await nieuwWachtwoordScherm(); history.replaceState(null, '', location.pathname + location.search); }
    try { profiel = await laadProfiel(); } catch (e) { gate(`<h1>Geen verbinding</h1><p>${esc(e.message)}</p><button class="prim" onclick="location.reload()">Opnieuw</button>`); return new Promise(() => {}); }
    if (!profiel) { gate('<h1>Account niet gevonden</h1><p>Je account heeft geen profiel. Vraag een beheerder om hulp.</p><div class="rij"><button class="link" id="hv-uit2">Uitloggen</button></div>'); document.getElementById('hv-uit2').onclick = uitloggen; return new Promise(() => {}); }
    if (profiel.rol === 'wacht') await wachtScherm();
    gateWeg();
    await startSw();
    startLive();
    knoppenInKop();
    return true;
  })();

  window.claude = {
    async use(naam) {
      await klaar;
      switch (naam) {
        case 'db': return DB;
        case 'user': return USER;
        case 'downloads': return DOWNLOADS;
        case 'assets': return ASSETS;
        case 'sample': return SAMPLE;
        default: throw fout('unavailable', 'Onbekende voorziening: ' + naam);
      }
    },
  };
})();
