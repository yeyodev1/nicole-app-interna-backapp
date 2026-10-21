import { Resend } from "resend";
import { models } from "../models";
import { POSRestockService } from "./pos-restock.service";
import { ContificoService } from "./contifico.service";
import { normalizeString } from "../utils/string.utils";
import { buildContificoCategoryMaps, CategoryMaps } from "../utils/contifico-categorias.util";

const FROM_ADDRESS = process.env.EMAIL_FROM || "Nicole Pastry Arts <app@nicole.com.ec>";

export interface OperationsProductRow {
  name: string;
  categoria: string | null; // tal cual Contífico (subcategorías de "Producto Venta")
  inicial: number | null; // con cuánto empezó el día (cierre anterior)
  recibido: number; // total que le llegó (confirmado + despachado sin OK)
  recibidoOk: number; // confirmado en Recepción Masiva (el OK)
  recibidoSinOk: number; // despachado por producción pero SIN el OK de la isla
  vendido: number | null; // vendido según Contífico
  bajas: number;
  deberiaQuedar: number | null; // inicial + recibido - vendido - bajas
  quedo: number | null; // lo que contó el cierre (stockFinal)
  // quedo - deberiaQuedar: negativo = FALTA producto (perdido o vendido sin
  // factura); positivo = SOBRA (recepción sin registrar o error de conteo)
  descuadre: number | null;
  ventaCierre: number | null; // venta implícita del cierre (dato de apoyo)
  pedidoFinal: number;
}

export interface OperationsBranchReport {
  branch: string;
  salesAvailable: boolean;
  hasClosing: boolean;
  /** Unidades despachadas por producción que la isla NO confirmó (sin OK). */
  sinOkTotal: number;
  totals: { vendido: number; ventaCierre: number; bajas: number; recibido: number; descuadre: number };
  products: OperationsProductRow[];
  losses: Array<{ productName: string; quantity: number; reason: string; category: string }>;
}

/**
 * Reporte del Jefe de Operaciones: por día y sucursal cruza la venta real de
 * Contífico con los datos internos (cierres, bajas, recepciones) y calcula
 * qué no cuadra. También dispara las alertas por correo (Resend) cuando una
 * sucursal envía su cierre.
 */
export class OperationsReportService {
  private posRestock = new POSRestockService();
  private resend = new Resend(process.env.RESEND_API_KEY);
  private contifico = new ContificoService("nicole");

  /** Lista de días YYYY-MM-DD entre from y to (inclusive). */
  private daysBetween(from: string, to: string): string[] {
    const days: string[] = [];
    const cursor = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    while (cursor <= end) {
      days.push(cursor.toISOString().split("T")[0]);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }

  /**
   * Reporte de un día o de un rango desde–hasta (máx. 31 días).
   * En rango: inicial = primer día, quedó = último día, y recibido/vendido/
   * bajas se acumulan. Cada día de Contífico usa la caché en Mongo.
   */
  async getReport(fromStr: string, toStr?: string) {
    const from = fromStr;
    const to = toStr && toStr >= fromStr ? toStr : fromStr;
    const days = this.daysBetween(from, to).slice(0, 31);
    const realTo = days[days.length - 1];

    const activeBranches = (await models.branches
      .find({ isActive: true })
      .sort({ sortOrder: 1 })
      .lean()) as any[];

    const dayStart = new Date(`${from}T00:00:00.000Z`);
    const dayEnd = new Date(`${realTo}T23:59:59.999Z`);

    const [leftovers, lossesDocs, categoryMaps, ...dispatchMaps] = await Promise.all([
      this.posRestock.getLeftovers({ from, to: realTo }),
      models.posLosses.find({ date: { $gte: dayStart, $lte: dayEnd } }).lean() as Promise<any[]>,
      buildContificoCategoryMaps(this.contifico),
      ...days.map((d) => this.getDispatchByDay(d)),
    ]);

    // Unir los despachos de todos los días del rango
    const dispatchMap = new Map<string, { ok: number; sinOk: number }>();
    for (const dm of dispatchMaps as Map<string, { ok: number; sinOk: number }>[]) {
      for (const [key, v] of dm) {
        const entry = dispatchMap.get(key) || { ok: 0, sinOk: 0 };
        entry.ok += v.ok;
        entry.sinOk += v.sinOk;
        dispatchMap.set(key, entry);
      }
    }

    const branches: OperationsBranchReport[] = [];
    for (const b of activeBranches) {
      const report = await this.buildBranchRange(b.name, days, leftovers, lossesDocs, categoryMaps, dispatchMap);
      if (report.salesAvailable || report.products.length > 0) branches.push(report);
    }

    return {
      date: from,
      from,
      to: realTo,
      branches,
      missingClosings: leftovers.missing.filter((m: any) =>
        branches.some(b => normalizeString(b.branch) === normalizeString(m.branch))
      ),
    };
  }

  /**
   * Lo despachado a cada sucursal en el día, enlazado al flujo real:
   * producción despacha (reportedAt) y la isla da el OK en Recepción Masiva
   * (receivedAt). Lo confirmado cuenta como OK; lo despachado sin confirmar
   * cuenta aparte (sinOk) para que igual conste y el jefe lo vea.
   * Clave: `${sucursal normalizada}|${producto normalizado}`.
   */
  private async getDispatchByDay(dateStr: string): Promise<Map<string, { ok: number; sinOk: number }>> {
    const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
    // receivedAt/reportedAt son timestamps: bordes EC (UTC-5)
    const start = new Date(dayStart.getTime());
    const end = new Date(dayStart.getTime() + 24 * 3600000 + 5 * 3600000);
    const ecDay = (d: Date) => new Date(d.getTime() - 5 * 3600000).toISOString().split("T")[0];

    const orders = (await models.orders
      .find(
        {
          $or: [
            { "dispatches.receivedAt": { $gte: start, $lte: end } },
            { "dispatches.reportedAt": { $gte: start, $lte: end } },
          ],
        },
        { dispatches: 1 }
      )
      .lean()) as any[];

    const map = new Map<string, { ok: number; sinOk: number }>();
    const bump = (branch: string, product: string, field: "ok" | "sinOk", qty: number) => {
      if (!qty) return;
      const key = `${normalizeString(branch)}|${normalizeString(product)}`;
      const entry = map.get(key) || { ok: 0, sinOk: 0 };
      entry[field] += qty;
      map.set(key, entry);
    };

    for (const order of orders) {
      for (const dispatch of order.dispatches || []) {
        const dest = String(dispatch.destination || "");
        if (!dest) continue;

        const confirmed = dispatch.receptionStatus !== "PENDING" && dispatch.receivedAt;
        if (confirmed) {
          if (ecDay(new Date(dispatch.receivedAt)) !== dateStr) continue;
          for (const item of dispatch.items || []) {
            bump(dest, item.name || "", "ok", item.quantityReceived ?? item.quantitySent ?? 0);
          }
        } else {
          if (!dispatch.reportedAt || ecDay(new Date(dispatch.reportedAt)) !== dateStr) continue;
          for (const item of dispatch.items || []) {
            bump(dest, item.name || "", "sinOk", item.quantitySent ?? 0);
          }
        }
      }
    }
    return map;
  }

  private async buildBranchRange(
    branch: string,
    days: string[],
    leftovers: any,
    lossesDocs: any[],
    categoryMaps: CategoryMaps,
    dispatchMap: Map<string, { ok: number; sinOk: number }>
  ): Promise<OperationsBranchReport> {
    // Venta de Contífico acumulada en el rango (cada día sale de la caché Mongo)
    let salesAvailable = false;
    const salesTotals: Record<string, number> = {};
    for (const day of days) {
      const daySales = await this.posRestock.getDailySales(branch, day);
      if (!daySales.available) continue;
      salesAvailable = true;
      for (const [name, qty] of Object.entries(daySales.products)) {
        salesTotals[name] = (salesTotals[name] || 0) + (qty as number);
      }
    }
    const sales = { available: salesAvailable, products: salesTotals };
    const firstDay = days[0];
    const lastDay = days[days.length - 1];
    const bKey = normalizeString(branch);

    // Suministros manuales (isGeneral): llegan por despacho pero no se venden
    // en caja — sin esto aparecían como "faltantes" gigantes falsos.
    const objectives = (await models.posStockObjectives
      .find({ branch: new RegExp(`^${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })
      .select("productName isGeneral")
      .lean()) as any[];
    const suministros = new Set(
      objectives.filter((o) => o.isGeneral).map((o) => normalizeString(o.productName))
    );

    const rows = (leftovers.rows as any[]).filter((r) => normalizeString(r.branch) === bKey);
    const losses = lossesDocs
      .filter((l) => normalizeString(l.branch) === bKey)
      .map((l) => ({
        productName: l.productName,
        quantity: l.quantity,
        reason: l.reason,
        category: l.category,
        categoria: categoryMaps.byName.get(normalizeString(l.productName)) || null,
      }));

    const byName = new Map<string, OperationsProductRow>();
    const getRow = (name: string): OperationsProductRow => {
      const key = normalizeString(name);
      let row = byName.get(key);
      if (!row) {
        const disp = dispatchMap.get(`${bKey}|${key}`) || { ok: 0, sinOk: 0 };
        row = {
          name,
          categoria: categoryMaps.byName.get(key) || null,
          inicial: null,
          recibido: disp.ok + disp.sinOk,
          recibidoOk: disp.ok,
          recibidoSinOk: disp.sinOk,
          vendido: sales.available ? 0 : null,
          bajas: 0,
          deberiaQuedar: null,
          quedo: null,
          descuadre: null,
          ventaCierre: null,
          pedidoFinal: 0,
        };
        byName.set(key, row);
      }
      return row;
    };

    if (sales.available) {
      for (const [name, qty] of Object.entries(sales.products)) {
        getRow(name).vendido = qty as number;
      }
    }
    for (const r of rows) {
      const row = getRow(r.productName);
      // Rango: inicial del primer día, quedó del último, bajas acumuladas
      if (r.date === firstDay) row.inicial = r.stockInicial ?? null;
      if (r.date === lastDay) {
        row.quedo = r.stockFinal ?? null;
        row.pedidoFinal = r.pedidoFinal || 0;
      }
      row.bajas += r.bajas || 0;
      if (r.ventaImplicita !== null && r.ventaImplicita !== undefined) {
        row.ventaCierre = (row.ventaCierre || 0) + r.ventaImplicita;
      }
    }
    for (const [key, row] of byName) {
      // Los suministros no se venden en caja: sin cuenta de diferencia
      if (suministros.has(key)) {
        row.vendido = null;
        if (!row.categoria) row.categoria = "Suministro";
        continue;
      }
      // Flujo del día: inicial + recibido - vendido - bajas = debería quedar.
      // Diferencia = lo que contó el cierre - lo que debería quedar.
      if (row.inicial !== null && row.vendido !== null) {
        row.deberiaQuedar = row.inicial + row.recibido - row.vendido - row.bajas;
        if (row.quedo !== null) {
          row.descuadre = row.quedo - row.deberiaQuedar;
        }
      }
    }

    const products = Array.from(byName.values()).sort((a, b) => {
      const da = Math.abs(a.descuadre ?? 0), db = Math.abs(b.descuadre ?? 0);
      if (da !== db) return db - da; // lo que no cuadra, primero
      return (b.vendido ?? 0) - (a.vendido ?? 0);
    });

    const totals = products.reduce(
      (acc, p) => {
        acc.vendido += p.vendido ?? 0;
        acc.ventaCierre += p.ventaCierre ?? 0;
        acc.bajas += p.bajas;
        acc.recibido += p.recibido;
        acc.descuadre += p.descuadre ?? 0;
        return acc;
      },
      { vendido: 0, ventaCierre: 0, bajas: 0, recibido: 0, descuadre: 0 }
    );

    const sinOkTotal = products.reduce((s, p) => s + p.recibidoSinOk, 0);
    return { branch, salesAvailable: sales.available, hasClosing: rows.length > 0, sinOkTotal, totals, products, losses };
  }

  /**
   * Alerta por correo a los Jefes de Operaciones cuando una sucursal envía su
   * cierre: venta Contífico vs cierre, bajas con motivos y descuadres.
   * Nunca bloquea el cierre: cualquier error solo se loguea.
   */
  async sendClosingAlert(branch: string, dateStr: string, submittedBy: string): Promise<void> {
    try {
      const recipients = (await models.users
        .find({ role: "OPERATIONS_MANAGER", isActive: { $ne: false } })
        .select("email")
        .lean()) as any[];
      const to = Array.from(new Set(recipients.map((u) => String(u.email || "").toLowerCase()).filter(Boolean)));
      if (to.length === 0) return;

      const [leftovers, lossesDocs, categoryMaps, dispatchMap] = await Promise.all([
        this.posRestock.getLeftovers({ from: dateStr, to: dateStr, branch }),
        models.posLosses.find({ branch, date: new Date(`${dateStr}T00:00:00.000Z`) }).lean() as Promise<any[]>,
        buildContificoCategoryMaps(this.contifico),
        this.getDispatchByDay(dateStr),
      ]);
      const report = await this.buildBranchRange(branch, [dateStr], leftovers, lossesDocs, categoryMaps, dispatchMap);

      const descuadres = report.products.filter((p) => (p.descuadre ?? 0) !== 0);
      const fecha = dateStr.split("-").reverse().join("/");
      const asunto = descuadres.length > 0
        ? `⚠️ Cierre ${branch} ${fecha}: ${descuadres.length} producto(s) no cuadran`
        : `✅ Cierre ${branch} ${fecha}: todo cuadra`;

      const td = `padding:6px 8px;border-bottom:1px solid #f1f5f9;`;
      const recibidoCell = (p: OperationsProductRow) => {
        if (!p.recibido) return "";
        const sinOk = p.recibidoSinOk > 0
          ? ` <span style="color:#d97706;font-size:10px;font-weight:bold;">⚠ ${p.recibidoSinOk} sin OK</span>`
          : "";
        return `${p.recibido}${sinOk}`;
      };
      const fila = (p: OperationsProductRow) => `
        <tr>
          <td style="${td}">${p.name}${p.categoria ? ` <span style="font-size:10px;color:#7c3aed;">(${p.categoria})</span>` : ""}</td>
          <td align="center" style="${td}">${p.inicial ?? "—"}</td>
          <td align="center" style="${td}">${recibidoCell(p)}</td>
          <td align="center" style="${td}">${p.vendido ?? "—"}</td>
          <td align="center" style="${td}">${p.bajas || ""}</td>
          <td align="center" style="${td}">${p.deberiaQuedar ?? "—"}</td>
          <td align="center" style="${td}">${p.quedo ?? "—"}</td>
          <td align="center" style="${td}font-weight:bold;color:${(p.descuadre ?? 0) !== 0 ? "#dc2626" : "#16a34a"};">${p.descuadre === null ? "—" : (p.descuadre > 0 ? `+${p.descuadre}` : p.descuadre)}</td>
        </tr>`;

      const bajasHtml = report.losses.length
        ? `<p style="margin:16px 0 6px;font-weight:bold;color:#991b1b;">Bajas reportadas (${report.losses.reduce((s, l) => s + l.quantity, 0)} unids):</p>
           <ul style="margin:0;padding-left:18px;color:#374151;font-size:13px;">
             ${report.losses.map((l) => `<li><strong>${l.quantity}×</strong> ${l.productName} — ${l.reason}</li>`).join("")}
           </ul>`
        : `<p style="margin:16px 0 0;color:#16a34a;font-size:13px;">Sin bajas reportadas.</p>`;

      const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;padding:28px;">
  <h2 style="margin:0 0 4px;color:#7c3aed;">Cierre de ${branch} — ${fecha}</h2>
  <p style="margin:0 0 16px;color:#6b7280;font-size:13px;">Enviado por <strong>${submittedBy}</strong> · Alertas de Operaciones · Nicole Pastry Arts</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse;">
    <tr style="background:#f8fafc;color:#475569;">
      <th align="left" style="padding:8px 8px;">Producto</th>
      <th style="padding:8px 8px;">Stock inicial</th>
      <th style="padding:8px 8px;">Recibido</th>
      <th style="padding:8px 8px;">Vendido (Contífico)</th>
      <th style="padding:8px 8px;">Bajas</th>
      <th style="padding:8px 8px;">Debería quedar</th>
      <th style="padding:8px 8px;">Quedó (isla)</th>
      <th style="padding:8px 8px;">Diferencia</th>
    </tr>
    ${(descuadres.length > 0 ? descuadres : report.products.slice(0, 15)).map(fila).join("")}
  </table>
  <p style="margin:14px 0 0;color:#374151;font-size:13px;">
    Totales: vendido <strong>${report.totals.vendido}</strong> · bajas <strong>${report.totals.bajas}</strong> ·
    descuadre <strong style="color:${report.totals.descuadre !== 0 ? "#dc2626" : "#16a34a"};">${report.totals.descuadre > 0 ? `+${report.totals.descuadre}` : report.totals.descuadre}</strong>
    <span style="color:#9ca3af;">(negativo = falta producto; positivo = sobra)</span>
  </p>
  ${bajasHtml}
  ${report.sinOkTotal > 0 ? `
  <p style="margin:14px 0 0;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;color:#92400e;font-size:12px;">
    ⚠ <strong>${report.sinOkTotal} unidades</strong> fueron despachadas por producción pero la isla
    <strong>no dio el OK</strong> en Recepción Masiva. Se cuentan igual, pero pide que confirmen la recepción.
  </p>` : ""}
  <p style="margin:18px 0 0;font-size:12px;color:#9ca3af;">Detalle completo en app.nicole.com.ec → Reporte de Operaciones.</p>
</div>`;

      const { error } = await this.resend.emails.send({ from: FROM_ADDRESS, to, subject: asunto, html });
      if (error) console.error("❌ [OPS] Error enviando alerta de cierre:", error);
      else console.log(`📧 [OPS] Alerta de cierre de ${branch} (${fecha}) enviada a: ${to.join(", ")}`);
    } catch (err: any) {
      console.error(`❌ [OPS] No se pudo enviar la alerta de cierre de ${branch}:`, err?.message || err);
    }
  }
}
