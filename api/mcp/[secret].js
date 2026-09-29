import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { salesByDay } from "../../lib/ml.js";

function buildServer() {
  const server = new McpServer({ name: "lympha-mercadolibre", version: "1.0.0" });
  server.registerTool(
    "ml_ventas_por_dia",
    {
      title: "Ventas de Mercado Libre por día",
      description:
        "Unidades vendidas y órdenes pagadas en Mercado Libre agrupadas por día (hora Argentina). Excluye canceladas.",
      inputSchema: {
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha inicial YYYY-MM-DD"),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Fecha final YYYY-MM-DD, por defecto hoy"),
        filtro: z.string().optional().describe("Solo cuenta ítems cuyo título contenga este texto"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const data = await salesByDay(args);
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    }
  );
  return server;
}

export default async function handler(req, res) {
  if (!process.env.MCP_SECRET || req.query.secret !== process.env.MCP_SECRET) {
    res.status(404).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).setHeader("allow", "POST").end();
    return;
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
