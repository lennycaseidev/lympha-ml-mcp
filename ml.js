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
