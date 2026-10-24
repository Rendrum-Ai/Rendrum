// api/admin.js — Pannello Super Admin (Fase 1)
// Si apre da rendrum.com/admin.html. Lo vedono SOLO gli account con l'email in
// RD_ADMIN_EMAILS (su Vercel, separate da virgola, es. superadmin@rendrum.com).
// Dopo il login normale serve un codice di 6 cifre mandato via email (Resend):
// il pannello resta aperto 12 ore, poi si chiede un codice nuovo.
// Ogni azione che cambia qualcosa (crediti, prova, tester) finisce nel registro
// (tabella rendrum_admin_log, vedi supabase_admin.sql).
//
//   GET  /api/admin?action=me              -> chi sei e cosa manca da configurare
//   POST /api/admin?action=code-send       -> manda il codice via email
//   POST /api/admin?action=code-check      -> { code } apre il pannello
//   POST /api/admin?action=logout          -> chiude il pannello
//   GET  /api/admin?action=dash            -> numeri della dashboard
//   GET  /api/admin?action=users&q=&f=&p=  -> elenco utenti
//   GET  /api/admin?action=user&id=        -> scheda utente
//   POST /api/admin?action=user-credits    -> { id, n, nota } dai/togli anteprime comprate
//   POST /api/admin?action=user-trial      -> { id } fai ripartire la prova gratuita
//   POST /api/admin?action=user-tester     -> { id, on } novità in prova sì/no
//   GET  /api/admin?action=subs            -> abbonamenti (solo lettura)
//   GET  /api/admin?action=incassi&days=   -> incassi dal sito (Stripe)
//   GET  /api/admin?action=log             -> registro delle azioni

const crypto = require("crypto");
const {
  getSupabaseConfig, supabaseRequest, currentAccount, stripeRequest, paymentsEnabled,
  emailEnabled, sendEmail, emailLayout, PLANS, TRIAL, trialOf, monthKey, isBeta, isAdminEmail, adminEmails,
} = require("./_auth-lib");

const ADM = "rd_adm", ADMC = "rd_adm_c", HOURS = 12;

// ---------- firma dei cookie del pannello (separata da quella del login) ----------
function b64u(s) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64u(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Buffer.from(s, "base64").toString("utf8"); }
function key() { return getSupabaseConfig().jwtSecret + "|rendrum-super-admin"; }
function hm(x) { return b64u(crypto.createHmac("sha256", key()).update(x).digest()); }
function sign(o) { const p = b64u(JSON.stringify(o)); return p + "." + hm(p); }
function same(a, b) { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function unsign(t) {
  try {
    const [p, s] = String(t || "").split(".");
    if (!p || !s || !same(s, hm(p))) return null;
    const o = JSON.parse(unb64u(p));
    return o && o.exp && Date.now() < o.exp ? o : null;
  } catch (e) { return null; }
}
function cookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) { const p = part.trim(); if (p.indexOf(name + "=") === 0) return p.slice(name.length + 1); }
  return null;
}
function setCookies(res, list) { res.setHeader("Set-Cookie", list); }
function ck(name, val, sec) { return name + "=" + (val || "") + "; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=" + (sec || 0); }

// ---------- registro ----------
async function logA(acc, action, target, detail) {
  const row = { admin_id: acc.id, admin_email: acc.email, action, target_id: target ? target.id : null, target_email: target ? target.email : null, detail: detail || {} };
  const r = await supabaseRequest("/rendrum_admin_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([row]) }).catch(() => ({ ok: false }));
  return r.ok;
}
async function countLog(acc, action, minutes) {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const r = await supabaseRequest("/rendrum_admin_log?admin_id=eq." + encodeURIComponent(acc.id) + "&action=eq." + encodeURIComponent(action) + "&created_at=gte." + encodeURIComponent(since) + "&select=id,detail", { method: "GET" }).catch(() => ({ ok: false }));
  return r.ok && Array.isArray(r.data) ? r.data : null;
}

// conteggio veloce (header Content-Range di Supabase)
async function countRows(path) {
  const { url, key: k } = getSupabaseConfig();
  try {
    const r = await fetch(url + "/rest/v1" + path, { method: "GET", headers: { apikey: k, Authorization: "Bearer " + k, Prefer: "count=exact", Range: "0-0" } });
    if (!r.ok && r.status !== 206 && r.status !== 416) return null;
    const m = /\/(\d+)$/.exec(r.headers.get("content-range") || "");
    return m ? Number(m[1]) : null;
  } catch (e) { return null; }
}

// ---------- utenti ----------
function stato(row) {
  const s = row.subscription_status || "none";
  if (["active", "past_due"].includes(s)) return s === "past_due" ? "insoluto" : "pagante";
  if (s === "trialing") return "prova";
  if (row.trial_start) {
    const t = trialOf(row), end = Date.parse(row.trial_start) + t.days * 86400000;
    if (Date.now() < end && (Number(row.trial_used) || 0) < t.n) return "prova";
  }
  return "gratis";
}
function slim(row) {
  const t = trialOf(row), mk = monthKey();
  return {
    id: row.id, email: row.email, nome: row.company_name || "", tel: row.phone || "",
    tipo: row.account_type === "privato" ? "privato" : "professionista",
    tier: row.tier || "", sub: row.subscription_status || "none", anno: row.billing_interval === "year",
    stato: stato(row), creato: row.created_at,
    usate: row.usage_month === mk ? (Number(row.usage_count) || 0) : 0, limite: (PLANS[row.tier] || {}).images || 0,
    crediti: row.credits == null ? null : Number(row.credits) || 0,
    prova: row.trial_used == null ? null : { usate: Number(row.trial_used) || 0, di: t.n, inizio: row.trial_start || null, fine: row.trial_start ? new Date(Date.parse(row.trial_start) + t.days * 86400000).toISOString() : null },
    tester: isBeta(row), testerManuale: row.is_tester === true, testerCol: Object.prototype.hasOwnProperty.call(row, "is_tester"),
    verificata: row.email_verified !== false, citta: row.profile_city || "", piva: row.piva || "",
    stripe: row.stripe_customer_id || null, social: { google: !!row.google_sub, apple: !!row.apple_sub },
  };
}
async function allAccounts() {
  const out = [];
  for (let off = 0; off < 50000; off += 1000) {
    const r = await supabaseRequest("/pro_accounts?select=*&order=created_at.desc&limit=1000&offset=" + off, { method: "GET" });
    if (!r.ok || !Array.isArray(r.data)) throw new Error("accounts " + r.status);
    r.data.forEach((x) => out.push(x));
    if (r.data.length < 1000) break;
  }
  return out;
}
async function oneAccount(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  const r = await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(id) + "&select=*", { method: "GET" });
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}

// ---------- dashboard ----------
async function dash() {
  const rows = await allAccounts();
  const now = Date.now(), day = 86400000;
  const d = { utenti: rows.length, privati: 0, professionisti: 0, oggi: 0, sett: 0, mese: 0, paganti: 0, prova: 0, insoluti: 0, tester: 0,
    perPiano: {}, mensileStimato: 0, giorni: [] };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const byDay = {};
  rows.forEach((r) => {
    if (r.account_type === "privato") d.privati++; else d.professionisti++;
    const c = Date.parse(r.created_at || "");
    if (c >= today.getTime()) d.oggi++;
    if (now - c < 7 * day) d.sett++;
    if (now - c < 30 * day) { d.mese++; const k = new Date(c).toISOString().slice(0, 10); byDay[k] = (byDay[k] || 0) + 1; }
    const s = stato(r);
    if (s === "pagante") {
      d.paganti++; d.perPiano[r.tier] = (d.perPiano[r.tier] || 0) + 1;
      const p = PLANS[r.tier]; if (p) d.mensileStimato += r.billing_interval === "year" ? Math.round(p.yearCents / 12) : p.priceCents;
    }
    if (s === "insoluto") d.insoluti++;
    if (s === "prova") d.prova++;
    if (isBeta(r)) d.tester++;
  });
  for (let i = 29; i >= 0; i--) { const k = new Date(now - i * day).toISOString().slice(0, 10); d.giorni.push([k, byDay[k] || 0]); }
  const since = (n) => encodeURIComponent(new Date(now - n * day).toISOString());
  const [g30, e30, g1] = await Promise.all([
    countRows("/rendrum_jobs?select=id&status=eq.done&created_at=gte." + since(30)),
    countRows("/rendrum_jobs?select=id&status=eq.error&created_at=gte." + since(30)),
    countRows("/rendrum_jobs?select=id&status=eq.done&created_at=gte." + encodeURIComponent(today.toISOString())),
  ]);
  d.anteprime = { mese: g30, errori: e30, oggi: g1 };
  d.ultimi = rows.slice(0, 6).map(slim);
  return d;
}

// ---------- abbonamenti (Stripe) ----------
async function stripeList(path, max) {
  const out = []; let after = null;
  for (let i = 0; i < (max || 10); i++) {
    const r = await stripeRequest("GET", path + (path.includes("?") ? "&" : "?") + "limit=100" + (after ? "&starting_after=" + encodeURIComponent(after) : ""));
    if (!r.ok || !r.data || !Array.isArray(r.data.data)) { const e = new Error("stripe"); e.stripe = r.data && r.data.error && r.data.error.message; throw e; }
    r.data.data.forEach((x) => out.push(x));
    if (!r.data.has_more || !r.data.data.length) break;
    after = r.data.data[r.data.data.length - 1].id;
  }
  return out;
}
async function subs() {
  const rows = (await allAccounts()).filter((r) => r.stripe_subscription_id || (r.subscription_status && r.subscription_status !== "none"));
  let st = {}; let errore = null;
  if (paymentsEnabled()) {
    try {
      (await stripeList("/subscriptions?status=all", 10)).forEach((s) => {
        const it = s.items && s.items.data && s.items.data[0];
        const end = s.current_period_end || (it && it.current_period_end);
        st[s.id] = { stato: s.status, rinnovo: end ? new Date(end * 1000).toISOString() : null, disdetto: !!s.cancel_at_period_end, importo: it && it.price ? it.price.unit_amount : null, ogni: it && it.price && it.price.recurring ? it.price.recurring.interval : null };
      });
    } catch (e) { errore = e.stripe || "Stripe non risponde"; }
  }
  return { errore, stripe: paymentsEnabled(), lista: rows.map((r) => Object.assign(slim(r), { stripeSub: st[r.stripe_subscription_id] || null })) };
}

// ---------- incassi dal sito (Stripe) ----------
function tipoPag(src) {
  if (!src || typeof src !== "object") return "Altro";
  const md = src.metadata || {};
  if (src.invoice) return "Abbonamento";
  if (md.pacchetto) return "Pacchetto anteprime";
  if (md.invito) return "Link cliente";
  return "Pagamento";
}
async function incassi(days) {
  if (!paymentsEnabled()) return { attivo: false };
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const tx = await stripeList("/balance_transactions?created[gte]=" + since + "&expand[]=data.source", 25);
  const t = { lordo: 0, commissioni: 0, rimborsi: 0, netto: 0, pagamenti: 0, altreValute: 0 };
  const giorni = {}, perTipo = {}, lista = [];
  tx.forEach((b) => {
    if (b.type === "payout" || b.type === "payout_cancel" || b.type === "payout_failure") return;
    if (b.currency !== "eur") { t.altreValute++; return; }
    const k = new Date(b.created * 1000).toISOString().slice(0, 10);
    const src = b.source && typeof b.source === "object" ? b.source : null;
    let tipo;
    if (b.type === "charge" || b.type === "payment") {
      t.lordo += b.amount; t.pagamenti++; giorni[k] = (giorni[k] || 0) + b.amount;
      tipo = tipoPag(src); perTipo[tipo] = (perTipo[tipo] || 0) + b.amount;
    } else if (b.type === "refund" || b.type === "payment_refund") { t.rimborsi += -b.amount; tipo = "Rimborso"; }
    else tipo = b.type === "stripe_fee" ? "Costi Stripe" : "Altro (" + b.type + ")";
    t.commissioni += b.fee; t.netto += b.net;
    const email = src ? ((src.billing_details && src.billing_details.email) || src.receipt_email || "") : "";
    lista.push({ data: new Date(b.created * 1000).toISOString(), tipo, email, desc: b.description || (src && src.description) || "", lordo: b.amount, commissione: b.fee, netto: b.net, stato: b.status, disponibile: b.available_on ? new Date(b.available_on * 1000).toISOString() : null });
  });
  const serie = [];
  for (let i = days - 1; i >= 0; i--) { const k = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); serie.push([k, giorni[k] || 0]); }
  let saldo = null, bonifici = [];
  const bal = await stripeRequest("GET", "/balance").catch(() => ({ ok: false }));
  if (bal.ok && bal.data) {
    const pick = (a) => (a || []).filter((x) => x.currency === "eur").reduce((s, x) => s + x.amount, 0);
    saldo = { disponibile: pick(bal.data.available), inArrivo: pick(bal.data.pending) };
  }
  const po = await stripeRequest("GET", "/payouts?limit=6").catch(() => ({ ok: false }));
  if (po.ok && po.data && Array.isArray(po.data.data)) bonifici = po.data.data.map((p) => ({ importo: p.amount, valuta: p.currency, arrivo: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null, stato: p.status }));
  return { attivo: true, giorni: days, totali: t, perTipo, serie, lista, saldo, bonifici, troncato: tx.length >= 2500 };
}

// ---------- azioni sugli utenti ----------
async function patchAcc(id, filter, body) {
  return supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(id) + (filter || ""), { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
}
function colMissing(r) { return r && r.data && /column|schema cache/i.test(String(r.data.message || r.data.hint || "")); }

async function userDetail(id) {
  const row = await oneAccount(id);
  if (!row) return null;
  const u = slim(row);
  const [jobs, quotes, sopr, projects, log] = await Promise.all([
    supabaseRequest("/rendrum_jobs?account_id=eq." + id + "&select=id,title,status,created_at,result_url&order=created_at.desc&limit=8", { method: "GET" }).catch(() => ({ ok: false })),
    countRows("/pro_quotes?select=id&account_id=eq." + id),
    countRows("/pro_sopralluoghi?select=id&account_id=eq." + id),
    countRows("/pro_projects?select=id&pro_id=eq." + id),
    supabaseRequest("/rendrum_admin_log?target_id=eq." + id + "&select=created_at,admin_email,action,detail&order=created_at.desc&limit=20", { method: "GET" }).catch(() => ({ ok: false })),
  ]);
  u.lavori = jobs.ok && Array.isArray(jobs.data) ? jobs.data : [];
  u.anteprimeTot = await countRows("/rendrum_jobs?select=id&status=eq.done&account_id=eq." + id);
  u.preventivi = quotes; u.sopralluoghi = sopr; u.cantieri = projects;
  u.registro = log.ok && Array.isArray(log.data) ? log.data : [];
  u.pagamenti = [];
  if (row.stripe_customer_id && paymentsEnabled()) {
    const ch = await stripeRequest("GET", "/charges?customer=" + encodeURIComponent(row.stripe_customer_id) + "&limit=10").catch(() => ({ ok: false }));
    if (ch.ok && ch.data && Array.isArray(ch.data.data)) u.pagamenti = ch.data.data.map((c) => ({ data: new Date(c.created * 1000).toISOString(), importo: c.amount, rimborsato: c.amount_refunded, stato: c.status, tipo: tipoPag(c) }));
  }
  return u;
}

async function guard(req) {
  if (!getSupabaseConfig().configured) return { err: [500, "Servizio account non configurato."] };
  const acc = await currentAccount(req);
  if (!acc) return { err: [401, "Accedi con l'account Super Admin.", "login"] };
  if (!isAdminEmail(acc.email)) return { err: [403, "Questo account non è Super Admin.", "no-admin"] };
  const t = unsign(cookie(req, ADM));
  if (!t || t.sub !== acc.id || (Number(t.v) || 0) !== (Number(acc.session_version) || 0)) return { acc, err: [401, "Serve il codice via email.", "code"] };
  return { acc };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const action = String((req.query && req.query.action) || "");
  const body = req.body || {};
  try {
    if (action === "me") {
      const acc = getSupabaseConfig().configured ? await currentAccount(req) : null;
      const admin = !!(acc && isAdminEmail(acc.email));
      const t = admin ? unsign(cookie(req, ADM)) : null;
      const logOk = admin ? (await countLog(acc, "login", 1)) !== null : null;
      return res.status(200).json({ email: acc ? acc.email : null, admin, open: !!(t && t.sub === acc.id && (Number(t.v) || 0) === (Number(acc.session_version) || 0)),
        adminSet: adminEmails().length > 0, emailOn: emailEnabled(), logOk, stripe: paymentsEnabled() });
    }
    if (action === "logout") { setCookies(res, [ck(ADM, "", 0), ck(ADMC, "", 0)]); return res.status(200).json({ ok: true }); }

    if (action === "code-send" || action === "code-check") {
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      const acc = getSupabaseConfig().configured ? await currentAccount(req) : null;
      if (!acc) return res.status(401).json({ error: "Accedi con l'account Super Admin.", code: "login" });
      if (!isAdminEmail(acc.email)) return res.status(403).json({ error: "Questo account non è Super Admin.", code: "no-admin" });
      if (action === "code-send") {
        if (!emailEnabled()) return res.status(503).json({ error: "Le email non partono: su Vercel manca RESEND_API_KEY." });
        const sent = await countLog(acc, "code-send", 10);
        if (sent === null) return res.status(503).json({ error: "Manca il registro: esegui supabase_admin.sql in Supabase." });
        if (sent.length >= 3) return res.status(429).json({ error: "Hai già chiesto 3 codici: aspetta 10 minuti." });
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0"), nonce = crypto.randomBytes(9).toString("hex");
        const ok = await sendEmail(acc.email, "Codice Super Admin Rendrum: " + code,
          emailLayout("Codice di accesso", "Il tuo codice per aprire il pannello Super Admin è <b style=\"font-size:22px;letter-spacing:4px\">" + code + "</b><br>Vale 10 minuti. Se non sei stato tu, cambia subito la password.", "Apri il pannello", "https://" + (req.headers["x-forwarded-host"] || req.headers.host) + "/admin.html"));
        if (!ok) return res.status(502).json({ error: "Email non partita, riprova tra poco." });
        await logA(acc, "code-send", null, { nonce });
        setCookies(res, [ck(ADMC, sign({ sub: acc.id, h: hm(code + "|" + acc.id + "|" + nonce), n: nonce, exp: Date.now() + 10 * 60000 }), 600)]);
        return res.status(200).json({ ok: true, to: acc.email });
      }
      const fails = await countLog(acc, "code-fail", 15);
      if (fails === null) return res.status(503).json({ error: "Manca il registro: esegui supabase_admin.sql in Supabase." });
      if (fails.length >= 5) return res.status(429).json({ error: "Troppi codici sbagliati: aspetta 15 minuti." });
      const c = unsign(cookie(req, ADMC));
      const code = String(body.code || "").replace(/\D/g, "");
      if (!c || c.sub !== acc.id) return res.status(401).json({ error: "Codice scaduto: chiedine uno nuovo." });
      const used = await countLog(acc, "login", 15);
      if (used && used.some((x) => x.detail && x.detail.nonce === c.n)) return res.status(401).json({ error: "Codice già usato: chiedine uno nuovo." });
      if (code.length !== 6 || !same(hm(code + "|" + acc.id + "|" + c.n), c.h)) {
        await logA(acc, "code-fail", null, {});
        return res.status(401).json({ error: "Codice sbagliato." });
      }
      await logA(acc, "login", null, { nonce: c.n, ip: String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() });
      setCookies(res, [ck(ADM, sign({ sub: acc.id, v: Number(acc.session_version) || 0, exp: Date.now() + HOURS * 3600000 }), HOURS * 3600), ck(ADMC, "", 0)]);
      return res.status(200).json({ ok: true });
    }

    const g = await guard(req);
    if (g.err) return res.status(g.err[0]).json({ error: g.err[1], code: g.err[2] });
    const acc = g.acc;

    if (action === "dash") return res.status(200).json(await dash());

    if (action === "users") {
      const q = String(req.query.q || "").trim().toLowerCase().slice(0, 80);
      const f = String(req.query.f || "");
      const p = Math.max(0, parseInt(req.query.p, 10) || 0);
      let list = (await allAccounts()).map(slim);
      if (q) list = list.filter((u) => [u.email, u.nome, u.tel, u.citta, u.piva].some((x) => String(x || "").toLowerCase().includes(q)));
      if (f === "privato" || f === "professionista") list = list.filter((u) => u.tipo === f);
      if (["pagante", "prova", "gratis", "insoluto"].includes(f)) list = list.filter((u) => u.stato === f);
      if (f === "tester") list = list.filter((u) => u.tester);
      return res.status(200).json({ tot: list.length, p, lista: list.slice(p * 50, p * 50 + 50) });
    }
    if (action === "user") {
      const u = await userDetail(String(req.query.id || ""));
      return u ? res.status(200).json(u) : res.status(404).json({ error: "Utente non trovato." });
    }
    if (action === "user-credits" || action === "user-trial" || action === "user-tester") {
      if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
      const row = await oneAccount(body.id);
      if (!row) return res.status(404).json({ error: "Utente non trovato." });
      if (action === "user-credits") {
        const n = parseInt(body.n, 10);
        if (!n || Math.abs(n) > 500) return res.status(400).json({ error: "Scrivi un numero da -500 a 500 (non zero)." });
        if (!Object.prototype.hasOwnProperty.call(row, "credits")) return res.status(409).json({ error: "Manca la colonna dei crediti: esegui supabase_crediti.sql." });
        const cur = Number(row.credits) || 0, nuovo = Math.max(0, cur + n);
        const r = await patchAcc(row.id, "&credits=eq." + cur, { credits: nuovo });
        if (!r.ok || !Array.isArray(r.data) || !r.data.length) return res.status(409).json({ error: "I crediti sono cambiati proprio adesso: riprova." });
        await logA(acc, "crediti", row, { prima: cur, dopo: nuovo, n, nota: String(body.nota || "").slice(0, 200) });
        return res.status(200).json({ ok: true, crediti: nuovo });
      }
      if (action === "user-trial") {
        if (!Object.prototype.hasOwnProperty.call(row, "trial_used")) return res.status(409).json({ error: "Manca la colonna della prova: esegui supabase_crediti.sql." });
        const r = await patchAcc(row.id, "", { trial_start: new Date().toISOString(), trial_used: 0 });
        if (!r.ok) return res.status(502).json({ error: "Non riuscito, riprova." });
        await logA(acc, "prova", row, { prima: { usate: row.trial_used, inizio: row.trial_start }, giorni: trialOf(row).days, anteprime: trialOf(row).n });
        return res.status(200).json({ ok: true });
      }
      const on = body.on === true;
      if (!Object.prototype.hasOwnProperty.call(row, "is_tester")) return res.status(409).json({ error: "Manca la colonna tester: esegui supabase_admin.sql." });
      const r = await patchAcc(row.id, "", { is_tester: on });
      if (!r.ok) return res.status(502).json({ error: "Non riuscito, riprova." });
      await logA(acc, on ? "tester-si" : "tester-no", row, {});
      return res.status(200).json({ ok: true, tester: isBeta(Object.assign({}, row, { is_tester: on })) });
    }
    if (action === "subs") return res.status(200).json(await subs());
    if (action === "incassi") {
      const days = [7, 30, 90, 365].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
      try { return res.status(200).json(await incassi(days)); }
      catch (e) { return res.status(502).json({ error: "Stripe non risponde: " + (e.stripe || "riprova tra poco.") }); }
    }
    if (action === "log") {
      const r = await supabaseRequest("/rendrum_admin_log?select=created_at,admin_email,action,target_email,detail&action=not.in.(code-send)&order=created_at.desc&limit=150", { method: "GET" });
      return res.status(200).json({ lista: r.ok && Array.isArray(r.data) ? r.data : [] });
    }
    return res.status(400).json({ error: "Azione non valida" });
  } catch (e) {
    console.error("admin", action, e && e.message);
    return res.status(500).json({ error: "Errore del server, riprova." });
  }
};
module.exports._test = { sign, unsign, stato, slim, tipoPag };
