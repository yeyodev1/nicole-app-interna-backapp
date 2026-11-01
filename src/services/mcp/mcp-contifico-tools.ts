import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Registro sin inferencia de tipos: con ~20 herramientas, tsc se quedaba sin memoria en Vercel. zod valida igual en ejecución. */
const reg = (server: unknown) => (server as any).registerTool.bind(server) as (name: string, config: any, cb: (args: any) => Promise<any>) => void;
import { ContificoService } from "../contifico.service";

/**
 * Contífico EN TIEMPO REAL (cada llamada consulta la API) de las dos empresas: Nicole y
 * Sucrée (cuentas distintas). SOLO LECTURA: facturas y documentos, ventas por punto de
 * emisión y vendedor, productos, stock y clientes. Nada se crea ni se modifica.
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `No pude leer Contífico: ${(e as Error).message}` }], isError: true });
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa AAAA-MM-DD");
const Empresa = z.enum(["nicole", "sucree", "ambas"]).default("ambas");
const Tipo = z.enum(["FAC", "NCT", "PRE", "COT", "todos"]).default("FAC").describe("FAC factura, NCT nota de crédito, PRE pre-factura, COT cotización");

const services: Record<string, ContificoService> = { nicole: new ContificoService("nicole"), sucree: new ContificoService("sucree") };
const label = { nicole: "Nicole", sucree: "Sucrée" } as const;
const empresas = (e: string) => (e === "ambas" ? (["nicole", "sucree"] as const) : ([e] as ("nicole" | "sucree")[]));
const dmy = (ymd: string) => ymd.split("-").reverse().join("/");
const num = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;

// Nombres de los puntos de emisión (cajas), 10 min.
const posCache: Record<string, { at: number; map: Map<string, string> }> = {};
async function posNames(src: "nicole" | "sucree") {
  const c = posCache[src];
  if (c && Date.now() - c.at < 600_000) return c.map;
  const list: any[] = await (services[src] as any).getPuntosEmision().catch(() => []);
  const map = new Map<string, string>((list || []).map((p: any) => [p.id, p.direccion || p.nombre || `${p.establecimiento}-${p.punto_emision}`]));
  posCache[src] = { at: Date.now(), map };
  return map;
}

async function documents(src: "nicole" | "sucree", desde: string, hasta: string, tipo: string) {
  const params: Record<string, string> = { fecha_inicial: dmy(desde), fecha_final: dmy(hasta) };
  if (tipo !== "todos") params.tipo = tipo;
  const d = await services[src].getDocuments(params);
  return Array.isArray(d) ? d : [];
}

const compact = (src: "nicole" | "sucree", d: any, pos: Map<string, string>) => ({
  empresa: label[src],
  id: d.id,
  tipo: d.tipo_documento,
  numero: d.documento,
  fecha: d.fecha_emision,
  hora: d.hora_emision || null,
  cliente: d.persona?.razon_social || null,
  identificacion: d.persona?.ruc || d.persona?.cedula || null,
  vendedor: d.vendedor?.razon_social || null,
  punto_emision: pos.get(d.pos) || d.pos,
  subtotal: num(d.subtotal),
  iva: num(d.iva),
  total: num(d.total),
  saldo: num(d.saldo),
  estado: d.anulado ? "anulado" : d.estado === "C" ? "cobrado" : d.estado === "P" ? "pendiente" : d.estado,
  autorizado_sri: !!d.autorizacion,
});

function checkRange(desde: string, hasta: string) {
  const days = (Date.parse(hasta) - Date.parse(desde)) / 86400000;
  if (days < 0) throw new Error("La fecha 'desde' es posterior a 'hasta'.");
  if (days > 62) throw new Error("Máximo 62 días por consulta (Contífico responde lento con rangos grandes).");
}

export function registerContificoTools(server: McpServer) {
  reg(server)(
    "contifico_ventas",
    {
      title: "Ventas en Contífico (tiempo real)",
      description:
        "Lo facturado en Contífico (en vivo) entre dos fechas, por empresa (Nicole, Sucrée o ambas): total, número de facturas, ticket promedio, por punto de emisión/caja, por vendedor y por día. Excluye anuladas. Máx. 62 días.",
      inputSchema: { desde: YMD, hasta: YMD, empresa: Empresa },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, empresa }: any) => {
      try {
        checkRange(desde, hasta);
        const out: Record<string, any> = {};
        for (const src of empresas(empresa)) {
          const [docs, pos] = await Promise.all([documents(src, desde, hasta, "FAC"), posNames(src)]);
          const valid = docs.filter((d) => !d.anulado);
          const group = (key: (d: any) => string) => {
            const acc: Record<string, { facturas: number; total: number }> = {};
            for (const d of valid) {
              const k = key(d) || "Sin dato";
              acc[k] ||= { facturas: 0, total: 0 };
              acc[k].facturas++;
              acc[k].total = num(acc[k].total + Number(d.total));
            }
            return acc;
          };
          const total = num(valid.reduce((s, d) => s + Number(d.total), 0));
          out[label[src]] = {
            facturas: valid.length,
            anuladas: docs.length - valid.length,
            total,
            subtotal_sin_iva: num(valid.reduce((s, d) => s + Number(d.subtotal), 0)),
            ticket_promedio: valid.length ? num(total / valid.length) : 0,
            por_punto_emision: group((d) => pos.get(d.pos) || d.pos),
            por_vendedor: group((d) => d.vendedor?.razon_social),
            por_dia: group((d) => d.fecha_emision),
          };
        }
        return json({ desde, hasta, fuente: "Contífico en tiempo real", empresas: out });
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "contifico_productos_vendidos",
    {
      title: "Productos vendidos en Contífico",
      description: "Ranking de productos facturados en Contífico (en vivo) entre dos fechas, por empresa: cantidad y venta sin IVA. Máx. 62 días.",
      inputSchema: { desde: YMD, hasta: YMD, empresa: Empresa, limite: z.number().int().min(1).max(100).default(20) },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, empresa, limite }: any) => {
      try {
        checkRange(desde, hasta);
        const out: Record<string, any> = {};
        for (const src of empresas(empresa)) {
          const docs = (await documents(src, desde, hasta, "FAC")).filter((d) => !d.anulado);
          const acc: Record<string, { cantidad: number; venta_sin_iva: number }> = {};
          for (const d of docs) {
            for (const it of d.detalles || []) {
              const k = it.producto_nombre || it.producto_id;
              acc[k] ||= { cantidad: 0, venta_sin_iva: 0 };
              acc[k].cantidad = num(acc[k].cantidad + Number(it.cantidad));
              acc[k].venta_sin_iva = num(acc[k].venta_sin_iva + Number(it.base_gravable || 0) + Number(it.base_cero || 0));
            }
          }
          out[label[src]] = Object.entries(acc)
            .map(([producto, v]) => ({ producto, ...v }))
            .sort((a, b) => b.cantidad - a.cantidad)
            .slice(0, limite);
        }
        return json({ desde, hasta, fuente: "Contífico en tiempo real", productos: out });
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "contifico_documentos",
    {
      title: "Documentos de Contífico",
      description: "Lista facturas u otros documentos de Contífico (en vivo) entre dos fechas, filtrando por cliente, vendedor o estado. Máx. 62 días.",
      inputSchema: {
        desde: YMD,
        hasta: YMD,
        empresa: Empresa,
        tipo: Tipo,
        cliente: z.string().optional().describe("Nombre, RUC o cédula"),
        vendedor: z.string().optional(),
        solo_pendientes_cobro: z.boolean().default(false),
        limite: z.number().int().min(1).max(200).default(50),
      },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, empresa, tipo, cliente, vendedor, solo_pendientes_cobro, limite }: any) => {
      try {
        checkRange(desde, hasta);
        const norm = (s: unknown) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
        const rows: any[] = [];
        for (const src of empresas(empresa)) {
          const [docs, pos] = await Promise.all([documents(src, desde, hasta, tipo), posNames(src)]);
          for (const d of docs) {
            if (cliente && ![d.persona?.razon_social, d.persona?.ruc, d.persona?.cedula].some((v) => norm(v).includes(norm(cliente)))) continue;
            if (vendedor && !norm(d.vendedor?.razon_social).includes(norm(vendedor))) continue;
            if (solo_pendientes_cobro && (d.anulado || Number(d.saldo) <= 0)) continue;
            rows.push(compact(src, d, pos));
          }
        }
        rows.sort((a, b) => `${b.fecha}${b.hora}`.localeCompare(`${a.fecha}${a.hora}`));
        return json({ total: rows.length, documentos: rows.slice(0, limite) });
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "contifico_documento",
    {
      title: "Ver documento de Contífico",
      description: "Detalle de un documento de Contífico (productos, cobros, autorización SRI y link al PDF/RIDE).",
      inputSchema: { empresa: z.enum(["nicole", "sucree"]), id: z.string().min(5) },
      annotations: READ_ONLY,
    },
    async ({ empresa, id }: any) => {
      try {
        const [d, pos] = await Promise.all([services[empresa].getDocument(id), posNames(empresa)]);
        return json({
          ...compact(empresa, d, pos),
          autorizacion: d.autorizacion || null,
          pdf: d.url_ride || null,
          productos: (d.detalles || []).map((it: any) => ({
            producto: it.producto_nombre,
            cantidad: num(it.cantidad),
            precio_sin_iva: Number(it.precio),
            descuento: Number(it.porcentaje_descuento) || 0,
          })),
          cobros: (d.cobros || []).map((c: any) => ({ forma: c.forma_cobro, monto: num(c.monto), fecha: c.fecha })),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "contifico_productos",
    {
      title: "Productos de Contífico",
      description: "Busca productos en el catálogo de Contífico (en vivo) de una empresa: código, precio (PVP sin IVA y con IVA) y estado.",
      inputSchema: { empresa: z.enum(["nicole", "sucree"]), buscar: z.string().min(2), limite: z.number().int().min(1).max(50).default(15) },
      annotations: READ_ONLY,
    },
    async ({ empresa, buscar, limite }: any) => {
      try {
        const list: any[] = await services[empresa].getProducts({ filtro: buscar, result_size: limite });
        return json(
          (list || []).slice(0, limite).map((p: any) => ({
            id: p.id,
            codigo: p.codigo,
            nombre: p.nombre,
            pvp_sin_iva: num(p.pvp1),
            pvp_con_iva: num(Number(p.pvp1) * 1.15),
            estado: p.estado === "A" ? "activo" : p.estado,
            categoria: p.categoria_id || null,
          }))
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "contifico_stock",
    {
      title: "Stock en Contífico",
      description: "Stock por bodega de un producto en Contífico (en vivo). Usa el id que devuelve contifico_productos.",
      inputSchema: { empresa: z.enum(["nicole", "sucree"]), producto_id: z.string().min(5) },
      annotations: READ_ONLY,
    },
    async ({ empresa, producto_id }: any) => {
      try {
        const [stock, bodegas] = await Promise.all([services[empresa].getStockByProduct(producto_id), services[empresa].getWarehouses()]);
        const names = new Map<string, string>((bodegas || []).map((b: any) => [b.id, b.nombre]));
        return json((stock || []).map((s: any) => ({ bodega: names.get(s.bodega_id) || s.bodega_id, cantidad: Number(s.cantidad) })));
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "contifico_cliente",
    {
      title: "Cliente en Contífico",
      description: "Busca un cliente/persona en Contífico por cédula o RUC.",
      inputSchema: { empresa: z.enum(["nicole", "sucree"]), identificacion: z.string().min(10).max(13) },
      annotations: READ_ONLY,
    },
    async ({ empresa, identificacion }: any) => {
      try {
        const p = await services[empresa].findPersona(identificacion.replace(/\D/g, ""));
        if (!p) return json({ encontrado: false });
        return json({ encontrado: true, nombre: p.razon_social, ruc: p.ruc, cedula: p.cedula, correo: p.email, telefono: p.telefonos, direccion: p.direccion, tipo: p.tipo });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
