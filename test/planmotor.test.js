// Draai met: node test/planmotor.test.js  (motor is een kopie van de code in web/index.html)
require('./planmotor.js');
const P = {'Uddel':[52.256,5.776],'Bawinkel':[52.600,7.400],'Putten':[52.259,5.607],'Enschede':[52.221,6.894],'Lommel':[51.230,5.313],
 'Barneveld':[52.140,5.585],'Antwerpen':[51.219,4.402],'Genk':[50.965,5.500],'Valkenswaard':[51.351,5.459],'Manhay':[50.293,5.677],
 'Naaldwijk':[51.994,4.209],'Schoningsdorf/Lingen':[52.700,7.060],'Noordwijk':[52.240,4.448],'Hamburg':[53.551,9.993],'Dassendorf':[53.495,10.373],
 'Goldenstedt':[52.788,8.433],'Syke':[52.913,8.826]};
const nrm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
const plaatsen = Object.fromEntries(Object.entries(P).map(([k,[lat,lon]])=>[nrm(k),{naam:k,lat,lon}]));
const wagens = [['w09brd9','09-BRD-9',1],['w09btd7','09-BTD-7',0],['w86bkn8','86-BKN-8',1],['w96bpb8','96-BPB-8',0],['wk1','BD-597-K',1],['wbb332s','BB-332-S',0],['wk2','29-BZN-3',1],['wbb773b','BB-773-B',0]].map(([id,k,kr])=>({id,kenteken:k,kraan:!!kr}));
const V = [[10,'Bawinkel','Uddel'],[1,'Putten','Enschede','wo','wk2'],[20,'Lommel','Uddel'],[5,'Barneveld','Antwerpen'],[5,'Uddel','Genk'],[1,'Uddel','Valkenswaard'],[5,'Manhay','Naaldwijk'],[2,'Schoningsdorf/Lingen','Noordwijk'],[2,'Barneveld','Hamburg'],[2,'Dassendorf','Goldenstedt'],[2,'Syke','Uddel']];
const vrachten = V.map((v,i)=>({id:'v'+(i+1),ref:'v'+(i+1),aantal:v[0],van:v[1],naar:v[2],dag:v[3]||'',wagen:v[4]||''}));
const regels = { start:'ma 05:00', startPlaats:'Uddel', eind:'vr', eindPlaats:'Uddel', snelheid:70, laadUur:1, losUur:1, maxRijtijd:9, maxDienst:13, minRust:11,
  vensters:[{plaats:'Uddel',van:'07:00',tot:'17:00',soort:'beide'}], maxPerDag:[{plaats:'Uddel',soort:'lossen',aantal:6}], maxLatenVallen:6, leegVermijden:['Lommel'],
  wagenAfspraken:[{kenteken:'29-BZN-3',plaats:'Uddel',van:'do 20:00',tot:'vr 04:00'},{kenteken:'09-BRD-9',plaats:'Barneveld',van:'wo 20:00',tot:'do 04:00'}], wegfactor:1.3 };
const koppels = [['w09brd9','w09btd7'],['w86bkn8','w96bpb8'],['wk1','wbb332s'],['wk2','wbb773b']];
function run(vr, wg, kp, label){
  const t0 = Date.now(); const r = planWeek({regels, plaatsen, wagens: wg, vrachten: vr, koppels: kp, iteraties: +(process.env.IT||400), tijdslimietMs: 20000});
  if (r.fout) { console.log('FOUT', r); return; }
  console.log(`== ${label}: ${r.gepland}/${r.totaal} gepland in ${r.iteraties} varianten, ${Date.now()-t0} ms, km ${r.kmTot}, leeg ${r.leegKm}`);
  r.voorcontrole.forEach(v=>console.log('  voorcontrole:', v.tekst)); r.controle.forEach(c=>console.log('  CONTROLE:', c));
  r.niet.forEach(n=>console.log('  niet:', n.ref, n.aantal, n.redenen.join(' | ')));
  return r;
}
const r = run(vrachten, wagens, koppels, 'scenario gebruiker');
// detail per team
const fmt = r.fmt; const per = {};
r.reizen.forEach(z => { (per[z.team] = per[z.team] || []).push(z); });
Object.entries(per).forEach(([t, zs]) => { console.log('-- team', r.teams[t].join(' + '));
  zs.forEach(z => console.log('  ', fmt(z.start), z.legs.map(l => l.soort==='rij' ? `${l.naar}(${l.km}${l.geladen?'':' leeg'})` : `${l.soort}@${fmt(l.start).slice(3)}`).join(' → '), z.reden||'')); });
// 100 vrachten: scenario ×2 (minus vaste), 8 wagens en 16 wagens
const v100 = vrachten.flatMap(v => v.wagen ? [v] : [Object.assign({}, v), Object.assign({}, v, {id: v.id+'b', ref: v.ref+'b'})]).slice(0,100);
console.log('aantal vrachten in test:', v100.reduce((t,v)=>t+v.aantal,0));
run(v100, wagens, koppels, '~109 vrachten, 8 wagens');
const w16 = wagens.concat(wagens.map(w=>Object.assign({}, w, {id: w.id+'x', kenteken: w.kenteken+'X'})));
run(v100, w16, null, '~109 vrachten, 16 wagens');
