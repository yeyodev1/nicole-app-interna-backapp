# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Dev server:** `pnpm dev` (ts-node-dev with auto-restart, default port 8100)
- **Build:** `pnpm build` (tsc → `dist/`)
- **Start prod:** `pnpm start` (runs `node dist/index.js`)
- **Watch compile:** `pnpm compile` (tsc --watch)
- **Format:** `pnpm format` (Prettier)
- **Seed users:** `pnpm seed:users`
- **Seed vendedores:** `pnpm seed:sellers` (`-- --source sucree`, `-- --dry-run`)
- **No test runner is configured.**

## Tech Stack

- Express 5 + TypeScript (CommonJS, target ES2024)
- MongoDB via Mongoose (connection string from `DB_URI` env var)
- JWT authentication (Bearer tokens, 2h expiry)
- Cloudinary for file uploads, Multer for multipart handling
- Contífico API integration (external accounting/ERP system)
- Google Generative AI (`@google/genai`) and OpenAI SDKs
- Resend for email delivery
- PDFKit for PDF generation
- Deployed on Vercel (`vercel.json` routes all traffic to `dist/index.js`)

## Architecture

### Request Flow

All routes are mounted under `/api` prefix. The flow is:
`Express app → CORS → JSON parser (50mb limit) → /api router → route-specific handlers → globalErrorHandler`

### API Routes (`/api/...`)

| Prefix | Router |
|---|---|
| `/orders` | Order CRUD and management |
| `/products` | Product catalog (Contífico integration) |
| `/persons` | Person/client records |
| `/documents` | Document generation |
| `/analytics` | Sales/reporting analytics |
| `/users` | Auth (login) and user management |
| `/production` | Production workflow |
| `/pos` | Point of sale operations |
| `/replenishment` | Inventory replenishment |
| `/delivery-personnel` | Delivery person management |
| `/providers` | Supplier management |
| `/raw-materials` | Raw material inventory |
| `/provider-categories` | Supplier categorization |
| `/warehouse` | Warehouse/stock movements |
| `/sellers` | Vendedores asignables a la factura (comisiones) |
| `/web-orders` | Pedidos de la tienda online (sin JWT, header `x-api-key` = `WEB_ORDERS_API_KEY`) |

### Layered Structure

- **Routes** (`src/routes/`) — Define endpoints, apply `authMiddleware`, delegate to controllers
- **Controllers** (`src/controllers/`) — Handle req/res, call services
- **Services** (`src/services/`) — Business logic and external API calls
- **Models** (`src/models/`) — Mongoose schemas/models

### Key Patterns

- **Auth middleware** (`src/middlewares/auth.middleware.ts`) — Verifies JWT Bearer token, attaches decoded payload to `req.user` (typed as `AuthRequest`)
- **Custom errors** — Throw `CustomError` (from `src/errors/customError.error.ts`) with status code; caught by `globalErrorHandler`
- **Contífico service** (`src/services/contifico.service.ts`) — External ERP integration with in-memory cache (1h TTL for products/categories). Credentials: `CONTIFICO_API_KEY`, `CONTIFICO_TOKEN`
- **Numeración de facturas** — El número sale de `nextInvoiceNumber()`: serie fija (001-001 = CDP) + contador atómico en Mongo (`InvoiceSequence`). El contador continúa la secuencia real de la serie: se siembra/corrige con `pnpm seed:invoice-sequence -- --desde 14/01/2026` (máximo entre Mongo y todo el historial de Contífico). La re-sincronización automática sólo sube el contador (`$max`); bajarlo es manual (`--force`). Los secuenciales del rango `CONTIFICO_SECUENCIALES_EXCLUIDOS` (1000001–1000010, las 10 facturas del 07–08/09/2026) se saltan al asignar y se ignoran al leer Contífico. Historia completa en `src/config/contifico-emision.config.ts`.
- **Vendedor en la factura** — `resolveVendedorPayload()` mapea el pedido a una persona `es_vendedor` de Contífico (catálogo `Seller`, expuesto en `/api/sellers`) y lo envía como `vendedor_id`. Es la base del reporte de comisiones.
- **Catálogo de vendedores** — `sellers` se siembra desde las personas `es_vendedor` de cada cuenta con `pnpm seed:sellers -- --source <nicole|sucree>`. `createOrder` valida la cédula filtrando por `contificoSource`, así que un vendedor de Nicole en un pedido de Sucree devuelve 400; el selector del frontend filtra por la cuenta del carrito.
- **Precio con IVA incluido** — Los productos listados en `src/config/precio-final.config.ts` (Delivery y la Torta Personalizada de Sucree, `TORT-001`) se cotizan a precio final: la base se calcula hacia atrás (`precio / 1.15`) y el total de la factura da exactamente el valor tecleado. El frontend replica la lista en `src/constants/pricing.ts`.
- **Pedidos de la tienda online** — La tienda (nicole-tienda-backapp) llama `POST /api/web-orders` (idempotente por `webOrder.externalId`), `PATCH /api/web-orders/:externalId/payment`, `GET /api/web-orders/contifico-products?q=` y `GET /api/web-orders/status?externalIds=` (solo lectura, máx. 100 ids, proyección mínima para avisar al cliente en qué va su pedido), autenticada con `x-api-key` (`webOrdersApiKey.middleware.ts`, comparación en tiempo constante). El pedido se crea con `salesChannel`/`responsible` = "Tienda Online", `status: "PENDIENTE_GESTION"` y el subdocumento `webOrder`; los precios se guardan sin IVA (`precio / 1.15`) salvo los de precio final. No se toca `invoiceStatus`: se factura como cualquier pedido. El equipo lo cierra con `PATCH /api/orders/:id/web-managed` (JWT) → `status: "GESTIONADO"`. `GET /api/orders?webPending=true` lista los pendientes (también para SALES_REP) y `salesChannel=` filtra por canal. Reglas propias de los pedidos web (se detectan por `webOrder.externalId`: `webOrder` es un path anidado y existe vacío en todo documento): no se facturan con el producto de prueba (`assertWebOrderProductsLinked` → 400 si algún ítem no tiene `contifico_id`); transferencia pagada → `payments[0]` TRA automático si no había cobros (Payphone solo deja nota en `auditLog`); `registerCollection` marca `webOrder.paymentStatus = PAID` al cubrir el total y no encola factura sin RUC; `generateMissingInvoices` ignora `PENDIENTE_GESTION`; `DELETE` responde 409 (se anulan, no se borran). Comprobante de transferencia: `POST /web-orders` y `PATCH /web-orders/:externalId/payment` aceptan `paymentProofUrl` opcional (https; en el PATCH puede venir solo, sin `paymentStatus`, y `""`/`null` lo quita cuando la tienda lo rechaza) → `webOrder.paymentProofUrl`/`paymentProofAt` + entrada en `auditLog`. Contrato: `docs/api-contract.md` del backapp de la tienda.
- **File uploads** — Multer middleware saves to `uploads/` dir with unique filenames (100MB limit, max 10 files)
- **Startup** — `index.ts` connects to MongoDB, seeds default users, then starts the HTTP server (10min timeout)

### Environment Variables

Required: `DB_URI`, `JWT_SECRET`, `CONTIFICO_API_KEY`, `CONTIFICO_TOKEN`. Check `.env` for additional keys (Cloudinary, Resend, Google AI, OpenAI, Firebase).

Optional, integración con la tienda online: `WEB_ORDERS_API_KEY=` (clave compartida para `/api/web-orders`; sin ella esas rutas responden 503), `CONTIFICO_DELIVERY_ID=` (producto de Contífico del ítem Delivery de los pedidos web; default `0pZeVwVRNf8ZAaGW`, "Delivery" código 950 de Nicole, en `precio-final.config.ts`).
`CONTIFICO_PAYPHONE_TIPO_PING` (opcional, default `D`): procesador del cobro TC de pedidos web pagados con Payphone. Los pedidos web sin datos de factura se facturan a Consumidor Final (9999999999999) con el correo del cliente; al quedar pagados entran en cola (`invoiceStatus` PENDING) para el cron nocturno, que no factura pedidos web anulados.

Optional, punto de emisión de facturas (`src/config/contifico-emision.config.ts`):
`CONTIFICO_ESTABLECIMIENTO` (default `001`), `CONTIFICO_PUNTO_EMISION` (default `001` = Matriz / CDP),
`CONTIFICO_SECUENCIAL_MINIMO` (piso opcional del contador, default 0), `CONTIFICO_SECUENCIALES_EXCLUIDOS` (default `1000001-1000010`: rango que se salta y se ignora al leer Contífico).

### Models (Mongoose)

`Order`, `DailySummary`, `User`, `ParLevel`, `DeliveryPerson`, `Provider`, `RawMaterial`, `ProviderCategory`, `WarehouseMovement`, `Seller`, `InvoiceSequence` — all exported from `src/models/index.ts`.

### Scripts

Utility scripts in `scripts/` for database seeding and Contífico API exploration (run with `ts-node-dev`).
