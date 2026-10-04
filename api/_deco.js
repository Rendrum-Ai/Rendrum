// api/_deco.js — Pareti decorate (decorazioni Loggia).
//
// Il browser manda solo codici (prodotto, tinta, effetto, protezione, dove):
// le descrizioni per l'AI stanno qui sul server, così nessuno può scrivere
// testo libero nel prompt. Le descrizioni parlano dell'EFFETTO visivo, non del
// marchio: all'AI serve sapere com'è la superficie.
const CAT = {
  // Spatolati e stucchi
  lumina:            ["Lumina", "decorazione spatolata a più passate con riflessi di luce delicati e leggera materia, superficie liscia con nuvolature di tono"],
  infinito:          ["Infinito", "rivestimento materico a base calce steso a spatola, superficie opaca minerale con leggere nuvolature e segni di spatola morbidi"],
  infinito_foto:     ["Infinito Fotocatalitico", "rivestimento materico a base calce steso a spatola, superficie opaca minerale con leggere nuvolature e segni di spatola morbidi"],
  riflesso:          ["Riflesso", "stucco a specchio a base calce (tipo stucco veneziano): superficie liscissima, lucida e profonda, con marezzature e riflessi tipici della lucidatura a ferro"],
  marmo_romano:      ["Marmo Romano", "rivestimento a calce effetto marmorino: superficie liscia e setosa, opaco-satinata, con leggere venature e nuvolature minerali"],
  plasma3d:          ["Plasma 3D", "rivestimento decorativo spatolato con velature profonde e leggere venature, superficie continua e liscia"],
  // Marmi
  carrara:           ["Infinito Carrara", "rivestimento a calce effetto marmo bianco di Carrara: fondo chiaro con venature grigie sottili e naturali, superficie liscia e levigata"],
  volare:            ["Volare", "rivestimento materico super opaco con effetto marmorizzato: nuvolature e venature morbide e delicate, nessun riflesso"],
  plasma_marmi:      ["Plasma 3D I Marmi", "riproduzione realistica di marmo naturale: venature ben definite e naturali su fondo uniforme, superficie liscia come marmo levigato"],
  monolith_marmo:    ["Monolith Marmo", "rivestimento continuo effetto marmo naturale con venature morbide, superficie liscia senza fughe"],
  // Pietra e materia
  canyon:            ["Canyon", "rivestimento materico effetto pietra naturale: leggeri rilievi, porosità e variazioni di tono come una pietra arenaria"],
  canyon_gravel:     ["Canyon Gravel", "rivestimento materico effetto pietra e ghiaia: superficie ruvida con piccoli inerti visibili e variazioni di tono naturali"],
  pietra_madre:      ["Pietra Madre", "effetto pietra antica dipinta a mano: velature sovrapposte, macchie e segni di consumo come una pietra invecchiata"],
  pietra_focata:     ["Pietra Focata", "rivestimento materico effetto pietra con sottili riflessi metallici, superficie irregolare e profonda"],
  tactile:           ["Tactile", "pittura decorativa a rilievo irregolare, morbida al tatto, con leggeri riflessi da opaco a perlato"],
  monolith_pietra:   ["Monolith Pietra", "rivestimento continuo effetto pietra con piccoli aggregati multicolore visibili, superficie liscia senza fughe"],
  // Cemento e microcemento
  microloggia:       ["Microloggia", "microcemento: superficie continua senza fughe, liscia e leggermente nuvolata, con le tipiche velature delle passate di spatola"],
  monolith:          ["Monolith", "rivestimento continuo monocomponente liscio e uniforme, leggermente nuvolato, senza fughe"],
  bi_plasma:         ["Bi Plasma 3D", "superficie continua effetto cemento senza fughe, liscia, con leggere nuvolature"],
  // Metalli e ruggine
  kymera:            ["Kymera", "rivestimento materico effetto ruggine: base bruno-ruggine opaca con chiazze e sfumature irregolari di ossidazione, pattern asimmetrico e naturale, mai arancione acceso"],
  keytown:           ["Keytown", "rivestimento effetto metallo invecchiato: superficie metallica scura con zone ossidate e consumate, riflessi opachi"],
  mantra:            ["Mantra", "finitura in metallo vero: superficie metallica con riflessi reali e leggere variazioni di luce, come una lamina di metallo spazzolato"],
  metallum:          ["Metallum", "pittura decorativa a effetto metallo: riflessi metallici cangianti e nuvolature di luce"],
  chromo:            ["Chromo System", "film a effetto metallico: superficie metallica riflettente e uniforme con riflessi morbidi"],
  monolith_metal:    ["Monolith Metal", "rivestimento continuo a effetto metallo industriale, riflessi metallici opachi, senza fughe"],
  bi_plasma_metal:   ["Bi Plasma 3D Metal", "superficie continua con polveri di metallo vero: riflessi metallici brillanti e profondità, senza fughe"],
  fusion:            ["Plasma 3D Fusion", "effetto metallo fuso: onde e colature metalliche lucide con riflessi intensi"],
  plasma_metal_mono: ["Plasma 3D Metal Monocomponente", "effetto metallo vero satinato, con riflessi morbidi e continui"],
  // Tessuti e perlati
  fabrics:           ["Fabrics", "pittura decorativa effetto tessuto (seta o velluto): trama morbida con leggere striature e riflessi setosi che cambiano con la luce"],
  pearlesse:         ["Pearlesse", "pittura decorativa perlata: superficie liscia con riflessi madreperla delicati"],
  uniq:              ["Uniq", "decorazione perlescente: nuvolature morbide con riflessi perlati"],
  // Sabbiati e glitter
  sablis:            ["Sablis", "pittura decorativa effetto sabbiato: micro-granuli e piccoli punti luce diffusi, effetto nuvola"],
  prisma:            ["Prisma", "pittura decorativa con glitter: piccoli brillantini diffusi che scintillano alla luce su fondo uniforme"],
  gleam:             ["Gleam", "finitura glitterata: brillantini fitti e luminosi su fondo colorato"],
  // Opachi e ceramici
  opal:              ["Opal", "finitura opaca morbida e vellutata dal gusto rétro, uniforme"],
  ceramica:          ["Ceramica", "finitura effetto ceramica: superficie liscia, lucida e vetrosa con leggere variazioni di tono"],
  quarzo_impero:     ["Quarzo Impero", "finitura decorativa effetto ceramica, liscia e luminosa"],
};
const METALS = { ferro: "ferro ossidato", ottone: "ottone", rame: "rame", argento: "argento", bronzo: "bronzo" };
const EFF = { leggero: "effetto delicato e poco marcato", medio: "effetto ben visibile", marcato: "effetto molto marcato e contrastato" };
const PROT = {
  none: { n: "Nessuna protezione", t: "" },
  microvetro_mono: { n: "Microvetro Mono", t: "protetta da un trasparente che la lascia leggermente satinata" },
  microvetro_1k: { n: "Microvetro 1K", t: "protetta da un trasparente che la lascia leggermente satinata" },
  microvetro_bi: { n: "Microvetro Bi", t: "protetta da un trasparente che la lascia leggermente satinata" },
  epoxy_vetro: { n: "Epoxy Vetro", t: "protetta da un trasparente che la lascia leggermente satinata" },
  cristallo: { n: "Cristallo Liquido", t: "protetta da un trasparente lucido a specchio, molto riflettente" },
  bicera: { n: "Bicera", t: "protetta da una cera che la rende leggermente lucida" },
  cera_specchio: { n: "Cera Specchio", t: "protetta da una cera che la rende leggermente lucida" },
};
const HEX = /^#[0-9a-f]{6}$/i;

// Controlla quello che arriva dal browser. Ritorna null se non valido.
function parse(d) {
  if (!d || typeof d !== "object" || !CAT[d.k]) return null;
  const metal = METALS[d.metal] ? d.metal : null;
  const hex = HEX.test(String(d.hex || "")) ? String(d.hex).toUpperCase() : null;
  if (!metal && !hex) return null;
  return {
    k: d.k, name: CAT[d.k][0], base: CAT[d.k][1], metal, hex,
    eff: EFF[d.eff] ? d.eff : "medio",
    prot: PROT[d.prot] ? d.prot : "none",
    dove: d.dove === "tutte" ? "tutte" : "parete",
  };
}

// Testo per l'AI: "una finitura decorativa ..." (senza nomi di marchi).
function text(s) {
  if (!s) return "";
  const col = s.metal ? `nella tonalità del ${METALS[s.metal]}` : `nel colore di fondo ${s.hex}`;
  const p = PROT[s.prot].t;
  return `una finitura decorativa realizzata a mano: ${s.base}, ${col}, ${EFF[s.eff]}${p ? ", " + p : ""}. La decorazione deve sembrare vera e fatta da un applicatore professionista: segue la luce e la prospettiva della stanza, è più scura nelle zone in ombra e più chiara dove arriva la luce, senza ripetizioni a griglia o motivi copiati`;
}

module.exports = { CAT, METALS, EFF, PROT, parse, text };
