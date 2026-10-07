// api/_extra.js — servizi in più per i professionisti, in una sola tabella (pro_extra,
// vedi supabase_extra.sql). Le chiamate passano da api/quotes.js, così non serve
// una funzione Vercel in più.
//
// Con accesso (professionista):
//   GET  ?action=px-list&kind=agenda|lavoro|review|vote|site|costo|tariffe|variante|cliente|proforma|commerc|incasso|materiale|fornitore|ordine  -> { items }
//   POST ?action=px-mail-ordine { ordineId, pdf } -> manda l'ordine al fornitore per email (se l'email è attiva)
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
const KINDS = ["agenda", "lavoro", "review", "vote", "site", "costo", "tariffe", "variante", "cliente", "proforma", "commerc", "incasso", "materiale", "fornitore", "ordine"];
const SINGLE = ["site", "tariffe", "commerc"];
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
  if (kind === "cliente") return cleanCliente(d);
  if (kind === "materiale") return {
    // un prodotto del listino materiali, con il modo di calcolo
    lav: str(d.lav, 30).replace(/[^a-z_]/g, ""), ordine: int(d.ordine, 0, 99), nome: str(d.nome, 120), codice: str(d.codice, 40),
    fornitoreId: UUID.test(String(d.fornitoreId || "")) ? d.fornitoreId : null,
    modo: ["resa", "scatola", "metro", "pezzo"].includes(d.modo) ? d.modo : "resa",
    resa: num(d.resa, 1000), um: ["kg", "l"].includes(d.um) ? d.um : "kg", mani: int(d.mani, 1, 10),
    conf: num(d.conf, 100000), confUm: str(d.confUm, 20), scarto: num(d.scarto, 100), ogni: num(d.ogni, 100000), fisso: int(d.fisso, 0, 10000),
    colore: !!d.colore, prezzo: num(d.prezzo, 1e6), scheda: url(d.scheda), nota: str(d.nota, 300),
    base: ["mq", "iso", "guide", "perim", "partenza", "spigoli", "montanti", "davanzali"].includes(d.base) ? d.base : "",
  };
  if (kind === "fornitore") return { nome: str(d.nome, 120), telefono: str(d.telefono, 40), email: str(d.email, 120), note: str(d.note, 300) };
  if (kind === "ordine") {
    const righe = (Array.isArray(d.righe) ? d.righe : (old.righe || [])).slice(0, 80).map(r => ({ nome: str(r && r.nome, 120), codice: str(r && r.codice, 40), colore: str(r && r.colore, 80), conf: str(r && r.conf, 40), qta: int(r && r.qta, 0, 100000) })).filter(r => r.nome && r.qta);
    const stato = ["inviato", "confermato", "arrivato"].includes(d.stato) ? d.stato : (old.stato || "inviato");
    return {
      quoteId: UUID.test(String(d.quoteId || old.quoteId || "")) ? (d.quoteId || old.quoteId) : null, cliente: str(d.cliente || old.cliente, 120),
      fornitoreId: UUID.test(String(d.fornitoreId || old.fornitoreId || "")) ? (d.fornitoreId || old.fornitoreId) : null,
      fornitore: str(d.fornitore || old.fornitore, 120), consegna: d.consegna === "ritiro" ? "ritiro" : (d.consegna === "cantiere" ? "cantiere" : (old.consegna || "cantiere")),
      indirizzo: str(d.indirizzo != null ? d.indirizzo : old.indirizzo, 200), data: date(d.data != null ? d.data : old.data), note: str(d.note != null ? d.note : old.note, 600),
      righe, stato, inviatoAt: old.inviatoAt || new Date().toISOString(), statoAt: stato !== old.stato ? new Date().toISOString() : (old.statoAt || ""),
      email: !!(d.email || old.email),
    };
  }
  if (kind === "incasso") return {
    // rate del preventivo accettato: quando vanno chieste e quanto è già arrivato
    quoteId: UUID.test(String(d.quoteId || "")) ? d.quoteId : (old.quoteId || null), numero: str(d.numero, 20), cliente: str(d.cliente, 120), telefono: str(d.telefono, 40), oggetto: str(d.oggetto, 200),
    rate: (Array.isArray(d.rate) ? d.rate : []).slice(0, 8).map(r => ({ d: str(r && r.d, 60), pct: num(r && r.pct, 100), quando: ["firma", "inizio", "meta", "fine"].includes(r && r.quando) ? r.quando : "fine", inc: num(r && r.inc, 1e8), data: date(r && r.data), soll: date(r && r.soll) })).filter(r => r.pct > 0),
  };
  if (kind === "commerc") return { nome: str(d.nome, 120), email: str(d.email, 120), telefono: str(d.telefono, 40) };
  if (kind === "proforma") {
    // il proforma è una fotografia: dopo la creazione cambia solo "fatturato"
    if (old.numero) return Object.assign({}, old, { fatturato: !!d.fatturato, fatturatoAt: d.fatturato ? (old.fatturatoAt || new Date().toISOString()) : "" });
    const tot = t => ({ imponibile: num(t && t.imponibile, 1e8), iva: num(t && t.iva, 1e8), totale: num(t && t.totale, 1e8) });
    return {
      numero: 0, anno: new Date().getFullYear(), data: date(d.data) || new Date().toISOString().slice(0, 10),
      tipo: ["acconto", "saldo", "tutto"].includes(d.tipo) ? d.tipo : "tutto",
      quoteId: UUID.test(String(d.quoteId || "")) ? d.quoteId : null, quoteNum: str(d.quoteNum, 20), oggetto: str(d.oggetto, 200), cantiere: str(d.cantiere, 200),
      cliente: cleanCliente(d.cliente),
      righe: (Array.isArray(d.righe) ? d.righe : []).slice(0, 60).map(v => ({ t: str(v && v.t, 160), d: str(v && v.d, 400), qta: num(v && v.qta, 1e6), um: str(v && v.um, 12), prezzo: num(v && v.prezzo, 1e8), imp: num(v && v.imp, 1e8) })).filter(v => v.t),
      scontoPct: num(d.scontoPct, 100), sconto: num(d.sconto, 1e8),
      aliquota: [0, 4, 5, 10, 22].includes(+d.aliquota) ? +d.aliquota : 22, ivaNota: str(d.ivaNota, 200),
      lavori: tot(d.lavori), fatt: tot(d.fatt), pct: num(d.pct, 100),
      dedotti: (Array.isArray(d.dedotti) ? d.dedotti : []).slice(0, 10).map(x => Object.assign({ numero: str(x && x.numero, 20), data: date(x && x.data) }, tot(x))),
      note: str(d.note, 800), fatturato: false, fatturatoAt: "",
    };
  }
  if (kind === "tariffe") return {
    mia: num(d.mia, 500), operaio: num(d.operaio, 500), operai: d.operai !== false,
    attrezzi: (Array.isArray(d.attrezzi) ? d.attrezzi : []).slice(0, 20).map(v => ({ nome: str(v && v.nome, 60), euro: num(v && v.euro, 100000) })).filter(v => v.nome),
  };
  return {};
}
function cleanCliente(d) {
  d = obj(d);
  return {
    tipo: d.tipo === "azienda" ? "azienda" : "privato", nome: str(d.nome, 120),
    cf: str(d.cf, 20).toUpperCase().replace(/\s+/g, ""), piva: str(d.piva, 20).toUpperCase().replace(/\s+/g, ""),
    indirizzo: str(d.indirizzo, 200), cap: str(d.cap, 10), comune: str(d.comune, 80), prov: str(d.prov, 4).toUpperCase(),
    telefono: str(d.telefono, 40), email: str(d.email, 120), sdi: str(d.sdi, 7).toUpperCase(), pec: str(d.pec, 120), note: str(d.note, 400),
  };
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
  if (action === "pub-team") {
    const code = normCode(q.c);
    const g = code.length >= 4 ? await getOne("kind=eq.team&token=eq." + code) : {};
    if (!g.row) return res.status(404).json({ error: "Codice non trovato." });
    const acc = await account(g.row.account_id, "company_name,logo_url") || {};
    return res.status(200).json({ impresa: acc.company_name || "", logo: acc.logo_url || null, code });
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
  if (action === "px-scheda-ai") {
    // legge foto o PDF della scheda tecnica e restituisce i numeri per il listino materiali (l'artigiano controlla)
    if (req.method !== "POST") return res.status(405).json({ error: "Metodo non valido" });
    const key = (process.env.OPENAI_API_KEY || "").trim();
    if (!key) return res.status(503).json({ error: "Lettura automatica non attiva.", code: "noai" });
    const du = String(b.dataUrl || "");
    const isPdf = /^data:application\/pdf;base64,/.test(du), isImg = /^data:image\/(jpeg|png|webp);base64,/.test(du);
    if ((!isPdf && !isImg) || du.length > 9000000) return res.status(400).json({ error: "Carica una foto o un PDF (massimo 6 MB)." });
    const prompt = "Sei un tecnico di cantiere. Dalla scheda tecnica o dalla confezione di questo prodotto edile estrai SOLO quello che c'è scritto, in JSON con queste chiavi: " +
      "nome (nome commerciale), codice (codice prodotto o vuoto), modo ('resa' se si consuma in kg o litri al m², 'scatola' se è venduto a scatole o rotoli con m² per confezione, 'metro' se a barre/rotoli in metri lineari, 'pezzo' altrimenti), " +
      "resa (numero: consumo per m² per UNA mano; se c'è un intervallo usa il valore medio; 0 se non c'è), um ('kg' o 'l'), mani (numero di mani consigliate, 1 se non indicato), " +
      "conf (numero: contenuto di una confezione in kg, litri, m² o metri), confUm (nome della confezione in italiano: secchio, latta, sacco, scatola, rotolo, barra, kit…), nota (max 120 caratteri: condizioni importanti, es. spessore o supporto a cui si riferisce la resa). " +
      "Non inventare: se un valore non c'è, metti 0 o stringa vuota. Rispondi solo con il JSON.";
    const content = [{ type: "input_text", text: prompt }, isPdf ? { type: "input_file", filename: "scheda.pdf", file_data: du } : { type: "input_image", image_url: du }];
    const model = (process.env.OPENAI_VISION_MODEL || "gpt-4o-mini").trim();
    const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: [{ role: "user", content }], text: { format: { type: "json_object" } } }) }).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    let out = j && (j.output_text || ((j.output || []).flatMap(o => o.content || []).map(c => c.text || "").join("")));
    let d = null; try { d = JSON.parse(String(out || "").replace(/^```json|```$/g, "")); } catch (e) { d = null; }
    if (!r || !r.ok || !d) return res.status(502).json({ error: "Non sono riuscito a leggere la scheda. Prova con una foto più nitida o scrivi i numeri a mano." });
    return res.status(200).json({ data: clean("materiale", Object.assign({}, d, { nota: d.nota ? "Dalla scheda: " + d.nota : "" })) });
  }
  if (action === "px-mail-ordine") {
    if (req.method !== "POST" || !UUID.test(String(b.ordineId || ""))) return res.status(400).json({ error: "Ordine non valido." });
    const key = (process.env.RESEND_API_KEY || "").trim();
    if (!key) return res.status(503).json({ error: "Invio email non attivo.", code: "noemail" });
    const g = await getOne("id=eq." + b.ordineId + "&" + mine);
    if (g.missing || !g.row || g.row.kind !== "ordine") return res.status(404).json({ error: "Ordine non trovato." });
    const o = g.row.data || {};
    let to = "";
    if (o.fornitoreId) { const f = await getOne("id=eq." + o.fornitoreId + "&" + mine); to = f.row && f.row.data && f.row.data.email || ""; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "Il fornitore non ha un'email valida." });
    const a = await account(acc.id, "company_name,email");
    const imp = (a && a.company_name) || "Rendrum";
    const esc = t => String(t || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const rows = (o.righe || []).map(r => "<tr><td style='padding:6px;border-bottom:1px solid #eee'>" + esc(r.codice) + "</td><td style='padding:6px;border-bottom:1px solid #eee'><b>" + esc(r.nome) + "</b>" + (r.colore ? " · " + esc(r.colore) : "") + "</td><td style='padding:6px;border-bottom:1px solid #eee'>" + esc(r.conf) + "</td><td style='padding:6px;border-bottom:1px solid #eee;text-align:right'><b>" + r.qta + "</b></td></tr>").join("");
    const html = "<div style='font-family:Arial,sans-serif;max-width:640px;color:#1C1B18'><h2 style='margin:0 0 8px'>Ordine materiali · " + esc(imp) + "</h2><p>Cantiere <b>" + esc(o.cliente) + "</b> · " + (o.consegna === "ritiro" ? "ritiro in magazzino" : "consegna in cantiere: " + esc(o.indirizzo)) + (o.data ? " · entro il " + esc(o.data.split("-").reverse().join("/")) : "") + "</p><table style='border-collapse:collapse;width:100%;font-size:14px'><tr style='background:#F7F5F1'><th style='text-align:left;padding:6px'>Codice</th><th style='text-align:left;padding:6px'>Prodotto</th><th style='text-align:left;padding:6px'>Confezione</th><th style='text-align:right;padding:6px'>Q.tà</th></tr>" + rows + "</table>" + (o.note ? "<p><b>Note:</b> " + esc(o.note) + "</p>" : "") + "<p>Per confermare rispondete a questa email.<br>Grazie, " + esc(imp) + "</p><p style='color:#999;font-size:12px'>Ordine preparato con Rendrum</p></div>";
    const body = { from: (process.env.EMAIL_FROM || "Rendrum <onboarding@resend.dev>").trim(), to: [to], subject: "Ordine materiali · " + (o.cliente || "") + " · " + imp, html };
    if (a && a.email) body.reply_to = a.email;
    if (typeof b.pdf === "string" && /^[A-Za-z0-9+/=]+$/.test(b.pdf) && b.pdf.length < 4000000) body.attachments = [{ filename: "Ordine_" + String(o.cliente || "materiali").replace(/[^A-Za-z0-9]+/g, "_") + ".pdf", content: b.pdf }];
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (!r || !r.ok) return res.status(502).json({ error: "L'email non è partita. Riprova o mandalo su WhatsApp." });
    await patch(g.row.id, Object.assign({}, o, { email: true }));
    return res.status(200).json({ ok: true, to });
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
    if (kind === "proforma" && !found) {
      // numerazione per anno: il primo proforma dell'anno è il n. 1
      const r0 = await supabaseRequest("/pro_extra?" + mine + "&kind=eq.proforma&select=data&limit=2000", { method: "GET" });
      if (missing(r0)) return res.status(404).json(NOTABLE);
      const max = (r0.ok && Array.isArray(r0.data) ? r0.data : []).filter(x => x.data && +x.data.anno === data.anno).reduce((m, x) => Math.max(m, +x.data.numero || 0), 0);
      data.numero = max + 1;
    }
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


// ---------- squadra: il titolare affida i cantieri ai collaboratori ----------
// Tutto in pro_extra, righe del titolare (account_id = impresa):
//   team     token = codice (es. DGM4K7)          data { }
//   membro   token = m + id impresa + id persona  data { memberId, nome, email, stato: richiesta|attivo|rimosso }
//   incarico                                       data { memberId, cliente, indirizzo, lavori, foto, passaggi, data, giorni, stato }
//   diario                                         data { incaricoId, memberId, passaggio, mq, ore, foto, note, chiusura }
const CODE_CH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function normCode(c) { return String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12); }
function newCode(nome) {
  const pre = (String(nome || "").toUpperCase().normalize("NFD").replace(/[^A-Z]/g, "") + "RDM").slice(0, 3);
  let r = ""; const b = crypto.randomBytes(3); for (let i = 0; i < 3; i++) r += CODE_CH[b[i] % CODE_CH.length];
  return pre + r;
}
async function rows(q) { const r = await supabaseRequest("/pro_extra?" + q + "&select=*&limit=500", { method: "GET" }); if (missing(r)) return null; return r.ok && Array.isArray(r.data) ? r.data : []; }
async function insert(accountId, kind, token, data) {
  const now = new Date().toISOString();
  const r = await supabaseRequest("/pro_extra", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([{ id: crypto.randomUUID(), account_id: accountId, kind, token, data, updated_at: now }]) });
  return r.ok && Array.isArray(r.data) ? r.data[0] : null;
}
function cleanIncarico(d, old) {
  d = obj(d); old = obj(old);
  return {
    memberId: UUID.test(String(d.memberId || "")) ? d.memberId : old.memberId || null, memberNome: str(d.memberNome || old.memberNome, 80),
    cliente: str(d.cliente, 120), telefono: str(d.telefono, 40), indirizzo: str(d.indirizzo, 200), titolo: str(d.titolo, 160),
    quoteId: UUID.test(String(d.quoteId || "")) ? d.quoteId : null,
    lavori: (Array.isArray(d.lavori) ? d.lavori : []).slice(0, 30).map(v => ({ t: str(v && v.t, 160), q: str(v && v.q, 40) })).filter(v => v.t),
    colori: (Array.isArray(d.colori) ? d.colori : []).slice(0, 20).map(v => str(v, 160)).filter(Boolean),
    ambienti: (Array.isArray(d.ambienti) ? d.ambienti : []).slice(0, 40).map(v => ({ n: str(v && v.n, 60), mq: num(v && v.mq, 100000) })).filter(v => v.n),
    foto: (Array.isArray(d.foto) ? d.foto : []).slice(0, 12).map(f => ({ url: url(f && f.url), nota: str(f && f.nota, 200) })).filter(f => f.url),
    nota: str(d.nota, 600), data: date(d.data), ora: time(d.ora), giorni: int(d.giorni, 1, 60),
    passaggi: (Array.isArray(d.passaggi) ? d.passaggi : []).slice(0, 10).map(p => ({ n: str(p && p.n, 40), p: num(p && p.p, 100) })).filter(p => p.n),
    mqTot: num(d.mqTot, 100000),
    stato: ["attivo", "chiuso", "confermato"].includes(old.stato) && old.stato !== "attivo" ? old.stato : "attivo",
    chiusoAt: old.chiusoAt || "",
  };
}
async function handleTeam(req, res, action, acc) {
  const b = req.body || {}, q = req.query || {}, me = acc.id, post = req.method === "POST";
  const owner = acc.account_type !== "privato";
  // ----- lato titolare -----
  if (action === "tm-team" || action === "tm-code") {
    if (!owner) return res.status(403).json({ error: "Solo per le imprese." });
    const t = await rows("account_id=eq." + me + "&kind=eq.team"); if (t === null) return res.status(404).json(NOTABLE);
    let row = t[0];
    if (!row || action === "tm-code") {
      let ok = null;
      for (let i = 0; i < 6 && !ok; i++) {
        const code = newCode(acc.company_name);
        const dup = await getOne("kind=eq.team&token=eq." + code); if (dup.row) continue;
        if (row) { const r = await supabaseRequest("/pro_extra?id=eq." + row.id, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ token: code, updated_at: new Date().toISOString() }) }); ok = r.ok && r.data && r.data[0]; }
        else ok = await insert(me, "team", code, {});
      }
      if (!ok) return res.status(502).json({ error: "Non riesco a creare il codice, riprova." });
      row = ok;
    }
    const m = await rows("account_id=eq." + me + "&kind=eq.membro") || [];
    return res.status(200).json({ code: row.token, members: m.filter(x => x.data.stato !== "rimosso").map(x => ({ id: x.id, memberId: x.data.memberId, nome: x.data.nome, email: x.data.email, stato: x.data.stato, at: x.created_at })) });
  }
  if (action === "tm-member") {
    if (!owner || !post || !UUID.test(String(b.id || ""))) return res.status(400).json({ error: "Richiesta non valida." });
    const g = await getOne("id=eq." + b.id + "&account_id=eq." + me + "&kind=eq.membro");
    if (!g.row) return res.status(404).json({ error: "Persona non trovata." });
    const stato = ["attivo", "rimosso"].includes(b.stato) ? b.stato : g.row.data.stato;
    const r = await patch(g.row.id, Object.assign({}, g.row.data, { stato }));
    return r.ok ? res.status(200).json({ ok: true }) : res.status(502).json({ error: "Non riuscito, riprova." });
  }
  if (action === "tm-assign") {
    if (!owner || !post) return res.status(400).json({ error: "Richiesta non valida." });
    const d = obj(b.data), id = String(b.id || "");
    const mm = await rows("account_id=eq." + me + "&kind=eq.membro") || [];
    const mem = mm.find(x => x.data.memberId === d.memberId && x.data.stato === "attivo");
    if (!mem) return res.status(400).json({ error: "Questa persona non è (più) nella tua squadra." });
    d.memberNome = mem.data.nome;
    if (id) {
      if (!UUID.test(id)) return res.status(400).json({ error: "Incarico non valido." });
      const g = await getOne("id=eq." + id + "&account_id=eq." + me + "&kind=eq.incarico"); if (!g.row) return res.status(404).json({ error: "Incarico non trovato." });
      const r = await patch(g.row.id, cleanIncarico(d, g.row.data)); const s = r.ok && r.data && r.data[0];
      return s ? res.status(200).json({ item: pub(s) }) : res.status(502).json({ error: "Non riuscito, riprova." });
    }
    const s = await insert(me, "incarico", null, cleanIncarico(d, {}));
    return s ? res.status(200).json({ item: pub(s) }) : res.status(502).json({ error: "Non riuscito, riprova." });
  }
  if (action === "tm-owner") {
    if (!owner) return res.status(403).json({ error: "Solo per le imprese." });
    const inc = await rows("account_id=eq." + me + "&kind=eq.incarico"); if (inc === null) return res.status(404).json(NOTABLE);
    const dia = await rows("account_id=eq." + me + "&kind=eq.diario") || [];
    return res.status(200).json({ incarichi: inc.map(pub), diario: dia.map(pub) });
  }
  if (action === "tm-confirm") {
    if (!owner || !post || !UUID.test(String(b.id || ""))) return res.status(400).json({ error: "Richiesta non valida." });
    const g = await getOne("id=eq." + b.id + "&account_id=eq." + me + "&kind=eq.incarico"); if (!g.row) return res.status(404).json({ error: "Incarico non trovato." });
    const r = await patch(g.row.id, Object.assign({}, g.row.data, { stato: b.riapri ? "attivo" : "confermato" }));
    return r.ok ? res.status(200).json({ ok: true }) : res.status(502).json({ error: "Non riuscito, riprova." });
  }
  if (action === "tm-unassign") {
    if (!owner || !post || !UUID.test(String(b.id || ""))) return res.status(400).json({ error: "Richiesta non valida." });
    await supabaseRequest("/pro_extra?id=eq." + b.id + "&account_id=eq." + me + "&kind=eq.incarico", { method: "DELETE" });
    return res.status(200).json({ ok: true });
  }
  // ----- lato collaboratore -----
  if (action === "tm-join") {
    if (!post) return res.status(405).json({ error: "Metodo non valido" });
    const code = normCode(b.code); if (code.length < 4) return res.status(400).json({ error: "Codice non valido." });
    const g = await getOne("kind=eq.team&token=eq." + code);
    if (g.missing) return res.status(404).json(NOTABLE);
    if (!g.row) return res.status(404).json({ error: "Codice non trovato: controlla di averlo scritto giusto." });
    const ownerId = g.row.account_id;
    if (ownerId === me) return res.status(400).json({ error: "Questo è il codice della tua impresa." });
    const tok = "m" + ownerId.replace(/-/g, "").slice(0, 12) + me.replace(/-/g, "");
    const ex = await getOne("kind=eq.membro&token=eq." + tok);
    const nome = str(b.nome, 80) || acc.company_name || acc.email || "Collaboratore";
    if (ex.row) {
      if (ex.row.data.stato === "rimosso") await patch(ex.row.id, Object.assign({}, ex.row.data, { stato: "richiesta", nome }));
    } else if (!await insert(ownerId, "membro", tok, { memberId: me, nome, email: str(acc.email, 120), stato: "richiesta" })) return res.status(502).json({ error: "Non riuscito, riprova." });
    const oa = await account(ownerId, "company_name") || {};
    return res.status(200).json({ ok: true, impresa: oa.company_name || "" });
  }
  if (action === "tm-me") {
    const m = await rows("kind=eq.membro&data->>memberId=eq." + me); if (m === null) return res.status(200).json({ teams: [] });
    const teams = [];
    for (const x of m.filter(x => x.data.stato !== "rimosso").slice(0, 5)) {
      const oa = await account(x.account_id, "company_name,logo_url,phone") || {};
      const t = { ownerId: x.account_id, impresa: oa.company_name || "", logo: oa.logo_url || null, telefono: oa.phone || "", stato: x.data.stato, incarichi: [], diario: [] };
      if (x.data.stato === "attivo") {
        t.incarichi = (await rows("account_id=eq." + x.account_id + "&kind=eq.incarico&data->>memberId=eq." + me) || []).map(pub);
        t.diario = (await rows("account_id=eq." + x.account_id + "&kind=eq.diario&data->>memberId=eq." + me) || []).map(pub);
      }
      teams.push(t);
    }
    return res.status(200).json({ teams });
  }
  if (action === "tm-photo") {
    if (!post) return res.status(405).json({ error: "Metodo non valido" });
    const u = await uploadPhoto(b.dataUrl, "extra/team/" + me).catch(() => null);
    return u ? res.status(200).json({ url: u }) : res.status(400).json({ error: "Foto non valida o troppo grande." });
  }
  if (action === "tm-diario") {
    if (!post || !UUID.test(String(b.incaricoId || ""))) return res.status(400).json({ error: "Richiesta non valida." });
    const g = await getOne("id=eq." + b.incaricoId + "&kind=eq.incarico");
    if (!g.row || g.row.data.memberId !== me) return res.status(404).json({ error: "Cantiere non trovato." });
    const tok = "m" + g.row.account_id.replace(/-/g, "").slice(0, 12) + me.replace(/-/g, "");
    const mem = await getOne("kind=eq.membro&token=eq." + tok);
    if (!mem.row || mem.row.data.stato !== "attivo") return res.status(403).json({ error: "Non fai più parte di questa squadra." });
    if (g.row.data.stato !== "attivo") return res.status(409).json({ error: "Questo cantiere è già chiuso." });
    const pass = (g.row.data.passaggi || []).map(p => p.n);
    const d = {
      incaricoId: g.row.id, memberId: me, nome: mem.row.data.nome, data: date(b.data) || new Date().toISOString().slice(0, 10),
      passaggio: pass.includes(b.passaggio) ? b.passaggio : "", mq: num(b.mq, 100000), ore: num(b.ore, 24),
      foto: urls(b.foto, 8), note: str(b.note, 600), chiusura: !!b.chiusura,
    };
    if (!d.chiusura && !d.passaggio && !d.ore && !d.foto.length) return res.status(400).json({ error: "Segna almeno un passaggio, le ore o una foto." });
    if (d.chiusura && d.foto.length < 3) return res.status(400).json({ error: "Per chiudere il cantiere servono almeno 3 foto finali." });
    const s = await insert(g.row.account_id, "diario", null, d);
    if (!s) return res.status(502).json({ error: "Non riuscito, riprova." });
    if (d.chiusura) await patch(g.row.id, Object.assign({}, g.row.data, { stato: "chiuso", chiusoAt: new Date().toISOString() }));
    return res.status(200).json({ ok: true, item: pub(s) });
  }
  return res.status(400).json({ error: "Azione non valida." });
}

module.exports = { handle, handlePublic, handleTeam, clean };
