import axios, { HttpStatusCode } from "axios";
import { IPerson } from "../interfaces/person.interface";
import { InvoiceSequenceModel } from "../models/invoice-sequence.model";
import { SellerModel } from "../models/seller.model";
import {
  CONTIFICO_SERIE,
  CONTIFICO_SECUENCIAL_MINIMO,
  CONTIFICO_SECUENCIALES_EXCLUIDOS,
  buildDocumentNumber,
  parseSequential,
  isExcludedSequential,
} from "../config/contifico-emision.config";
import { CONTIFICO_CUENTA_BANCARIA_TRA } from "../config/contifico-cobro.config";
import { isPrecioIvaIncluido } from "../config/precio-final.config";
import CustomError from "../errors/customError.error";

/**
 * Pedidos de la tienda online: ningún ítem puede facturarse con el producto de
 * prueba de respaldo. Si alguno no tiene `contifico_id`, se corta antes de llamar
 * a Contífico. Los pedidos manuales conservan el comportamiento de siempre.
 */
export function assertWebOrderProductsLinked(orderData: any): void {
  // `webOrder` es un path anidado: en un documento hidratado existe (vacío) aunque el
  // pedido sea manual, por eso se mira externalId.
  if (!orderData?.webOrder?.externalId) return;
  const missing = (orderData.products || []).find((p: any) => !String(p?.contifico_id ?? "").trim());
  if (missing) {
    throw new CustomError(
      `El producto «${missing.name || "sin nombre"}» no está vinculado a Contífico. Edita el pedido y elígelo del catálogo antes de facturar.`,
      400
    );
  }
}

export class ContificoService {
  private apiKey: string;
  private token: string;
  private baseUrl: string = "https://api.contifico.com/sistema/api/v1";
  // POS (Punto de Venta) ID para la cuenta — cada empresa tiene el suyo
  private posId: string;
  // Identifica qué cuenta de Contífico maneja esta instancia
  readonly source: 'nicole' | 'sucree';

  constructor(source: 'nicole' | 'sucree' = 'nicole') {
    this.source = source;

    // Seleccionar credenciales y POS según el negocio
    if (source === 'sucree') {
      this.apiKey = process.env.CONTIFICO_SUCREE_API_KEY || "";
      this.token = process.env.CONTIFICO_SUCREE_TOKEN || "";
      this.posId = process.env.CONTIFICO_SUCREE_POS_ID || "";
    } else {
      // Default: Nicole (negocio principal)
      this.apiKey = process.env.CONTIFICO_API_KEY || "";
      this.token = process.env.CONTIFICO_TOKEN || "";
      this.posId = process.env.CONTIFICO_POS_ID || "00f60268-ca0c-48f9-8768-4f2625fa975a";
    }

    if (!this.apiKey || !this.token) {
      console.warn(`⚠️ Contífico credentials missing for source '${source}' in .env`);
    }
    // posId puede estar vacío — se auto-detecta desde /caja/ en el primer uso si no está configurado.
  }

  // --- CACHE POR INSTANCIA (evita que Nicole y Sucree compartan caché) ---
  private cachedProducts: any[] | null = null;
  private cachedProductsTime: number = 0;
  private static readonly PRODUCTS_TTL = 3600 * 1000; // 1 hora

  private cachedCategories: any[] | null = null;
  private cachedCategoriesTime: number = 0;
  private static readonly CATEGORIES_TTL = 3600 * 1000; // 1 hora

  // POS ID auto-detectado desde la API de Contífico (una vez por instancia)
  private resolvedPosId: string = "";
  private posIdResolved: boolean = false;

  /**
   * Retorna productos cacheados o frescos si el TTL expiró.
   */
  async getCachedProducts(result_size: number = 2000) {
    const now = Date.now();
    if (this.cachedProducts && (now - this.cachedProductsTime < ContificoService.PRODUCTS_TTL)) {
      return this.cachedProducts;
    }

    const products = await this.getProducts({ result_size });
    if (products) {
      this.cachedProducts = products;
      this.cachedProductsTime = now;
    }
    return products || [];
  }

  /**
   * Retorna categorías cacheadas o frescas si el TTL expiró.
   */
  async getCachedCategories() {
    const now = Date.now();
    if (this.cachedCategories && (now - this.cachedCategoriesTime < ContificoService.CATEGORIES_TTL)) {
      return this.cachedCategories;
    }

    const categories = await this.getCategories();
    if (categories) {
      this.cachedCategories = categories;
      this.cachedCategoriesTime = now;
    }
    return categories || [];
  }

  /**
   * Lista personas de la cuenta. `params` pasa tal cual a la API
   * (ej. `{ es_vendedor: true }` para traer sólo vendedores).
   */
  async getPersonas(params: Record<string, any> = {}): Promise<any[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/persona/`, {
        headers: { Authorization: this.apiKey },
        params,
      });
      const data = response.data;
      return Array.isArray(data) ? data : data?.results || [];
    } catch (error: any) {
      console.error(`❌ [${this.source}] Error listando personas:`, error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Busca una persona en Contifico por cédula/RUC.
   * Devuelve el primer resultado o null si no existe.
   */
  async findPersona(identificacion: string): Promise<any | null> {
    try {
      const response = await axios.get(`${this.baseUrl}/persona/`, {
        headers: { Authorization: this.apiKey },
        params: { identificacion },
      });
      const results = response.data;
      if (Array.isArray(results) && results.length > 0) return results[0];
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Si la persona existe en Contifico con tipo "C" (inválido para SRI),
   * intenta actualizar el tipo al valor correcto via PUT.
   * Retorna true si la persona quedó con el tipo correcto, false si falló.
   */
  async ensurePersonaTipo(rawId: string, correctTipo: string): Promise<boolean> {
    try {
      const persona = await this.findPersona(rawId);
      if (!persona) return true; // No existe aún — se creará nueva con tipo correcto
      if (persona.tipo !== 'C') return true; // Ya tiene tipo válido

      // Intentar corregir el tipo via PUT
      console.log(`🔧 [${this.source}] Persona ${rawId} tiene tipo "C" — intentando corregir a "${correctTipo}"...`);
      await axios.put(`${this.baseUrl}/persona/`, {
        ...persona,
        tipo: correctTipo,
      }, {
        headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
        params: { pos: this.token },
      });
      console.log(`✅ [${this.source}] Persona ${rawId} actualizada a tipo "${correctTipo}"`);
      return true;
    } catch (err: any) {
      console.warn(`⚠️ [${this.source}] No se pudo actualizar tipo de persona ${rawId}: ${err?.response?.data?.mensaje || err.message}`);
      return false; // El caller fallback a CF
    }
  }

  /**
   * Create an invoice in Contífico
   */
  async createInvoice(orderData: any) {
    // Fuera del try: el catch de abajo convierte todo en { error } y esto debe llegar como 400.
    assertWebOrderProductsLinked(orderData);
    try {
      // 1. Calculate Per-Item Values and Totals
      let subtotal_0 = 0;
      let subtotal_15 = 0; // Using subtotal_12 variable name for legacy compatibility if needed, map to subtotal_12 in payload
      let total_iva = 0;
      let total_final = 0;

      const detalles = orderData.products.map((p: any) => {
        const cantidad = Number(p.quantity);
        const precio = Number(p.price);
        // const totalLine = cantidad * precio; // This line will be moved/recalculated later

        // Todo se factura con IVA 15%: mandar 0% hace que Contífico rechace la
        // línea (error 1098).
        const porcentaje_iva = 15;

        // Delivery y la Torta Personalizada se cotizan con el IVA ya dentro: el
        // precio tecleado es lo que paga el cliente, así que la base se calcula
        // hacia atrás y el total de la línea vuelve a dar ese mismo valor.
        const ivaIncluido = isPrecioIvaIncluido(p);
        const calcPrice = ivaIncluido ? precio / 1.15 : precio;

        // Apply Discount Logic (Courtesy = 100%)
        let discountPercentage = p.isCourtesy ? 100 : 0;

        // Apply Global Overrides
        if (orderData.isGlobalCourtesy) {
          discountPercentage = 100;
        } else if (orderData.globalDiscountPercentage > 0 && discountPercentage < 100) {
          discountPercentage = orderData.globalDiscountPercentage;
        }

        // Total Line = Qty * Price * (1 - Discount/100)
        // If 100% discount, totalLine becomes 0, so it doesn't add to the invoice totals
        const totalLine = cantidad * calcPrice * ((100 - discountPercentage) / 100);

        let base_cero = 0;
        let base_gravable = 0;
        let base_no_gravable = 0;

        if (porcentaje_iva > 0) {
          base_gravable = Number(totalLine.toFixed(2)); // Round Base to 2 decimals
          subtotal_15 += base_gravable;
          // NOTE: Do NOT accumulate per-line rounded IVA here.
          // total_iva is computed once from subtotal_15 after the loop
          // to avoid 1-cent rounding discrepancies with Contifico's validation.
        } else {
          base_cero = Number(totalLine.toFixed(2)); // Round Base 0 to 2 decimals
          subtotal_0 += base_cero;
        }

        return {
          producto_id: p.contifico_id || "9pgenB6GQcVWoeNQ", // Fallback to test product if missing, but should be mapped
          cantidad: cantidad,
          // For Contifico, if we want to force the price, we just send it.
          // However, verify if 'pvp_manual' is needed or if sending 'precio' is enough.
          // Documentation says 'precio' is the unit price.
          precio: Number(calcPrice.toFixed(4)), // High precision for unit price
          descripcion: p.name,
          porcentaje_iva: porcentaje_iva,
          base_cero: base_cero,
          base_gravable: base_gravable,
          base_no_gravable: base_no_gravable,
          descuento: discountPercentage
        };
      });

      // Compute total_iva ONCE from the total taxable base (not sum of per-line rounded IVAs).
      // This ensures our `iva` field matches what Contifico recomputes from line bases,
      // preventing the "saldos de debe y haber no cuadran" 1-cent error.
      total_iva = Number((subtotal_15 * 0.15).toFixed(2));
      total_final = subtotal_0 + subtotal_15 + total_iva;

      // 2. Prepare Payload
      // Número de documento de la serie principal (001-001 = Matriz / CDP).
      // El secuencial sale de un contador atómico en Mongo, sembrado con el último
      // número realmente emitido en Contífico — ver contifico-emision.config.ts.
      const docNumber = await this.nextInvoiceNumber();

      // POS ID de la cuenta Contífico correspondiente.
      // Se obtiene de env var o se auto-detecta desde /caja/ (una vez, cacheado por instancia).
      const POS_DULCERIA_ID = await this.resolvePosId();

      // Vendedor a cargo — Contífico arma el reporte de comisiones con este campo.
      const vendedorPayload = await this.resolveVendedorPayload(orderData);

      // Identificación del cliente para la factura.
      // REGLA SRI: tipoIdentificacionComprador se determina SOLO por el largo del ID:
      //   13 dígitos → RUC (04): enviar solo `ruc`, `cedula = ""`
      //   10 dígitos → Cédula (05): enviar `cedula` y `ruc = cedula + "001"`
      // NO mezclar cedula + ruc — si se envían ambos Contifico genera
      // tipoIdentificacionComprador="None" y el SRI rechaza: "ARCHIVO NO CUMPLE ESTRUCTURA XML".
      const rawId = (orderData.invoiceData?.ruc || "").replace(/\s+/g, "");

      let computedRuc: string;
      let computedCedula: string;

      // tipo según doc oficial Contifico: N=Natural, J=Juridica, I=SinId, P=Placa
      // "C" NO es un valor válido — causa XML inválido en el SRI.
      let computedTipo: string;
      if (rawId.length === 13) {
        // RUC empresa (no termina en 001) → Juridica; persona natural con RUC (termina en 001) → Natural
        computedTipo = rawId.endsWith("001") ? "N" : "J";
        computedRuc = rawId;
        computedCedula = rawId.endsWith("001") ? rawId.slice(0, 10) : "";
      } else {
        // Cédula (10 dígitos) → persona Natural
        computedTipo = "N";
        computedRuc = rawId + "001";
        computedCedula = rawId;
      }

      // BLINDAJE SRI: si la persona ya existe en Contifico con tipo "C",
      // intentar corregirla antes de crear la factura.
      // Si no se puede corregir, usar datos de Consumidor Final como fallback.
      // Consumidor Final (9999999999 / 9999999999999): no es una persona real, se
      // emite con los datos oficiales del SRI (mismo bloque que el fallback de abajo).
      const isConsumidorFinal = /^9{10}(9{3})?$/.test(rawId);
      const personaOk = isConsumidorFinal ? false : await this.ensurePersonaTipo(rawId, computedTipo);
      let invoiceRuc = computedRuc;
      let invoiceCedula = computedCedula;
      let invoiceTipo = computedTipo;
      let invoiceRazonSocial = orderData.invoiceData?.businessName;
      let invoiceEmail = orderData.invoiceData?.email;
      let invoiceDireccion = orderData.invoiceData?.address;

      if (!personaOk) {
        // Fallback: Consumidor Final (persona_id: NO8bYRVq3HX9xd7j, tipo N, siempre autoriza)
        if (!isConsumidorFinal) console.warn(`⚠️ [${this.source}] Usando Consumidor Final como fallback para ${rawId}`);
        invoiceRuc = "9999999999999";
        invoiceCedula = "9999999999";
        invoiceTipo = "N";
        invoiceRazonSocial = "consumidor final";
        // Al Consumidor Final elegido a propósito (pedidos web) le llega su comprobante.
        invoiceEmail = (isConsumidorFinal && orderData.invoiceData?.email) || "noname@noname.com";
        invoiceDireccion = (isConsumidorFinal && orderData.invoiceData?.address) || "sin dirección";
      }

      const clientePayload = {
        razon_social: invoiceRazonSocial,
        ruc: invoiceRuc,
        cedula: invoiceCedula,
        email: invoiceEmail,
        direccion: invoiceDireccion,
        tipo: invoiceTipo,
        // Pedidos web (v7): customerPhone es de quien recibe; la factura lleva su propio teléfono.
        telefonos: orderData.invoiceData?.phone || orderData.customerPhone
      };

      const payload = {
        pos: POS_DULCERIA_ID,
        fecha_emision: new Date().toLocaleDateString("en-GB"), // DD/MM/YYYY
        tipo_documento: "FAC",
        documento: docNumber,
        estado: "P",
        electronico: true,
        autorizacion: "",
        cliente: clientePayload,
        detalles: detalles.map((d: any) => ({
          ...d,
          porcentaje_descuento: d.descuento,
          descuento: undefined
        })),
        subtotal_0: Number(subtotal_0.toFixed(2)),
        // Contifico usa `subtotal_12` como campo de base gravable para IVA (sin importar si la tasa es 12% o 15%).
        // La tasa real se determina por `porcentaje_iva` en cada detalle.
        // `subtotal_15` es ignorado por la API → enviarlo como 0 evita confusión.
        subtotal_12: Number(subtotal_15.toFixed(2)),
        subtotal_15: 0,
        iva: Number(total_iva.toFixed(2)),
        ice: 0,
        total: Number(total_final.toFixed(2)),
        servicio: 0,
        propina: 0,
        metodo_pago: "TRA",
        // Vendedor a cargo (comisiones). Se omite si el pedido no tiene uno asignado.
        ...(vendedorPayload || {})
      };


      const response = await axios.post(`${this.baseUrl}/documento/`, payload, {
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
        },
      });

      return response.data;
    } catch (error: any) {
      const apiError = error.response?.data || error.message;
      console.error("❌ Error creating invoice in Contífico:", apiError);

      // Si Contífico rechazó el número de documento (secuencial repetido o fuera
      // de rango), re-sincronizamos el contador contra la API para que el próximo
      // intento arranque desde el número correcto. No reintentamos aquí a
      // propósito: reintentar dentro del mismo request puede duplicar la factura.
      const msg = typeof apiError === "object" ? JSON.stringify(apiError) : String(apiError);
      if (/secuencia|secuencial|documento ya|duplicad|ya existe|ya fue registrad/i.test(msg)) {
        await this.resyncInvoiceSequence().catch(() => undefined);
      }

      // Return error info instead of throwing to avoid blocking order creation flow
      return { error: apiError };
    }
  }

  /**
   * Get products from Contífico
   * @param options Search options (filtro, codigo_barra, categoria_id)
   */
  async getProducts(options: { filtro?: string; codigo_barra?: string; categoria_id?: string; result_size?: number; result_page?: number } = {}) {
    try {
      const params: any = {};

      if (options.filtro) params.filtro = options.filtro;
      if (options.codigo_barra) params.codigo_barra = options.codigo_barra;
      if (options.categoria_id) params.categoria_id = options.categoria_id;
      if (options.result_size) params.result_size = options.result_size;
      if (options.result_page) params.result_page = options.result_page;


      const response = await axios.get(`${this.baseUrl}/producto/`, {
        headers: {
          Authorization: this.apiKey,
        },
        params,
      });

      return response.data;
    } catch (error: any) {
      console.error("❌ Error fetching products from Contífico:", error.response?.data || error.message);
      const err = new Error("Failed to fetch products from Contífico") as any;
      err.contificoStatus = error.response?.status ?? null;
      throw err;
    }
  }

  async getCategories() {
    try {
      const response = await axios.get(`${this.baseUrl}/categoria/`, {
        headers: {
          Authorization: this.apiKey,
        },
      });
      return response.data;
    } catch (error: any) {
      console.error("❌ Error fetching categories from Contífico:", error.response?.data || error.message);
      throw new Error("Failed to fetch categories from Contífico");
    }
  }

  /**
   * Get person from Contífico (Search by ID or Name)
   * @param query Search query (RUC, Cedula, or Name)
   */
  async getPerson(query: string) {
    try {

      const params: any = {};

      // Basic heuristic: if it contains only numbers, search by identificacion
      // otherwise search by filtro (name/razon social)
      const isNumeric = /^\d+$/.test(query);

      if (isNumeric) {
        params.identificacion = query;
      } else {
        params.filtro = query;
      }

      const response = await axios.get(`${this.baseUrl}/persona/`, {
        headers: {
          Authorization: this.apiKey,
        },
        params: params,
      });

      return response.data;
    } catch (error: any) {
      console.error("❌ Error fetching person from Contífico:", error.response?.data || error.message);
      // Don't throw unique error, just return empty list or propagate error safely
      if (error.response?.status === 404) {
        return [];
      }
      throw new Error("Failed to fetch person from Contífico");
    }
  }

  /**
   * Create a new person in Contífico
   * @param personData Person data (ruc, razon_social, email, etc.)
   */
  async createPerson(personData: IPerson): Promise<IPerson> {
    try {

      // If tipo is not provided, infer from length
      const tipo = personData.tipo || (personData.ruc.length === 13 ? "J" : "N");

      const payload: IPerson = {
        ...personData,
        tipo: tipo,
        es_cliente: true,
        es_proveedor: false,
        es_empleado: false,
        es_vendedor: false,
        es_extranjero: false
      };

      // Identify cedula vs ruc logic
      if (tipo === "N") {
        payload.cedula = personData.ruc; // Map our 'ruc' input to 'cedula' field for API
        payload.ruc = ""; // Clear RUC to avoid API conflicts if strictly N
      } else {
        payload.ruc = personData.ruc;
        payload.cedula = "";
      }

      const response = await axios.post(`${this.baseUrl}/persona/`, payload, {
        headers: {
          Authorization: this.apiKey,
        },
      });

      return response.data;
    } catch (error: any) {
      console.error("❌ Error creating person in Contífico:", error.response?.data || error.message);
      throw new Error("Failed to create person in Contífico: " + (error.response?.data?.mensaje || error.message));
    }
  }

  /**
   * Register a collection (cobro) for a document
   * @param documentId The Contífico Document ID
   * @param collectionData The collection data payload
   */
  async registerCollection(documentId: string, collectionData: any) {
    try {
      // Format date to DD/MM/YYYY if needed
      let formattedDate = collectionData.fecha;
      if (collectionData.fecha && collectionData.fecha.includes('-')) {
        // Assume YYYY-MM-DD
        const [year, month, day] = collectionData.fecha.split('-');
        formattedDate = `${day}/${month}/${year}`;
      }

      // Ensure we use the formatted date
      const payload = {
        ...collectionData,
        fecha: formattedDate
      };

      // 1057 Error Fix: Falta campo caja
      // If no caja_id is provided, try to find one
      if (!payload.caja_id) {
        const cajas = await this.getCajas();

        if (cajas && cajas.length > 0) {
          // Usar el POS de esta cuenta (auto-detectado o configurado por env var)
          const PREFERRED_POS_ID = await this.resolvePosId();

          // Strategy: Find ALL sessions for our POS and pick the LATEST one.
          // We ignore 'fecha_cierre' because sometimes active sessions have it populated.
          const posSessions = cajas.filter((c: any) => c.pos === PREFERRED_POS_ID);

          let targetCajaId = "";

          if (posSessions.length > 0) {
            // Assume the list is chronological or sort it? API usually returns chronological.
            // Taking the last one is the safest bet for "most recent".
            const latestSession = posSessions[posSessions.length - 1];
            targetCajaId = latestSession.id;
          } else {
            // Fallback to the very first caja in the list if no match for POS
            targetCajaId = cajas[0].id;
          }

          payload.caja_id = targetCajaId;

        } else {
          console.warn("⚠️ No Cajas found in Contífico account.");
        }
      }

      // Toda transferencia entra a la misma cuenta: Banco Guayaquil.
      // Se fija el ID, no el nombre — ver contifico-cobro.config.ts para el
      // porqué (la cuenta está registrada como "Banco Guayquil", sin la "a",
      // así que empatar por nombre fallaba y caía al primer banco de la lista).
      if (payload.forma_cobro === 'TRA') {
        payload.cuenta_bancaria_id = CONTIFICO_CUENTA_BANCARIA_TRA;
        if (!payload.tipo_ping) payload.tipo_ping = "D"; // D = Depósito
      }


      const response = await axios.post(`${this.baseUrl}/documento/${documentId}/cobro/`, payload, {
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
        },
      });

      return response.data;
    } catch (error: any) {
      console.error("❌ Error registering collection in Contífico:", error.response?.data || error.message);
      // Return error structure to be handled by controller
      throw new Error(error.response?.data?.mensaje || "Failed to register collection in Contífico");
    }
  }

  /**
   * Get documents (movements) from Contífico
   * @param options Search filters (fecha_emision, tipo, persona_id, etc.)
   */
  async getDocuments(options: { fecha_emision?: string; tipo?: string; persona_identificacion?: string;[key: string]: any } = {}) {
    try {

      const params = { ...options };

      const response = await axios.get(`${this.baseUrl}/documento/`, {
        headers: {
          Authorization: this.apiKey,
        },
        params: params,
      });

      return response.data;
    } catch (error: any) {
      console.error("❌ Error fetching documents from Contífico:", error.response?.data || error.message);
      // Handle 404 as empty list if Contífico returns 404 for no results
      if (error.response?.status === 404) {
        return [];
      }
      throw new Error("Failed to fetch documents from Contífico");
    }
  }

  /**
   * Get specific document by ID
   * @param id Document ID
   */
  async getDocument(id: string) {
    try {
      const response = await axios.get(`${this.baseUrl}/documento/${id}/`, {
        headers: { Authorization: this.apiKey }
      });
      return response.data;
    } catch (error: any) {
      console.error("❌ Error fetching document from Contífico:", error.response?.data || error.message);
      throw new Error(error.response?.data?.mensaje || "Failed to fetch document");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NUMERACIÓN DE FACTURAS (serie del CDP principal)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Entrega el siguiente número de factura de la serie configurada
   * (`CONTIFICO_SERIE`, por defecto 001-001 = Matriz / CDP).
   *
   * Antes se generaba con `Math.random()`, lo que podía repetir un secuencial ya
   * emitido o saltar cientos de miles de números dentro de la serie del SRI.
   * Ahora el contador vive en Mongo y se incrementa de forma atómica. Si no existe
   * todavía, se siembra con el último secuencial realmente emitido en Contífico
   * (lo normal es sembrarlo antes con `pnpm seed:invoice-sequence`).
   */
  async nextInvoiceNumber(): Promise<string> {
    const serie = CONTIFICO_SERIE;

    const existing = await InvoiceSequenceModel.findOne({ source: this.source, serie });
    if (!existing) {
      const seed = await this.fetchLastSequentialFromContifico(serie, { daysBack: 7 });
      if (seed <= 0) {
        // Sin contador y sin nada leído: no inventar un número. Se aborta la factura
        // (createInvoice devuelve el error) hasta que alguien siembre el contador.
        throw new Error(
          `Contador de la serie ${serie} no sembrado y Contífico no devolvió documentos recientes. Correr: pnpm seed:invoice-sequence -- --desde 14/01/2026`
        );
      }
      await InvoiceSequenceModel.updateOne(
        { source: this.source, serie },
        { $setOnInsert: { source: this.source, serie, lastSequential: seed } },
        { upsert: true }
      );
      console.log(`✅ [${this.source}] Contador de la serie ${serie} sembrado en ${seed}`);
    }

    let updated = await InvoiceSequenceModel.findOneAndUpdate(
      { source: this.source, serie },
      { $inc: { lastSequential: 1 } },
      { new: true }
    );

    // Saltar las 10 facturas ya emitidas en 1000001–1000010: el contador brinca al
    // final del rango y se vuelve a incrementar. `$max` es idempotente si otro
    // request concurrente ya lo hizo.
    if (isExcludedSequential(updated!.lastSequential)) {
      await InvoiceSequenceModel.updateOne(
        { source: this.source, serie },
        { $max: { lastSequential: CONTIFICO_SECUENCIALES_EXCLUIDOS.hasta } }
      );
      updated = await InvoiceSequenceModel.findOneAndUpdate(
        { source: this.source, serie },
        { $inc: { lastSequential: 1 } },
        { new: true }
      );
      console.log(`↪️ [${this.source}] Secuencial dentro del rango excluido; se salta a ${updated!.lastSequential}`);
    }

    return buildDocumentNumber(updated!.lastSequential);
  }

  /**
   * Re-sincroniza el contador contra Contífico. Se llama cuando la API rechaza el
   * documento por un problema de secuencia, para que el siguiente intento arranque
   * por encima de todo lo que Contífico ya tiene.
   *
   * Sólo SUBE el contador (`$max`): nunca lo baja. Bajarlo es la única operación que
   * puede reutilizar un número y queda reservada al script `seed-invoice-sequence`
   * con `--force`, después de barrer todo el historial.
   */
  async resyncInvoiceSequence(): Promise<number> {
    const serie = CONTIFICO_SERIE;
    const last = await this.fetchLastSequentialFromContifico(serie, { daysBack: 2 });
    await InvoiceSequenceModel.updateOne(
      { source: this.source, serie },
      { $max: { lastSequential: last }, $setOnInsert: { source: this.source, serie } },
      { upsert: true }
    );
    const after = await InvoiceSequenceModel.findOne({ source: this.source, serie }).lean();
    const value = after?.lastSequential ?? last;
    console.log(`🔄 [${this.source}] Contador de la serie ${serie} re-sincronizado en ${value} (Contífico: ${last})`);
    return value;
  }

  /**
   * Busca en Contífico el mayor secuencial ya emitido para una serie.
   *
   * El endpoint sólo filtra por fecha de emisión, así que se recorre día por día:
   * o los últimos `daysBack` días, o desde `desde` hasta `hasta` (hoy por defecto)
   * cuando hace falta barrer todo el historial (cada día son ~2 MB y varios segundos).
   *
   * Se ignoran los secuenciales del rango excluido (`CONTIFICO_SECUENCIALES_EXCLUIDOS`,
   * ver contifico-emision.config.ts): las facturas 001000001–001000010 del
   * 07–08/09/2026, fuera de la secuencia real.
   *
   * Devuelve al menos `floor` (por defecto `CONTIFICO_SECUENCIAL_MINIMO`).
   */
  async fetchLastSequentialFromContifico(
    serie: string = CONTIFICO_SERIE,
    options: number | {
      daysBack?: number;
      desde?: Date;
      hasta?: Date;
      floor?: number;
      /** `ok = false` cuando algún request de ese día falló y el máximo del día puede estar incompleto. */
      onDay?: (fecha: string, maxDia: number, acumulado: number, ok: boolean) => void;
    } = {}
  ): Promise<number> {
    const opts = typeof options === "number" ? { daysBack: options } : options;
    const floor = opts.floor ?? CONTIFICO_SECUENCIAL_MINIMO;
    let max = floor;

    const dias: Date[] = [];
    if (opts.desde) {
      const hasta = opts.hasta ?? new Date();
      for (const d = new Date(opts.desde); d <= hasta; d.setDate(d.getDate() + 1)) {
        dias.push(new Date(d));
      }
    } else {
      const daysBack = opts.daysBack ?? 2;
      for (let i = 0; i < daysBack; i++) {
        const day = new Date();
        day.setDate(day.getDate() - i);
        dias.push(day);
      }
    }

    // La API pagina (`result_size` / `result_page`). Se recorren todas las páginas del
    // día; sin esto un día con muchas facturas podría dejar fuera el máximo real.
    const PAGE_SIZE = 500;
    const MAX_PAGES = 40;

    for (const day of dias) {
      const fecha = day.toLocaleDateString("en-GB"); // DD/MM/YYYY
      let maxDia = 0;
      let ok = true;
      const seenIds = new Set<string>();

      for (let page = 1; page <= MAX_PAGES; page++) {
        let docs: any[];
        try {
          const res = await this.getDocuments({
            fecha_emision: fecha,
            tipo_registro: "CLI",
            result_size: PAGE_SIZE,
            result_page: page,
          });
          docs = Array.isArray(res) ? res : [];
        } catch (err: any) {
          ok = false;
          console.warn(`⚠️ [${this.source}] No se pudo leer documentos de ${fecha} (página ${page}): ${err.message}`);
          break;
        }

        let nuevos = 0;
        for (const doc of docs) {
          const id = String(doc?.id ?? doc?.documento ?? "");
          if (id && seenIds.has(id)) continue; // la API repitió resultados: no seguir paginando
          if (id) seenIds.add(id);
          nuevos++;
          const seq = parseSequential(doc?.documento, serie);
          if (seq !== null && seq > maxDia) maxDia = seq;
        }

        // Última página: vino incompleta, vacía, o sólo repitió lo ya visto.
        if (docs.length < PAGE_SIZE || nuevos === 0) break;
      }

      if (maxDia > max) max = maxDia;
      opts.onDay?.(fecha, maxDia, max, ok);
    }

    return max;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VENDEDOR (comisiones)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resuelve el vendedor que debe salir en la factura.
   *
   * Orden de búsqueda:
   *   1. `order.sellerIdentification` (cédula elegida al crear el pedido)
   *   2. `order.sellerName`
   *   3. `order.responsible` — para que los pedidos antiguos, donde el
   *      responsable ya es uno de los vendedores, también arrastren la comisión.
   *
   * Devuelve el fragmento de payload listo para mezclar en el documento, o `null`
   * si no hay vendedor identificable (la factura sale igual, sin comisión).
   */
  async resolveVendedorPayload(orderData: any): Promise<{ vendedor_id?: string; vendedor?: any } | null> {
    const identification = String(orderData?.sellerIdentification || "").replace(/\D/g, "");
    const byName = String(orderData?.sellerName || orderData?.responsible || "").trim();

    let seller = null as any;

    if (identification) {
      seller = await SellerModel.findOne({
        contificoSource: this.source,
        identification,
        isActive: true,
      });
    }

    if (!seller && byName) {
      seller = await SellerModel.findOne({
        contificoSource: this.source,
        isActive: true,
        name: new RegExp(`^${byName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      });
    }

    if (!seller) {
      if (identification || byName) {
        console.warn(`⚠️ [${this.source}] Sin vendedor en catálogo para "${byName || identification}" — la factura sale sin comisión.`);
      }
      return null;
    }

    // Contífico identifica al vendedor por su ID de persona. Si todavía no lo
    // tenemos guardado, lo resolvemos por cédula y lo cacheamos.
    if (!seller.contificoPersonId) {
      const persona = await this.findPersona(seller.identification);
      if (persona?.id) {
        seller.contificoPersonId = persona.id;
        await seller.save();
      }
    }

    if (!seller.contificoPersonId) {
      console.warn(`⚠️ [${this.source}] Vendedor ${seller.name} (${seller.identification}) no existe en Contífico.`);
      return null;
    }

    return {
      vendedor_id: seller.contificoPersonId,
      vendedor: {
        cedula: seller.identification,
        razon_social: seller.name,
        tipo: "N",
      },
    };
  }

  /**
   * Resuelve el POS ID para esta cuenta Contífico.
   * Prioridad: env var → auto-detección por frecuencia en /caja/ → primer caja disponible.
   * El resultado queda cacheado por instancia (una sola llamada a la API por ciclo de vida).
   */
  async resolvePosId(): Promise<string> {
    if (this.posIdResolved) return this.resolvedPosId;

    // Si viene configurado por env var, usarlo directamente
    if (this.posId) {
      this.resolvedPosId = this.posId;
      this.posIdResolved = true;
      return this.resolvedPosId;
    }

    // Auto-detectar desde la API
    try {
      const cajas = await this.getCajas();
      if (cajas && cajas.length > 0) {
        // Contar qué POS aparece más veces en las sesiones de caja → el más activo
        const freq: Record<string, number> = {};
        for (const c of cajas) {
          if (c.pos) freq[c.pos] = (freq[c.pos] || 0) + 1;
        }
        const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0) {
          this.resolvedPosId = sorted[0][0];
          console.log(`✅ [${this.source}] POS auto-detectado: ${this.resolvedPosId}`);
        } else {
          // Sin campo pos, usar el id de la primera caja directamente
          this.resolvedPosId = cajas[0].id || "";
          console.warn(`⚠️ [${this.source}] Cajas sin campo 'pos', usando primera caja: ${this.resolvedPosId}`);
        }
      } else {
        console.warn(`⚠️ [${this.source}] No se encontraron cajas en Contífico.`);
      }
    } catch (err) {
      console.error(`❌ [${this.source}] Error al auto-detectar POS ID:`, err);
    }

    this.posIdResolved = true;
    return this.resolvedPosId;
  }

  /**
   * Get Cajas (Cash Registers)
   */
  async getCajas() {
    try {
      const response = await axios.get(`${this.baseUrl}/caja/`, {
        headers: { Authorization: this.apiKey }
      });
      return response.data;
    } catch (error: any) {
      console.error("❌ Error fetching Cajas:", error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Get Bank Accounts (Cuentas Bancarias)
   */
  async getBankAccounts() {
    try {
      // Endpoint: /banco/cuenta/
      const response = await axios.get(`${this.baseUrl}/banco/cuenta/`, {
        headers: { Authorization: this.apiKey }
      });
      return response.data;
    } catch (error: any) {
      console.warn("⚠️ Error fetching Bank Accounts (trying /banco/cuenta/):", error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Repara una factura rota vía PUT (subtotal_12 = 0 con iva > 0).
   * La API de Contífico no soporta DELETE en documentos — en cambio usamos PUT
   * para corregir los campos y re-firmar. Contífico re-genera la firma automáticamente.
   * @param documentId ID del documento en Contífico
   * @param orderData Datos del pedido (mismos que se usan en createInvoice)
   */
  async repairDocument(documentId: string, orderData: any) {
    assertWebOrderProductsLinked(orderData);
    try {
      // Recalcular totales correctos (igual que createInvoice)
      let subtotal_0 = 0;
      let subtotal_12_val = 0;

      const detalles = orderData.products.map((p: any) => {
        const cantidad = Number(p.quantity);
        const precio = Number(p.price);
        const ivaIncluido = isPrecioIvaIncluido(p);
        const porcentaje_iva = 15; // Siempre 15% (Ecuador 2024+)

        let calcPrice = precio;
        if (ivaIncluido) calcPrice = precio / 1.15;

        let discountPercentage = p.isCourtesy ? 100 : 0;
        if (orderData.isGlobalCourtesy) {
          discountPercentage = 100;
        } else if (orderData.globalDiscountPercentage > 0 && discountPercentage < 100) {
          discountPercentage = orderData.globalDiscountPercentage;
        }

        const totalLine = cantidad * calcPrice * ((100 - discountPercentage) / 100);
        const base_gravable = Number(totalLine.toFixed(2));
        subtotal_12_val += base_gravable;

        return {
          producto_id: p.contifico_id || "9pgenB6GQcVWoeNQ",
          cantidad,
          precio: Number(calcPrice.toFixed(4)),
          descripcion: p.name,
          porcentaje_iva,
          base_cero: 0,
          base_gravable,
          base_no_gravable: 0,
          porcentaje_descuento: discountPercentage,
        };
      });

      const iva = Number((subtotal_12_val * 0.15).toFixed(2));
      const total = Number((subtotal_0 + subtotal_12_val + iva).toFixed(2));

      const POS_ID = await this.resolvePosId();
      // El documento reparado debe conservar el mismo vendedor, o se pierde la comisión.
      const vendedorPayload = await this.resolveVendedorPayload(orderData);
      const rawId = (orderData.invoiceData?.ruc || "").replace(/\s+/g, "");

      // Mismo criterio que createInvoice: tipo según doc oficial (N/J), nunca "C"
      let ruc: string, cedula: string, tipo: string;
      if (rawId.length === 13) {
        ruc = rawId;
        cedula = rawId.endsWith("001") ? rawId.slice(0, 10) : "";
        tipo = rawId.endsWith("001") ? "N" : "J";
      } else {
        ruc = rawId + "001"; cedula = rawId; tipo = "N";
      }

      const payload = {
        id: documentId,
        pos: POS_ID,
        fecha_emision: new Date().toLocaleDateString("en-GB"),
        tipo_documento: "FAC",
        // Preservar el número de secuencia original del documento para que Contifico
        // no genere uno nuevo. Sin esto, el PUT puede asignar un numero diferente
        // lo que rompe la trazabilidad con el SRI.
        documento: orderData.invoiceInfo?.documento,
        estado: "P",
        electronico: true,
        autorizacion: "",
        cliente: {
          razon_social: orderData.invoiceData?.businessName,
          ruc,
          cedula,
          email: orderData.invoiceData?.email,
          direccion: orderData.invoiceData?.address,
          tipo,
          telefonos: orderData.invoiceData?.phone || orderData.customerPhone,
        },
        detalles,
        subtotal_0: Number(subtotal_0.toFixed(2)),
        subtotal_12: Number(subtotal_12_val.toFixed(2)),
        subtotal_15: 0,
        iva,
        ice: 0,
        total,
        servicio: 0,
        propina: 0,
        metodo_pago: "TRA",
        ...(vendedorPayload || {}),
      };

      const response = await axios.put(`${this.baseUrl}/documento/`, payload, {
        headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      });

      return response.data;
    } catch (error: any) {
      console.error("❌ Error repairing document in Contífico:", error.response?.data || error.message);
      throw new Error(error.response?.data?.mensaje || "Failed to repair document in Contífico");
    }
  }

  /**
   * Espera a que Contifico firme el documento y luego lo envía al SRI.
   * Contifico firma en background unos segundos después de crear el documento.
   * Si llamamos sendToSri antes de que esté firmado, el request se ignora silenciosamente.
   * @param documentId Document ID
   * @param maxWaitMs Tiempo máximo de espera en ms (default 30s)
   */
  async sendToSriWhenReady(documentId: string, maxWaitMs = 600000): Promise<any> {
    const pollInterval = 15000; // verificar cada 15 segundos (Contifico firma en 2-10 min)
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      try {
        const estado = await this.getDocumentEstado(documentId);
        // NOTA: la API devuelve "No se ha firmado" (no "No Firmado") para documentos sin firma.
        // Solo llamar sendToSri cuando el estado sea exactamente "Firmado".
        if (estado?.estado === 'Firmado') {
          // Documento firmado — ahora sí enviar al SRI
          console.log(`✅ [${this.source}] Doc ${documentId} firmado, enviando al SRI...`);
          return await this.sendToSri(documentId);
        }
        console.log(`⏳ [${this.source}] Doc ${documentId} estado="${estado?.estado}" — reintentando en ${pollInterval/1000}s...`);
      } catch {
        // Si getDocumentEstado falla, esperamos y reintentamos
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    console.warn(`⚠️ [${this.source}] Doc ${documentId} no se firmó en ${maxWaitMs/1000}s — enviando al SRI de todas formas (Contifico puede haberlo firmado internamente sin actualizar el flag).`);
    return await this.sendToSri(documentId);
  }

  /**
   * Send document to SRI for authorization
   * @param documentId Document ID
   */
  async sendToSri(documentId: string) {
    try {
      // PUT /documento/<ID>/sri/ - No body required
      const response = await axios.put(`${this.baseUrl}/documento/${documentId}/sri/`, {}, {
        headers: { Authorization: this.apiKey }
      });
      return response.data;
    } catch (error: any) {
      console.warn("⚠️ Error triggering SRI authorization:", error.response?.data || error.message);
      // We don't throw here because the invoice is already created and valid, just not authorized yet.
      // Contifico auto-script might pick it up later.
      return { error: error.response?.data || error.message };
    }
  }

  /**
   * Get SRI authorization status for an electronic document
   * @param documentId The Contífico Document ID
   */
  async getDocumentEstado(documentId: string) {
    try {
      const response = await axios.get(`${this.baseUrl}/documento/${documentId}/estado/`, {
        headers: { Authorization: this.apiKey }
      });
      return response.data; // { documento_id, tipo_registro, tipo_documento, estado }
    } catch (error: any) {
      console.error("❌ Error fetching document estado:", error.response?.data || error.message);
      throw new Error(error.response?.data?.mensaje || "Failed to fetch document estado");
    }
  }

  /**
   * Get stock per warehouse for a specific product
   * @param productId The Contífico Product ID
   */
  async getStockByProduct(productId: string) {
    try {
      if (!productId) throw new Error("Product ID is required");

      const response = await axios.get(`${this.baseUrl}/producto/${productId}/stock/`, {
        headers: { Authorization: this.apiKey },
      });

      return response.data;
    } catch (error: any) {
      console.error(`❌ Error fetching stock for product ${productId}:`, error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Get warehouses from Contífico
   */
  async getWarehouses() {
    try {
      const response = await axios.get(`${this.baseUrl}/bodega/`, {
        headers: { Authorization: this.apiKey },
      });
      return response.data;
    } catch (error: any) {
      console.error("❌ Error fetching warehouses from Contífico:", error.response?.data || error.message);
      return [];
    }
  }
}
