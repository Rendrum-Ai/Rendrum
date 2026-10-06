// api/_extra.js — servizi in più per i professionisti, in una sola tabella (pro_extra,
// vedi supabase_extra.sql). Le chiamate passano da api/quotes.js, così non serve
// una funzione Vercel in più.
//
// Con accesso (professionista):
//   GET  ?action=px-list&kind=agenda|lavoro|review|vote|site|costo|tariffe  -> { items }
//   POST ?action=px-save    { id?, kind, data }               -> { item }
//   POST ?action=px-delete  { id }
//   POST ?action=px-photo   { dataUrl }                       -> { url }
// Pubbliche (senza accesso, con il codice del link):
//   GET  ?action=pub-review&t=...   POST { t, stelle, testo, nome }   recensione del cliente
//   GET  ?action=pub-vote&t=...     POST { t, scelta, nome, interno } voto dei condòmini
//   GET  ?action=pub-site&s=...                                        sito vetrina dell'impresa
//   GET  ?action=pub-variante&t=... POST { t, scelta:'si'|'no', nome }  lavoro in più da confermare
const crypto = require("crypto");
const { supabaseRequest } = require("./_auth-lib");
const { uploadPhoto } = require("./_projects-lib");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["agenda", "lavoro", "review", "vote", "site", "costo", "tariffe", "variante"];
const SINGLE = ["site", "tariffe"];
const TOKEN = /^[a-f0-9]{20}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

function str(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[<>]/g, "").trim().slice(0, max); }
function url(u) { u = String(u || ""); return /^https:\/\/[^\s"'<>]+$/.test(u) && u.length < 600 ? u : ""; }
function urls(v, max) { return (Array.isArray(v) ? v : []).map(url).filter(Boolean).slice(0, max); }
function date(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : ""; }
function time(v) { return /^\d{2}:\d{2}$/.test(String(v || "")) ? String(v) : ""; }
function num(v, max) { v = Math.round((+String(v == null ? "" : v).replace(",", ".") || 0) * 100) / 100; return v > 0 ? Math.min(v, max) : 0; }
function int(v, min, max) { v = Math.round(+v || 0); return Math.max(min, Math.min(max, v)); }
function obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
const missing = r => !r.ok && (r.status === 404 || (r.data && /42P01|does not exist/.test(JSON.stringify(r.data))));
const NOTABLE = { error: "Questa funzione non è ancora attiva: manca la tabella su Supabase.", code: "notable" };

function clean(kind, d, old) {
  d = obj(d); old = obj(old);
  if (kind === "agenda") return {
    tipo: ["sopralluogo", "lavoro", "altro"].includes(d.tipo) ? d.tipo : "altro",
    titolo: str(d.titolo, 120), cliente: str(d.cliente, 120), telefono: str(d.telefono, 40), indirizzo: str(d.indirizzo, 200),
    data: date(d.data), ora: time(d.ora), note: str(d.note, 1000), fatto: !!d.fatto,
  };
  if (kind === "lavoro") return {
    titolo: str(d.titolo, 120), cliente: str(d.cliente, 120), telefono: str(d.telefono, 40), comune: str(d.comune, 80),
    data: date(d.data), prima: urls(d.prima, 6), dopo: urls(d.dopo, 6), pubblica: !!d.pubblica, permesso: !!d.permesso,
    quoteId: UUID.test(String(d.quoteId || "")) ? d.quoteId : null, reviewId: UUID.test(String(d.reviewId || "")) ? d.reviewId : null,
  };
  if (kind === "review") return {
    // la parte scritta dal cliente (stelle, testo, nome) arriva solo dal link pubblico
    lavoroId: UUID.test(String(d.lavoroId || "")) ? d.lavoroId : (old.lavoroId || null),
    cliente: str(d.cliente || old.cliente, 120), telefono: str(d.telefono || old.telefono, 40), titolo: str(d.titolo || old.titolo, 120),
    stato: old.stato === "ricevuta" ? "ricevuta" : "attesa",
    stelle: old.stelle || 0, testo: old.testo || "", nome: old.nome || "", at: old.at || "",
    nascosta: !!d.nascosta,
  };
  if (kind === "vote") return {
    titolo: str(d.titolo, 120), indirizzo: str(d.indirizzo, 200), note: str(d.note, 600),
    opzioni: (Array.isArray(d.opzioni) ? d.opzioni : []).slice(0, 4).map(o => ({ img: url(o && o.img), nome: str(o && o.nome, 80) })).filter(o => o.img),
    chiuso: !!d.chiuso, voti: Array.isArray(old.voti) ? old.voti : [],
  };
  if (kind === "site") return {
    attivo: !!d.attivo, slogan: str(d.slogan, 140), dominio: str(d.dominio, 80).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
  };
  if (kind === "costo") return {
    tipo: ["ore", "materiali", "mezzi"].includes(d.tipo) ? d.tipo : "materiali",
    cliente: str(d.cliente, 120), quoteId: UUID.test(String(d.quoteId || "")) ? d.quoteId : null,
    data: date(d.data), importo: num(d.importo, 1000000), desc: str(d.desc, 200),
    io: !!d.io, operai: int(d.operai, 0, 20), ore: num(d.ore, 24), giorni: int(d.giorni, 1, 60),
    foto: urls(d.foto, 3), iva: d.iva !== false,
    voci: (Array.isArray(d.voci) ? d.voci : []).slice(0, 12).map(v => ({ nome: str(v && v.nome, 60), euro: num(v && v.euro, 100000), giorni: int(v && v.giorni, 1, 60) })).filter(v => v.nome),
  };
  if (kind === "variante") {
    // la conferma (stato, nome, data) arriva solo dal link pubblico del cliente
    const ferma = old.stato === "confermata" || old.stato === "rifiutata";
    const src = ferma ? old : d;
    return {
      quoteId: UUID.test(String(src.quoteId || "")) ? src.quoteId : null, numero: str(src.numero, 20),
      cliente: str(d.cliente || old.cliente, 120), telefono: str(d.telefono || old.telefono, 40),
      titolo: str(src.titolo, 160), descrizione: str(src.descrizione, 600),
      qta: num(src.qta, 100000), um: ["mq", "ml", "pz", "a corpo", "h"].includes(src.um) ? src.um : "a corpo",
      prezzo: num(src.prezzo, 1000000), iva: [0, 4, 10, 22].includes(+src.iva) ? +src.iva : 22, foto: urls(src.foto, 3),
      stato: ferma ? old.stato : "attesa", nome: old.nome || "", at: old.at || "", applicata: !!old.applicata,
    };
  }
  if (kind === "tariffe") return {
    mia: num(d.mia, 500), operaio: num(d.operaio, 500), operai: d.operai !== false,
    attrezzi: (Array.isArray(d.attrezzi) ? d.attrezzi : []).slice(0, 20).map(v => ({ nome: str(v && v.nome, 60), euro: num(v && v.euro, 100000) })).filter(v => v.nome),
  };
  return {};
}
function pub(row) { return { id: row.id, kind: row.kind, token: row.token || null, data: row.data || {}, createdAt: row.created_at, updatedAt: row.updated_at }; }
async function getOne(q) {
  const r = await supabaseRequest("/pro_extra?" + q + "&select=*&limit=1", { method: "GET" });
  if (missing(r)) return { missing: true };
  return { row: r.ok && Array.isArray(r.data) ? r.data[0] : null };
}
async function patch(id, data) {
  return supabaseRequest("/pro_extra?id=eq." + id, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ data, updated_at: new Date().toISOString() }) });
}
async function account(id, cols) {
  const r = await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(id) + "&select=" + cols, { method: "GET" });
  return r.ok && Array.isArray(r.data) ? r.data[0] : null;
}

// ---------- pubbliche ----------
async function handlePublic(req, res, action) {
  const q = req.query || {}, b = req.body || {};
  if (action === "pub-review") {
    const t = String(req.method === "POST" ? b.t : q.t || "");
    if (!TOKEN.test(t)) return res.status(404).json({ error: "Link non valido." });
    const g = await getOne("kind=eq.review&token=eq." + t);
    if (g.missing || !g.row) return res.status(404).json({ error: "Link non valido o scaduto." });
    const d = g.row.data || {}, acc = await account(g.row.account_id, "company_name,logo_url") || {};
    if (req.method === "GET") return res.status(200).json({ impresa: acc.company_name || "", logo: acc.logo_url || null, cliente: d.cliente || "", titolo: d.titolo || "", fatta: d.stato === "ricevuta" });
    if (d.stato === "ricevuta") return res.status(409).json({ error: "Hai già lasciato la recensione. Grazie!" });
    const stelle = Math.round(+b.stelle);
    if (!(stelle >= 1 && stelle <= 5)) return res.status(400).json({ error: "Scegli da 1 a 5 stelle." });
    const nd = Object.assign({}, d, { stato: "ricevuta", stelle, testo: str(b.testo, 800), nome: str(b.nome, 60) || d.cliente || "Cliente", at: new Date().toISOString() });
    const r = await patch(g.row.id, nd);
    if (!r.ok) return res.status(502).json({ error: "Non sono riuscito a salvare, riprova." });
    return res.status(200).json({ ok: true });
  }
  if (action === "pub-vote") {
    const t = String(req.method === "POST" ? b.t : q.t || "");
    if (!TOKEN.test(t)) return res.status(404).json({ error: "Link non valido." });
    const g = await getOne("kind=eq.vote&token=eq." + t);
    if (g.missing || !g.row) return res.status(404).json({ error: "Link non valido o scaduto." });
    const d = g.row.data || {}, acc = await account(g.row.account_id, "company_name,logo_url") || {};
    if (req.method === "GET") return res.status(200).json({ impresa: acc.company_name || "", logo: acc.logo_url || null, titolo: d.titolo || "", indirizzo: d.indirizzo || "", note: d.note || "", opzioni: (d.opzioni || []).map(o => ({ img: o.img, nome: o.nome })), chiuso: !!d.chiuso, n: (d.voti || []).length });
    if (d.chiuso) return res.status(409).json({ error: "La votazione è chiusa." });
    const scelta = Math.round(+b.scelta), nome = str(b.nome, 60), interno = str(b.interno, 20);
    if (!(scelta >= 0 && scelta < (d.opzioni || []).length)) return res.status(400).json({ error: "Scegli una proposta." });
    if (!nome) return res.status(400).json({ error: "Scrivi il tuo nome." });
    const voti = (d.voti || []).slice(0, 400), k = (nome + "|" + interno).toLowerCase();
    const i = voti.findIndex(v => (v.nome + "|" + v.interno).toLowerCase() === k);
    const v = { scelta, nome, interno, at: new Date().toISOString() };
    if (i > -1) voti[i] = v; else voti.push(v);
    const r = await patch(g.row.id, Object.assign({}, d, { voti }));
    if (!r.ok) return res.status(502).json({ error: "Non sono riuscito a salvare il voto, riprova." });
    return res.status(200).json({ ok: true, cambiato: i > -1 });
  }
  if (action === "pub-site") {
    const s = String(q.s || "").toLowerCase();
    if (!SLUG.test(s)) return res.status(404).json({ error: "Sito non trovato." });
    const g = await getOne("kind=eq.site&token=eq." + s);
    if (g.missing || !g.row || !(g.row.data || {}).attivo) return res.status(404).json({ error: "Sito non trovato." });
    const accId = g.row.account_id;
    const acc = await account(accId, "company_name,logo_url,phone,email,profile_bio,profile_city,profile_website,profile_lavorazioni,profile_gallery") || {};
    const r = await supabaseRequest("/pro_extra?account_id=eq." + accId + "&kind=in.(lavoro,review)&select=id,kind,data,created_at&order=created_at.desc&limit=300", { method: "GET" });
    const rows = r.ok && Array.isArray(r.data) ? r.data : [];
    const lavori = rows.filter(x => x.kind === "lavoro" && x.data && x.data.pubblica && x.data.permesso && (x.data.dopo || []).length)
      .slice(0, 36).map(x => ({ id: x.id, titolo: x.data.titolo || "", comune: x.data.comune || "", data: x.data.data || "", prima: x.data.prima || [], dopo: x.data.dopo || [] }));
    const rec = rows.filter(x => x.kind === "review" && x.data && x.data.stato === "ricevuta" && !x.data.nascosta)
      .slice(0, 40).map(x => ({ stelle: x.data.stelle, testo: x.data.testo || "", nome: x.data.nome || "", titolo: x.data.titolo || "", at: x.data.at || "", lavoroId: x.data.lavoroId || null }));
    const media = rec.length ? Math.round(rec.reduce((a, x) => a + x.stelle, 0) / rec.length * 10) / 10 : null;
    return res.status(200).json({
      impresa: { nome: acc.company_name || "", logo: acc.logo_url || null, telefono: acc.phone || "", email: acc.email || "", bio: acc.profile_bio || "", citta: acc.profile_city || "", web: acc.profile_website || "", lavorazioni: acc.profile_lavorazioni || [], galleria: (acc.profile_gallery || []).slice(0, 12) },
      slogan: g.row.data.slogan || "", lavori, recensioni: rec, media,
    });
  }
  if (action === "pub-variante") {
    const t = String(req.method === "POST" ? b.t : q.t || "");
    if (!TOKEN.test(t)) return res.status(404).json({ error: "Link non valido." });
    const g = await getOne("kind=eq.variante&token=eq." + t);
    if (g.missing || !g.row) return res.status(404).json({ error: "Link non valido o scaduto." });
    const d = g.row.data || {}, acc = await account(g.row.account_id, "company_name,logo_url") || {};
    const imp = Math.round(d.qta * d.prezzo * 100) / 100, tot = Math.round(imp * (1 + (d.iva || 0) / 100) * 100) / 100;
    if (req.method === "GET") return res.status(200).json({ impresa: acc.company_name || "", logo: acc.logo_url || null, cliente: d.cliente || "", numero: d.numero || "", titolo: d.titolo || "", descrizione: d.descrizione || "", qta: d.qta, um: d.um, prezzo: d.prezzo, iva: d.iva, imponibile: imp, totale: tot, foto: d.foto || [], stato: d.stato || "attesa", at: d.at || "" });
    if (d.stato === "confermata" || d.stato === "rifiutata") return res.status(409).json({ error: d.stato === "confermata" ? "Hai già confermato questo lavoro. Grazie!" : "Hai già risposto a questa richiesta." });
    const si = b.scelta === "si";
    const nd = Object.assign({}, d, { stato: si ? "confermata" : "rifiutata", nome: str(b.nome, 60) || d.cliente || "Cliente", at: new Date().toISOString() });
    // confermata: la voce si aggiunge da sola al preventivo
    if (si && d.quoteId && !d.applicata) {
      const qr = await supabaseRequest("/pro_quotes?id=eq." + d.quoteId + "&account_id=eq." + encodeURIComponent(g.row.account_id) + "&select=*", { method: "GET" });
      const row = qr.ok && Array.isArray(qr.data) && qr.data[0];
      if (row && row.data && Array.isArray(row.data.voci)) {
        const qd = Object.assign({}, row.data), quando = new Date().toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Rome" });
        qd.voci = row.data.voci.concat([{ titolo: "Lavoro in più: " + d.titolo, descrizione: (d.descrizione ? d.descrizione + "\n" : "") + "Confermato dal cliente (" + nd.nome + ") il " + quando + ".", qta: d.qta, um: d.um, prezzo: d.prezzo, lavorazione: "" }]).slice(0, 60);
        try { qd.totali = require("./quotes")._test.totals(qd); } catch (e) { qd.totali = row.data.totali; }
        const up = await supabaseRequest("/pro_quotes?id=eq." + row.id, { method: "PATCH", body: JSON.stringify({ data: qd, total_cents: Math.round(((qd.totali || {}).totale || 0) * 100), updated_at: new Date().toISOString() }) });
        if (up.ok) nd.applicata = true;
      }
    }
    const r = await patch(g.row.id, nd);
    if (!r.ok) return res.status(502).json({ error: "Non sono riuscito a salvare, riprova." });
    return res.status(200).json({ ok: true, stato: nd.stato });
  }
  return res.status(400).json({ error: "Azione non valida." });
}

// ---------- con accesso ----------
async function handle(req, res, action, acc) {
  const mine = "account_id=eq." + encodeURIComponent(acc.id), b = req.body || {}, q = req.query || {};
  if (action === "px-photo") {
    if (req.method !== "POST") return res.status(405).json({ error: "Metodo non valido" });
    const u = await uploadPhoto(b.dataUrl, "extra/" + acc.id).catch(() => null);
    if (!u) return res.status(400).json({ error: "Foto non valida o troppo grande." });
    return res.status(200).json({ url: u });
  }
  if (action === "px-list") {
    const kind = String(q.kind || "");
    if (!KINDS.includes(kind)) return res.status(400).json({ error: "Tipo non valido." });
    const r = await supabaseRequest("/pro_extra?" + mine + "&kind=eq." + kind + "&select=*&order=updated_at.desc&limit=300", { method: "GET" });
    if (missing(r)) return res.status(404).json(NOTABLE);
    if (!r.ok) return res.status(502).json({ error: "Non riesco a caricare i dati." });
    return res.status(200).json({ items: (r.data || []).map(pub) });
  }
  if (action === "px-delete") {
    if (req.method !== "POST" || !UUID.test(String(b.id || ""))) return res.status(400).json({ error: "Elemento non valido." });
    const r = await supabaseRequest("/pro_extra?id=eq." + b.id + "&" + mine, { method: "DELETE" });
    if (missing(r)) return res.status(404).json(NOTABLE);
    return res.status(200).json({ ok: true });
  }
  if (action === "px-save") {
    if (req.method !== "POST") return res.status(405).json({ error: "Metodo non valido" });
    const kind = String(b.kind || ""), id = String(b.id || "");
    if (!KINDS.includes(kind)) return res.status(400).json({ error: "Tipo non valido." });
    if (id && !UUID.test(id)) return res.status(400).json({ error: "Elemento non valido." });
    let found = null;
    if (id) {
      const g = await getOne("id=eq." + id);
      if (g.missing) return res.status(404).json(NOTABLE);
      found = g.row;
      if (found && (found.account_id !== acc.id || found.kind !== kind)) return res.status(403).json({ error: "Elemento di un altro account." });
    } else if (SINGLE.includes(kind)) {
      const g = await getOne(mine + "&kind=eq." + kind);
      if (g.missing) return res.status(404).json(NOTABLE);
      found = g.row;
    }
    const data = clean(kind, b.data, found && found.data);
    if (JSON.stringify(data).length > 60000) return res.status(413).json({ error: "Troppi dati." });
    let token = found ? found.token : null;
    if (kind === "site") {
      const slug = String((b.data || {}).slug || token || "").toLowerCase();
      if (!SLUG.test(slug)) return res.status(400).json({ error: "Indirizzo del sito non valido: usa lettere, numeri e trattini (da 3 a 40)." });
      if (slug !== token) {
        const g = await getOne("kind=eq.site&token=eq." + slug);
        if (g.row && g.row.account_id !== acc.id) return res.status(409).json({ error: "Questo indirizzo è già usato da un'altra impresa: scegline un altro." });
      }
      token = slug;
    }
    if (!token && (kind === "review" || kind === "vote" || kind === "variante")) token = crypto.randomBytes(10).toString("hex");
    const now = new Date().toISOString();
    let r;
    if (found) r = await supabaseRequest("/pro_extra?id=eq." + found.id + "&" + mine, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ data, token, updated_at: now }) });
    else r = await supabaseRequest("/pro_extra", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([{ id: UUID.test(id) ? id : crypto.randomUUID(), account_id: acc.id, kind, token, data, updated_at: now }]) });
    if (missing(r)) return res.status(404).json(NOTABLE);
    const saved = r.ok && Array.isArray(r.data) && r.data[0];
    if (!saved) return res.status(502).json({ error: "Salvataggio non riuscito. Riprova." });
    return res.status(200).json({ ok: true, item: pub(saved) });
  }
  return res.status(400).json({ error: "Azione non valida." });
}

module.exports = { handle, handlePublic, clean };
