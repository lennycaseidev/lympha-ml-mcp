import { redirectUri } from "../../lib/ml.js";

export default function handler(req, res) {
  const s = process.env.MCP_SECRET || "";
  const k = String(req.query.key || "");
  if (!s || k !== s) {
    res.status(403).send(
      `No autorizado. MCP_SECRET cargado: ${s ? "sí (" + s.length + " caracteres)" : "NO"}. ` +
      `Clave del link: ${k.length} caracteres. ML_CLIENT_ID cargado: ${process.env.ML_CLIENT_ID ? "sí" : "NO"}.`
    );
    return;
  }
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.ML_CLIENT_ID,
    redirect_uri: redirectUri(req),
    state: s,
  });
  res.redirect(302, `https://auth.mercadolibre.com.ar/authorization?${q}`);
}
