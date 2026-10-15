import axios, { AxiosError } from "axios";
import CustomError from "../errors/customError.error";

/**
 * Links de pago de Payphone que el asesor genera desde la app interna.
 * API: POST https://pay.payphonetodoesposible.com/api/Links (docs.payphone.app/links-de-pago).
 * Montos en centavos enteros; amount = amountWithoutTax + amountWithTax + tax.
 *
 * El cobro no se detecta solo: el asesor registra el número de transacción en el
 * pedido, como con una transferencia.
 */

const PAYPHONE_LINKS_URL = "https://pay.payphonetodoesposible.com/api/Links";
const TIMEOUT_MS = 15_000;

export interface PayphoneLinkInput {
  /** Base de los productos que gravan IVA, en centavos. */
  amountWithTaxCents: number;
  /** IVA de esa base, en centavos. */
  taxCents: number;
  /** Productos sin IVA o con precio final (Delivery), en centavos. */
  amountWithoutTaxCents: number;
  reference: string;
  clientTransactionId: string;
}

const isCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export function isPayphoneConfigured(): boolean {
  return !!(process.env.PAYPHONE_TOKEN && process.env.PAYPHONE_STORE_ID);
}

export async function createPayphoneLink(input: PayphoneLinkInput): Promise<string> {
  if (!isPayphoneConfigured()) {
    throw new CustomError("Los links de Payphone no están configurados (faltan PAYPHONE_TOKEN y PAYPHONE_STORE_ID).", 503);
  }
  const { amountWithTaxCents, taxCents, amountWithoutTaxCents } = input;
  if (![amountWithTaxCents, taxCents, amountWithoutTaxCents].every(isCents)) {
    throw new CustomError("Los montos del link deben ser centavos enteros.", 400);
  }
  const amount = amountWithTaxCents + taxCents + amountWithoutTaxCents;
  if (amount <= 0) throw new CustomError("El link de pago debe tener un monto mayor a cero.", 400);

  try {
    const { data } = await axios.post(
      PAYPHONE_LINKS_URL,
      {
        amount,
        amountWithTax: amountWithTaxCents,
        tax: taxCents,
        amountWithoutTax: amountWithoutTaxCents,
        currency: "USD",
        reference: input.reference.slice(0, 100),
        clientTransactionId: input.clientTransactionId.slice(0, 50),
        storeId: process.env.PAYPHONE_STORE_ID,
        oneTime: true,
        expireIn: 48,
        isAmountEditable: false,
      },
      {
        headers: { Authorization: `Bearer ${process.env.PAYPHONE_TOKEN}`, "Content-Type": "application/json" },
        timeout: TIMEOUT_MS,
      }
    );
    // Payphone responde la URL como string plano.
    const url = typeof data === "string" ? data : data?.url || data?.link;
    if (!url || !/^https:\/\//.test(String(url))) {
      throw new CustomError("Payphone no devolvió un link válido.", 502);
    }
    return String(url);
  } catch (error) {
    if (error instanceof CustomError) throw error;
    const detail =
      error instanceof AxiosError
        ? (error.response?.data as any)?.message || (error.response?.data as any)?.errors?.[0]?.message || error.message
        : String(error);
    throw new CustomError(`No se pudo generar el link de Payphone: ${detail}`, 502);
  }
}
