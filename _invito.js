// api/_invito.js — "Fai provare l'anteprima al cliente".
// L'artigiano manda al cliente un link (rendrum.com/?i=CODICE) su WhatsApp. Il cliente, senza
// registrarsi, crea l'anteprima SOLO del lavoro scelto dall'artigiano:
//  - la prima è in omaggio e si scala dalle anteprime dell'artigiano;
//  - poi compra pacchetti (PACK_N anteprime a PACK_CENTS, IVA inclusa) con Stripe;
//  - ogni anteprima finisce nella riga dell'invito, che l'artigiano vede nei suoi Progetti.
// Tutto sta in pro_extra (kind = "invito", token = codice del link): nessuna tabella nuova.
const { supabaseRequest } = require("./_auth-lib");

const PACK_N = 4, PACK_CENTS = 500, DAYS = 30;
const TOKEN = /^[a-f0-9]{20}$/;
// lavoro scelto dall'artigiano -> lavorazioni che il server accetta
const LAVORI = {
  resina: { n: "Pavimento in resina", ok: (m) => /^monolith/.test(m) },
  microcemento: { n: "Microcemento", ok: (m) => m === "microcemento" },
  piastrelle: { n: "Piastrelle", ok: (m) => m === "piastrelle" },
  pittura: { n: "Pittura interni", ok: (m, c) => m === "imbiancatura" && c !== "esterno" },
  facciata: { n: "Pittura della facciata", ok: (m, c) => m === "imbiancatura" && c === "esterno" },
  deco: { n: "Pareti decorate", ok: (m, c) => m === "imbiancatura" && c !== "esterno" },
  cartongesso: { n: "Cartongesso", ok: (m, c) => m === "imbiancatura" && c !== "esterno" },
  legno: { n: "Pavimento in legno", ok: (m) => ["parquet", "spc", "laminato"].includes(m) },
  scale: { n: "Scale", ok: (m) => m === "scale" },
  graniglia: { n: "Graniglia per esterni", ok: (m) => m === "graniglia_esterni" },
};
const missing = (r) => !r.ok && (r.status === 404 || (r.data && /42P01|does not exist/.test(JSON.stringify(r.data))));

async function find(t) {
  if (!TOKEN.test(String(t || ""))) return { error: "Link non valido." };
  const r = await supabaseRequest("/pro_extra?kind=eq.invito&token=eq." + t + "&select=*&limit=1", { method: "GET" }).catch(() => ({ ok: false }));
  if (missing(r)) return { error: "Questa funzione non è ancora attiva." };
  const row = r.ok && Array.isArray(r.data) ? r.data[0] : null;
  if (!row) return { error: "Link non valido o scaduto." };
  return { row };
}
function scaduto(d) { return !d.attivo || (d.scade && Date.parse(d.scade) < Date.now()); }
// Cambia i dati dell'invito solo se nessun altro l'ha cambiato nel frattempo (updated_at uguale).
async function update(row, fn) {
  for (let i = 0; i < 4; i++) {
    const d = Object.assign({}, row.data || {});
    const nd = fn(d);
    if (!nd) return null;
    const now = new Date(Date.now() + i).toISOString();
    const p = await supabaseRequest("/pro_extra?id=eq." + row.id + "&updated_at=eq." + encodeURIComponent(row.updated_at), { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ data: nd, updated_at: now }) }).catch(() => ({ ok: false }));
    if (p.ok && Array.isArray(p.data) && p.data[0]) return p.data[0];
    const g = await supabaseRequest("/pro_extra?id=eq." + row.id + "&select=*&limit=1", { method: "GET" }).catch(() => ({ ok: false }));
    row = g.ok && Array.isArray(g.data) && g.data[0]; if (!row) return null;
  }
  return null;
}
// Prenota un'anteprima: prima i crediti comprati, poi l'omaggio. -> { kind:"credito"|"omaggio", row } | null
async function reserve(row) {
  let kind = null;
  const saved = await update(row, (d) => {
    if ((+d.crediti || 0) > 0) { kind = "credito"; d.crediti = (+d.crediti || 0) - 1; return d; }
    if (d.omaggio && !d.omaggioUsato) { kind = "omaggio"; d.omaggioUsato = true; return d; }
    return null;
  });
  return saved ? { kind, row: saved } : null;
}
async function release(row, kind) {
  return update(row, (d) => { if (kind === "credito") d.crediti = (+d.crediti || 0) + 1; else d.omaggioUsato = false; return d; });
}
async function addResult(row, item) {
  return update(row, (d) => { d.anteprime = (Array.isArray(d.anteprime) ? d.anteprime : []).concat([item]).slice(-40); return d; });
}
// Pagamento confermato da Stripe: aggiunge il pacchetto una sola volta per pagamento.
async function addPack(t, sessionId, n) {
  const f = await find(t); if (!f.row) return false;
  if ((f.row.data.pagamenti || []).includes(sessionId)) return "dup";
  const out = await update(f.row, (d) => {
    const P = Array.isArray(d.pagamenti) ? d.pagamenti : [];
    if (P.includes(sessionId)) return null;
    d.pagamenti = P.concat([sessionId]).slice(-50);
    d.crediti = (+d.crediti || 0) + n; d.comprate = (+d.comprate || 0) + n;
    return d;
  });
  return out ? "ok" : false;
}
function publicView(row, acc) {
  const d = row.data || {}, L = LAVORI[d.lavoro] || LAVORI.pittura;
  return {
    impresa: (acc && acc.company_name) || "", logo: (acc && acc.logo_url) || null, telefono: (acc && acc.phone) || "",
    cliente: d.cliente || "", lavoro: d.lavoro || "pittura", lavoroNome: L.n,
    omaggio: !!(d.omaggio && !d.omaggioUsato), crediti: +d.crediti || 0, scaduto: !!scaduto(d),
    anteprime: (d.anteprime || []).map((a) => ({ url: a.url, titolo: a.titolo || "", at: a.at })),
    pacchetto: { n: PACK_N, euro: PACK_CENTS / 100 },
  };
}
module.exports = { PACK_N, PACK_CENTS, DAYS, TOKEN, LAVORI, find, scaduto, reserve, release, addResult, addPack, publicView };
