// api/_auth-lib.js
// Funzioni condivise dai 4 endpoint di login/registrazione account
// (auth-register.js, auth-login.js, auth-logout.js, auth-me.js).
// Gli account possono essere di due tipi — "professionista" o "privato" —
// ma condividono la stessa tabella, lo stesso login e gli stessi 3 piani
// a pagamento (Basic/Medium/Pro): è il campo account_type a distinguerli.
//
// NOTA IMPORTANTE SU VERCEL: i file dentro "api/" diventano automaticamente
// degli indirizzi web (es. api/auth-login.js → /api/auth-login). Questo file
// inizia con "_" apposta: Vercel NON lo trasforma in un indirizzo pubblico,
// resta solo una libreria di supporto importata dagli altri file con require().
//
// COSA SERVE PER FAR FUNZIONARE IL LOGIN (da fare una volta sola)
// 1. Crea un account gratuito su https://supabase.com e crea un nuovo progetto.
// 2. Nel progetto, vai su "SQL Editor" e incolla/esegui questo comando per
//    creare la tabella che contiene TUTTI gli account (professionisti E
//    privati — sono nella stessa tabella, distinti dal campo account_type):
//
//      create table pro_accounts (
//        id uuid primary key default gen_random_uuid(),
//        email text unique not null,
//        password_hash text not null,
//        password_salt text not null,
//        account_type text not null default 'professionista'
//          check (account_type in ('professionista','privato')),
//        company_name text,
//        piva text,
//        phone text,
//        tier text not null default 'basic' check (tier in ('basic','medium','pro','promax')),
//        logo_url text,
//        created_at timestamptz not null default now()
//      );
//
//    Nota su "company_name": per i professionisti contiene la ragione
//    sociale; per i privati contiene semplicemente nome e cognome. Il campo
//    non è più obbligatorio a livello di database (NOT NULL rimosso) perché
//    entrambi i tipi di account lo valorizzano comunque dal form, ma così il
//    database non blocca nulla se in futuro cambia la logica.
//
//    SE LA TABELLA "pro_accounts" ESISTE GIA' (creata prima che i privati
//    potessero registrarsi), esegui invece questi due comandi per aggiornarla
//    senza perdere gli account già creati:
//
//      alter table pro_accounts add column if not exists account_type text
//        not null default 'professionista'
//        check (account_type in ('professionista','privato'));
//      alter table pro_accounts alter column company_name drop not null;
//
// 3. Vai su "Project Settings" → "API": copia l'indirizzo "Project URL" e la
//    chiave segreta "service_role" (NON la "anon public", quella è diversa).
// 4. Su Vercel, in "Settings > Environment Variables" del progetto, aggiungi:
//      SUPABASE_URL = l'indirizzo copiato al punto 3
//      SUPABASE_SERVICE_KEY = la chiave "service_role" copiata al punto 3
//      JWT_SECRET = una password lunga e a caso, a scelta tua (serve solo per
//                   firmare la sessione di accesso, tienila segreta e non
//                   cambiarla più una volta scelta, altrimenti tutti gli
//                   utenti già loggati verrebbero disconnessi)
// 5. Fai il deploy. Da quel momento login e registrazione funzionano davvero.
//
// Finché questi passaggi non sono fatti, le funzioni sotto restituiscono un
// errore chiaro ("Servizio account non configurato") invece di andare in crash.

const crypto = require("crypto");

function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = (process.env.SUPABASE_SERVICE_KEY || "").trim();
  const jwtSecret = (process.env.JWT_SECRET || "").trim();
  return { url, key, jwtSecret, configured: Boolean(url && key && jwtSecret) };
}

// Chiama la REST API di Supabase (PostgREST) sulla tabella pro_accounts.
async function supabaseRequest(path, options) {
  const { url, key } = getSupabaseConfig();
  const response = await fetch(url + "/rest/v1" + path, {
    ...options,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...(options && options.headers ? options.headers : {}),
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

// Password: scrypt con salt casuale, confronto a tempo costante.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}
function verifyPassword(password, salt, expectedHash) {
  const computed = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Sessione: un token firmato "fatto in casa" (stile JWT, senza librerie
// esterne): base64url(payload) + "." + firma HMAC-SHA256(payload, JWT_SECRET).
function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(input) {
  input = input.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4) input += "=";
  return Buffer.from(input, "base64").toString("utf8");
}
function signSession(payloadObj) {
  const { jwtSecret } = getSupabaseConfig();
  const payload = base64url(JSON.stringify(payloadObj));
  const sig = base64url(crypto.createHmac("sha256", jwtSecret).update(payload).digest());
  return payload + "." + sig;
}
function verifySession(token) {
  try {
    const { jwtSecret } = getSupabaseConfig();
    const parts = (token || "").split(".");
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expectedSig = base64url(crypto.createHmac("sha256", jwtSecret).update(payload).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(base64urlDecode(payload));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (e) {
    return null;
  }
}

const COOKIE_NAME = "dgm_session";
const SESSION_DAYS = 30;

function setSessionCookie(res, userId, version) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const token = signSession({ sub: userId, exp, v: version || 0 });
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}
function readSessionCookie(req) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map(function (p) { return p.trim(); });
  for (const p of parts) {
    if (p.indexOf(COOKIE_NAME + "=") === 0) {
      return p.slice(COOKIE_NAME.length + 1);
    }
  }
  return null;
}

// Toglie i campi sensibili prima di restituire l'utente al frontend.
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    accountType: row.account_type || "professionista",
    companyName: row.company_name,
    piva: row.piva,
    phone: row.phone,
    tier: row.tier,
    logoUrl: row.logo_url,
    subscriptionStatus: row.subscription_status || "none",
    usageMonth: row.usage_month || null,
    usageCount: row.usage_month === monthKey() ? (row.usage_count || 0) : 0,
    usageLimit: (PLAN_LIMITS[row.tier] || 0) + carryOver(row),
    carry: carryOver(row),
    yearly: row.billing_interval === "year",
    // piani nuovi e pacchetti per tutti (su Vercel PIANI_TUTTI=1); senza, solo gli account di prova
    pianiAll: String(process.env.PIANI_TUTTI || "").trim() === "1",
    paymentsEnabled: paymentsEnabled(),
    // generazioni senza limite (account di prova di Rendrum e quelli messi su Vercel in TEST_EMAILS / RD_UNLIMITED_EMAILS)
    unlimited: unlimitedEmail(row.email),
    // novita' attive (account registrati fino al 14/10/2026 + staff)
    tester: isBeta(row),
    // pannello Super Admin (solo email in RD_ADMIN_EMAILS)
    admin: isAdminEmail(row.email),
    // Accesso con Google/Apple (colonne di supabase_accesso_social.sql; assenti = valori di sempre)
    passwordSet: row.password_set !== false,
    needsOnboarding: row.needs_onboarding === true,
    social: { google: !!row.google_sub, apple: !!row.apple_sub },
    // Crediti comprati e prova gratuita settimanale (colonne di supabase_crediti.sql; assenti = null)
    credits: row.credits == null ? null : Number(row.credits) || 0,
    trial: row.trial_used == null ? null : {
      used: Number(row.trial_used) || 0,
      limit: trialOf(row).n,
      endsAt: row.trial_start ? new Date(Date.parse(row.trial_start) + trialOf(row).days * 86400000).toISOString() : null,
    },
  };
}

// Piani a pagamento (prezzi in centesimi di euro al mese, IVA esclusa) e
// anteprime AI incluse ogni mese. Valgono sia per i privati sia per i
// professionisti. Per cambiare un prezzo basta modificarlo qui.
// Annuale = 11 mesi (1 mese gratis). Pro Max: anteprime anche in 4K (una in 4K conta 2).
const PLANS = {
  basic:  { name: "Rendrum Basic",   priceCents: 1390,  yearCents: 15290,  images: 10 },
  medium: { name: "Rendrum Medium",  priceCents: 4890,  yearCents: 53790,  images: 35 },
  pro:    { name: "Rendrum Pro",     priceCents: 8290,  yearCents: 91190,  images: 60 },
  promax: { name: "Rendrum Pro Max", priceCents: 16490, yearCents: 181390, images: 120, k4: true },
};
const PLAN_LIMITS = {};
Object.keys(PLANS).forEach(function (k) { PLAN_LIMITS[k] = PLANS[k].images; });
// Pacchetti di anteprime in più: pagamento singolo, non scadono mai.
// Professionisti: prezzi IVA esclusa. Privati: prezzi IVA inclusa.
const PACKS = {
  professionista: [{ n: 20, cents: 2790 }, { n: 50, cents: 6990 }, { n: 100, cents: 13990 }],
  privato:        [{ n: 5, cents: 890 },   { n: 10, cents: 1690 }, { n: 25, cents: 4190 }],
};
// Prova gratuita (senza carta): professionisti 14 giorni / 10 anteprime, privati 7 giorni / 5.
const TRIAL = { professionista: { days: 14, n: 10 }, privato: { days: 7, n: 5 } };
function trialOf(row) { return (row && row.account_type === "privato") ? TRIAL.privato : TRIAL.professionista; }
function monthKey(d) { return (d || new Date()).toISOString().slice(0, 7); }
function prevMonthKey() { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return monthKey(d); }
// Anteprime del mese scorso non usate: passano a questo mese (solo per un mese).
// Servono le colonne bonus_month / bonus_n (supabase_piani.sql): senza, niente riporto.
function carryOver(row) {
  if (!row || !Object.prototype.hasOwnProperty.call(row, "bonus_n")) return 0;
  const cur = monthKey();
  if (row.bonus_month === cur) return Math.max(0, Number(row.bonus_n) || 0);
  if (row.usage_month === prevMonthKey()) return Math.max(0, (PLAN_LIMITS[row.tier] || 0) - (Number(row.usage_count) || 0));
  return 0;
}

// I pagamenti sono attivi solo quando su Vercel c'è STRIPE_SECRET_KEY: finché
// manca, l'app continua a funzionare come prima (anteprime libere).
function unlimitedEmail(e) {
  const list = ["prova@rendrum.com", "provalo@rendrum.com", "info@rendrum.com", "info@dgmresine.com"]
    .concat(String(process.env.TEST_EMAILS || "").split(","), String(process.env.RD_UNLIMITED_EMAILS || "").split(","))
    .map(x => String(x).trim().toLowerCase()).filter(Boolean);
  return list.includes(String(e || "").trim().toLowerCase());
}
// Account "beta": vedono tutte le novita' dell'app. Sono lo staff e tutti gli account
// registrati prima di BETA_FINO (su Vercel si puo' cambiare la data con BETA_FINO, o aggiungere email in BETA_EMAILS).
function isBeta(row) {
  if (!row) return false;
  if (row.is_tester === true) return true; // messo dal pannello Super Admin
  if (isAdminEmail(row.email)) return true; // il Super Admin vede tutte le novita'
  const e = String(row.email || "").trim().toLowerCase();
  const extra = ["info@dgmresine.com", "prova@rendrum.com"].concat(String(process.env.BETA_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean));
  if (extra.includes(e)) return true;
  const fino = Date.parse(String(process.env.BETA_FINO || "").trim() || "2026-10-15T00:00:00+02:00");
  const c = Date.parse(row.created_at || "");
  return !!(c && fino && c < fino);
}
// Super Admin: solo le email messe su Vercel in RD_ADMIN_EMAILS (separate da virgola).
function adminEmails() { return String(process.env.RD_ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean); }
function isAdminEmail(e) { const x = String(e || "").trim().toLowerCase(); return !!x && adminEmails().includes(x); }
function paymentsEnabled() { return Boolean((process.env.STRIPE_SECRET_KEY || "").trim()); }

// Chiamata alla REST API di Stripe (form-encoded), senza librerie esterne.
function toForm(obj, prefix, out) {
  out = out || [];
  Object.keys(obj).forEach(function (k) {
    const v = obj[k]; if (v === undefined || v === null) return;
    const key = prefix ? prefix + "[" + k + "]" : k;
    if (typeof v === "object") toForm(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  });
  return out;
}
async function stripeRequest(method, path, params) {
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  const r = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? toForm(params).join("&") : undefined,
  });
  const data = await r.json().catch(function () { return null; });
  return { ok: r.ok, status: r.status, data };
}

// Email (Resend). La conferma dell'email è obbligatoria solo quando su Vercel
// c'è RESEND_API_KEY, così nessuno resta bloccato se le email non partono.
function emailEnabled() { return Boolean((process.env.RESEND_API_KEY || "").trim()); }
async function sendEmail(to, subject, html) {
  const key = (process.env.RESEND_API_KEY || "").trim();
  const from = (process.env.EMAIL_FROM || "Rendrum <onboarding@resend.dev>").trim();
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  return r.ok;
}
function emailLayout(title, text, buttonLabel, url) {
  return '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1C1B18">'
    + '<h2 style="margin:0 0 12px">' + title + '</h2>'
    + '<p style="font-size:15px;line-height:1.5">' + text + '</p>'
    + '<p style="margin:24px 0"><a href="' + url + '" style="background:#D9824B;color:#1A1006;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;display:inline-block">' + buttonLabel + '</a></p>'
    + '<p style="font-size:12px;color:#6B6558">Se il pulsante non funziona copia questo indirizzo nel browser:<br>' + url + '</p>'
    + '<p style="font-size:12px;color:#6B6558">Rendrum S.r.l.s. · Gallarate (VA) · info@rendrum.com</p></div>';
}
function siteOrigin(req) {
  return (req.headers["x-forwarded-proto"] || "https") + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
}
function newToken() { return crypto.randomBytes(24).toString("hex"); }
async function sendVerifyEmail(req, email, token) {
  const url = siteOrigin(req) + "/api/auth-email?action=verify&token=" + token;
  return sendEmail(email, "Conferma il tuo account Rendrum",
    emailLayout("Benvenuto in Rendrum!", "Per attivare il tuo account conferma il tuo indirizzo email cliccando il pulsante qui sotto.", "Conferma email", url));
}

// Legge l'account della sessione corrente (o null).
async function currentAccount(req) {
  const { configured } = getSupabaseConfig();
  if (!configured) return null;
  const token = readSessionCookie(req);
  const session = token ? verifySession(token) : null;
  if (!session || !session.sub) return null;
  const found = await supabaseRequest("/pro_accounts?id=eq." + encodeURIComponent(session.sub) + "&select=*", { method: "GET" });
  const row = found.ok && Array.isArray(found.data) && found.data[0] ? found.data[0] : null;
  return row && sessionMatches(session, row) ? row : null;
}
// Dopo un cambio password le sessioni vecchie (altri dispositivi) non valgono più.
function sessionMatches(session, row) {
  return (Number(row.session_version) || 0) === (Number(session.v) || 0);
}

module.exports = {
  getSupabaseConfig,
  supabaseRequest,
  hashPassword,
  verifyPassword,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  verifySession,
  publicUser,
  PLANS,
  PLAN_LIMITS,
  PACKS,
  TRIAL,
  trialOf,
  monthKey,
  prevMonthKey,
  carryOver,
  paymentsEnabled,
  isBeta,
  isAdminEmail,
  adminEmails,
  stripeRequest,
  currentAccount,
  sessionMatches,
  emailEnabled,
  sendEmail,
  emailLayout,
  siteOrigin,
  newToken,
  sendVerifyEmail,
};
