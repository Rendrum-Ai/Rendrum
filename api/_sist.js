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
  veletta: "una VELETTA in cartongesso lungo il soffitto: una fascia ribassata di circa 25–35 cm di altezza e 40–60 cm di profondità, che corre lungo la parete indicata, con spigoli dritti e superficie liscia",
  soffitto: "un CONTROSOFFITTO in cartongesso ribassato di circa 10–15 cm su tutto il soffitto della stanza, superficie liscia e continua, perimetro pulito con una sottile gola d'ombra lungo le pareti",
  nicchia: "una NICCHIA rettangolare incassata in una controparete in cartongesso sulla parete indicata, larga circa 120–160 cm e alta circa 50–70 cm, profonda circa 15–20 cm, con spigoli netti, posizionata a un'altezza naturale (ad esempio per TV o mensole)",
  parete: "una PARETE DIVISORIA in cartongesso, dritta e piana, dal pavimento al soffitto, che divide la stanza nel punto indicato; superficie liscia, con un'apertura passante rettangolare larga circa 90 cm se serve per passare",
  libreria: "una LIBRERIA in cartongesso a tutta parete sulla parete indicata: struttura di vani rettangolari regolari (ripiani e montanti spessi circa 10–12 cm), profonda circa 30 cm, dal pavimento al soffitto, con superficie liscia",
  controparete: "una CONTROPARETE in cartongesso che riveste completamente la parete indicata: superficie nuova, perfettamente piana e liscia, con spigoli netti",
};
const CG_DOVE = { fondo: "sulla parete di fondo (quella di fronte nella foto)", sinistra: "sulla parete a sinistra", destra: "sulla parete a destra", soffitto: "sul soffitto" };
const CG_LUCI = {
  led: "con una striscia LED nascosta a luce calda (circa 3000 K) che crea una lama di luce morbida e uniforme lungo il bordo",
  faretti: "con faretti a incasso tondi piccoli e bianchi distribuiti regolarmente, accesi a luce calda",
  no: "senza luci",
};
function parseCg(c) {
  if (!c || typeof c !== "object" || !CG_TIPO[c.tipo]) return null;
  return { tipo: c.tipo, dove: CG_DOVE[c.dove] ? c.dove : (c.tipo === "soffitto" ? "soffitto" : "fondo"), luci: CG_LUCI[c.luci] ? c.luci : "no" };
}
// prompt completo per il cartongesso: si COSTRUISCE qualcosa che prima non c'era
function cgPrompt(c, colorDesc) {
  const luci = (c.tipo === "parete" || c.tipo === "controparete") ? "" : " " + CG_LUCI[c.luci] + ".";
  return [
    "Modifica la foto di questo interno aggiungendo un lavoro in cartongesso realizzato da un professionista.",
    "Aggiungi " + CG_TIPO[c.tipo] + (c.tipo === "soffitto" ? "" : ", " + CG_DOVE[c.dove]) + "." + luci,
    "Il nuovo elemento in cartongesso è rifinito e dipinto nel colore " + colorDesc + ", opaco, con stuccature invisibili.",
    "Proporzioni realistiche rispetto alla stanza, alle porte e ai mobili; segui esattamente la prospettiva e le linee della foto; luci e ombre coerenti con la luce della stanza.",
    "Mantieni identici pavimento, mobili, finestre, porte, oggetti, inquadratura e tutte le altre pareti: aggiungi SOLO l'elemento in cartongesso descritto. Non spostare né eliminare nulla.",
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

module.exports = { parseCapp, cappNote, parseCg, cgPrompt, cappFix, GRANA, CG_TIPO };
