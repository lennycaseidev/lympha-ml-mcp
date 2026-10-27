import { Redis } from "@upstash/redis";

const API = "https://api.mercadolibre.com";
const TZ_OFFSET = "-03:00";

export const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

export function redirectUri(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}/api/ml/callback`;
}

async function tokenRequest(params) {
  const body = new URLSearchParams({
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    ...params,
  });
  const r = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`ML token error ${r.status}: ${j.message || j.error || "desconocido"}`);
  return j;
}

async function store(tok) {
  await redis.set("ml:auth", {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    user_id: tok.user_id,
    expires_at: Date.now() + (tok.expires_in - 300) * 1000,
  });
}

export async function exchangeCode(code, redirect_uri) {
  const tok = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri });
  await store(tok);
  return tok.user_id;
}

// ML refresh tokens are single-use: take a lock so two calls never burn the same one.
export async function getAuth() {
  let auth = await redis.get("ml:auth");
  if (!auth) throw new Error("Mercado Libre no está autorizado todavía. Entrá a /api/ml/login?key=TU_MCP_SECRET.");
  if (Date.now() < auth.expires_at) return auth;
  const gotLock = await redis.set("ml:lock", "1", { nx: true, ex: 20 });
  if (!gotLock) {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      auth = await redis.get("ml:auth");
      if (Date.now() < auth.expires_at) return auth;
    }
    throw new Error("Timeout renovando el token de Mercado Libre, probá de nuevo.");
  }
  try {
    const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refresh_token });
    await store(tok);
    return await redis.get("ml:auth");
  } finally {
    await redis.del("ml:lock");
  }
}

const localDate = (iso) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

// Frascos por publicación según el título: "X2", "4 Gotero", "Pack 3 Frascos", "2x1", "Pack Doble", "4 Meses"...
export function frascosPorTitulo(title) {
  const t = title.toLowerCase();
  if (/\b2\s*x\s*1\b/.test(t)) return 2;
  if (/\bpack doble\b/.test(t)) return 2;
  let m = t.match(/\bx\s?(\d{1,2})\b/);
  if (m) return Number(m[1]);
  m = t.match(/\b(\d{1,2})\s+(gotero|goteros|unidades|frascos|meses)\b/);
  if (m) return Number(m[1]);
  m = t.match(/\bpack\s+(\d{1,2})\b/);
  if (m) return Number(m[1]);
  return 1;
}

export const traeGuaSha = (title) => /gua sha|piedra de masaje/i.test(title);

export async function salesByDay({ desde, hasta, filtro }) {
  const auth = await getAuth();
  const to = hasta || localDate(new Date().toISOString());
  const dias = {};
  for (let d = new Date(desde + "T00:00:00Z"); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    dias[d.toISOString().slice(0, 10)] = { fecha: d.toISOString().slice(0, 10), unidades: 0, frascos: 0, gua_sha: 0, ordenes: 0 };
  }
  const titulos = {};
  const f = (filtro || "").toLowerCase();
  let offset = 0, total = Infinity;
  while (offset < total && offset < 10000) {
    const q = new URLSearchParams({
      seller: String(auth.user_id),
      "order.status": "paid",
      "order.date_created.from": `${desde}T00:00:00.000${TZ_OFFSET}`,
      "order.date_created.to": `${to}T23:59:59.999${TZ_OFFSET}`,
      sort: "date_asc",
      limit: "50",
      offset: String(offset),
    });
    const r = await fetch(`${API}/orders/search?${q}`, { headers: { authorization: `Bearer ${auth.access_token}` } });
    const j = await r.json();
    if (!r.ok) throw new Error(`ML orders error ${r.status}: ${j.message || "desconocido"}`);
    total = j.paging?.total ?? 0;
    for (const o of j.results || []) {
      const day = dias[localDate(o.date_created)];
      if (!day) continue;
      let u = 0, fr = 0, gs = 0;
      for (const it of o.order_items || []) {
        const t = it.item?.title || "";
        if (f && !t.toLowerCase().includes(f)) continue;
        const q = it.quantity || 0;
        const porPack = frascosPorTitulo(t);
        u += q;
        fr += q * porPack;
        if (traeGuaSha(t)) gs += q;
        const row = (titulos[t] ||= { ventas: 0, frascos_por_venta: porPack, frascos: 0 });
        row.ventas += q;
        row.frascos += q * porPack;
      }
      if (u) { day.unidades += u; day.frascos += fr; day.gua_sha += gs; day.ordenes += 1; }
    }
    offset += 50;
  }
  const lista = Object.values(dias);
  const totales = lista.reduce((a, d) => ({
    ventas: a.ventas + d.unidades, frascos: a.frascos + d.frascos, gua_sha: a.gua_sha + d.gua_sha, ordenes: a.ordenes + d.ordenes,
  }), { ventas: 0, frascos: 0, gua_sha: 0, ordenes: 0 });
  return { seller_id: auth.user_id, desde, hasta: to, totales, dias: lista, titulos, truncado: total > 10000 };
}

// ---------- Plata de Mercado Libre: facturación, cargo por venta y envío por día ----------

const SHIP_TTL = 60 * 60 * 24 * 120; // el costo de un envío no cambia: se guarda 120 días

async function shippingCost(auth, shipmentId) {
  const key = `ml:ship:${shipmentId}`;
  const cached = await redis.get(key);
  if (cached !== null && cached !== undefined) return Number(cached);
  const r = await fetch(`${API}/shipments/${shipmentId}/costs`, {
    headers: { authorization: `Bearer ${auth.access_token}`, "x-format-new": "true" },
  });
  if (r.status === 404) { await redis.set(key, 0, { ex: SHIP_TTL }); return 0; }
  if (!r.ok) return null; // no se pudo leer ahora: no se guarda, se reintenta la próxima
  const j = await r.json();
  const senders = Array.isArray(j.senders) ? j.senders : [];
  const mine = senders.filter((s) => !s.user_id || String(s.user_id) === String(auth.user_id));
  const cost = mine.reduce((a, s) => a + Number(s.cost || 0), 0);
  await redis.set(key, cost, { ex: SHIP_TTL });
  return cost;
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

export async function financesByDay({ desde, hasta }) {
  const auth = await getAuth();
  const to = hasta || localDate(new Date().toISOString());
  const dias = {};
  for (let d = new Date(desde + "T00:00:00Z"); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const f = d.toISOString().slice(0, 10);
    dias[f] = { fecha: f, ordenes: 0, frascos: 0, facturacion: 0, cargo_venta: 0, envio: 0, reembolsado: 0, en_cuotas: 0, envios_sin_dato: 0 };
  }
  const envios = new Map(); // shipment id -> día (un carrito con varias órdenes comparte un envío)
  let offset = 0, total = Infinity;
  while (offset < total && offset < 10000) {
    const q = new URLSearchParams({
      seller: String(auth.user_id),
      "order.status": "paid",
      "order.date_created.from": `${desde}T00:00:00.000${TZ_OFFSET}`,
      "order.date_created.to": `${to}T23:59:59.999${TZ_OFFSET}`,
      sort: "date_asc",
      limit: "50",
      offset: String(offset),
    });
    const r = await fetch(`${API}/orders/search?${q}`, { headers: { authorization: `Bearer ${auth.access_token}` } });
    const j = await r.json();
    if (!r.ok) throw new Error(`ML orders error ${r.status}: ${j.message || "desconocido"}`);
    total = j.paging?.total ?? 0;
    for (const o of j.results || []) {
      const fecha = localDate(o.date_created);
      const day = dias[fecha];
      if (!day) continue;
      let fr = 0, fee = 0;
      for (const it of o.order_items || []) {
        const qty = it.quantity || 0;
        fr += qty * frascosPorTitulo(it.item?.title || "");
        fee += Number(it.sale_fee || 0) * qty;
      }
      const pagos = o.payments || [];
      day.ordenes += 1;
      day.frascos += fr;
      day.facturacion += Number(o.total_amount || 0);
      day.cargo_venta += fee;
      day.reembolsado += pagos.reduce((a, p) => a + Number(p.transaction_amount_refunded || 0), 0);
      if (pagos.some((p) => Number(p.installments || 1) > 1)) day.en_cuotas += 1;
      const sid = o.shipping?.id;
      if (sid && !envios.has(sid)) envios.set(sid, fecha);
    }
    offset += 50;
  }
  const ids = [...envios.keys()];
  const costos = await inBatches(ids, 10, (id) => shippingCost(auth, id).catch(() => null));
  ids.forEach((id, i) => {
    const day = dias[envios.get(id)];
    if (costos[i] === null) day.envios_sin_dato += 1;
    else day.envio += costos[i];
  });
  // Publicidad de Mercado Libre (Product Ads): gasto por día
  let publicidad_error = null;
  try {
    const ads = await adsCostByDay(auth, desde, to);
    for (const [f, cost] of Object.entries(ads)) if (dias[f]) dias[f].publicidad = (dias[f].publicidad || 0) + cost;
  } catch (e) {
    publicidad_error = String(e.message || e);
  }
  const lista = Object.values(dias).map((d) => ({
    publicidad: 0,
    ...d,
    facturacion: Math.round(d.facturacion * 100) / 100,
    cargo_venta: Math.round(d.cargo_venta * 100) / 100,
    envio: Math.round(d.envio * 100) / 100,
    reembolsado: Math.round(d.reembolsado * 100) / 100,
  }));
  const totales = lista.reduce((a, d) => {
    for (const k of ["ordenes", "frascos", "facturacion", "cargo_venta", "envio", "publicidad", "reembolsado", "en_cuotas", "envios_sin_dato"]) a[k] = (a[k] || 0) + d[k];
    return a;
  }, {});
  return { seller_id: auth.user_id, desde, hasta: to, totales, dias: lista, truncado: total > 10000, publicidad_error };
}

async function advertiserId(auth) {
  const key = `ml:adv:${auth.user_id}`;
  const cached = await redis.get(key);
  if (cached && cached.id) return String(cached.id);
  const r = await fetch(`${API}/advertising/advertisers?product_id=PADS`, {
    headers: { authorization: `Bearer ${auth.access_token}`, "Api-Version": "1", "content-type": "application/json" },
  });
  if (r.status === 404) return null;
  const j = await r.json();
  if (!r.ok) throw new Error(`ML publicidad ${r.status}: ${j.message || "sin permiso"}`);
  const list = j.advertisers || [];
  const adv = list.find((a) => a.site_id === "MLA") || list[0];
  if (!adv) return null;
  await redis.set(key, { id: String(adv.advertiser_id) }, { ex: 60 * 60 * 24 * 30 });
  return String(adv.advertiser_id);
}

async function adsCostByDay(auth, desde, hasta) {
  const adv = await advertiserId(auth);
  const out = {};
  if (!adv) return out;
  let d0 = new Date(desde + "T00:00:00Z");
  const fin = new Date(hasta + "T00:00:00Z");
  while (d0 <= fin) {
    const d1 = new Date(Math.min(fin.getTime(), d0.getTime() + 29 * 864e5));
    const q = new URLSearchParams({
      date_from: d0.toISOString().slice(0, 10), date_to: d1.toISOString().slice(0, 10),
      metrics: "cost", aggregation_type: "daily", limit: "100", offset: "0",
    });
    const r = await fetch(`${API}/advertising/advertisers/${adv}/product_ads/campaigns?${q}`, {
      headers: { authorization: `Bearer ${auth.access_token}`, "api-version": "2" },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`ML publicidad ${r.status}: ${j.message || "desconocido"}`);
    const rows = Array.isArray(j) ? j : j.results || [];
    for (const row of rows) {
      const m = row.metrics || row;
      const f = row.date || m.date;
      if (f) out[f] = (out[f] || 0) + Number(m.cost || 0);
    }
    d0 = new Date(d1.getTime() + 864e5);
  }
  return out;
}
