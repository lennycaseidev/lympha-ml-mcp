# Lympha ML — conector de Mercado Libre para Claude

Servidor MCP chico que lee las ventas pagadas de tu cuenta de Mercado Libre y se las da al dashboard de stock.
Corre gratis en Vercel. El token de ML se guarda en Upstash Redis y se renueva solo.

## Setup (una sola vez, ~15 min)

1. **Subí esta carpeta a GitHub** como repo privado (`lympha-ml-mcp`).
2. **Vercel** → Add New → Project → importá el repo → Deploy. Anotá la URL (ej. `https://lympha-ml-mcp.vercel.app`).
3. **Vercel → tu proyecto → Storage → Create → Upstash (Redis)** → plan free → conectalo al proyecto.
   Esto agrega solo las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN`.
4. **Mercado Libre** → https://developers.mercadolibre.com.ar → Mis aplicaciones → Crear aplicación:
   - Redirect URI: `https://TU-URL.vercel.app/api/ml/callback`
   - Permisos: lectura de órdenes/ventas + `offline_access`
   - PKCE: desactivado
   - Copiá **Client ID** y **Client Secret**.
5. **Vercel → Settings → Environment Variables**, agregá:
   - `ML_CLIENT_ID` = tu Client ID
   - `ML_CLIENT_SECRET` = tu Client Secret
   - `MCP_SECRET` = una clave larga al azar (no la compartas)
   Después: Deployments → Redeploy.
6. **Autorizá ML:** abrí `https://TU-URL.vercel.app/api/ml/login?key=TU_MCP_SECRET`, logueate con la cuenta vendedora y aceptá.
   Tiene que decir "Listo: Mercado Libre conectado".
7. **claude.ai → Ajustes → Conectores → Agregar conector personalizado:**
   - Nombre: **`Lympha ML`** (exacto, el dashboard lo busca con ese nombre)
   - URL: `https://TU-URL.vercel.app/api/mcp/TU_MCP_SECRET`
   - Sin autenticación
8. Abrí el dashboard y aceptá el permiso para "Lympha ML". La sección Canales pasa a decir "automático".

## Herramienta

`ml_ventas_por_dia({ desde, hasta?, filtro? })` → unidades y órdenes pagadas por día (hora Argentina), sin canceladas.

## Si algo falla

- "no está autorizado todavía" → repetí el paso 6.
- Error de token después de semanas sin uso → repetí el paso 6 (ML vence el refresh token si no se usa por 6 meses).
- 404 en la URL del conector → el secreto de la URL no coincide con `MCP_SECRET`.
