import { models } from "../models";
import { ContificoService } from "./contifico.service";

/**
 * Emite en el momento la factura de un pedido, con los mismos pasos que el cron
 * nocturno (`processPendingInvoices`):
 *  1. createInvoice en la cuenta del pedido (reintenta en la otra si Contífico
 *     responde "no pertenece a la empresa").
 *  2. PROCESSED + invoiceInfo.
 *  3. Envío al SRI cuando Contífico lo firme (no bloquea).
 *  4. El cobro registrado en el pedido se manda a Contífico (salvo crédito).
 *
 * No lanza: si falla deja `invoiceStatus = ERROR` con el motivo y el cron de la
 * noche lo reintenta solo.
 */

const services = {
  nicole: new ContificoService("nicole"),
  sucree: new ContificoService("sucree"),
};

const errorText = (raw: any): string => {
  if (!raw) return "";
  if (typeof raw === "object") return raw.mensaje || JSON.stringify(raw);
  try {
    const parsed = JSON.parse(String(raw));
    return parsed?.mensaje || String(raw);
  } catch {
    return String(raw);
  }
};

export async function issueInvoiceNow(orderId: string): Promise<{ ok: boolean; error?: string }> {
  const order: any = await models.orders.findById(orderId);
  if (!order) return { ok: false, error: "Pedido no encontrado" };
  if (order.invoiceStatus === "PROCESSED") return { ok: true };

  order.invoiceNeeded = true;
  try {
    let svc = order.contificoSource === "sucree" ? services.sucree : services.nicole;
    let response: any = await svc.createInvoice(order);

    if (response?.error && errorText(response.error).includes("no pertenece a la empresa")) {
      svc = svc.source === "sucree" ? services.nicole : services.sucree;
      response = await svc.createInvoice(order);
      if (!response?.error) order.contificoSource = svc.source;
    }
    if (response?.error) throw new Error(errorText(response.error));

    order.invoiceStatus = "PROCESSED";
    order.invoiceInfo = response;
    order.invoiceError = undefined;
    order.invoiceSentToSriAt = new Date();
    await order.save();

    svc
      .sendToSriWhenReady(response.id)
      .catch((err) => console.warn(`⚠️ [${orderId}] SRI no disparado (no bloquea):`, err));

    const pd = order.paymentDetails;
    if (pd?.monto && pd.forma_cobro !== "CR") {
      try {
        await svc.registerCollection(response.id, { ...pd.toObject?.() ?? pd, monto: response.total });
      } catch (err: any) {
        console.error(`⚠️ [${orderId}] Cobro no registrado en Contífico:`, err?.message || err);
      }
    }
    return { ok: true };
  } catch (error: any) {
    const message = error?.message || String(error);
    console.error(`❌ [${orderId}] Factura inmediata falló:`, message);
    await models.orders.findByIdAndUpdate(orderId, {
      invoiceNeeded: true,
      invoiceStatus: "ERROR",
      invoiceError: message,
    });
    return { ok: false, error: message };
  }
}
