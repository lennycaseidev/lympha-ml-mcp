import { exchangeCode, redirectUri } from "../../lib/ml.js";

export default async function handler(req, res) {
  if (!process.env.MCP_SECRET || req.query.state !== process.env.MCP_SECRET || !req.query.code) {
    res.status(400).send("Autorización inválida. Volvé a entrar por /api/ml/login?key=TU_MCP_SECRET");
    return;
  }
  try {
    const userId = await exchangeCode(req.query.code, redirectUri(req));
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(`<p style="font:16px system-ui;padding:24px">Listo: Mercado Libre conectado (vendedor ${userId}). Ya podés cerrar esta pestaña.</p>`);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
}
