// api/_camp.js — Campionario: schede tecniche dei prodotti.
//   GET  /api/quotes?action=cs-list                       -> { schede: [{ key, nome, url, at }] }   (tutti i professionisti)
//   POST /api/quotes?action=cs-upload  { key, nome, dataUrl } -> carica il PDF (solo account Rendrum)
//   POST /api/quotes?action=cs-delete  { key }               -> toglie la scheda (solo account Rendrum)
// Le schede stanno in pro_extra (kind "scheda", token = chiave del prodotto): nessuna tabella nuova.
// I PDF vanno nello stesso archivio delle foto (project-photos/schede).
const crypto = require("crypto");
const { supabaseRequest, getSupabaseConfig } = require("./_auth-lib");
const STAFF = ["info@dgmresine.com", "prova@rendrum.com"];
const KEY = /^[a-z0-9_]{2,40}$/;
const isStaff = (acc) => STAFF.includes(String((acc && acc.email) || "").toLowerCase());
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001F<>]/g, "").trim().slice(0, n);

async function uploadPdf(dataUrl, key) {
  const m = String(dataUrl || "").match(/^data:application\/pdf;base64,(.+)$/);
  if (!m) return { error: "Carica un file PDF." };
  if (m[1].length > 4_300_000) return { error: "Il PDF è troppo grande: massimo 3 MB. Riducilo o caricane solo le pagine tecniche." };
  const buf = Buffer.from(m[1], "base64");
  if (buf.slice(0, 5).toString() !== "%PDF-") return { error: "Il file non è un PDF valido." };
  const { url, key: sk } = getSupabaseConfig();
  const path = "schede/" + key + "-" + crypto.randomBytes(6).toString("hex") + ".pdf";
  const r = await fetch(url + "/storage/v1/object/project-photos/" + path, { method: "POST", headers: { Authorization: "Bearer " + sk, apikey: sk, "Content-Type": "application/pdf", "x-upsert": "true" }, body: buf }).catch(() => null);
  if (!r || !r.ok) return { error: "Caricamento non riuscito. Riprova." };
  return { url: url + "/storage/v1/object/public/project-photos/" + path, size: buf.length };
}

async function handle(req, res, action, acc) {
  if (action === "cs-list") {
    const r = await supabaseRequest("/pro_extra?kind=eq.scheda&select=token,data,updated_at&order=updated_at.desc&limit=500", { method: "GET" });
    if (!r.ok) return res.status(502).json({ error: "Non riesco a caricare le schede." });
    const seen = {}, out = [];
    (r.data || []).forEach(function (x) { if (!x.token || seen[x.token]) return; seen[x.token] = 1; out.push({ key: x.token, nome: (x.data && x.data.nome) || "", url: (x.data && x.data.url) || "", at: x.updated_at }); });
    return res.status(200).json({ schede: out.filter(function (s) { return /^https:\/\//.test(s.url); }) });
  }
  if (!isStaff(acc)) return res.status(403).json({ error: "Solo gli account Rendrum possono caricare le schede." });
  if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
  const b = req.body || {}, key = String(b.key || "");
  if (!KEY.test(key)) return res.status(400).json({ error: "Prodotto non valido." });
  if (action === "cs-upload") {
    const up = await uploadPdf(b.dataUrl, key);
    if (up.error) return res.status(400).json({ error: up.error });
    const data = { nome: str(b.nome, 120), url: up.url, size: up.size };
    const now = new Date().toISOString();
    const g = await supabaseRequest("/pro_extra?kind=eq.scheda&token=eq." + key + "&select=id", { method: "GET" });
    const row = g.ok && Array.isArray(g.data) && g.data[0];
    const w = row
      ? await supabaseRequest("/pro_extra?id=eq." + row.id, { method: "PATCH", body: JSON.stringify({ data, updated_at: now }) })
      : await supabaseRequest("/pro_extra", { method: "POST", body: JSON.stringify([{ id: crypto.randomUUID(), account_id: acc.id, kind: "scheda", token: key, data, updated_at: now }]) });
    if (!w.ok) return res.status(502).json({ error: "Salvataggio non riuscito. Riprova." });
    return res.status(200).json({ ok: true, scheda: { key, nome: data.nome, url: data.url, at: now } });
  }
  if (action === "cs-delete") {
    const d = await supabaseRequest("/pro_extra?kind=eq.scheda&token=eq." + key, { method: "DELETE" });
    if (!d.ok) return res.status(502).json({ error: "Non riesco a togliere la scheda." });
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: "Azione non valida" });
}
module.exports = { handle, _test: { isStaff } };
