// api/_sopralluoghi.js — sopralluoghi dei professionisti (tabella pro_sopralluoghi,
// vedi supabase_sopralluoghi.sql). Le chiamate passano da api/quotes.js
// (?action=sopr-...), così non serve una funzione Vercel in più.
//   GET  ?action=sopr-list            -> elenco (sintesi)
//   GET  ?action=sopr-get&id=...      -> sopralluogo completo
//   POST ?action=sopr-save            -> crea o aggiorna { id, clientName, ... , data }
//   POST ?action=sopr-photo           -> { dataUrl } carica una foto, ritorna { url }
//   POST ?action=sopr-delete          -> { id }
const { supabaseRequest } = require("./_auth-lib");
const { uploadPhoto } = require("./_projects-lib");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function str(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max); }
function num(v, max) {
  let n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(",", "."));
  if (!isFinite(n) || n < 0) n = 0; return Math.round(Math.min(max, n) * 100) / 100;
}
function photoUrl(u) { u = String(u || ""); return /^https:\/\/[^\s"'<>]+$/.test(u) && u.length < 600 ? u : ""; }

const SCHEDE = ["facciata", "interni", "resine", "microcemento", "scale", "piastrelle", "legno", "haccp", "graniglia", "altro"];
const UMS = ["mq", "ml", "pz", "a corpo"];
const key = (k, max) => String(k || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, max || 48);
function obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }

function clean(d) {
  d = obj(d);
  const lavori = (Array.isArray(d.lavori) ? d.lavori : []).filter((k, i, a) => SCHEDE.includes(k) && a.indexOf(k) === i);
  const sup = s => { const o = {}; Object.keys(obj(s)).slice(0, 10).forEach(k => { if (SCHEDE.includes(k)) { const x = obj(s[k]); o[k] = { pav: !!x.pav, par: !!x.par, sof: !!x.sof }; } }); return o; };
  const ambienti = (Array.isArray(d.ambienti) ? d.ambienti : []).slice(0, 60).map(a => ({
    nome: str(a && a.nome, 60), l: num(a && a.l, 200), w: num(a && a.w, 200), h: num(a && a.h, 30), sottrai: num(a && a.sottrai, 500),
    sup: sup(a && a.sup), note: str(a && a.note, 500),
  }));
  const prospetti = (Array.isArray(d.prospetti) ? d.prospetti : []).slice(0, 20).map(p => ({
    nome: str(p && p.nome, 60), w: num(p && p.w, 500), h: num(p && p.h, 200), aperture: num(p && p.aperture, 5000), finestre: num(p && p.finestre, 1000),
    extra: num(p && p.extra, 5000), piani: num(p && p.piani, 100), note: str(p && p.note, 500),
  }));
  const aree = (Array.isArray(d.aree) ? d.aree : []).slice(0, 40).map(a => ({
    nome: str(a && a.nome, 60), mq: num(a && a.mq, 100000), perim: num(a && a.perim, 10000), lav: (Array.isArray(a && a.lav) ? a.lav : []).filter(k => SCHEDE.includes(k)),
  }));
  const g = obj(d.gradini);
  const gradini = { n: num(g.n, 500), larg: num(g.larg, 20), pedata: num(g.pedata, 5), alzata: num(g.alzata, 5), pian: num(g.pian, 1000) };
  const voci = {};
  Object.keys(obj(d.voci)).forEach(sk => { if (!SCHEDE.includes(sk)) return; const o = {}; Object.keys(obj(d.voci[sk])).slice(0, 120).forEach(k => { const kk = key(k); const x = obj(d.voci[sk][k]); if (kk) o[kk] = { q: num(x.q, 1000000), m: x.m ? 1 : 0 }; }); voci[sk] = o; });
  const extra = (Array.isArray(d.extra) ? d.extra : []).slice(0, 60).map(x => ({ sk: SCHEDE.includes(x && x.sk) ? x.sk : "altro", k: key(x && x.k), t: str(x && x.t, 120), um: UMS.includes(x && x.um) ? x.um : "a corpo" })).filter(x => x.k && x.t);
  const scelte = {};
  Object.keys(obj(d.scelte)).forEach(sk => { if (!SCHEDE.includes(sk)) return; const o = {}; Object.keys(obj(d.scelte[sk])).slice(0, 20).forEach(k => { const kk = key(k, 30); if (kk) o[kk] = str(d.scelte[sk][k], 160); }); scelte[sk] = o; });
  const controlli = {};
  Object.keys(obj(d.controlli)).slice(0, 200).forEach(k => { const kk = key(k, 60); const v = d.controlli[k]; if (kk && ["ok", "ko", "?"].includes(v)) controlli[kk] = v; });
  const foto = (Array.isArray(d.foto) ? d.foto : []).slice(0, 30).map(f => ({ url: photoUrl(f && f.url), nota: str(f && f.nota, 300) })).filter(f => f.url);
  return {
    lavori, tipo: str(d.tipo, 40), ambienti, prospetti, aree, gradini, voci, extra, scelte, controlli, foto,
    note: str(d.note, 4000),
    firma: photoUrl(d.firma), firmaNome: str(d.firmaNome, 80), firmaData: str(d.firmaData, 30),
    data: str(d.data, 10), riassunto: str(d.riassunto, 200),
  };
}
function totals(d) {
  let pav = 0, par = 0, sof = 0, fac = 0;
  (d.ambienti || []).forEach(a => {
    const s = Object.values(a.sup || {}); const any = k => s.some(x => x && x[k]) || !!a[k];
    if (any("pav")) pav += a.l * a.w; if (any("sof")) sof += a.l * a.w;
    if (any("par")) par += Math.max(0, 2 * (a.l + a.w) * a.h - (a.sottrai || 0));
  });
  (d.prospetti || []).forEach(p => { fac += Math.max(0, p.w * p.h + (p.extra || 0) - (p.aperture || 0)); });
  const r = x => Math.round(x * 10) / 10;
  return { pav: r(pav), par: r(par), sof: r(sof), fac: r(fac), n: (d.ambienti || []).length };
}
function pub(row, full) {
  const d = row.data || {};
  const o = { id: row.id, clientName: row.client_name || "", address: row.address || "", phone: row.phone || "", leadId: row.lead_id || null, status: row.status || "bozza", updatedAt: row.updated_at, createdAt: row.created_at, tot: totals(d), lavori: Array.isArray(d.lavori) ? d.lavori : [], riassunto: d.riassunto || "" };
  if (full) o.data = d;
  return o;
}
const missing = r => !r.ok && (r.status === 404 || (r.data && /42P01|does not exist/.test(JSON.stringify(r.data))));

async function handle(req, res, action, acc) {
  const mine = "account_id=eq." + encodeURIComponent(acc.id);
  const b = req.body || {};
  if (action === "sopr-photo") {
    if (req.method !== "POST") return res.status(405).json({ error: "Metodo non valido" });
    const url = await uploadPhoto(b.dataUrl, "sopralluoghi/" + acc.id).catch(() => null);
    if (!url) return res.status(400).json({ error: "Foto non valida o troppo grande." });
    return res.status(200).json({ url });
  }
  if (action === "sopr-list") {
    const r = await supabaseRequest("/pro_sopralluoghi?" + mine + "&select=*&order=updated_at.desc&limit=200", { method: "GET" });
    if (missing(r)) return res.status(404).json({ error: "Sopralluoghi non ancora attivi: manca la tabella su Supabase.", code: "notable" });
    if (!r.ok) return res.status(502).json({ error: "Non riesco a caricare i sopralluoghi." });
    return res.status(200).json({ items: (r.data || []).map(x => pub(x, false)) });
  }
  if (action === "sopr-get") {
    const id = (req.query && req.query.id) || "";
    if (!UUID.test(id)) return res.status(400).json({ error: "Sopralluogo non valido." });
    const r = await supabaseRequest("/pro_sopralluoghi?id=eq." + id + "&" + mine + "&select=*", { method: "GET" });
    if (missing(r)) return res.status(404).json({ error: "Sopralluoghi non ancora attivi.", code: "notable" });
    const row = r.ok && Array.isArray(r.data) && r.data[0];
    if (!row) return res.status(404).json({ error: "Sopralluogo non trovato." });
    return res.status(200).json({ item: pub(row, true) });
  }
  if (action === "sopr-delete") {
    if (req.method !== "POST" || !UUID.test(String(b.id || ""))) return res.status(400).json({ error: "Sopralluogo non valido." });
    await supabaseRequest("/pro_sopralluoghi?id=eq." + b.id + "&" + mine, { method: "DELETE" });
    return res.status(200).json({ ok: true });
  }
  if (action === "sopr-save") {
    if (req.method !== "POST") return res.status(405).json({ error: "Metodo non valido" });
    const id = String(b.id || "");
    if (!UUID.test(id)) return res.status(400).json({ error: "Sopralluogo non valido." });
    const clientName = str(b.clientName, 120);
    if (!clientName) return res.status(400).json({ error: "Scrivi il nome del cliente." });
    const data = clean(b.data);
    if (JSON.stringify(data).length > 150000) return res.status(413).json({ error: "Sopralluogo troppo grande." });
    const row = { client_name: clientName, address: str(b.address, 200), phone: str(b.phone, 40), lead_id: UUID.test(String(b.leadId || "")) ? b.leadId : null, status: b.status === "chiuso" ? "chiuso" : "bozza", data, updated_at: new Date().toISOString() };
    const ex = await supabaseRequest("/pro_sopralluoghi?id=eq." + id + "&select=id,account_id", { method: "GET" });
    if (missing(ex)) return res.status(404).json({ error: "Sopralluoghi non ancora attivi: manca la tabella su Supabase.", code: "notable" });
    const found = ex.ok && Array.isArray(ex.data) && ex.data[0];
    let r;
    if (found) {
      if (found.account_id !== acc.id) return res.status(403).json({ error: "Sopralluogo di un altro account." });
      r = await supabaseRequest("/pro_sopralluoghi?id=eq." + id + "&" + mine, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
    } else {
      r = await supabaseRequest("/pro_sopralluoghi", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([Object.assign({ id, account_id: acc.id }, row)]) });
    }
    const saved = r.ok && Array.isArray(r.data) && r.data[0];
    if (!saved) return res.status(502).json({ error: "Salvataggio non riuscito. Riprova." });
    return res.status(200).json({ ok: true, item: pub(saved, true) });
  }
  return res.status(400).json({ error: "Azione non valida." });
}

module.exports = { handle, clean, totals };
