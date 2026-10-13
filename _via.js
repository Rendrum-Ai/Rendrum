// api/_via.js — ricerca della via mentre si scrive (OpenStreetMap, servizio Photon di komoot: gratis, senza chiave).
//   GET /api/quotes?action=vi-cerca&q=largo camussi  ->  { vie: [{ t:"Largo Camussi 3", s:"21013 Gallarate VA", full:"Largo Camussi 3, 21013 Gallarate VA" }] }
// Se il servizio non risponde, l'app lascia scrivere l'indirizzo a mano.
const PROV = {};
try { require("./_geo").GEO.IT.regions.forEach(function (r) { r.provinces.forEach(function (x) { PROV[x[1]] = x[0]; PROV["Provincia di " + x[1]] = x[0]; }); }); } catch (e) {}
PROV["Monza e Brianza"] = PROV["Monza e Brianza"] || "MB"; PROV["Forlì-Cesena"] = PROV["Forlì-Cesena"] || "FC";
async function handle(req, res, action) {
  if (action !== "vi-cerca") return res.status(400).json({ error: "Azione non valida" });
  const q = String((req.query && req.query.q) || "").replace(/[\u0000-\u001F]/g, "").trim().slice(0, 120);
  if (q.length < 3) return res.status(200).json({ vie: [] });
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch("https://photon.komoot.io/api/?lang=it&limit=10&lat=42.5&lon=12.5&q=" + encodeURIComponent(q), { signal: ctl.signal, headers: { "User-Agent": "Rendrum (rendrum.com)" } });
    if (!r.ok) return res.status(200).json({ vie: [], off: true });
    const j = await r.json();
    const seen = {}, out = [];
    (j.features || []).forEach(function (f) {
      const p = f.properties || {};
      if (p.countrycode && ["IT", "SM", "VA"].indexOf(p.countrycode) < 0) return;
      const via = p.street || (p.osm_key === "highway" || p.type === "street" ? p.name : "") || "";
      if (!via) return;
      const t = (via + (p.housenumber ? " " + p.housenumber : "")).trim();
      const citta = p.city || p.town || p.village || p.locality || p.district || "";
      const pr = PROV[p.county] || PROV[p.state] || "";
      const s = [p.postcode, citta, pr].filter(Boolean).join(" ");
      const full = t + (s ? ", " + s : "");
      if (seen[full.toLowerCase()]) return; seen[full.toLowerCase()] = 1;
      out.push({ t: t, s: s, full: full, cap: p.postcode || "", comune: citta, prov: pr });
    });
    return res.status(200).json({ vie: out.slice(0, 6) });
  } catch (e) {
    return res.status(200).json({ vie: [], off: true });
  } finally { clearTimeout(tm); }
}
module.exports = { handle };
