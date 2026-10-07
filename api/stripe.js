// api/stripe.js
// Tutte le funzioni dei pagamenti in un unico file (così su Vercel conta come
// una sola funzione): /api/stripe?action=checkout | portal | webhook
const { PLANS, paymentsEnabled, stripeRequest, currentAccount, supabaseRequest } = require("./_auth-lib");

// ---------- codici sconto ----------
// I codici si creano nel pannello di Stripe (Prodotti → Coupon → Codici promozionali).
// Qui li verifichiamo prima del pagamento per mostrare il prezzo scontato, e li
// applichiamo noi alla pagina di pagamento. Piani senza sconti: NO_PROMO_TIERS.
const NO_PROMO_TIERS = ["start"];
function promoLabel(c) {
  const quanto = c.percent_off ? "−" + String(c.percent_off).replace(".", ",") + "%" : "−" + (c.amount_off / 100).toFixed(2).replace(".", ",") + " €";
  const durata = c.duration === "forever" ? "per sempre" : c.duration === "once" ? "sul primo mese" : "per " + c.duration_in_months + (c.duration_in_months === 1 ? " mese" : " mesi");
  return quanto + " " + durata;
}
function discounted(cents, c) {
  if (c.percent_off) return Math.max(0, Math.round(cents * (100 - c.percent_off) / 100));
  if (c.amount_off) return Math.max(0, cents - c.amount_off);
  return cents;
}
// Restituisce { promo } se il codice è valido per questo piano, altrimenti { error }.
async function findPromo(code, tier, acc) {
  code = String(code || "").trim();
  if (!code) return { error: "Scrivi il codice." };
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(code)) return { error: "Codice non valido." };
  if (NO_PROMO_TIERS.includes(tier)) return { error: "Questo piano ha già il prezzo più basso: i codici sconto valgono dagli altri piani." };
  const r = await stripeRequest("GET", "/promotion_codes?active=true&limit=1&code=" + encodeURIComponent(code));
  const pc = r.ok && r.data && Array.isArray(r.data.data) ? r.data.data[0] : null;
  if (!pc || !pc.coupon || !pc.coupon.valid) return { error: "Codice non valido o scaduto." };
  if (pc.expires_at && pc.expires_at * 1000 < Date.now()) return { error: "Questo codice è scaduto." };
  if (pc.max_redemptions && pc.times_redeemed >= pc.max_redemptions) return { error: "Questo codice è già stato usato da tutti quelli previsti." };
  if (pc.restrictions && pc.restrictions.first_time_transaction && acc && acc.stripe_customer_id) return { error: "Questo codice vale solo per il primo abbonamento." };
  const plan = PLANS[tier], c = pc.coupon;
  if (pc.restrictions && pc.restrictions.minimum_amount && plan.priceCents < pc.restrictions.minimum_amount) return { error: "Questo codice non vale per questo piano." };
  return { promo: { id: pc.id, code: pc.code, label: promoLabel(c), finalCents: discounted(plan.priceCents, c), duration: c.duration, months: c.duration_in_months || 0 } };
}
async function offer(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Usa una richiesta POST" });
  const body = req.body || {}, acc = await currentAccount(req).catch(() => null);
  const tier = PLANS[body.tier] ? body.tier : (acc && PLANS[acc.tier] ? acc.tier : "basic"), plan = PLANS[tier];
  const out = { tier, plan: { name: plan.name, priceCents: plan.priceCents, images: plan.images }, promoOk: !NO_PROMO_TIERS.includes(tier) && paymentsEnabled() };
  if (body.code) {
    if (!paymentsEnabled()) return res.status(503).json(Object.assign(out, { error: "I pagamenti non sono ancora attivi: i codici si potranno usare appena partono." }));
    const f = await findPromo(body.code, tier, acc);
    if (f.error) return res.status(400).json(Object.assign(out, { error: f.error }));
    out.promo = f.promo;
  }
  return res.status(200).json(out);
}

// api/stripe-checkout.js
// Crea la pagina di pagamento Stripe per l'abbonamento scelto e restituisce
// l'indirizzo a cui mandare il cliente. Serve essere loggati.

async function checkout(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Usa una richiesta POST" });
  if (!paymentsEnabled()) return res.status(503).json({ error: "Pagamenti non ancora attivi (manca STRIPE_SECRET_KEY su Vercel)." });
  try {
    const acc = await currentAccount(req);
    if (!acc) return res.status(401).json({ error: "Accedi o registrati prima di attivare l'abbonamento." });
    // Abbonamento già attivo: niente secondo pagamento, si apre la gestione abbonamento.
    if (acc.stripe_customer_id && ["active", "trialing", "past_due"].includes(acc.subscription_status)) {
      const o = (req.headers["x-forwarded-proto"] || "https") + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
      const pr = await stripeRequest("POST", "/billing_portal/sessions", { customer: acc.stripe_customer_id, return_url: o + "/" });
      if (pr.ok && pr.data && pr.data.url) return res.status(200).json({ url: pr.data.url, portal: true });
      return res.status(409).json({ error: "Hai già un abbonamento attivo: gestiscilo dal pulsante Abbonamento." });
    }
    const body = req.body || {};
    const tier = PLANS[body.tier] ? body.tier : (PLANS[acc.tier] ? acc.tier : "basic");
    const plan = PLANS[tier];
    const origin = (req.headers["x-forwarded-proto"] || "https") + "://" + (req.headers["x-forwarded-host"] || req.headers.host);

    const params = {
      mode: "subscription",
      client_reference_id: acc.id,
      success_url: origin + "/?pagamento=ok",
      cancel_url: origin + "/?pagamento=annullato",
      billing_address_collection: "required",
      tax_id_collection: { enabled: "true" },
      locale: "it",
      line_items: { 0: { quantity: 1, price_data: {
        currency: "eur", unit_amount: plan.priceCents, tax_behavior: "exclusive",
        recurring: { interval: "month" },
        product_data: { name: plan.name + " – " + plan.images + " anteprime AI al mese" },
      } } },
      metadata: { account_id: acc.id, tier: tier },
      subscription_data: { metadata: { account_id: acc.id, tier: tier } },
    };
    // codice sconto: verificato da noi; senza codice, si può scrivere anche sulla pagina Stripe (non per i piani senza sconti)
    if (body.code) {
      const f = await findPromo(body.code, tier, acc);
      if (f.error) return res.status(400).json({ error: f.error });
      params.discounts = { 0: { promotion_code: f.promo.id } };
      params.metadata.promo = f.promo.code; params.subscription_data.metadata.promo = f.promo.code;
    } else if (!NO_PROMO_TIERS.includes(tier)) params.allow_promotion_codes = "true";
    // IVA: con STRIPE_AUTOMATIC_TAX=1 (e Stripe Tax attivo) Stripe aggiunge da solo il 22%.
    if ((process.env.STRIPE_AUTOMATIC_TAX || "").trim() === "1") params.automatic_tax = { enabled: "true" };
    if (acc.stripe_customer_id) params.customer = acc.stripe_customer_id;
    else params.customer_email = acc.email;
    if (acc.stripe_customer_id) params.customer_update = { address: "auto", name: "auto" };

    const r = await stripeRequest("POST", "/checkout/sessions", params);
    if (!r.ok || !r.data || !r.data.url) {
      console.error("stripe checkout", r.data);
      return res.status(502).json({ error: "Stripe non ha creato la pagina di pagamento. Riprova tra poco." });
    }
    // Il piano NON si cambia qui: lo scrive solo il webhook quando Stripe conferma il pagamento.
    return res.status(200).json({ url: r.data.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Errore imprevisto. Riprova tra poco." });
  }
}

// ---------- anteprime comprate dal cliente dal link dell'artigiano ----------
// Pagamento singolo (niente abbonamento): PACK_N anteprime a PACK_CENTS, IVA inclusa.
// Le anteprime le aggiunge SOLO il webhook, quando Stripe conferma il pagamento.
async function invitoCheckout(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Usa una richiesta POST" });
  if (!paymentsEnabled()) return res.status(503).json({ error: "I pagamenti non sono ancora attivi: riprova più tardi." });
  const INV = require("./_invito");
  const t = String((req.body || {}).t || "");
  const f = await INV.find(t);
  if (!f.row) return res.status(404).json({ error: f.error });
  if (INV.scaduto(f.row.data || {})) return res.status(410).json({ error: "Questo link è scaduto: chiedi all'impresa di mandartene uno nuovo." });
  const origin = (req.headers["x-forwarded-proto"] || "https") + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
  const params = {
    mode: "payment",
    success_url: origin + "/?i=" + t + "&pagato=1",
    cancel_url: origin + "/?i=" + t,
    locale: "it",
    line_items: { 0: { quantity: 1, price_data: { currency: "eur", unit_amount: INV.PACK_CENTS, tax_behavior: "inclusive", product_data: { name: INV.PACK_N + " anteprime Rendrum" } } } },
    metadata: { invito: t, anteprime: String(INV.PACK_N) },
    payment_intent_data: { metadata: { invito: t } },
  };
  if ((process.env.STRIPE_AUTOMATIC_TAX || "").trim() === "1") params.automatic_tax = { enabled: "true" };
  const r = await stripeRequest("POST", "/checkout/sessions", params);
  if (!r.ok || !r.data || !r.data.url) { console.error("stripe invito", r.data); return res.status(502).json({ error: "Il pagamento non è partito. Riprova tra poco." }); }
  return res.status(200).json({ url: r.data.url });
}

// api/stripe-portal.js
// Apre il "portale cliente" di Stripe: il cliente può cambiare carta,
// scaricare le fatture o disdire l'abbonamento da solo.

async function portal(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Usa una richiesta POST" });
  if (!paymentsEnabled()) return res.status(503).json({ error: "Pagamenti non ancora attivi." });
  try {
    const acc = await currentAccount(req);
    if (!acc) return res.status(401).json({ error: "Accedi prima." });
    if (!acc.stripe_customer_id) return res.status(400).json({ error: "Non hai ancora un abbonamento attivo." });
    const origin = (req.headers["x-forwarded-proto"] || "https") + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
    const r = await stripeRequest("POST", "/billing_portal/sessions", { customer: acc.stripe_customer_id, return_url: origin + "/" });
    if (!r.ok || !r.data || !r.data.url) { console.error("stripe portal", r.data); return res.status(502).json({ error: "Impossibile aprire la gestione abbonamento. Riprova tra poco." }); }
    return res.status(200).json({ url: r.data.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Errore imprevisto. Riprova tra poco." });
  }
}

// api/stripe-webhook.js
// Stripe chiama questo indirizzo quando un pagamento va a buon fine, quando
// l'abbonamento si rinnova, non viene pagato o viene disdetto.
// Sicurezza: non ci fidiamo del contenuto ricevuto, ma rileggiamo l'evento
// direttamente da Stripe con la chiave segreta (così un falso avviso non ha effetto).

async function updateAccount(filter, fields) {
  return supabaseRequest("/pro_accounts?" + filter, { method: "PATCH", body: JSON.stringify(fields) });
}

async function webhook(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  if (!paymentsEnabled()) return res.status(200).json({ ignored: true });
  try {
    const incoming = req.body || {};
    if (!incoming.id) return res.status(400).json({ error: "evento senza id" });
    const ev = await stripeRequest("GET", "/events/" + encodeURIComponent(incoming.id));
    if (!ev.ok || !ev.data) return res.status(400).json({ error: "evento non trovato su Stripe" });
    const type = ev.data.type, obj = ev.data.data && ev.data.data.object ? ev.data.data.object : {};

    // Pacchetto di anteprime comprato dal cliente (link dell'artigiano)
    if (type === "checkout.session.completed" && obj.mode === "payment" && obj.metadata && obj.metadata.invito) {
      if (obj.payment_status !== "paid") return res.status(200).json({ ignored: "non pagato" });
      const INV = require("./_invito");
      const ok = await INV.addPack(obj.metadata.invito, obj.id, INV.PACK_N);
      if (!ok) return res.status(500).json({ error: "invito non aggiornato" });   // Stripe riproverà
      return res.status(200).json({ received: true, added: ok });
    }
    // Da quale abbonamento arriva l'evento?
    let subId = null, fallbackAccount = null;
    if (type === "checkout.session.completed" && obj.mode === "subscription") {
      subId = obj.subscription; fallbackAccount = obj.client_reference_id || (obj.metadata && obj.metadata.account_id);
    } else if (type.indexOf("customer.subscription.") === 0) {
      subId = obj.id;
    } else if (type === "invoice.payment_failed" || type === "invoice.paid") {
      subId = obj.subscription || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription) || null;
    }
    if (!subId) return res.status(200).json({ ignored: true });

    // Non ci fidiamo dell'evento (può arrivare in ritardo o fuori ordine):
    // leggiamo da Stripe lo stato ATTUALE dell'abbonamento.
    const sr = await stripeRequest("GET", "/subscriptions/" + encodeURIComponent(subId));
    if (!sr.ok || !sr.data) return res.status(500).json({ error: "abbonamento non leggibile" });
    const sub = sr.data;
    const meta = sub.metadata || {};
    const accountId = meta.account_id || fallbackAccount;
    const filter = accountId ? "id=eq." + encodeURIComponent(accountId) : "stripe_customer_id=eq." + encodeURIComponent(sub.customer);
    const found = await supabaseRequest("/pro_accounts?" + filter + "&select=id,stripe_subscription_id,subscription_status", { method: "GET" });
    if (!found.ok) return res.status(500).json({ error: "database non raggiungibile" }); // Stripe riproverà
    const acc = Array.isArray(found.data) ? found.data[0] : null;
    if (!acc) {
      // Account Rendrum eliminato: un suo abbonamento ancora vivo va disdetto
      // subito, così nessuno paga per un account che non c'è più. Solo per gli
      // abbonamenti creati da Rendrum (metadata.account_id), mai per altri.
      if (meta.account_id && !["canceled", "incomplete_expired"].includes(sub.status)) {
        await stripeRequest("DELETE", "/subscriptions/" + encodeURIComponent(sub.id)).catch(function () {});
        return res.status(200).json({ canceled: "account non trovato" });
      }
      return res.status(200).json({ ignored: "account non trovato" });
    }

    const liveStatuses = ["active", "trialing"];
    // Se l'account ha già un ALTRO abbonamento attivo, un abbonamento chiuso non lo spegne.
    if (acc.stripe_subscription_id && acc.stripe_subscription_id !== sub.id && liveStatuses.includes(acc.subscription_status) && !liveStatuses.includes(sub.status)) {
      return res.status(200).json({ ignored: "altro abbonamento attivo" });
    }
    const item = sub.items && sub.items.data && sub.items.data[0];
    const periodEnd = sub.current_period_end || (item && item.current_period_end);
    const fields = {
      stripe_customer_id: sub.customer,
      stripe_subscription_id: sub.id,
      subscription_status: sub.status === "incomplete_expired" ? "canceled" : sub.status,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    };
    if (PLANS[meta.tier] && liveStatuses.includes(sub.status)) fields.tier = meta.tier;
    await updateAccount("id=eq." + encodeURIComponent(acc.id), fields);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("webhook", err);
    return res.status(500).json({ error: "errore webhook" });
  }
}

module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || "";
  if (action === "checkout") return checkout(req, res);
  if (action === "offer") return offer(req, res);
  if (action === "portal") return portal(req, res);
  if (action === "invito-checkout") return invitoCheckout(req, res);
  if (action === "webhook") return webhook(req, res);
  return res.status(404).json({ error: "Azione sconosciuta" });
};
module.exports._test = { findPromo, promoLabel, discounted };
