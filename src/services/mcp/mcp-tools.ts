import { Types } from "mongoose";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { models } from "../../models";
import { registerCrmTools } from "./mcp-crm-tools";

/** Registro sin inferencia de tipos: con ~20 herramientas, tsc se quedaba sin memoria en Vercel. zod valida igual en ejecución. */
const reg = (server: unknown) => (server as any).registerTool.bind(server) as (name: string, config: any, cb: (args: any) => Promise<any>) => void;
import { registerContificoTools } from "./mcp-contifico-tools";

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
    factura: o.posInvoiceBranch && o.invoiceStatus !== "PROCESSED" ? `factura en punto de venta (${o.posInvoiceBranch})` : o.settledInIsland ? "facturado en isla" : o.invoiceStatus || "sin factura",
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
        "Montos en dólares con IVA (total del pedido). marca: nicole | sucree | todas. " +
        "Las herramientas crm_* leen el CRM (HighLevel) de Nicole y de Sucrée (subcuentas distintas; parámetro marca: nicole | sucree, por defecto nicole; para comparar, consulta cada una): equipo, quién atiende y cómo, conversaciones, mensajes, contactos, embudo y citas. " +
        "Las herramientas contifico_* consultan Contífico EN TIEMPO REAL (Nicole y Sucrée son empresas separadas): ventas facturadas por caja y vendedor, productos vendidos, documentos, catálogo, stock y clientes. " +
        "Para cifras contables/facturadas usa contifico_*; para pedidos, entregas y producción usa las herramientas de la app interna.",
    }
  );

  reg(server)(
    "resumen_ventas",
    {
      title: "Resumen de ventas",
      description:
        "Totales de un rango de fechas: número de pedidos, ventas ($ con IVA), cobrado, ticket promedio y desglose por marca, canal y tipo de entrega. Excluye anulados.",
      inputSchema: { desde: YMD, hasta: YMD, marca: Marca, fecha_por: FechaPor },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, marca, fecha_por }: any) => {
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

  reg(server)(
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
    async ({ desde, hasta, fecha_por, marca, canal, texto, pago, incluir_anulados, limite }: any) => {
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
        .select("customerName salesChannel responsible createdAt deliveryDate deliveryTime deliveryType branch totalValue payments invoiceStatus settledInIsland posInvoiceBranch productionStage dispatchStatus voidedAt contificoSource webOrder.code")
        .lean();
      if (pago !== "todos") {
        orders = orders.filter((o) => (paidOf(o) >= (o.totalValue || 0) - 0.05) === (pago === "pagado")).slice(0, limite);
      }
      return json({ total: orders.length, pedidos: orders.map(compact) });
    }
  );

  reg(server)(
    "ver_pedido",
    {
      title: "Ver pedido",
      description: "Detalle completo de un pedido por su id (el que devuelve buscar_pedidos) o por su código web (NP-XXXXXX).",
      inputSchema: { id_o_codigo: z.string().min(3) },
      annotations: READ_ONLY,
    },
    async ({ id_o_codigo }: any) => {
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

  reg(server)(
    "productos_mas_vendidos",
    {
      title: "Productos más vendidos",
      description: "Ranking de productos por cantidad vendida en un rango (sin anulados ni cortesías). Montos sin IVA.",
      inputSchema: { desde: YMD, hasta: YMD, marca: Marca, fecha_por: FechaPor, limite: z.number().int().min(1).max(100).default(20) },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, marca, fecha_por, limite }: any) => {
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

  reg(server)(
    "entregas_del_dia",
    {
      title: "Entregas del día",
      description: "Pedidos con entrega o retiro en una fecha, ordenados por hora, con su estado de producción, despacho y pago.",
      inputSchema: { fecha: YMD, marca: Marca, tipo: z.enum(["todos", "delivery", "retiro"]).default("todos") },
      annotations: READ_ONLY,
    },
    async ({ fecha, marca, tipo }: any) => {
      const q: any = { ...range(fecha, fecha, "entrega"), ...brandFilter(marca), ...NOT_VOID };
      if (tipo !== "todos") q.deliveryType = tipo;
      const orders: any[] = await models.orders
        .find(q)
        .select("customerName salesChannel responsible createdAt deliveryDate deliveryTime deliveryType branch totalValue payments invoiceStatus settledInIsland posInvoiceBranch productionStage dispatchStatus voidedAt contificoSource webOrder.code")
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

  reg(server)(
    "estado_facturacion",
    {
      title: "Estado de facturación",
      description: "Cuántos pedidos están facturados, en cola, con error o sin factura en un rango, y la lista de los que tienen error.",
      inputSchema: { desde: YMD, hasta: YMD, marca: Marca, fecha_por: FechaPor },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, marca, fecha_por }: any) => {
      const orders: any[] = await models.orders
        .find({ ...range(desde, hasta, fecha_por), ...brandFilter(marca), ...NOT_VOID })
        .select("customerName invoiceStatus invoiceError settledInIsland posInvoiceBranch totalValue createdAt deliveryDate contificoSource")
        .lean();
      const count: Record<string, number> = { facturado: 0, en_cola: 0, error: 0, sin_factura: 0, facturado_en_isla: 0, factura_punto_de_venta: 0 };
      for (const o of orders) {
        if ((o as any).posInvoiceBranch && o.invoiceStatus !== "PROCESSED") count.factura_punto_de_venta!++;
        else if (o.settledInIsland) count.facturado_en_isla!++;
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

  reg(server)(
    "operaciones_locales",
    {
      title: "Operaciones por local",
      description:
        "Por local y día, con anomalías: despacho del CDP (pedido de reposición vs. despachado), Recepción Masiva de la isla " +
        "(registrada o no, faltantes y dañados) y Cierre de Producción del día (enviado o no, productos sin reporte y bajas). " +
        "Panel de gestión para comprobar que cada local usa esas pantallas de la app.",
      inputSchema: { fecha: YMD },
      annotations: READ_ONLY,
    },
    async ({ fecha }: any) => {
      const [y, m, d] = fecha.split("-").map(Number);
      const day = new Date(Date.UTC(y!, m! - 1, d!));
      const MAX = 60; // tope de anomalías por lista
      const [restocks, cierres]: [any[], any[]] = await Promise.all([
        models.orders
          .find({ ...range(fecha, fecha, "entrega"), ...NOT_VOID, salesChannel: { $in: ["Restock", "Restock-Bodega"] } })
          .select("branch salesChannel dispatchStatus products._id products.name products.quantity dispatches")
          .lean(),
        models.posDailyEntries.find({ date: day }).select("branch status submittedAt submittedBy items.productName items.stockFinal items.bajas items.bajasNote").lean(),
      ]);

      const locales: Record<string, any> = {};
      const local = (branch: string) => {
        const k = String(branch || "Sin sucursal").trim();
        return (locales[k.toLowerCase()] ||= {
          sucursal: k,
          despacho: { pedidos: [] as any[], anomalias: [] as any[] },
          recepcion: { despachos: 0, registrados: 0, con_problema: 0, pendientes: 0, ultima: null, por: null, notas: [] as string[], anomalias: [] as any[] },
          cierre: { enviado: false, hora: null, por: null, productos: 0, sin_reporte: 0, productos_sin_reporte: [] as string[], bajas: [] as any[] },
        });
      };

      for (const o of restocks) {
        const L = local(o.branch);
        const r = L.recepcion;
        L.despacho.pedidos.push({ id: String(o._id), canal: o.salesChannel, estado: o.dispatchStatus });

        // Despacho: pedido de reposición vs. lo que el CDP registró como despachado
        const sent: Record<string, number> = {};
        const keyOf = (id: any, name: any) => String(id || name || "").toLowerCase();
        const byId: Record<string, string> = {};
        for (const p of o.products || []) byId[String(p._id)] = String(p.name || "").toLowerCase();
        for (const disp of o.dispatches || [])
          for (const it of disp.items || []) {
            const k = byId[String(it.productId)] ?? keyOf(null, it.name);
            sent[k] = (sent[k] || 0) + (Number(it.quantitySent) || 0);
          }
        const seen = new Set<string>();
        for (const p of o.products || []) {
          const k = String(p.name || "").toLowerCase();
          seen.add(k);
          const pedido = Number(p.quantity) || 0, env = sent[k] || 0;
          if (env !== pedido && L.despacho.anomalias.length < MAX)
            L.despacho.anomalias.push({ producto: p.name, pedido, despachado: env, tipo: env === 0 ? "no despachado" : env < pedido ? "faltó" : "de más" });
        }
        for (const disp of o.dispatches || [])
          for (const it of disp.items || []) {
            const k = byId[String(it.productId)] ?? keyOf(null, it.name);
            if (!seen.has(k) && L.despacho.anomalias.length < MAX) {
              seen.add(k);
              L.despacho.anomalias.push({ producto: it.name, pedido: 0, despachado: sent[k], tipo: "no estaba en el pedido" });
            }
          }

        // Recepción Masiva
        for (const disp of o.dispatches || []) {
          r.despachos++;
          if (disp.receptionStatus === "PENDING" || !disp.receptionStatus) {
            r.pendientes++;
            if (r.anomalias.length < MAX)
              r.anomalias.push({ tipo: "no registrado", despachado: ecDateTime(disp.reportedAt), productos: (disp.items || []).length });
            continue;
          }
          r.registrados++;
          if (disp.receptionStatus === "PROBLEM") r.con_problema++;
          const at = ecDateTime(disp.receivedAt);
          if (at && (!r.ultima || at > r.ultima)) {
            r.ultima = at;
            r.por = disp.receivedBy || null;
          }
          if (disp.receptionNotes) r.notas.push(String(disp.receptionNotes).slice(0, 200));
          for (const it of disp.items || []) {
            const rec = it.quantityReceived ?? it.quantitySent;
            if ((it.itemStatus && it.itemStatus !== "OK") || rec !== it.quantitySent) {
              if (r.anomalias.length < MAX)
                r.anomalias.push({ tipo: it.itemStatus || "diferencia", producto: it.name, enviado: it.quantitySent, recibido: rec, nota: it.itemNote || null });
            }
          }
        }
      }

      for (const e of cierres) {
        const c = local(e.branch).cierre;
        const items = e.items || [];
        c.enviado = e.status !== "draft";
        c.hora = ecDateTime(e.submittedAt);
        c.por = e.submittedBy || null;
        c.productos = items.length;
        const sinRep = items.filter((i: any) => i.stockFinal == null);
        c.sin_reporte = sinRep.length;
        c.productos_sin_reporte = sinRep.slice(0, MAX).map((i: any) => i.productName);
        c.bajas = items
          .filter((i: any) => Number(i.bajas) > 0)
          .slice(0, MAX)
          .map((i: any) => ({ producto: i.productName, cantidad: i.bajas, nota: i.bajasNote || null }));
      }

      return json({
        fecha,
        nota: "despacho/recepcion = reposición con entrega ese día; cierre = Cierre de Producción de ese día (pide la reposición del día siguiente). Listas de anomalías con tope de 60.",
        locales: Object.values(locales).sort((a: any, b: any) => a.sucursal.localeCompare(b.sucursal)),
      });
    }
  );

  registerCrmTools(server);
  registerContificoTools(server);

  return server;
}
