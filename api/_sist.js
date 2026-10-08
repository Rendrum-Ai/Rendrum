// api/_sist.js — Cappotto termico (facciate) e cartongesso (interni) nell'anteprima AI.
// Il browser manda solo codici: i testi per l'AI stanno qui, così nessuno scrive testo libero nel prompt.

const GRANA = {
  fine: "intonachino di finitura a grana FINE (circa 1 mm): superficie uniforme, leggermente ruvida e opaca, granulosità appena percepibile da vicino",
  media: "intonachino di finitura a grana MEDIA (circa 1,5 mm): superficie uniforme, ruvida e opaca, granulosità visibile ma regolare",
  liscia: "rasatura di finitura LISCIA: superficie uniforme, piana e opaca, senza granulosità",
};
function parseCapp(c) {
  if (!c || typeof c !== "object") return null;
  return { grana: GRANA[c.grana] ? c.grana : "fine", zoc: c.zoc === "si" };
}
// nota da aggiungere al prompt della facciata quando c'è il cappotto
function cappNote(c, zocColor) {
  if (!c) return "";
  return " CAPPOTTO TERMICO: la facciata è stata rifatta con un cappotto termico appena posato. Tutte le pareti esterne intonacate visibili hanno ora una superficie NUOVA, perfettamente planare e uniforme, senza crepe, macchie, distacchi, rappezzi o vecchi segni, con " + GRANA[c.grana] + ", nel colore indicato." +
    " Gli spigoli degli angoli e delle aperture sono dritti e netti; finestre e porte restano esattamente dove sono, con la stessa forma, ma appaiono più incassate (spallette più profonde di circa 12–15 cm) e con davanzali nuovi un po' più sporgenti." +
    (c.zoc ? " Alla base della facciata c'è una ZOCCOLATURA alta circa 60–80 cm, continua e dritta, in un tono " + (zocColor ? zocColor : "più scuro dello stesso colore") + ", con un sottile profilo di separazione." : "") +
    " Non cambiare tetto, serramenti, ringhiere, vegetazione, cielo, inquadratura né l'architettura della casa: cambia solo la superficie delle pareti esterne.";
}

const CG_TIPO = {
  veletta: "una VELETTA in cartongesso lungo il soffitto: una fascia ribassata di circa 25–35 cm di altezza e 40–60 cm di profondità, che corre lungo il soffitto nel punto indicato, con spigoli dritti e superficie liscia",
  soffitto: "un CONTROSOFFITTO in cartongesso ribassato di circa 10–15 cm su tutto il soffitto della stanza, superficie liscia e continua, perimetro pulito con una sottile gola d'ombra lungo le pareti",
  nicchia: "una NICCHIA rettangolare incassata in una controparete in cartongesso sulla parete indicata, larga circa 120–160 cm e alta circa 50–70 cm, profonda circa 15–20 cm, con spigoli netti, posizionata a un'altezza naturale (ad esempio per TV o mensole)",
  parete: "una PARETE DIVISORIA in cartongesso, dritta e piana, dal pavimento al soffitto, che divide la stanza nel punto indicato; superficie liscia, con un'apertura passante rettangolare larga circa 90 cm se serve per passare",
  libreria: "una LIBRERIA in cartongesso a tutta parete sulla parete indicata: struttura di vani rettangolari regolari (ripiani e montanti spessi circa 10–12 cm), profonda circa 30 cm, dal pavimento al soffitto, con superficie liscia",
  controparete: "una CONTROPARETE in cartongesso che riveste completamente la parete indicata: superficie nuova, perfettamente piana e liscia, con spigoli netti",
};
const CG_DOVE = { fondo: "sulla parete di fondo (quella di fronte nella foto)", sinistra: "sulla parete a sinistra", destra: "sulla parete a destra", soffitto: "sul soffitto", giro: "lungo tutto il perimetro della stanza, su tutte le pareti visibili" };
const CG_LUCI = {
  led: "con una striscia LED nascosta a luce calda (circa 3000 K) che crea una lama di luce morbida e uniforme lungo il bordo",
  faretti: "con faretti a incasso tondi piccoli e bianchi distribuiti regolarmente, accesi a luce calda",
  no: "senza luci",
};
const CG_NOLUCI = ["parete", "controparete"];
// versione 2 (in prova): misure vere e soluzioni dei sistemi a secco (tagli di luce, scuretto, veletta curva)
const CG_MIS = { veletta: ["30", "50", "100", "curva"], soffitto: ["scuretto", "liscio"], nicchia: ["tv", "mensole", "alta"], taglio: ["linea", "angolo", "croce", "stella"] };
function parseOne(c, v2) {
  if (!c || typeof c !== "object") return null;
  if (!(CG_TIPO[c.tipo] || (v2 && c.tipo === "taglio"))) return null;
  let dove = CG_DOVE[c.dove] ? c.dove : (c.tipo === "soffitto" ? "soffitto" : "fondo");
  if (dove === "giro" && c.tipo !== "veletta") dove = "fondo";
  if (dove === "soffitto" && c.tipo !== "soffitto" && c.tipo !== "taglio") dove = "fondo";
  const o = { tipo: c.tipo, dove: c.tipo === "soffitto" ? "soffitto" : dove, luci: (CG_NOLUCI.includes(c.tipo) || c.tipo === "taglio") ? "no" : (CG_LUCI[c.luci] ? c.luci : "no") };
  if (v2) {
    const M = CG_MIS[c.tipo] || [];
    o.mis = M.includes(c.mis) ? c.mis : (M[0] || "");
    if (c.tipo === "taglio") o.w = c.w === "40" ? "40" : "18";
  }
  return o;
}
// Uno o più lavori in cartongesso (massimo 3, senza doppioni): { items:[{tipo,dove,luci}] }
function parseCg(c) {
  if (!c || typeof c !== "object") return null;
  const v2 = !!c.v2, src = Array.isArray(c.items) ? c.items : [c], seen = {}, items = [];
  src.slice(0, 6).forEach(function (x) { const o = parseOne(x, v2); if (o && !seen[o.tipo] && items.length < 3) { seen[o.tipo] = 1; items.push(o); } });
  return items.length ? (v2 ? { items: items, v2: true } : { items: items }) : null;
}
function cgOne(o) {
  const luci = o.luci === "no" || CG_NOLUCI.includes(o.tipo) ? "" : ", " + CG_LUCI[o.luci];
  return CG_TIPO[o.tipo] + (o.tipo === "soffitto" ? "" : ", " + CG_DOVE[o.dove]) + luci;
}
// prompt completo per il cartongesso: si COSTRUISCE qualcosa che prima non c'era
const CG_DOVE2 = Object.assign({}, CG_DOVE, { soffitto: "sul soffitto, al centro della stanza" });
function cgOne2(o) {
  const dove = o.tipo === "soffitto" ? "" : " Si trova " + CG_DOVE2[o.dove] + ".";
  if (o.tipo === "veletta") {
    const h = o.mis === "50" ? 50 : o.mis === "100" ? 100 : 30;
    let t = o.mis === "curva"
      ? "una VELETTA in cartongesso che scende esattamente 30 cm dal soffitto e sporge circa 40 cm dalla parete, con il bordo frontale CURVO: una linea morbida e continua, senza spigoli, che si raccorda dolcemente alla parete"
      : "una VELETTA in cartongesso: un volume pieno che scende esattamente " + h + " cm dal soffitto (misura verticale) e sporge circa 40 cm dalla parete, con la faccia inferiore piana e orizzontale e gli spigoli vivi, dritti e paralleli al soffitto";
    t += "." + dove;
    if (o.luci === "led") t += " Dentro la veletta, nascosta alla vista, c'è una striscia LED a luce calda 3000 K: NON si vede la striscia, si vede solo una lama di luce morbida e uniforme che illumina dall'alto la parete sotto la veletta, più intensa vicino alla veletta e che sfuma verso il basso.";
    if (o.luci === "faretti") t += " Nella faccia inferiore della veletta ci sono 3–5 faretti tondi piccoli a incasso, allineati al centro e alla stessa distanza tra loro, accesi a luce calda.";
    return t;
  }
  if (o.tipo === "soffitto") {
    let t = "un CONTROSOFFITTO in cartongesso che abbassa tutto il soffitto della stanza di circa 10 cm: superficie liscia, piana e continua, senza giunti visibili";
    t += o.mis === "scuretto" ? ". Lungo TUTTI i muri, tra il controsoffitto e la parete, corre una FESSURA D'OMBRA (scuretto perimetrale) dritta e scura larga circa 1–2 cm: il soffitto sembra sospeso." : ", raccordato ai muri con uno spigolo pulito e dritto.";
    if (o.luci === "led") t += " Lungo il perimetro c'è una gola luminosa con LED nascosti a luce calda 3000 K che illumina le pareti dall'alto con una luce morbida; la striscia non si vede.";
    if (o.luci === "faretti") t += " Nel controsoffitto ci sono faretti tondi piccoli a incasso disposti in file regolari, alla stessa distanza tra loro e dai muri, accesi a luce calda.";
    return t;
  }
  if (o.tipo === "nicchia") {
    const n = { tv: "larga 160 cm e alta 60 cm, con il bordo inferiore a circa 100 cm da terra (per la TV)", mensole: "larga 100 cm e alta 40 cm, con il bordo inferiore a circa 120 cm da terra", alta: "larga 50 cm e alta 150 cm, che parte da circa 50 cm da terra" }[o.mis] || "larga 160 cm e alta 60 cm";
    let t = "una NICCHIA rettangolare incassata in una controparete in cartongesso spessa circa 15 cm che riveste la parete; la nicchia è " + n + ", profonda circa 15 cm, con spigoli netti e dritti." + dove;
    if (o.luci === "led") t += " Nel bordo superiore della nicchia ci sono LED nascosti a luce calda 3000 K che illuminano l'interno della nicchia; la striscia non si vede.";
    if (o.luci === "faretti") t += " Nel lato superiore della nicchia 2–3 piccoli faretti a incasso accesi a luce calda.";
    return t;
  }
  if (o.tipo === "taglio") {
    const w = o.w === "40" ? "larghe circa 4 cm" : "sottili, larghe circa 2 cm";
    const f = { linea: "una sola riga di luce verticale lunga circa 120 cm", angolo: "due righe di luce a forma di L che si toccano ad angolo retto, ognuna lunga circa 80 cm", croce: "due righe di luce che si incrociano al centro: la verticale lunga circa 120 cm, l'orizzontale circa 100 cm", stella: "quattro righe di luce che si incrociano nello stesso punto (verticale, orizzontale e due diagonali), ognuna lunga circa 70 cm" }[o.mis] || "una riga di luce lunga circa 120 cm";
    return "un TAGLIO DI LUCE nel cartongesso: " + f + ", " + w + ", incassate A FILO nella superficie (non sporgono e non sono lampade appese). Luce bianca calda 3000 K, uniforme lungo tutta la riga, con un leggero alone morbido sulla superficie intorno; il resto della superficie è cartongesso liscio pitturato." + dove;
  }
  return CG_TIPO[o.tipo] + "." + dove;
}
function cgPrompt2(c, colorDesc) {
  const L = c.items, more = L.length > 1;
  return [
    "Modifica la foto di questo interno aggiungendo " + (more ? L.length + " lavori in cartongesso" : "un lavoro in cartongesso") + " realizzati da un professionista con un sistema a secco (orditura metallica e lastre).",
    more ? "Aggiungi TUTTI questi elementi, ognuno al suo posto: " + L.map(function (o, i) { return (i + 1) + ") " + cgOne2(o); }).join(" ") : "Aggiungi " + cgOne2(L[0]),
    "Rispetta le MISURE indicate: per la scala usa le cose della foto (una porta è alta circa 210 cm, un tavolo circa 75 cm, un soffitto di solito circa 270 cm).",
    "Il cartongesso nuovo è pitturato " + colorDesc + ", opaco, con stuccature invisibili; spigoli perfettamente dritti e paralleli alle linee della stanza; ombre morbide e realistiche sotto velette e sporgenze; le luci accese sono coerenti con la luce della stanza.",
    "Mantieni IDENTICI pavimento, mobili, finestre, porte, oggetti, colori, esposizione e inquadratura: aggiungi SOLO " + (more ? "gli elementi descritti" : "l'elemento descritto") + ". Non spostare, non eliminare e non aggiungere altro.",
    "Il risultato deve sembrare una fotografia reale della stessa stanza dopo i lavori, non un rendering.",
  ].join(" ");
}
function cgPrompt(c, colorDesc) {
  if (c && c.v2 && Array.isArray(c.items)) return cgPrompt2(c, colorDesc);
  const L = c.items || [c], more = L.length > 1;
  return [
    "Modifica la foto di questo interno aggiungendo " + (more ? L.length + " lavori in cartongesso" : "un lavoro in cartongesso") + " realizzati da un professionista.",
    more ? "Aggiungi TUTTI questi elementi, ognuno al suo posto: " + L.map(function (o, i) { return (i + 1) + ") " + cgOne(o); }).join("; ") + "." : "Aggiungi " + cgOne(L[0]) + ".",
    "I nuovi elementi in cartongesso sono rifiniti e dipinti nel colore " + colorDesc + ", opachi, con stuccature invisibili.",
    "Proporzioni realistiche rispetto alla stanza, alle porte e ai mobili; segui esattamente la prospettiva e le linee della foto; luci e ombre coerenti con la luce della stanza.",
    "Mantieni identici pavimento, mobili, finestre, porte, oggetti, inquadratura e tutte le altre pareti: aggiungi SOLO " + (more ? "gli elementi in cartongesso descritti" : "l'elemento in cartongesso descritto") + ". Non spostare né eliminare nulla.",
    "Il risultato deve sembrare una fotografia reale della stessa stanza dopo i lavori, non un rendering.",
  ].join(" ");
}

// Cappotto: il testo generale della facciata dice "spallette e davanzali identici" e "nessuna banda":
// così l'AI faceva solo la pittura. Qui il cappotto diventa il lavoro principale e le regole che lo
// cancellerebbero vengono tolte o superate da eccezioni esplicite.
function cappFix(prompt, c) {
  if (!c) return prompt;
  const zoc = c.zoc
    ? "una ZOCCOLATURA ben visibile alta circa 70 cm alla base di tutta la facciata, continua e dritta, in un tono nettamente più scuro dello stesso colore, separata dal resto da una sottile linea orizzontale"
    : "alla base della facciata, a circa 20–30 cm da terra, una sottile linea orizzontale dritta (il profilo di partenza del cappotto)";
  const lead = "LAVORO PRINCIPALE: CAPPOTTO TERMICO. Questa facciata è stata isolata con un cappotto termico e rifinita da poco: il risultato deve far capire SUBITO, a colpo d'occhio, che la casa ha il cappotto nuovo e non è solo stata ridipinta. Cambiamenti visibili OBBLIGATORI: "
    + "1) tutte le pareti esterne hanno una superficie NUOVA, perfettamente dritta e planare, senza crepe, rappezzi, macchie o vecchi segni, con " + GRANA[c.grana] + ", nel colore indicato; "
    + "2) le pareti sono più spesse di circa 12–15 cm: attorno a OGNI finestra e porta le spallette laterali e l'architrave sono visibilmente più profondi, intonacati e lisci nello stesso colore, con una striscia d'ombra più marcata verso il serramento; i serramenti restano dove sono ma appaiono più incassati nel muro; "
    + "3) sotto ogni finestra c'è un davanzale NUOVO, sottile, in alluminio o pietra chiara, che sporge di qualche centimetro oltre la nuova parete e getta una piccola ombra; "
    + "4) gli spigoli degli angoli della casa e delle aperture sono netti e perfettamente dritti (paraspigoli); "
    + "5) " + zoc + ". ";
  let p = prompt
    .replace(/le cornici di porte e finestre, /, "")
    .replace(/, i davanzali/, "")
    .replace(/SUPERFICIE CONTINUA \(regola vincolante\): /, "SUPERFICIE CONTINUA (regola vincolante, tranne la base della facciata descritta nel CAPPOTTO): ");
  const after = " ECCEZIONI PER IL CAPPOTTO (valgono più di tutte le regole sopra): spallette e architravi più profondi, davanzali nuovi, spigoli dritti e " + (c.zoc ? "zoccolatura" : "linea del profilo di partenza") + " sono RICHIESTI e vanno fatti; non contano come elementi aggiunti né come bande o righe decorative. Restano invece identici tetto, serramenti, persiane, ringhiere, grondaie, vegetazione, cielo e inquadratura.";
  return lead + p + after;
}

// Zoccolo scelto come "parte in più" della facciata (senza cappotto o con cappotto senza zoccolatura)
function parseZoc(z) {
  if (!z || typeof z !== "object" || !/^#[0-9a-fA-F]{6}$/.test(String(z.hex || ""))) return null;
  return { hex: String(z.hex).toUpperCase(), name: String(z.name || "").replace(/[^\w àèéìòù'.-]/gi, "").slice(0, 40) };
}
function zocNote(z) {
  return z ? " ZOCCOLO: alla base di tutta la facciata dipingi uno zoccolo alto circa 70 cm, continuo e perfettamente dritto, nel colore \"" + (z.name || "zoccolo") + "\" (codice esadecimale esatto " + z.hex + "), con una sottile linea orizzontale di separazione dal resto della facciata." : "";
}
function zocFix(prompt, z) {
  if (!z) return prompt;
  return prompt.replace(/SUPERFICIE CONTINUA \(regola vincolante\): /, "SUPERFICIE CONTINUA (regola vincolante, tranne lo ZOCCOLO richiesto alla base): ")
    + " ECCEZIONE ZOCCOLO (vale più delle regole sopra): lo zoccolo alto circa 70 cm alla base della facciata, nel colore " + z.hex + ", è RICHIESTO e va fatto; non conta come banda decorativa vietata.";
}


// ---------- boiserie: cornici e riquadri in rilievo sulle pareti ----------
const BS_STILE = {
  classica: "classica a riquadri: cornici rettangolari in rilievo con profilo sagomato (circa 4 cm) che formano pannelli regolari, tutti della stessa larghezza, allineati e con la stessa distanza tra loro",
  inglese: "all'inglese (wainscoting): pannelli rettangolari bassi delimitati da cornici in rilievo, tutti uguali, con una cornice orizzontale continua più marcata sopra i pannelli",
  listelli: "moderna a listelli verticali: listelli in rilievo dritti e paralleli, larghi circa 3 cm e distanziati in modo regolare di circa 8-10 cm",
  geometrica: "geometrica: cornici sottili in rilievo che formano un disegno regolare e simmetrico di rettangoli con diagonali (effetto a rombi)",
};
const BS_DOVE = {
  fondo: "sulla parete di fondo (quella di fronte nella foto)",
  sinistra: "sulla parete di sinistra",
  destra: "sulla parete di destra",
  letto: "sulla parete dietro il letto o il divano, solo nella zona del letto o del divano, centrata",
  tutta: "su tutte le pareti che si vedono nella foto",
};
const BS_ALT = {
  tutta: "dal battiscopa fino quasi al soffitto (lascia circa 15 cm sotto il soffitto)",
  "23": "fino a circa due terzi dell'altezza della parete, chiusa in alto da una cornice orizzontale continua",
  "1m": "solo nella parte bassa, dal battiscopa fino a circa 1 metro di altezza, chiusa in alto da una cornice orizzontale continua",
};
// con le misure scelte dall'artigiano: lo stile senza numeri (i numeri arrivano da bsMisure)
const BS_STILE2 = {
  classica: "classica a riquadri: cornici rettangolari in rilievo che formano pannelli regolari, tutti uguali e allineati",
  inglese: "all'inglese (wainscoting): pannelli rettangolari bassi delimitati da cornici in rilievo, tutti uguali, con una fascia orizzontale continua più marcata sopra i pannelli",
  listelli: "moderna a listelli verticali in rilievo, dritti e paralleli",
  geometrica: "geometrica: cornici in rilievo che formano un disegno regolare e simmetrico di rettangoli con diagonali (effetto a rombi)",
};
const BS_LARG = { "2": 2.2, "3": 3, "4": 4, "5": 5 };
const BS_CORN = { sottile: 2, media: 4, importante: 6 };
const BS_LIST = { fitti: [2, 2], medi: [3, 6], radi: [4, 12] };
function parseBs(b) {
  if (!b || typeof b !== "object") return null;
  const stile = BS_STILE[b.stile] ? b.stile : null; if (!stile) return null;
  const o = { stile, dove: BS_DOVE[b.dove] ? b.dove : "fondo", alt: BS_ALT[b.alt] ? b.alt : (stile === "inglese" ? "1m" : "tutta"), col: b.col === "tono" ? "tono" : "colore" };
  if (BS_LARG[b.larg]) o.larg = b.larg;
  if (stile === "listelli" ? BS_LIST[b.corn] : BS_CORN[b.corn]) o.corn = b.corn;
  return o;
}
function r5(n) { return Math.round(n / 5) * 5; }
// misure vere: quanti riquadri, quanto larghi, cornici di che spessore
function bsMisure(b) {
  const W = BS_LARG[b.larg], out = [];
  const h = b.alt === "1m" ? 100 : b.alt === "23" ? 170 : 255;
  if (b.stile === "listelli") {
    const L = BS_LIST[b.corn] || [3, 6];
    out.push("Listelli larghi " + L[0] + " cm e distanziati " + L[1] + " cm uno dall'altro, tutti uguali, dritti e perfettamente verticali" + (W ? ": su questa parete larga circa " + String(W).replace(".", ",") + " m ci stanno circa " + Math.round(W * 100 / (L[0] + L[1])) + " listelli" : "") + ".");
    return out.join(" ");
  }
  const c = BS_CORN[b.corn] || 4;
  out.push("Cornici in rilievo con profilo sagomato larghe circa " + c + " cm, sporgenti circa " + Math.max(1, Math.round(c / 2)) + " cm.");
  if (W && b.stile !== "geometrica") {
    const n = Math.max(2, Math.round(W / 0.7)), gap = 8, pw = r5((W * 100 - gap * (n + 1)) / n);
    if (b.stile === "classica" && b.alt === "tutta") out.push("Due file di riquadri separate da una cornice orizzontale continua a circa 90 cm da terra: in basso " + n + " riquadri uguali alti circa 60 cm, sopra " + n + " riquadri uguali alti fino a circa 20 cm sotto il soffitto, allineati in colonna con quelli sotto.");
    else out.push("Esattamente " + n + " riquadri uguali per fila, ognuno largo circa " + pw + " cm.");
    out.push("Distanza costante di circa " + gap + " cm tra un riquadro e l'altro e dai bordi della zona con la boiserie; il disegno è centrato e simmetrico sulla parete (parete larga circa " + String(W).replace(".", ",") + " m).");
  } else if (b.stile === "classica" && b.alt === "tutta") {
    out.push("Due file di riquadri separate da una cornice orizzontale continua a circa 90 cm da terra: in basso riquadri bassi (circa 60 cm), sopra riquadri alti, allineati in colonna; riquadri larghi circa 60–70 cm.");
  } else if (b.stile !== "geometrica") out.push("Riquadri larghi circa 60–70 cm, tutti uguali, con circa 8 cm tra uno e l'altro.");
  if (b.alt !== "tutta") out.push("La cornice orizzontale che chiude la boiserie in alto (fascia) è più marcata delle altre, alta circa " + (c + 3) + " cm, a circa " + h + " cm da terra.");
  return out.join(" ");
}
function bsPrompt(b, colorDesc) {
  const colore = b.col === "tono"
    ? "Le cornici e i pannelli sono dello STESSO colore della parete esistente (tono su tono), finitura satinata leggera: la boiserie si riconosce solo grazie al rilievo e alle ombre."
    : "Le cornici e i pannelli della boiserie sono dipinti nel colore " + colorDesc + ", finitura opaca" + (b.alt === "tutta" ? ", su tutta la parete con la boiserie." : "; la parte di parete sopra la boiserie resta del colore attuale.");
  const mis = (b.larg || b.corn) ? bsMisure(b) : "";
  return [
    "Modifica la foto di questo interno aggiungendo una boiserie realizzata da un professionista " + BS_DOVE[b.dove] + ", " + BS_ALT[b.alt] + ".",
    "Stile: " + (mis ? BS_STILE2[b.stile] : BS_STILE[b.stile]) + ".",
    mis,
    colore,
    mis ? "In basso un battiscopa coordinato alto circa 10 cm, dello stesso colore della boiserie. Per la scala usa le cose della foto (una porta è alta circa 210 cm, un letto circa 50 cm, un tavolo circa 75 cm)." : "",
    "Linee perfettamente dritte e parallele che seguono esattamente la prospettiva della parete; disegno simmetrico rispetto al centro della parete; proporzioni realistiche rispetto alla stanza, alle porte e ai mobili.",
    "Le cornici si interrompono intorno a porte, finestre, prese, interruttori e termosifoni senza passarci sopra; non coprire mobili, quadri o oggetti.",
    "Rilievo realistico con ombre leggere coerenti con la luce della stanza" + (mis ? ": un'ombra sottile sotto ogni cornice orizzontale e di lato a quelle verticali, nella direzione della luce." : "."),
    "Mantieni identici pavimento, soffitto, mobili, porte, finestre, oggetti, luci e inquadratura: aggiungi SOLO la boiserie.",
    mis ? "Il risultato deve sembrare una fotografia reale della stessa stanza dopo i lavori, non un rendering." : "",
  ].filter(Boolean).join(" ");
}

module.exports = { parseBs, bsPrompt, parseCapp, cappNote, parseCg, cgPrompt, cappFix, parseZoc, zocNote, zocFix, GRANA, CG_TIPO };
