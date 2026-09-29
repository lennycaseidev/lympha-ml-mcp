import { redirectUri } from "../../lib/ml.js";

export default function handler(req, res) {
  if (!process.env.MCP_SECRET || req.query.key !== process.env.MCP_SECRET) {
    res.status(404).end();
    return;
  }
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.ML_CLIENT_ID,
    redirect_uri: redirectUri(req),
    state: process.env.MCP_SECRET,
  });
  res.redirect(302, `https://auth.mercadolibre.com.ar/authorization?${q}`);
}
