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
  recibido: number; // cuánto le llegó según el despacho
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

  async getReport(dateStr: string) {
    const activeBranches = (await models.branches
      .find({ isActive: true })
      .sort({ sortOrder: 1 })
      .lean()) as any[];

    const [leftovers, lossesDocs, categoryMaps] = await Promise.all([
      this.posRestock.getLeftovers({ from: dateStr, to: dateStr }),
      models.posLosses.find({ date: new Date(`${dateStr}T00:00:00.000Z`) }).lean() as Promise<any[]>,
      buildContificoCategoryMaps(this.contifico),
    ]);

    const branches: OperationsBranchReport[] = [];
    for (const b of activeBranches) {
      const report = await this.buildBranchDay(b.name, dateStr, leftovers, lossesDocs, categoryMaps);
      if (report.salesAvailable || report.products.length > 0) branches.push(report);
    }

    return {
      date: dateStr,
      branches,
      missingClosings: leftovers.missing.filter((m: any) =>
        branches.some(b => normalizeString(b.branch) === normalizeString(m.branch))
      ),
    };
  }

  private async buildBranchDay(
    branch: string,
    dateStr: string,
    leftovers: any,
    lossesDocs: any[],
    categoryMaps: CategoryMaps
  ): Promise<OperationsBranchReport> {
    const sales = await this.posRestock.getDailySales(branch, dateStr);
    const bKey = normalizeString(branch);

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
        row = {
          name,
          categoria: categoryMaps.byName.get(key) || null,
          inicial: null,
          recibido: 0,
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
      row.inicial = r.stockInicial ?? null;
      row.recibido = r.recibido || 0;
      row.bajas = r.bajas || 0;
      row.quedo = r.stockFinal ?? null;
      row.ventaCierre = r.ventaImplicita;
      row.pedidoFinal = r.pedidoFinal || 0;
    }
    for (const row of byName.values()) {
      // Flujo del día: empezó + llegó - vendido - bajas = debería quedar.
      // Descuadre = lo que contó el cierre - lo que debería quedar.
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

    return { branch, salesAvailable: sales.available, hasClosing: rows.length > 0, totals, products, losses };
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

      const [leftovers, lossesDocs, categoryMaps] = await Promise.all([
        this.posRestock.getLeftovers({ from: dateStr, to: dateStr, branch }),
        models.posLosses.find({ branch, date: new Date(`${dateStr}T00:00:00.000Z`) }).lean() as Promise<any[]>,
        buildContificoCategoryMaps(this.contifico),
      ]);
      const report = await this.buildBranchDay(branch, dateStr, leftovers, lossesDocs, categoryMaps);

      const descuadres = report.products.filter((p) => (p.descuadre ?? 0) !== 0);
      const fecha = dateStr.split("-").reverse().join("/");
      const asunto = descuadres.length > 0
        ? `⚠️ Cierre ${branch} ${fecha}: ${descuadres.length} producto(s) no cuadran`
        : `✅ Cierre ${branch} ${fecha}: todo cuadra`;

      const td = `padding:6px 8px;border-bottom:1px solid #f1f5f9;`;
      const fila = (p: OperationsProductRow) => `
        <tr>
          <td style="${td}">${p.name}${p.categoria ? ` <span style="font-size:10px;color:#7c3aed;">(${p.categoria})</span>` : ""}</td>
          <td align="center" style="${td}">${p.inicial ?? "—"}</td>
          <td align="center" style="${td}">${p.recibido || ""}</td>
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
      <th style="padding:8px 8px;">Empezó</th>
      <th style="padding:8px 8px;">Llegó</th>
      <th style="padding:8px 8px;">Vendido</th>
      <th style="padding:8px 8px;">Bajas</th>
      <th style="padding:8px 8px;">Debería quedar</th>
      <th style="padding:8px 8px;">Quedó</th>
      <th style="padding:8px 8px;">Descuadre</th>
    </tr>
    ${(descuadres.length > 0 ? descuadres : report.products.slice(0, 15)).map(fila).join("")}
  </table>
  <p style="margin:14px 0 0;color:#374151;font-size:13px;">
    Totales: vendido <strong>${report.totals.vendido}</strong> · bajas <strong>${report.totals.bajas}</strong> ·
    descuadre <strong style="color:${report.totals.descuadre !== 0 ? "#dc2626" : "#16a34a"};">${report.totals.descuadre > 0 ? `+${report.totals.descuadre}` : report.totals.descuadre}</strong>
    <span style="color:#9ca3af;">(negativo = falta producto; positivo = sobra)</span>
  </p>
  ${bajasHtml}
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
