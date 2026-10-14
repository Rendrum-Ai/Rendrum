// api/_plink.js — il link del preventivo per il cliente (in prova).
// Il cliente, senza account, dal link:
//   1. guarda il preventivo e lo accetta (nome + spunta + firma col dito) o chiede una modifica
//   2. dopo la conferma dell'impresa vede gli acconti, IBAN e causale (ed eventualmente il link carta dell'impresa)
//   3. carica la contabile del bonifico
// L'impresa conferma l'accettazione e segna "arrivati" quando vede i soldi in banca. Rendrum non tocca i soldi.
//
// Tutto in pro_extra:
//   kind "plink"   token = codice del link   data { quoteId, numero, cliente, telefono, stato, acc, conf, modifiche, viste }
//   kind "incasso" (già esistente)           data.rate[i].cont = [{ u, k, at, da, l, v, rem }]  contabili dell'acconto
//
// Pubbliche:  GET  ?action=pub-prev&t=...
//             POST ?action=pub-prev { t, op:'accetta', nome, firma, ok } | { t, op:'modifica', testo } | { t, op:'contabile', idx, file }
// Con accesso: POST pk-link { quoteId } -> { token, url }
//             GET  pk-list -> { links, avvisi }
//             POST pk-confirm { id, inizio } | pk-undo { id } | pk-seen { id } | pk-cont { quoteId, idx, file } | pk-cont-seen { quoteId, idx, rem }
const crypto = require("crypto");
const { supabaseRequest, getSupabaseConfig, isBeta } = require("./_auth-lib");
const { uploadPhoto } = require("./_projects-lib");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[a-f0-9]{20}$/;
const TESTERS = ["prova@rendrum.com", "info@dgmresine.com"];
const QUANDO = { firma: "alla firma", inizio: "a inizio lavori", meta: "a metà lavori", fine: "a fine lavori" };

function on(acc) { return process.env.PLINK_ALL === "1" || TESTERS.includes(String((acc && acc.email) || "").toLowerCase()) || isBeta(acc); }
function str(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[<>]/g, "").trim().slice(0, max); }
function r2(x) { return Math.round((+x || 0) * 100) / 100; }
function today() { return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" }); }
function addDays(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function date(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : ""; }
const missing = r => !r.ok && (r.status === 404 || (r.data && /42P01|does not exist/.test(JSON.stringify(r.data))));

async function one(q) { const r = await supabaseRequest("/pro_extra?" + q + "&select=*&limit=1", { method: "GET" }); if (missing(r)) return { missing: true }; return { row: r.ok && Array.isArray(r.data) ? r.data[0] : null }; }
async function patch(id, data) { const r = await supabaseRequest("/pro_extra?id=eq." + id, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ data, updated_at: new Date().toISOString() }) }); return r.ok && Array.isArray(r.data) ? r.data[0] : null; }
async function insert(accountId, kind, token, data) {
  const r = await supabaseRequest("/pro_extra", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([{ id: crypto.randomUUID(), account_id: accountId, kind, token, data, updated_at: new Date().toISOString() }]) });
  return r.ok && Array.isArray(r.data) ? r.data[0] : null;
}
async function quoteRow(accountId, id) {
  if (!UUID.test(String(id || ""))) return null;
  const r = await supabaseRequest("/pro_quotes?id=eq." + id + "&account_id=eq." + encodeURIComponent(accountId) + "&select=*", { method: "GET" });
  return r.ok && Array.isArray(r.data) ? r.data[0] || null : null;
}
async function account(id) {
  const r = await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(id) + "&select=id,email,company_name,logo_url,phone,quote_settings", { method: "GET" });
  return r.ok && Array.isArray(r.data) ? r.data[0] || null : null;
}
function numero(row) { return ("00" + row.number).slice(-3) + "/" + row.year; }

// ----- acconti: stessa logica dell'app (sopr/incassi.js) -----
function guess(r, i, n) {
  const t = String((r.descrizione || "") + " " + (r.scadenza || "")).toLowerCase();
  if (/firma|accett|ordine|conferma|sottoscri/.test(t)) return "firma";
  if (/inizio|avvio|apertura|posa|consegna/.test(t)) return "inizio";
  if (/met[aà]|\bsal\b|avanzamento|intermed/.test(t)) return "meta";
  if (/fine|saldo|ultimazione|termine|collaudo|chiusura|consegna lavori/.test(t)) return "fine";
  return i === 0 && n > 1 ? "firma" : i === n - 1 ? "fine" : "meta";
}
function rateFromQuote(q) {
  let R = (q.rate || []).filter(r => +r.pct > 0);
  if (!R.length) R = [{ descrizione: "Saldo", scadenza: "a fine lavori", pct: 100 }];
  return R.map((r, i) => ({ d: str(r.descrizione, 60) || ("Acconto " + (i + 1)), pct: +r.pct, quando: guess(r, i, R.length), inc: 0, data: "", soll: "", cont: [] }));
}
function amounts(tot, rate) {
  let sum = 0;
  return rate.map((r, i) => { const imp = i === rate.length - 1 ? r2(tot - sum) : r2(tot * r.pct / 100); sum = r2(sum + imp); return imp; });
}
async function incassoOf(accountId, quoteId) {
  const g = await one("account_id=eq." + encodeURIComponent(accountId) + "&kind=eq.incasso&data->>quoteId=eq." + quoteId);
  return g.row || null;
}
async function ensureIncasso(accountId, qrow) {
  const ex = await incassoOf(accountId, qrow.id); if (ex) return ex;
  const q = qrow.data || {};
  return insert(accountId, "incasso", null, { quoteId: qrow.id, numero: numero(qrow), cliente: str((q.cliente || {}).nome || qrow.client_name, 120), telefono: str((q.cliente || {}).telefono, 40), oggetto: str(q.oggetto, 200), rate: rateFromQuote(q) });
}

// ----- file: foto o PDF (contabili e firme) -----
async function uploadFile(dataUrl, folder) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  if (m[1].toLowerCase() !== "application/pdf") return uploadPhoto(dataUrl, folder).catch(() => null);
  if (m[2].length > 5_800_000) return null;
  const buf = Buffer.from(m[2], "base64");
  if (buf.slice(0, 5).toString() !== "%PDF-") return null;
  const { url, key } = getSupabaseConfig();
  const path = folder + "/" + crypto.randomBytes(16).toString("hex") + ".pdf";
  const r = await fetch(url + "/storage/v1/object/project-photos/" + path, { method: "POST", headers: { Authorization: "Bearer " + key, apikey: key, "Content-Type": "application/pdf", "x-upsert": "true" }, body: buf }).catch(() => null);
  return r && r.ok ? url + "/storage/v1/object/public/project-photos/" + path : null;
}
// legge la contabile: copia solo quello che c'è scritto
async function readContabile(dataUrl) {
  const key = (process.env.OPENAI_API_KEY || "").trim(); if (!key) return null;
  const isPdf = /^data:application\/pdf;base64,/.test(dataUrl);
  const prompt = "Questa è la ricevuta (contabile) di un pagamento, di solito un bonifico bancario italiano. Estrai SOLO quello che c'è scritto, in JSON con queste chiavi: " +
    "importo (numero in euro, punto per i decimali, 0 se non c'è), data (YYYY-MM-DD dell'esecuzione o dell'ordine, vuota se non c'è), ordinante (chi paga), beneficiario (chi riceve), " +
    "causale, tipo ('istantaneo' se è scritto bonifico istantaneo o immediato, 'ordinario' se è un bonifico normale/SEPA, 'carta' se è un pagamento con carta, '' se non si capisce), cro (codice CRO o TRN, vuoto se non c'è). " +
    "Non inventare niente: se un valore non c'è metti stringa vuota o 0. Rispondi solo con il JSON.";
  const content = [{ type: "input_text", text: prompt }, isPdf ? { type: "input_file", filename: "contabile.pdf", file_data: dataUrl } : { type: "input_image", image_url: dataUrl }];
  const model = (process.env.OPENAI_VISION_MODEL || "gpt-4o-mini").trim();
  try {
    const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: [{ role: "user", content }], text: { format: { type: "json_object" } } }) });
    const j = await r.json();
    const out = j && (j.output_text || ((j.output || []).flatMap(o => o.content || []).map(c => c.text || "").join("")));
    const d = JSON.parse(String(out || "").replace(/^```json|```$/g, ""));
    if (!r.ok || !d) return null;
    const imp = r2(String(d.importo || "0").replace(/[^\d.,]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
    return { importo: imp > 0 ? imp : 0, data: date(d.data), ordinante: str(d.ordinante, 80), beneficiario: str(d.beneficiario, 80), causale: str(d.causale, 160), tipo: ["istantaneo", "ordinario", "carta"].includes(d.tipo) ? d.tipo : "", cro: str(d.cro, 40) };
  } catch (e) { return null; }
}
async function addContabile(accountId, qrow, idx, file, da) {
  const inc = await ensureIncasso(accountId, qrow);
  if (!inc) return { error: "Non riesco a salvare la contabile, riprova.", status: 502 };
  const rate = (inc.data.rate || []).slice();
  if (!(idx >= 0 && idx < rate.length)) return { error: "Acconto non valido.", status: 400 };
  const cont = (rate[idx].cont || []).slice();
  if (cont.length >= 6) return { error: "Hai già caricato troppe contabili per questo acconto.", status: 409 };
  const u = await uploadFile(file, "plink/" + accountId);
  if (!u) return { error: "File non valido: carica una foto, uno screenshot o un PDF (massimo 3 MB).", status: 400 };
  const l = await readContabile(file);
  cont.push({ u, k: /\.pdf$/i.test(u) ? "pdf" : "img", at: new Date().toISOString(), da, l, v: da !== "c", rem: "" });
  rate[idx] = Object.assign({}, rate[idx], { cont });
  const s = await patch(inc.id, Object.assign({}, inc.data, { rate }));
  return s ? { ok: true, cont: cont[cont.length - 1] } : { error: "Non riesco a salvare la contabile, riprova.", status: 502 };
}

// ----- cosa vede il cliente -----
function scadenza(q) { const d = date(q.data) || today(); return addDays(d, +q.validitaGiorni || 30); }
function statoVero(d, tot) {
  // se l'impresa ha cambiato il preventivo dopo l'accettazione, va riaccettato
  if (d.stato === "accettato" && d.acc && Math.abs((+d.acc.totale || 0) - tot) > 0.009) return "attesa";
  return d.stato || "attesa";
}
async function view(row) {
  const d = row.data || {};
  const [acc, qrow] = await Promise.all([account(row.account_id), quoteRow(row.account_id, d.quoteId)]);
  if (!qrow) return null;
  const q = qrow.data || {}, set = (acc && acc.quote_settings) || {}, imp = set.impresa || {}, bk = set.banca || {};
  const tot = (qrow.total_cents || 0) / 100, stato = statoVero(d, tot), scade = scadenza(q);
  const inc = stato === "confermato" ? await incassoOf(row.account_id, qrow.id) : null;
  const R = inc ? inc.data.rate || [] : rateFromQuote(q), A = amounts(tot, R);
  const t = q.totali || {};
  const out = {
    impresa: { nome: imp.ragioneSociale || (acc && acc.company_name) || "", logo: (acc && acc.logo_url) || null, telefono: imp.telefono || (acc && acc.phone) || "" },
    numero: numero(qrow), data: q.data || "", scade, scaduto: (stato === "attesa" || stato === "modifica") && today() > scade,
    oggetto: q.oggetto || "", cliente: (q.cliente || {}).nome || qrow.client_name || "", cantiere: (q.cantiere || {}).indirizzo || (q.cliente || {}).indirizzo || "",
    voci: (q.voci || []).map(v => ({ titolo: v.titolo || "", descrizione: v.descrizione || "", qta: v.qta, um: v.um, importo: r2((+v.qta || 0) * (+v.prezzo || 0)) })),
    totali: { imponibile: t.imponibile || 0, sconto: t.sconto || 0, iva: t.iva || 0, totale: tot }, aliquota: (q.iva || {}).aliquota, ivaNota: (q.iva || {}).nota || "",
    anteprima: q.anteprima && q.anteprima.attiva ? { prima: q.anteprima.prima || null, dopo: q.anteprima.dopo || null } : null,
    stato, acc: d.acc && stato !== "attesa" ? { nome: d.acc.nome, at: d.acc.at } : null, conf: stato === "confermato" ? { at: (d.conf || {}).at, inizio: (d.conf || {}).inizio || "" } : null,
    modifica: (d.modifiche || []).slice(-1)[0] || null,
    acconti: R.map((r, i) => {
      const cont = r.cont || [], inc0 = +r.inc || 0;
      return { d: r.d, pct: r.pct, quando: QUANDO[r.quando] || "", importo: A[i], pagato: inc0 >= A[i] - 0.009, arrivati: r2(inc0), dataPag: r.data || "", contabili: cont.filter(c => c.da === "c").map(c => ({ at: c.at, k: c.k })) };
    }),
  };
  if (stato === "confermato") {
    out.banca = bk.iban ? { iban: String(bk.iban).replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim(), intestatario: bk.intestatario || imp.ragioneSociale || "", banca: bk.banca || "" } : null;
    out.carta = /^https:\/\//.test(bk.linkCarta || "") ? bk.linkCarta : null;
  }
  return out;
}

async function handlePublic(req, res) {
  const q = req.query || {}, b = req.body || {}, post = req.method === "POST";
  const t = String(post ? b.t : q.t || "");
  if (!TOKEN.test(t)) return res.status(404).json({ error: "Link non valido." });
  const g = await one("kind=eq.plink&token=eq." + t);
  if (g.missing || !g.row) return res.status(404).json({ error: "Link non valido o scaduto." });
  res.setHeader && res.setHeader("Cache-Control", "no-store");
  const row = g.row, d = row.data || {};
  if (!post) { const v = await view(row); return v ? res.status(200).json(v) : res.status(404).json({ error: "Questo preventivo non è più disponibile." }); }
  const qrow = await quoteRow(row.account_id, d.quoteId);
  if (!qrow) return res.status(404).json({ error: "Questo preventivo non è più disponibile." });
  const tot = (qrow.total_cents || 0) / 100, stato = statoVero(d, tot);
  if (b.op === "accetta") {
    if (!["attesa", "modifica"].includes(stato)) return res.status(409).json({ error: stato === "confermato" ? "Il preventivo è già confermato." : "Hai già accettato questo preventivo: aspetta la conferma dell'impresa." });
    if (today() > scadenza(qrow.data || {})) return res.status(409).json({ error: "Il preventivo è scaduto: chiedi all'impresa un preventivo aggiornato." });
    const nome = str(b.nome, 80);
    if (nome.length < 3) return res.status(400).json({ error: "Scrivi nome e cognome." });
    if (b.ok !== true) return res.status(400).json({ error: "Spunta la casella per accettare." });
    if (!/^data:image\/png;base64,/.test(String(b.firma || "")) || String(b.firma).length > 400000) return res.status(400).json({ error: "Firma qui sotto col dito." });
    const firma = await uploadPhoto(b.firma, "plink/" + row.account_id).catch(() => null);
    if (!firma) return res.status(400).json({ error: "Non riesco a salvare la firma, riprova." });
    const nd = Object.assign({}, d, { stato: "accettato", acc: { nome, firma, at: new Date().toISOString(), totale: tot, numero: numero(qrow) }, viste: Object.assign({}, d.viste, { acc: false }) });
    return (await patch(row.id, nd)) ? res.status(200).json({ ok: true }) : res.status(502).json({ error: "Non sono riuscito a salvare, riprova." });
  }
  if (b.op === "modifica") {
    if (stato === "confermato") return res.status(409).json({ error: "Il preventivo è già confermato: per cambiare qualcosa chiama l'impresa." });
    const testo = str(b.testo, 800);
    if (testo.length < 3) return res.status(400).json({ error: "Scrivi cosa vorresti cambiare." });
    const mods = (d.modifiche || []).slice(-9).concat([{ testo, at: new Date().toISOString() }]);
    const nd = Object.assign({}, d, { stato: stato === "accettato" ? "accettato" : "modifica", modifiche: mods, viste: Object.assign({}, d.viste, { mod: false }) });
    return (await patch(row.id, nd)) ? res.status(200).json({ ok: true }) : res.status(502).json({ error: "Non sono riuscito a salvare, riprova." });
  }
  if (b.op === "contabile") {
    if (stato !== "confermato") return res.status(409).json({ error: "Prima l'impresa deve confermare il preventivo." });
    const r = await addContabile(row.account_id, qrow, Math.round(+b.idx), String(b.file || ""), "c");
    return r.ok ? res.status(200).json({ ok: true }) : res.status(r.status || 400).json({ error: r.error });
  }
  return res.status(400).json({ error: "Azione non valida." });
}

// ----- lato impresa -----
async function linkFor(acc, qrow) {
  const g = await one("account_id=eq." + encodeURIComponent(acc.id) + "&kind=eq.plink&data->>quoteId=eq." + qrow.id);
  if (g.missing) return { missing: true };
  if (g.row) return { row: g.row };
  const q = qrow.data || {};
  const row = await insert(acc.id, "plink", crypto.randomBytes(10).toString("hex"), { quoteId: qrow.id, numero: numero(qrow), cliente: str((q.cliente || {}).nome || qrow.client_name, 120), telefono: str((q.cliente || {}).telefono, 40), stato: "attesa", modifiche: [], viste: {} });
  return { row };
}
function origin(req) { const h = (req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || ""; return /^[a-z0-9.-]+(:\d+)?$/i.test(h) && !/^localhost|^127\./.test(h) ? "https://" + h : "https://rendrum.com"; }
function linkUrl(req, token) { return origin(req) + "/?prev=" + token; }

async function handle(req, res, action, acc) {
  if (!on(acc)) return res.status(403).json({ error: "Funzione non ancora attiva.", code: "nopk" });
  const b = req.body || {}, post = req.method === "POST", mine = "account_id=eq." + encodeURIComponent(acc.id);
  if (action === "pk-link") {
    if (!post) return res.status(405).json({ error: "Usa POST" });
    const qrow = await quoteRow(acc.id, b.quoteId);
    if (!qrow) return res.status(404).json({ error: "Salva il preventivo prima di mandare il link." });
    const l = await linkFor(acc, qrow);
    if (l.missing) return res.status(404).json({ error: "Manca la tabella su Supabase.", code: "notable" });
    if (!l.row) return res.status(502).json({ error: "Non riesco a creare il link, riprova." });
    return res.status(200).json({ id: l.row.id, token: l.row.token, url: linkUrl(req, l.row.token), stato: l.row.data.stato });
  }
  if (action === "pk-list") {
    const r = await supabaseRequest("/pro_extra?" + mine + "&kind=in.(plink,incasso)&select=*&order=updated_at.desc&limit=400", { method: "GET" });
    if (missing(r)) return res.status(200).json({ links: [], avvisi: [] });
    const rows = r.ok && Array.isArray(r.data) ? r.data : [];
    const links = rows.filter(x => x.kind === "plink").map(x => ({ id: x.id, token: x.token, url: linkUrl(req, x.token), quoteId: x.data.quoteId, numero: x.data.numero, cliente: x.data.cliente, telefono: x.data.telefono, stato: x.data.stato, acc: x.data.acc ? { nome: x.data.acc.nome, at: x.data.acc.at, totale: x.data.acc.totale, firma: x.data.acc.firma } : null, conf: x.data.conf || null, modifica: (x.data.modifiche || []).slice(-1)[0] || null, viste: x.data.viste || {} }));
    const oggi = today(), avvisi = [];
    rows.filter(x => x.kind === "incasso").forEach(x => (x.data.rate || []).forEach((rt, i) => (rt.cont || []).forEach((c, k) => {
      if (c.da !== "c") return;
      if (c.v && !(c.rem && c.rem <= oggi)) return;
      avvisi.push({ quoteId: x.data.quoteId, cliente: x.data.cliente, telefono: x.data.telefono, numero: x.data.numero, idx: i, d: rt.d, k, at: c.at, l: c.l || null, u: c.u, inc: +rt.inc || 0 });
    })));
    return res.status(200).json({ links, avvisi });
  }
  const g = UUID.test(String(b.id || "")) ? await one("id=eq." + b.id + "&" + mine + "&kind=eq.plink") : {};
  if (action === "pk-confirm") {
    if (!post || !g.row) return res.status(404).json({ error: "Link non trovato." });
    const d = g.row.data, qrow = await quoteRow(acc.id, d.quoteId);
    if (!qrow) return res.status(404).json({ error: "Preventivo non trovato." });
    if (statoVero(d, (qrow.total_cents || 0) / 100) !== "accettato") return res.status(409).json({ error: "Il cliente non ha ancora accettato questa versione: se hai cambiato il preventivo dopo il suo sì, deve riaccettarlo dal link." });
    const inizio = date(b.inizio);
    const qd = Object.assign({}, qrow.data, { status: "accettato" });
    const up = await supabaseRequest("/pro_quotes?id=eq." + qrow.id + "&" + mine, { method: "PATCH", body: JSON.stringify({ status: "accettato", data: qd, updated_at: new Date().toISOString() }) });
    if (!up.ok) return res.status(502).json({ error: "Non riesco a confermare, riprova." });
    await ensureIncasso(acc.id, qrow);
    if (inizio) {
      const q = qrow.data || {};
      await insert(acc.id, "agenda", null, { tipo: "lavoro", titolo: str(String(q.oggetto || "Inizio lavori").replace(/^Offerta per:\s*/i, ""), 120), cliente: str((q.cliente || {}).nome || qrow.client_name, 120), telefono: str((q.cliente || {}).telefono, 40), indirizzo: str((q.cantiere || {}).indirizzo || (q.cliente || {}).indirizzo, 200), data: inizio, ora: "", note: "Inizio lavori (preventivo " + numero(qrow) + ")", fatto: false });
    }
    const nd = Object.assign({}, d, { stato: "confermato", conf: { at: new Date().toISOString(), inizio }, viste: Object.assign({}, d.viste, { acc: true, mod: true }) });
    return (await patch(g.row.id, nd)) ? res.status(200).json({ ok: true }) : res.status(502).json({ error: "Non riesco a confermare, riprova." });
  }
  if (action === "pk-undo") {
    // "non posso così": il cliente torna a vedere il preventivo da accettare
    if (!post || !g.row) return res.status(404).json({ error: "Link non trovato." });
    if (g.row.data.stato === "confermato") return res.status(409).json({ error: "Il preventivo è già confermato." });
    const nd = Object.assign({}, g.row.data, { stato: "attesa", acc: null, viste: Object.assign({}, g.row.data.viste, { acc: true, mod: true }) });
    return (await patch(g.row.id, nd)) ? res.status(200).json({ ok: true }) : res.status(502).json({ error: "Non riuscito, riprova." });
  }
  if (action === "pk-seen") {
    if (!post || !g.row) return res.status(404).json({ error: "Link non trovato." });
    const nd = Object.assign({}, g.row.data, { viste: Object.assign({}, g.row.data.viste, { mod: true }) });
    return (await patch(g.row.id, nd)) ? res.status(200).json({ ok: true }) : res.status(502).json({ error: "Non riuscito, riprova." });
  }
  if (action === "pk-cont") {
    if (!post) return res.status(405).json({ error: "Usa POST" });
    const qrow = await quoteRow(acc.id, b.quoteId);
    if (!qrow) return res.status(404).json({ error: "Preventivo non trovato." });
    const r = await addContabile(acc.id, qrow, Math.round(+b.idx), String(b.file || ""), "i");
    return r.ok ? res.status(200).json({ ok: true, cont: r.cont }) : res.status(r.status || 400).json({ error: r.error });
  }
  if (action === "pk-cont-seen") {
    // l'artigiano ha guardato la contabile del cliente ("Arrivati" o "Non ancora": in quel caso te la ricordo domani)
    if (!post || !UUID.test(String(b.quoteId || ""))) return res.status(400).json({ error: "Richiesta non valida." });
    const inc = await incassoOf(acc.id, b.quoteId);
    const i = Math.round(+b.idx);
    if (!inc || !(inc.data.rate || [])[i]) return res.status(404).json({ error: "Acconto non trovato." });
    const rate = inc.data.rate.slice(), rem = b.rem ? addDays(today(), 1) : "";
    rate[i] = Object.assign({}, rate[i], { cont: (rate[i].cont || []).map(c => Object.assign({}, c, { v: true, rem })) });
    return (await patch(inc.id, Object.assign({}, inc.data, { rate }))) ? res.status(200).json({ ok: true }) : res.status(502).json({ error: "Non riuscito, riprova." });
  }
  return res.status(400).json({ error: "Azione non valida." });
}

// per le email del preventivo: il link da mettere nel messaggio (solo se attivo per l'account)
async function linkForMail(req, acc, qrow) {
  if (!on(acc)) return null;
  const l = await linkFor(acc, qrow).catch(() => ({}));
  return l.row ? linkUrl(req, l.row.token) : null;
}
// il preventivo confermato dal cliente non cambia più (le aggiunte vanno in "Lavori in più")
async function locked(accId, quoteId) {
  const g = await one("account_id=eq." + encodeURIComponent(accId) + "&kind=eq.plink&data->>quoteId=eq." + quoteId).catch(() => ({}));
  return !!(g.row && g.row.data && g.row.data.stato === "confermato");
}

module.exports = { handle, handlePublic, linkForMail, locked, _test: { amounts, rateFromQuote, statoVero, guess, view } };
