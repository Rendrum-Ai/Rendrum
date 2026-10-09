// api/_plan.js
// Planimetria -> misure (in prova). Legge il disegno con l'AI e restituisce, piano per piano,
// i m² di pavimento, pareti e plafone. Non inventa: ogni numero dice da dove arriva.
//   POST /api/quotes?action=pl-read  { image: "data:image/jpeg;base64,..." }
//   -> { piani:[{ nome, pavimento:{mq,fonte,calcolo}, pareti:{...}, plafone:{...}, altezze:[...] }], mancanti:[...], avvisi:[...] }

const MAX_B64 = 6 * 1024 * 1024;
const FONTI = ["scritto", "calcolato", "stimato"];

const PROMPT = `Sei un geometra italiano. Ti mando la foto o la scansione di una planimetria (può avere più piani, note scritte, quote, altezze "h").
Devi ricavare SOLO tre misure per ogni piano o zona: m² di PAVIMENTO, m² di PARETI (da imbiancare, interne), m² di PLAFONE (soffitto).

Regole importanti:
- Usa i numeri SCRITTI sul disegno: note (es. "superficie pavimento PT: mq 58,27"), quote, m² delle stanze, altezze (h 270 = 2,70 m), perimetri (ml).
- Se una nota dà un calcolo (es. "imbiancatura pt: ml 37,80 x 2,70 + 5,00 x 1,10 x 2"), riportalo nel campo "calcolo" usando solo numeri con il punto decimale e i simboli + - * / ( ). Esempio: "37.80*2.70+5.00*1.10*2".
- Se le pareti non sono scritte ma conosci perimetro e altezza, calcola perimetro*altezza e scrivi il calcolo.
- Molte piante hanno le misure dei lati scritte vicino ai muri di ogni stanza, in centimetri (es. "370" e "330" = stanza 3,70 × 3,30 m). In quel caso calcola il pavimento di ogni stanza (lato × lato) e somma tutte le stanze dello stesso piano: nel campo "calcolo" scrivi la somma, es. "3.70*3.30+3.70*3.30+2.25*5.20". Per le stanze non rettangolari usa i lati che vedi; se un lato manca, salta quella stanza e scrivila in "mancanti".
- Le misure di porte e finestre (es. "80/210", "120/130") NON sono misure delle stanze: ignorale per i pavimenti.
- Se l'altezza dei locali non è scritta, le pareti mettile null e aggiungi in "mancanti": "altezza dei locali".
- Se una zona ha solo le pareti (es. "parte alta"), mettila come piano a sé con pavimento e plafone a null.
- NON misurare col righello sul disegno e NON inventare. Se un numero non c'è, metti null e aggiungi una riga in "mancanti" (es. "Piano interrato: m² del pavimento").
- Metti comunque nella lista ogni piano o locale che vedi (es. "Piano interrato" con la cantina), anche se tutti i suoi numeri sono null.
- Il plafone di solito non è scritto: mettilo null (l'app userà il pavimento).
- "fonte": "scritto" se il numero è scritto sul disegno, "calcolato" se l'hai ottenuto con un calcolo da numeri scritti, "stimato" solo se l'hai dedotto in altro modo (evitalo).
- Nomi dei piani brevi in italiano: "Piano terra", "Piano primo", "Piano interrato", "Parte alta"...
- In "avvisi" metti in una frase breve cose utili per l'artigiano (es. "Sui muri non ci sono quote: le singole stanze non si possono misurare").

Rispondi SOLO con un JSON così:
{"piani":[{"nome":"Piano terra","pavimento":{"mq":58.27,"fonte":"scritto","calcolo":""},"pareti":{"mq":113.06,"fonte":"calcolato","calcolo":"37.80*2.70+5.00*1.10*2"},"plafone":{"mq":null,"fonte":"","calcolo":""},"altezze":[2.7,7.6]}],"mancanti":["..."],"avvisi":["..."]}`;

function str(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001F]/g, " ").trim().slice(0, max); }
function round2(n) { return Math.round(n * 100 + 1e-6) / 100; }

// calcolo sicuro: solo numeri e + - * / ( )
function evalCalc(c) {
  let s = String(c || "").replace(/[x×X]/g, "*").replace(/,/g, ".").replace(/\s+/g, "");
  if (!s || s.length > 300 || !/^[0-9+\-*/().]+$/.test(s)) return null;
  try { const v = Function('"use strict";return (' + s + ")")(); return (typeof v === "number" && isFinite(v) && v > 0) ? round2(v) : null; } catch (e) { return null; }
}

function cleanMis(m, avvisi, label) {
  m = (m && typeof m === "object") ? m : {};
  let mq = Number(m.mq);
  mq = (isFinite(mq) && mq > 0 && mq < 100000) ? round2(mq) : null;
  const calcolo = str(m.calcolo, 300);
  const ev = calcolo ? evalCalc(calcolo) : null;
  if (ev != null) {
    if (mq != null && Math.abs(ev - mq) > Math.max(0.05, mq * 0.01)) avvisi.push(label + ": rifatto il conto, " + String(ev).replace(".", ",") + " m² invece di " + String(mq).replace(".", ",") + ".");
    mq = ev;
  }
  let fonte = FONTI.indexOf(m.fonte) >= 0 ? m.fonte : (mq != null ? "stimato" : "");
  if (ev != null && fonte === "stimato") fonte = "calcolato";
  return { mq, fonte: mq != null ? fonte : "", calcolo: ev != null ? calcolo : "", verificato: ev != null };
}

function clean(d) {
  d = (d && typeof d === "object") ? d : {};
  const avvisi = (Array.isArray(d.avvisi) ? d.avvisi : []).map(x => str(x, 200)).filter(Boolean).slice(0, 8);
  const piani = (Array.isArray(d.piani) ? d.piani : []).slice(0, 8).map((p, i) => {
    const nome = str(p && p.nome, 40) || ("Zona " + (i + 1));
    return {
      nome,
      pavimento: cleanMis(p && p.pavimento, avvisi, nome + " pavimento"),
      pareti: cleanMis(p && p.pareti, avvisi, nome + " pareti"),
      plafone: cleanMis(p && p.plafone, avvisi, nome + " plafone"),
      altezze: (Array.isArray(p && p.altezze) ? p.altezze : []).map(Number).filter(h => isFinite(h) && h > 0 && h < 30).slice(0, 6),
    };
  });
  const mancanti = (Array.isArray(d.mancanti) ? d.mancanti : []).map(x => str(x, 120)).filter(Boolean).slice(0, 8);
  return { piani, mancanti, avvisi };
}

function aiErr(status, body) {
  const t = String(body || "");
  if (status === 429 && /insufficient_quota|billing|credit/i.test(t)) return { code: "credito", msg: "Il credito dell'intelligenza artificiale è finito: va ricaricato." };
  if (status === 429) return { code: "troppe", msg: "Troppe richieste in questo momento: riprova tra un minuto." };
  if (status === 401) return { code: "chiave", msg: "La chiave dell'intelligenza artificiale non è valida." };
  if (status === 404 || /model_not_found|does not exist/i.test(t)) return { code: "modello", msg: "Modello AI non disponibile." };
  if (status === 400 && /image/i.test(t)) return { code: "immagine", msg: "Il disegno non si riesce ad aprire: prova con una foto più nitida." };
  return { code: "ai", msg: "Non riesco a leggere il disegno adesso. Riprova tra poco." };
}
async function ask(key, model, image) {
  const ctl = new AbortController(), tm = setTimeout(function () { ctl.abort(); }, 55000);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal: ctl.signal,
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, temperature: 0, response_format: { type: "json_object" },
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: image, detail: "high" } }] }],
      }),
    });
    return { status: r.status, ok: r.ok, text: await r.text() };
  } catch (e) {
    return { status: 0, ok: false, text: e && e.name === "AbortError" ? "timeout" : String(e && e.message || e) };
  } finally { clearTimeout(tm); }
}
async function read(image) {
  const key = (process.env.OPENAI_API_KEY || "").trim();
  if (!key) { const e = new Error("no key"); e.code = 500; throw e; }
  let model = (process.env.PLAN_MODEL || "gpt-4.1").trim();
  let r = await ask(key, model, image);
  if (!r.ok && (r.status === 404 || /model_not_found|does not exist/i.test(r.text)) && model !== "gpt-4o") { model = "gpt-4o"; r = await ask(key, model, image); }
  if (!r.ok) {
    console.error("plan openai", r.status, String(r.text).slice(0, 500));
    const x = r.status === 0 ? (r.text === "timeout" ? { code: "tempo", msg: "Il disegno ci mette troppo a essere letto: riprova, o carica una foto più leggera." } : { code: "rete", msg: "Non riesco a raggiungere il servizio AI. Riprova tra poco." }) : aiErr(r.status, r.text);
    const e = new Error(x.msg); e.code = 502; e.ai = x; throw e;
  }
  let j; try { j = JSON.parse(r.text); } catch (e) { j = {}; }
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  let d; try { d = JSON.parse(c || "{}"); } catch (e) { d = {}; }
  return clean(d);
}

const STAFF = ["info@dgmresine.com", "prova@rendrum.com"];
async function handle(req, res, action, acc) {
  if (action !== "pl-read") return res.status(400).json({ error: "Azione non valida" });
  if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
  const img = String((req.body || {}).image || "");
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > MAX_B64) return res.status(400).json({ error: "Carica una foto o un PDF del disegno (massimo 4 MB)." });
  try {
    const out = await read(img);
    if (!out.piani.length) return res.status(200).json(Object.assign(out, { vuoto: true }));
    return res.status(200).json(out);
  } catch (e) {
    if (e.code === 500) return res.status(500).json({ error: "Lettura dei disegni non attiva sul server." });
    const staff = acc && STAFF.includes(String(acc.email || "").toLowerCase());
    const x = e.ai || { code: "ai", msg: "Non riesco a leggere il disegno adesso. Riprova tra poco." };
    // il motivo vero lo vede solo il titolare; agli artigiani un messaggio semplice
    const pub = (x.code === "credito" || x.code === "chiave" || x.code === "modello") ? "La lettura dei disegni non è disponibile in questo momento. Riprova più tardi." : x.msg;
    return res.status(502).json({ error: staff ? x.msg : pub, code: x.code });
  }
}

module.exports = { handle, _test: { evalCalc, clean } };
