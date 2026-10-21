/* Havas planningsmotor — rekent een weekplanning door voor (veel) vrachten.
   Uitgangspunten (instelbaar via regels):
   - Een vracht = één wagenlading. Laden kan alleen met een kraanwagen erbij; die laadt eerst de trailer(s), dan zichzelf.
   - Kraanwagens en trailers rijden als koppel (team). Een kraanwagen neemt zelf ook een vracht mee.
   - Trailers lossen zelf. Lossen gebeurt per wagen, tegelijk.
   - Rijtijd per dienst, dienstduur, rust, openingstijden per plaats, maximum lossen/laden per plaats per dag,
     afspraken "wagen X staat van … tot … in plaats Y", vaste dag of vaste wagen per vracht.
   De motor probeert veel varianten (gerandomiseerd gretig) en houdt de beste: meeste vrachten, dan minste lege km. */
(function (root) {
  'use strict';
  const DAG = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
  const nrm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  function tijd(s) { // 'di 04:00' of {dag,tijd} -> uren vanaf ma 00:00
    if (s == null) return null; if (typeof s === 'number') return s;
    const m = String(s).trim().toLowerCase().match(/^(ma|di|wo|do|vr|za|zo)\w*\s+(\d{1,2})[:.](\d{2})$/);
    if (!m) return null; return DAG.indexOf(m[1]) * 24 + Number(m[2]) + Number(m[3]) / 60;
  }
  const uurVan = s => { const m = String(s || '').match(/^(\d{1,2})[:.](\d{2})$/); return m ? Number(m[1]) + Number(m[2]) / 60 : null; };
  function fmt(x) { const d = Math.floor(x / 24); let r = x - d * 24; let h = Math.floor(r + 1e-9); let m = Math.round((r - h) * 60); if (m === 60) { h++; m = 0; } return `${DAG[d] || 'd' + d} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }

  function maakRNG(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  function maakPlanner(inp) {
    const R0 = inp.regels || {};
    const R = {
      startT: tijd(R0.start) ?? 5, startPlaats: R0.startPlaats || 'Uddel',
      eindT: tijd(R0.eind) ?? (4 * 24 + 15.5), eindPlaats: R0.eindPlaats || R0.startPlaats || 'Uddel',
      snel: Number(R0.snelheid) || 70, laadU: R0.laadUur ?? 1, losU: R0.losUur ?? 1,
      maxRij: Number(R0.maxRijtijd) || 9, maxDienst: Number(R0.maxDienst) || 13, minRust: Number(R0.minRust) || 11,
      vroegste: uurVan(R0.vroegsteStart) ?? 4, wegfactor: Number(R0.wegfactor) || 1.3,
      kraanVerplicht: R0.kraanVerplicht !== false,
      std: { van: uurVan((R0.standaardVenster || {}).van) ?? 6, tot: uurVan((R0.standaardVenster || {}).tot) ?? 18 },
      maxVallen: R0.maxLatenVallen ?? null,
      leegVermijden: (R0.leegVermijden || []).map(nrm),
    };
    const vensters = {}; (R0.vensters || []).forEach(v => { const k = nrm(v.plaats); const s = v.soort || 'beide';
      const w = { van: uurVan(v.van) ?? R.std.van, tot: uurVan(v.tot) ?? R.std.tot };
      if (s === 'laden' || s === 'beide') vensters[k + '|laden'] = w; if (s === 'lossen' || s === 'beide') vensters[k + '|lossen'] = w; });
    const caps = {}; (R0.maxPerDag || []).forEach(c => { caps[nrm(c.plaats) + '|' + (c.soort || 'lossen')] = Number(c.aantal); });
    const plaatsInfo = inp.plaatsen || {};
    const coord = naam => { const p = plaatsInfo[nrm(naam)] || plaatsInfo[naam]; return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null; };
    const kmCache = new Map();
    function km(a, b) {
      if (nrm(a) === nrm(b)) return 0; const key = nrm(a) < nrm(b) ? nrm(a) + '|' + nrm(b) : nrm(b) + '|' + nrm(a);
      if (kmCache.has(key)) return kmCache.get(key);
      const vast = (inp.kmVast || {})[key]; let d;
      if (vast != null) d = vast; else {
        const p = coord(a), q = coord(b); if (!p || !q) { d = NaN; } else {
          const r = Math.PI / 180, dl = (q.lat - p.lat) * r, dn = (q.lon - p.lon) * r;
          const h = Math.sin(dl / 2) ** 2 + Math.cos(p.lat * r) * Math.cos(q.lat * r) * Math.sin(dn / 2) ** 2;
          d = Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * R.wegfactor); } }
      kmCache.set(key, d); return d;
    }
    const venster = (plaats, soort) => vensters[nrm(plaats) + '|' + soort] || R.std;
    function openOp(plaats, soort, t) { // eerstvolgend moment >= t dat de plaats open is
      const w = venster(plaats, soort); let d = Math.floor(t / 24), h = t - d * 24;
      if (h < w.van) return d * 24 + w.van; if (h >= w.tot) return (d + 1) * 24 + w.van; return t; }
    const sluitOp = (plaats, soort, t) => { const w = venster(plaats, soort); return Math.floor(t / 24) * 24 + w.tot; };

    // ---- wagens en koppels
    const wagens = inp.wagens.map(w => ({ id: w.id, kenteken: w.kenteken, kraan: w.kraan === true }));
    const afspraken = (R0.wagenAfspraken || []).map(a => ({ wagen: (wagens.find(w => nrm(w.kenteken) === nrm(a.kenteken)) || {}).id, kenteken: a.kenteken, plaats: a.plaats, van: tijd(a.van), tot: tijd(a.tot) }))
      .filter(a => a.wagen && a.van != null && a.tot != null && a.tot > a.van);
    let teamsBasis;
    if (!R.kraanVerplicht) teamsBasis = wagens.map(w => [w]);
    else {
      const kr = wagens.filter(w => w.kraan), tr = wagens.filter(w => !w.kraan);
      teamsBasis = kr.map(k => [k]);
      if (inp.koppels) { // vaste koppels opgegeven: [[kraanId, trailerId, ...], ...]
        teamsBasis = inp.koppels.map(ids => ids.map(id => wagens.find(w => w.id === id)).filter(Boolean)).filter(t => t.some(w => w.kraan));
      } else tr.forEach((t, i) => { if (teamsBasis.length) teamsBasis[i % teamsBasis.length].push(t); });
    }
    const zonderTeam = wagens.filter(w => !teamsBasis.some(t => t.includes(w)));

    // ---- vrachten
    const vrachten = inp.vrachten.map(v => ({ id: v.id, ref: v.ref || v.id, van: v.van, naar: v.naar, aantal: Math.max(0, Math.round(Number(v.aantal) || 0)),
      dag: v.dag ? DAG.indexOf(v.dag) : -1, wagen: v.wagen || '' }));
    const onbekend = [...new Set(vrachten.flatMap(v => [v.van, v.naar]).concat([R.startPlaats, R.eindPlaats], afspraken.map(a => a.plaats)).filter(p => !coord(p) && !Object.keys(inp.kmVast || {}).some(k => k.includes(nrm(p)))))];
    if (onbekend.length) return { fout: 'plaatsen', onbekend, stap(){ return 0; }, resultaat(){ return { fout: 'plaatsen', onbekend }; } };

    // ---- vooraf: onvermijdelijke tekorten door losmaxima
    const dagen = []; for (let d = Math.floor(R.startT / 24); d <= Math.floor(R.eindT / 24); d++) dagen.push(d);
    const voorcontrole = [];
    Object.entries(caps).forEach(([k, n]) => { const [p, soort] = k.split('|');
      const vraag = vrachten.filter(v => nrm(soort === 'lossen' ? v.naar : v.van) === p).reduce((t, v) => t + v.aantal, 0);
      const naam = (vrachten.find(v => nrm(soort === 'lossen' ? v.naar : v.van) === p) || {})[soort === 'lossen' ? 'naar' : 'van'] || p;
      const max = n * dagen.length; if (vraag > max) voorcontrole.push({ soort: 'capaciteit', plaats: naam, actie: soort, vraag, max, tekort: vraag - max,
        tekst: `${vraag} vrachten ${soort} in ${naam}, maar maximaal ${n} per dag × ${dagen.length} dagen = ${max}: minstens ${vraag - max} passen niet.` }); });
    if (R.kraanVerplicht && !wagens.some(w => w.kraan)) voorcontrole.push({ soort: 'kraan', tekst: 'Er is geen enkele kraanwagen; niets kan worden geladen.' });
    vrachten.forEach(v => { if (v.wagen && !wagens.some(w => w.id === v.wagen)) voorcontrole.push({ soort: 'wagen', tekst: `${v.ref}: de vaste wagen bestaat niet.` }); });

    // ---- één variant doorrekenen
    function variant(rand, ruis) {
      const rest = Object.fromEntries(vrachten.map(v => [v.id, v.aantal]));
      const capTel = {}; const redenen = {}; const ritten = []; const reizen = [];
      const teams = teamsBasis.map((leden, i) => ({ i, leden, pos: R.startPlaats, t: R.startT, dStart: R.startT, rij: 0, actief: true, wachtPogingen: 0,
        afspr: afspraken.filter(a => leden.some(w => w.id === a.wagen)).sort((a, b) => a.van - b.van), log: [], leegKm: 0, km: 0 }));
      const noteer = (vid, r) => { (redenen[vid] = redenen[vid] || {})[r] = (redenen[vid][r] || 0) + 1; };

      function sim(team, job) {
        const st = { t: team.t, pos: team.pos, dStart: team.dStart, rij: team.rij, legs: [], leeg: 0, km: 0, rust: 0 };
        const capLokaal = {};
        const rust = () => { let x = st.t + R.minRust; const h = x - Math.floor(x / 24) * 24; if (h < R.vroegste) x = Math.floor(x / 24) * 24 + R.vroegste; st.t = x; st.dStart = x; st.rij = 0; st.rust++; };
        const rij = (naar, geladen) => { const d = km(st.pos, naar); if (!Number.isFinite(d)) return 'afstand onbekend'; const u = d / R.snel; if (u > R.maxRij) return `rit ${st.pos} → ${naar} is langer dan de maximale rijtijd`;
          if (st.rij + u > R.maxRij + 1e-9 || st.t + u - st.dStart > R.maxDienst + 1e-9) rust();
          st.legs.push({ soort: 'rij', van: st.pos, naar, start: st.t, eind: st.t + u, km: d, geladen }); st.t += u; st.rij += u; st.pos = naar; st.km += d; if (!geladen) st.leeg += d; return null; };
        const plek = (soort, dur, n) => { // laden/lossen op st.pos; n = aantal vrachten (voor maximum per dag)
          for (let poging = 0; poging < 4; poging++) {
            let s = openOp(st.pos, soort, st.t);
            if (s + dur > sluitOp(st.pos, soort, s) + 1e-9) { st.t = Math.floor(s / 24) * 24 + 24; continue; }
            if (s + dur - st.dStart > R.maxDienst + 1e-9) { rust(); continue; }
            const ck = nrm(st.pos) + '|' + soort; if (caps[ck] != null) { const d = Math.floor(s / 24), k = ck + '|' + d;
              if ((capTel[k] || 0) + (capLokaal[k] || 0) + n > caps[ck]) { st.t = (d + 1) * 24 + venster(st.pos, soort).van; if (st.t - st.dStart > R.maxDienst) rust(); if (poging === 3) return `${soort} in ${st.pos} vol (max ${caps[ck]} per dag)`; continue; }
              capLokaal[k] = (capLokaal[k] || 0) + n; }
            st.legs.push({ soort, plaats: st.pos, start: s, eind: s + dur, n }); st.t = s + dur; return null; }
          return `${soort} in ${st.pos} past niet binnen de openingstijden`; };
        const aankomst = (vanSt, naar) => { let t = vanSt.t, r = vanSt.rij, ds = vanSt.dStart; const d = km(vanSt.pos, naar); if (!Number.isFinite(d)) return Infinity; const u = d / R.snel;
          if (r + u > R.maxRij + 1e-9 || t + u - ds > R.maxDienst + 1e-9) { t = t + R.minRust; const h = t - Math.floor(t / 24) * 24; if (h < R.vroegste) t = Math.floor(t / 24) * 24 + R.vroegste; }
          return t + u; };
        const start = st.t;
        let f = rij(job.van, false); if (f) return { ok: false, reden: f };
        const laadStart = st.t; const n = job.lading.length;
        f = plek('laden', n * R.laadU, n); if (f) return { ok: false, reden: f };
        const geladenOp = st.legs[st.legs.length - 1].start;
        if (job.dag >= 0 && Math.floor(geladenOp / 24) !== job.dag) return { ok: false, reden: `vaste dag ${DAG[job.dag]} niet haalbaar` };
        const losTijden = {};
        for (const best of job.bestemmingen) { f = rij(best, true); if (f) return { ok: false, reden: f };
          const m = job.lading.filter(x => x.naar === best).length; f = plek('lossen', R.losU, m); if (f) return { ok: false, reden: f }; losTijden[best] = st.t; }
        if (st.t > R.eindT) return { ok: false, reden: 'past niet meer in de week' };
        // afspraken van wagens in dit koppel
        // vaste ritten (vaste wagen + vaste dag) van dit koppel moeten bereikbaar blijven
        for (const v of vrachten) { if (!v.wagen || v.dag < 0 || rest[v.id] <= 0 || !team.leden.some(w => w.id === v.wagen) || job.lading.some(l => l.vracht === v)) continue;
          const deadline = v.dag * 24 + venster(v.van, 'laden').tot - R.laadU; if (start <= deadline && aankomst(st, v.van) > deadline + 1e-9) return { ok: false, reden: `vaste rit ${v.ref} op ${DAG[v.dag]} komt in gevaar` }; }
        for (const a of team.afspr) { if (start >= a.tot) continue;
          if (aankomst(st, a.plaats) > a.van + 1e-9) return { ok: false, reden: `afspraak: ${a.kenteken} moet ${fmt(a.van)} in ${a.plaats} staan` }; }
        // daarna nog op tijd op de eindplaats?
        if (aankomst(st, R.eindPlaats) > R.eindT + 1e-9) return { ok: false, reden: `daarna niet op tijd terug in ${R.eindPlaats}` };
        return { ok: true, st, start, laadStart, geladenOp, losTijden, duur: st.t - start };
      }

      function kandidaten(team) {
        const ids = new Set(team.leden.map(w => w.id)); const perHerkomst = {};
        vrachten.forEach(v => { if (rest[v.id] <= 0) return; if (v.wagen && !ids.has(v.wagen)) return; (perHerkomst[nrm(v.van)] = perHerkomst[nrm(v.van)] || []).push(v); });
        const out = [];
        Object.values(perHerkomst).forEach(lijst => {
          lijst.forEach(hoofd => {
            const lading = []; const r = Object.assign({}, rest); const leden = [...team.leden].sort((a, b) => b.kraan - a.kraan);
            // vaste wagen eerst
            const vast = lijst.filter(v => v.wagen); for (const v of vast) { const w = leden.find(x => x.id === v.wagen && !lading.some(l => l.wagen === x.id)); if (w && r[v.id] > 0) { lading.push({ wagen: w.id, vracht: v, naar: v.naar }); r[v.id]--; } }
            const vrij = () => leden.filter(w => !lading.some(l => l.wagen === w.id));
            if (!hoofd.wagen) for (const w of vrij()) { if (r[hoofd.id] <= 0) break; lading.push({ wagen: w.id, vracht: hoofd, naar: hoofd.naar }); r[hoofd.id]--; }
            const anderen = lijst.filter(v => v !== hoofd && !v.wagen && r[v.id] > 0).sort((a, b) => km(hoofd.naar, a.naar) - km(hoofd.naar, b.naar));
            for (const v of anderen) { if (km(hoofd.naar, v.naar) > 70) break; for (const w of vrij()) { if (r[v.id] <= 0) break; lading.push({ wagen: w.id, vracht: v, naar: v.naar }); r[v.id]--; } }
            if (!lading.length) return;
            const best = [...new Set(lading.map(l => l.naar))].sort((a, b) => km(hoofd.van, a) - km(hoofd.van, b));
            const dagen_ = [...new Set(lading.map(l => l.vracht.dag).filter(d => d >= 0))];
            out.push({ van: hoofd.van, lading, bestemmingen: best, dag: dagen_.length ? dagen_[0] : -1, sleutel: lading.map(l => l.vracht.id + '>' + l.wagen).sort().join(',') });
          }); });
        const gezien = new Set(); return out.filter(k => !gezien.has(k.sleutel) && gezien.add(k.sleutel));
      }

      function kosten(team, job, r) {
        const n = job.lading.length; let c = r.duur;
        c += (r.st.leeg / R.snel) * 0.6;
        if (R.leegVermijden.length) r.st.legs.forEach(l => { if (l.soort === 'rij' && !l.geladen && R.leegVermijden.includes(nrm(l.naar))) c += (l.km / R.snel) * 0.8; });
        c /= n;
        // schaarse loscapaciteit vandaag benutten
        job.bestemmingen.forEach(b => { const ck = nrm(b) + '|lossen'; if (caps[ck] != null) { const vraag = vrachten.filter(v => nrm(v.naar) === nrm(b)).reduce((t, v) => t + rest[v.id], 0);
          const d = Math.floor(r.losTijden[b] / 24); const over = dagen.filter(x => x >= d).reduce((t, x) => t + Math.max(0, caps[ck] - (capTel[ck + '|' + x] || 0)), 0);
          if (over > 0 && vraag / over > 0.7) c -= 1.2 * job.lading.filter(l => l.naar === b).length / n; } });
        if (job.dag >= 0) c -= 3;
        // vooruitkijken: hoe ver is de volgende ophaalplaats
        let dichtst = Infinity; vrachten.forEach(v => { if (rest[v.id] > 0 && !job.lading.some(l => l.vracht === v && rest[v.id] <= job.lading.filter(x => x.vracht === v).length)) dichtst = Math.min(dichtst, km(r.st.pos, v.van)); });
        if (Number.isFinite(dichtst)) c += 0.25 * dichtst / R.snel;
        return c * (1 + (rand() - 0.5) * ruis);
      }

      function voerUit(team, job, r) {
        const reis = { team: team.i, leden: team.leden.map(w => w.id), start: r.start, legs: r.st.legs, lading: job.lading.map(l => ({ wagen: l.wagen, vracht: l.vracht.id, naar: l.naar })) };
        reizen.push(reis);
        const kraan = team.leden.find(w => w.kraan);
        job.lading.forEach(l => { rest[l.vracht.id]--; });
        r.st.legs.forEach(l => { if (l.soort !== 'rij' && l.n) { const ck = nrm(l.plaats) + '|' + l.soort; if (caps[ck] != null) { const k = ck + '|' + Math.floor(l.start / 24); capTel[k] = (capTel[k] || 0) + l.n; } } });
        const laadLeg = r.st.legs.find(l => l.soort === 'laden');
        job.lading.forEach((l, i) => { const losLeg = r.st.legs.find(x => x.soort === 'lossen' && x.plaats === l.naar);
          ritten.push({ wagen: l.wagen, vracht: l.vracht.id, ref: l.vracht.ref, van: job.van, naar: l.naar, vertrek: r.start, laadStart: laadLeg.start, losStart: losLeg.start, losEind: losLeg.eind,
            leegKm: r.st.legs.filter(x => x.soort === 'rij' && !x.geladen && x.eind <= laadLeg.start + 1e-9).reduce((t, x) => t + x.km, 0),
            geladenKm: r.st.legs.filter(x => x.soort === 'rij' && x.geladen && x.eind <= losLeg.start + 1e-9).reduce((t, x) => t + x.km, 0),
            kraanWagen: kraan ? kraan.id : l.wagen, reis: reizen.length - 1 }); });
        team.t = r.st.t; team.pos = r.st.pos; team.dStart = r.st.dStart; team.rij = r.st.rij; team.km += r.st.km; team.leegKm += r.st.leeg; team.wachtPogingen = 0;
      }
      function verplaats(team, naar, reden) { // lege rit, bijv. naar afspraak of naar huis
        const d = km(team.pos, naar); if (!d) return; const u = d / R.snel;
        if (team.rij + u > R.maxRij || team.t + u - team.dStart > R.maxDienst) { team.t += R.minRust; team.dStart = team.t; team.rij = 0; }
        reizen.push({ team: team.i, leden: team.leden.map(w => w.id), start: team.t, legs: [{ soort: 'rij', van: team.pos, naar, start: team.t, eind: team.t + u, km: d, geladen: false }], lading: [], reden });
        team.t += u; team.rij += u; team.pos = naar; team.km += d; team.leegKm += d; }

      let veilig = 0;
      while (teams.some(t => t.actief) && veilig++ < 5000) {
        const team = teams.filter(t => t.actief).sort((a, b) => a.t - b.t)[0];
        // lopende afspraak? dan wachten tot het einde
        const nu = team.afspr.find(a => team.t >= a.van - 1e-9 && team.t < a.tot);
        if (nu) { if (nrm(team.pos) !== nrm(nu.plaats)) verplaats(team, nu.plaats, 'afspraak'); team.t = Math.max(team.t, nu.tot); team.dStart = team.t; team.rij = 0; continue; }
        let best = null, bestC = Infinity;
        for (const job of kandidaten(team)) { const r = sim(team, job);
          if (!r.ok) { job.lading.forEach(l => noteer(l.vracht.id, r.reden)); continue; }
          const c = kosten(team, job, r); if (c < bestC) { bestC = c; best = { job, r }; } }
        if (best) { voerUit(team, best.job, best.r); continue; }
        const komend = team.afspr.find(a => a.van > team.t);
        if (komend) { verplaats(team, komend.plaats, 'afspraak'); const rustTot = team.t + R.minRust; team.t = Math.max(team.t, komend.tot, komend.tot - team.t >= 0 ? komend.tot : rustTot); team.dStart = team.t; team.rij = 0; continue; }
        if (team.wachtPogingen < 2 && team.t + R.minRust < R.eindT) { team.wachtPogingen++; team.t = team.t + R.minRust; const h = team.t % 24; if (h < R.vroegste) team.t += R.vroegste - h; team.dStart = team.t; team.rij = 0; continue; }
        if (nrm(team.pos) !== nrm(R.eindPlaats)) verplaats(team, R.eindPlaats, 'naar huis');
        team.actief = false;
      }
      teams.forEach(t => { if (t.actief && nrm(t.pos) !== nrm(R.eindPlaats)) verplaats(t, R.eindPlaats, 'naar huis'); });
      const gepland = vrachten.reduce((s, v) => s + (v.aantal - rest[v.id]), 0);
      const leegKm = teams.reduce((s, t) => s + t.leegKm, 0), kmTot = teams.reduce((s, t) => s + t.km, 0);
      return { gepland, rest, ritten, reizen, redenen, leegKm, kmTot, teams: teams.map(t => ({ leden: t.leden.map(w => w.kenteken), km: t.km, leegKm: t.leegKm, eind: t.t, pos: t.pos })) };
    }

    const rng = maakRNG(inp.seed || 12345);
    let best = null, n = 0, laatsteVerbetering = 0;
    function stap(aantal) { for (let i = 0; i < aantal; i++, n++) { const v = variant(rng, n === 0 ? 0 : 0.35);
        if (!best || v.gepland > best.gepland || (v.gepland === best.gepland && v.leegKm < best.leegKm - 1e-9)) { best = v; laatsteVerbetering = n; } } return n; }
    function resultaat() {
    // controle achteraf (onafhankelijk van de zoekfunctie): rijtijd per dienst, eindplaats, overlap per wagen
    const controle = [];
    { // per koppel alle stappen op tijd volgorde nalopen
      const perTeam = {}; best.reizen.forEach(z => (perTeam[z.team] = perTeam[z.team] || []).push(...z.legs.map(l => Object.assign({}, l))));
      Object.entries(perTeam).forEach(([ti, legs]) => { legs.sort((a, b) => a.start - b.start); const naam = teamsBasis[ti].map(w => w.kenteken).join(' + ');
        let dStart = null, rij = 0, vorigEind = R.startT, pos = R.startPlaats;
        legs.forEach(l => { if (l.start < vorigEind - 1e-6) controle.push(`${naam}: overlap om ${fmt(l.start)}`);
          if (dStart == null || l.start - vorigEind >= R.minRust - 1e-6) { dStart = l.start; rij = 0; }
          if (l.soort === 'rij') { if (nrm(l.van) !== nrm(pos)) controle.push(`${naam}: rijdt vanaf ${l.van} maar stond in ${pos}`); rij += l.eind - l.start; pos = l.naar;
            if (rij > R.maxRij + 1e-6) controle.push(`${naam}: ${rij.toFixed(1)} u rijtijd in dienst vanaf ${fmt(dStart)}`); }
          else { const w = venster(l.plaats, l.soort), h = l.start - Math.floor(l.start / 24) * 24; if (h < w.van - 1e-6 || h + (l.eind - l.start) > w.tot + 1e-6) controle.push(`${naam}: ${l.soort} in ${l.plaats} om ${fmt(l.start)} buiten openingstijd`); }
          if (l.eind - dStart > R.maxDienst + 1e-6) controle.push(`${naam}: dienst vanaf ${fmt(dStart)} duurt ${(l.eind - dStart).toFixed(1)} u`);
          vorigEind = l.eind; });
        teamsBasis[ti].forEach(w => afspraken.filter(a => a.wagen === w.id).forEach(a => {
          const bezig = legs.find(l => l.start < a.tot - 1e-6 && l.eind > a.van + 1e-6); const voor = legs.filter(l => l.eind <= a.van + 1e-6).pop();
          const waar = voor ? (voor.soort === 'rij' ? voor.naar : voor.plaats) : R.startPlaats;
          if (bezig || nrm(waar) !== nrm(a.plaats)) controle.push(`${w.kenteken} staat ${fmt(a.van)}–${fmt(a.tot)} niet in ${a.plaats}${bezig ? ' (onderweg om ' + fmt(bezig.start) + ')' : ' maar in ' + waar}`); })); });
      const tel = {}; best.reizen.forEach(z => z.legs.forEach(l => { if (l.n) { const ck = nrm(l.plaats) + '|' + l.soort; if (caps[ck] != null) { const k = ck + '|' + Math.floor(l.start / 24); tel[k] = (tel[k] || 0) + l.n; if (tel[k] > caps[ck]) controle.push(`${l.soort} in ${l.plaats} op ${DAG[Math.floor(l.start / 24)]}: ${tel[k]} (max ${caps[ck]})`); } } }));
    }
    best.teams.forEach(t => { if (nrm(t.pos) !== nrm(R.eindPlaats)) controle.push(`${t.leden.join(' + ')} eindigt in ${t.pos}`); if (t.eind > R.eindT + 1e-9) controle.push(`${t.leden.join(' + ')} is pas ${fmt(t.eind)} klaar`); });
    const totaal = vrachten.reduce((s, v) => s + v.aantal, 0);
    const niet = vrachten.filter(v => best.rest[v.id] > 0).map(v => { const r = best.redenen[v.id] || {};
      const cap = voorcontrole.find(c => c.soort === 'capaciteit' && nrm(c.plaats) === nrm(c.actie === 'lossen' ? v.naar : v.van));
      let lijst = Object.entries(r).sort((a, b) => b[1] - a[1]).map(x => x[0]); if (lijst.some(x => !x.startsWith('afspraak'))) lijst = lijst.filter(x => !x.startsWith('afspraak'));
      const top = (cap ? [`maximum ${cap.actie} in ${cap.plaats} (${cap.max} per week) is bereikt`] : []).concat(lijst).slice(0, 2);
      return { vracht: v.id, ref: v.ref, aantal: best.rest[v.id], redenen: top.length ? top : ['geen ruimte meer in de week bij de koppels'] }; });
    return { regels: R, teams: teamsBasis.map(t => t.map(w => w.kenteken)), zonderTeam: zonderTeam.map(w => w.kenteken), voorcontrole, iteraties: n, totaal, gepland: best.gepland, niet,
      ritten: best.ritten, reizen: best.reizen, leegKm: best.leegKm, kmTot: best.kmTot, controle, fmt, km };
    }
    return { stap, resultaat, get beste(){ return best ? best.gepland : 0; }, get iteraties(){ return n; }, get sindsVerbetering(){ return n - laatsteVerbetering; }, totaal: vrachten.reduce((s, v) => s + v.aantal, 0), voorcontrole };
  }
  function planWeek(inp) { const p = maakPlanner(inp); if (p.fout) return p; const tot = Date.now() + (inp.tijdslimietMs || 4000); while (p.iteraties < (inp.iteraties || 300) && Date.now() < tot) p.stap(10); return p.resultaat(); }
  root.planWeek = planWeek; root.maakPlanner = maakPlanner; root.planTijd = tijd; root.planFmt = fmt;
})(typeof window !== 'undefined' ? window : globalThis);
