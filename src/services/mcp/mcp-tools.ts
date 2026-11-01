import { Types } from "mongoose";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { models } from "../../models";

/**
 * Herramientas de SOLO LECTURA del conector de Claude sobre los pedidos de Nicole y Sucrée
 * (la marca es `contificoSource`; los pedidos viejos sin marca son de Nicole). No hay ninguna
 * herramienta que escriba: no se crean, editan ni anulan pedidos desde aquí.
 *
 * Fechas en hora de Ecuador (YYYY-MM-DD). `deliveryDate` se guarda como medianoche UTC del
 * día; `createdAt` es un instante real (Ecuador = UTC-5).
 */
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato AAAA-MM-DD");
const Marca = z.enum(["nicole", "sucree", "todas"]).default("todas");
const FechaPor = z.enum(["registro", "entrega"]).default("registro");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function range(desde: string, hasta: string, fechaPor: "registro" | "entrega") {
  const [y1, m1, d1] = desde.split("-").map(Number);
  const [y2, m2, d2] = hasta.split("-").map(Number);
  if (fechaPor === "entrega") {
    return { deliveryDate: { $gte: new Date(Date.UTC(y1!, m1! - 1, d1!)), $lte: new Date(Date.UTC(y2!, m2! - 1, d2!, 23, 59, 59, 999)) } };
  }
  return {
    createdAt: {
      $gte: new Date(Date.UTC(y1!, m1! - 1, d1!, 5)),
      $lte: new Date(Date.UTC(y2!, m2! - 1, d2!, 23, 59, 59, 999) + 5 * 3600 * 1000),
    },
  };
}

function brandFilter(marca: string) {
  if (marca === "sucree") return { contificoSource: "sucree" };
  if (marca === "nicole") return { contificoSource: { $ne: "sucree" } };
  return {};
}

const NOT_VOID = { voidedAt: null, productionStage: { $ne: "VOID" } };
const brandOf = (o: any) => (o.contificoSource === "sucree" ? "Sucrée" : "Nicole");
const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const ecDateTime = (d: any) => (d ? new Date(new Date(d).getTime() - 5 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ") : null);
const paidOf = (o: any) => money((o.payments || []).reduce((s: number, p: any) => s + (Number(p.monto) || 0), 0));

function compact(o: any) {
  return {
    id: String(o._id),
    marca: brandOf(o),
    cliente: o.customerName,
    canal: o.salesChannel,
    responsable: o.responsible,
    registrado: ecDateTime(o.createdAt),
    entrega: ymd(o.deliveryDate),
    hora: o.deliveryTime || null,
    tipo: o.deliveryType,
    sucursal: o.branch || null,
    total: money(o.totalValue),
    pagado: paidOf(o),
    pago_pendiente: money(Math.max(0, (o.totalValue || 0) - paidOf(o))),
    factura: o.settledInIsland ? "facturado en isla" : o.invoiceStatus || "sin factura",
    produccion: o.productionStage,
    despacho: o.dispatchStatus,
    anulado: !!o.voidedAt || o.productionStage === "VOID",
    codigo_web: o.webOrder?.code || null,
  };
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function buildMcpServer(userEmail: string) {
  const server = new McpServer(
    { name: "nicole-sucree-lectura", version: "1.0.0" },
    {
      instructions:
        "Datos en vivo de la app interna de Nicole Pastry Arts y Sucrée (pedidos, ventas, entregas y facturación). " +
        `Solo lectura. Conectado como ${userEmail}. Fechas en hora de Ecuador (AAAA-MM-DD). ` +
        "Montos en dólares con IVA (total del pedido). marca: nicole | sucree | todas.",
    }
  );

  server.registerTool(
    "resumen_ventas",
    {
      title: "Resumen de ventas",
      description:
        "Totales de un rango de fechas: número de pedidos, ventas ($ con IVA), cobrado, ticket promedio y desglose por marca, canal y tipo de entrega. Excluye anulados.",
      inputSchema: { desde: YMD, hasta: YMD, marca: Marca, fecha_por: FechaPor },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, marca, fecha_por }) => {
      const orders: any[] = await models.orders
        .find({ ...range(desde, hasta, fecha_por), ...brandFilter(marca), ...NOT_VOID })
        .select("totalValue payments contificoSource salesChannel deliveryType")
        .lean();
      const by = (key: (o: any) => string) => {
        const acc: Record<string, { pedidos: number; ventas: number }> = {};
        for (const o of orders) {
          const k = key(o) || "Sin dato";
          acc[k] ||= { pedidos: 0, ventas: 0 };
          acc[k].pedidos++;
          acc[k].ventas = money(acc[k].ventas + (o.totalValue || 0));
        }
        return acc;
      };
      const ventas = money(orders.reduce((s, o) => s + (o.totalValue || 0), 0));
      return json({
        rango: { desde, hasta, fecha_por, marca },
        pedidos: orders.length,
        ventas,
        cobrado: money(orders.reduce((s, o) => s + paidOf(o), 0)),
        ticket_promedio: orders.length ? money(ventas / orders.length) : 0,
        por_marca: by(brandOf),
        por_canal: by((o) => o.salesChannel),
        por_tipo: by((o) => o.deliveryType),
      });
    }
  );

  server.registerTool(
    "buscar_pedidos",
    {
      title: "Buscar pedidos",
      description:
        "Lista pedidos (máx. 100) por rango de fechas, marca, canal, texto (cliente o teléfono) y estado de pago. Devuelve datos resumidos; usa ver_pedido para el detalle.",
      inputSchema: {
        desde: YMD.optional(),
        hasta: YMD.optional(),
        fecha_por: FechaPor,
        marca: Marca,
        canal: z.string().optional().describe("Canal de venta exacto, p. ej. 'Tienda Online'"),
        texto: z.string().optional().describe("Nombre del cliente o teléfono"),
        pago: z.enum(["todos", "pendiente", "pagado"]).default("todos"),
        incluir_anulados: z.boolean().default(false),
        limite: z.number().int().min(1).max(100).default(30),
      },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, fecha_por, marca, canal, texto, pago, incluir_anulados, limite }) => {
      const q: any = { ...brandFilter(marca), ...(incluir_anulados ? {} : NOT_VOID) };
      if (desde || hasta) Object.assign(q, range(desde || hasta!, hasta || desde!, fecha_por));
      if (canal) q.salesChannel = canal;
      if (texto) {
        const safe = texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const digits = texto.replace(/\D/g, "");
        q.$or = [{ customerName: new RegExp(safe, "i") }, ...(digits.length >= 6 ? [{ customerPhone: new RegExp(digits.slice(-8)) }] : [])];
      }
      let orders: any[] = await models.orders
        .find(q)
        .sort({ createdAt: -1 })
        .limit(pago === "todos" ? limite : 500)
        .select("customerName salesChannel responsible createdAt deliveryDate deliveryTime deliveryType branch totalValue payments invoiceStatus settledInIsland productionStage dispatchStatus voidedAt contificoSource webOrder.code")
        .lean();
      if (pago !== "todos") {
        orders = orders.filter((o) => (paidOf(o) >= (o.totalValue || 0) - 0.05) === (pago === "pagado")).slice(0, limite);
      }
      return json({ total: orders.length, pedidos: orders.map(compact) });
    }
  );

  server.registerTool(
    "ver_pedido",
    {
      title: "Ver pedido",
      description: "Detalle completo de un pedido por su id (el que devuelve buscar_pedidos) o por su código web (NP-XXXXXX).",
      inputSchema: { id_o_codigo: z.string().min(3) },
      annotations: READ_ONLY,
    },
    async ({ id_o_codigo }) => {
      const key = id_o_codigo.trim();
      const o: any = Types.ObjectId.isValid(key)
        ? await models.orders.findById(key).lean()
        : await models.orders.findOne({ "webOrder.code": key.toUpperCase() }).lean();
      if (!o) return json({ error: "No encontré ese pedido." });
      return json({
        ...compact(o),
        telefono: o.customerPhone,
        direccion: o.deliveryAddress || null,
        comentarios: o.comments || null,
        vendedor: o.sellerName || null,
        productos: (o.products || []).map((p: any) => ({
          nombre: p.name,
          cantidad: p.quantity,
          precio_sin_iva: money(p.price),
          cortesia: !!p.isCourtesy,
          nota: p.customerNote || null,
        })),
        delivery: money(o.deliveryValue),
        descuento_global: o.globalDiscountPercentage || 0,
        pagos: (o.payments || []).map((p: any) => ({ forma: p.forma_cobro || p.method || null, monto: money(p.monto), fecha: ymd(p.fecha) })),
        factura_numero: o.invoiceInfo?.documento || o.invoiceInfo?.numero || null,
        historial: (o.auditLog || []).slice(-10).map((a: any) => ({ quien: a.user, que: a.action, cuando: ecDateTime(a.at), detalle: a.details || null })),
      });
    }
  );

  server.registerTool(
    "productos_mas_vendidos",
    {
      title: "Productos más vendidos",
      description: "Ranking de productos por cantidad vendida en un rango (sin anulados ni cortesías). Montos sin IVA.",
      inputSchema: { desde: YMD, hasta: YMD, marca: Marca, fecha_por: FechaPor, limite: z.number().int().min(1).max(100).default(20) },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, marca, fecha_por, limite }) => {
      const rows = await models.orders.aggregate([
        { $match: { ...range(desde, hasta, fecha_por), ...brandFilter(marca), ...NOT_VOID } },
        { $unwind: "$products" },
        { $match: { "products.isCourtesy": { $ne: true }, "products.name": { $not: /delivery|env[ií]o/i } } },
        {
          $group: {
            _id: "$products.name",
            cantidad: { $sum: "$products.quantity" },
            ventas_sin_iva: { $sum: { $multiply: ["$products.quantity", "$products.price"] } },
            pedidos: { $sum: 1 },
          },
        },
        { $sort: { cantidad: -1 } },
        { $limit: limite },
      ]);
      return json({
        rango: { desde, hasta, fecha_por, marca },
        productos: rows.map((r: any) => ({ producto: r._id, cantidad: r.cantidad, pedidos: r.pedidos, ventas_sin_iva: money(r.ventas_sin_iva) })),
      });
    }
  );

  server.registerTool(
    "entregas_del_dia",
    {
      title: "Entregas del día",
      description: "Pedidos con entrega o retiro en una fecha, ordenados por hora, con su estado de producción, despacho y pago.",
      inputSchema: { fecha: YMD, marca: Marca, tipo: z.enum(["todos", "delivery", "retiro"]).default("todos") },
      annotations: READ_ONLY,
    },
    async ({ fecha, marca, tipo }) => {
      const q: any = { ...range(fecha, fecha, "entrega"), ...brandFilter(marca), ...NOT_VOID };
      if (tipo !== "todos") q.deliveryType = tipo;
      const orders: any[] = await models.orders
        .find(q)
        .select("customerName salesChannel responsible createdAt deliveryDate deliveryTime deliveryType branch totalValue payments invoiceStatus settledInIsland productionStage dispatchStatus voidedAt contificoSource webOrder.code")
        .lean();
      orders.sort((a, b) => String(a.deliveryTime || "").localeCompare(String(b.deliveryTime || "")));
      return json({
        fecha,
        total: orders.length,
        deliveries: orders.filter((o) => o.deliveryType === "delivery").length,
        retiros: orders.filter((o) => o.deliveryType === "retiro").length,
        pedidos: orders.map(compact),
      });
    }
  );

  server.registerTool(
    "estado_facturacion",
    {
      title: "Estado de facturación",
      description: "Cuántos pedidos están facturados, en cola, con error o sin factura en un rango, y la lista de los que tienen error.",
      inputSchema: { desde: YMD, hasta: YMD, marca: Marca, fecha_por: FechaPor },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, marca, fecha_por }) => {
      const orders: any[] = await models.orders
        .find({ ...range(desde, hasta, fecha_por), ...brandFilter(marca), ...NOT_VOID })
        .select("customerName invoiceStatus invoiceError settledInIsland totalValue createdAt deliveryDate contificoSource")
        .lean();
      const count: Record<string, number> = { facturado: 0, en_cola: 0, error: 0, sin_factura: 0, facturado_en_isla: 0 };
      for (const o of orders) {
        if (o.settledInIsland) count.facturado_en_isla!++;
        else if (o.invoiceStatus === "PROCESSED") count.facturado!++;
        else if (o.invoiceStatus === "PENDING") count.en_cola!++;
        else if (o.invoiceStatus === "ERROR") count.error!++;
        else count.sin_factura!++;
      }
      return json({
        rango: { desde, hasta, fecha_por, marca },
        pedidos: orders.length,
        ...count,
        con_error: orders
          .filter((o) => o.invoiceStatus === "ERROR")
          .slice(0, 50)
          .map((o) => ({ id: String(o._id), marca: brandOf(o), cliente: o.customerName, total: money(o.totalValue), error: o.invoiceError || null })),
      });
    }
  );

  return server;
}
