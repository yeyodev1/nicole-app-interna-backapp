import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Registro sin inferencia de tipos: con ~20 herramientas, tsc se quedaba sin memoria en Vercel. zod valida igual en ejecución. */
const reg = (server: unknown) => (server as any).registerTool.bind(server) as (name: string, config: any, cb: (args: any) => Promise<any>) => void;
import { ec, hl, hlConfigured, locationId, pipelines, stageMap, teamMap, userIdByName } from "./highlevel.service";

/**
 * Herramientas de SOLO LECTURA del CRM de Nicole (HighLevel): equipo, quién atiende y cómo
 * (conversaciones pendientes, mensajes), contactos, embudo de ventas y citas.
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `No pude leer el CRM: ${(e as Error).message}` }], isError: true });
const hoursSince = (ms: unknown) => (ms ? Math.round(((Date.now() - Number(ms)) / 3600000) * 10) / 10 : null);

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa AAAA-MM-DD");
const ecStart = (ymd: string) => Date.parse(`${ymd}T00:00:00-05:00`);
const ecEnd = (ymd: string) => Date.parse(`${ymd}T23:59:59.999-05:00`);
const todayEc = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
const daysAgoEc = (n: number) => new Date(Date.now() - 5 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
/** "AAAA-MM-DD" → "MM-DD-AAAA" (formato del filtro de oportunidades del CRM). */
const mdy = (ymd: string) => {
  const [y, m, d] = ymd.split("-");
  return `${m}-${d}-${y}`;
};

const MAX_PAGES = 40; // 4.000 conversaciones
const TIME_BUDGET_MS = 45_000;

/**
 * Conversaciones cuyo último mensaje cae entre `desde` y `hasta` (hora de Ecuador). El CRM
 * entrega de a 100, de la más reciente a la más vieja: se pagina hasta pasar `desde`.
 */
async function conversationsInRange(opts: { desde: string; hasta: string; assignedTo?: string; query?: string }) {
  const from = ecStart(opts.desde);
  const to = ecEnd(opts.hasta);
  const out: any[] = [];
  let startAfterDate: string | undefined;
  let pages = 0;
  let complete = false;
  const started = Date.now();
  while (pages < MAX_PAGES && Date.now() - started < TIME_BUDGET_MS) {
    const qs = new URLSearchParams({ locationId: locationId(), limit: "100", sort: "desc", sortBy: "last_message_date" });
    if (opts.assignedTo) qs.set("assignedTo", opts.assignedTo);
    if (opts.query) qs.set("query", opts.query);
    if (startAfterDate) qs.set("startAfterDate", startAfterDate);
    const d = await hl<any>(`/conversations/search?${qs}`);
    const page: any[] = d.conversations || [];
    pages++;
    for (const c of page) {
      const t = Number(c.lastMessageDate);
      if (t >= from && t <= to) out.push(c);
    }
    const oldest = Number(page[page.length - 1]?.lastMessageDate);
    if (page.length < 100 || !Number.isFinite(oldest) || oldest < from) {
      complete = true;
      break;
    }
    startAfterDate = String(page[page.length - 1].sort?.[0] ?? page[page.length - 1].lastMessageDate);
  }
  return { conversations: out, complete, pages };
}

export function registerCrmTools(server: McpServer) {
  if (!hlConfigured()) return;

  reg(server)(
    "crm_equipo",
    { title: "Equipo del CRM", description: "Personas del equipo de ventas/atención en el CRM (HighLevel) de Nicole.", inputSchema: {}, annotations: READ_ONLY },
    async () => {
      try {
        return json([...(await teamMap())].map(([id, nombre]) => ({ id, nombre })));
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "crm_atencion",
    {
      title: "Quién atiende y cómo",
      description:
        "Resume la atención por asesor en un rango de fechas (por defecto, los últimos 7 días): conversaciones con actividad, respondidas, sin responder (el último mensaje es del cliente), sin leer, la espera más larga y las que más tiempo llevan esperando. Recorre TODAS las conversaciones del rango, no solo las últimas 100.",
      inputSchema: { desde: YMD.optional(), hasta: YMD.optional(), asesor: z.string().optional() },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, asesor }: any) => {
      try {
        const team = await teamMap();
        const range = { desde: desde || daysAgoEc(6), hasta: hasta || todayEc() };
        const { conversations: convs, complete, pages } = await conversationsInRange({ ...range, assignedTo: await userIdByName(asesor) });
        const by: Record<string, any> = {};
        const pendientes: any[] = [];
        for (const c of convs) {
          const who = team.get(c.assignedTo) || (c.assignedTo ? c.assignedTo : "Sin asignar");
          by[who] ||= { conversaciones: 0, respondidas: 0, sin_responder: 0, sin_leer: 0, espera_max_horas: 0 };
          by[who].conversaciones++;
          if (Number(c.unreadCount) > 0) by[who].sin_leer++;
          if (c.lastMessageDirection === "inbound" && !c.isLastMessageInternalComment) {
            by[who].sin_responder++;
            const h = hoursSince(c.lastMessageDate) || 0;
            by[who].espera_max_horas = Math.max(by[who].espera_max_horas, h);
            pendientes.push({ conversacion_id: c.id, cliente: c.fullName || c.contactName, asesor: who, canal: c.lastMessageType, ultimo_mensaje: String(c.lastMessageBody || "").slice(0, 140), recibido: ec(c.lastMessageDate), horas_esperando: h });
          } else by[who].respondidas++;
        }
        pendientes.sort((a, b) => (b.horas_esperando || 0) - (a.horas_esperando || 0));
        return json({
          rango: range,
          conversaciones_en_rango: convs.length,
          revision_completa: complete,
          nota: complete ? undefined : `Se revisaron ${pages * 100} conversaciones (límite de tiempo); acota el rango para ver todo.`,
          por_asesor: by,
          mas_tiempo_esperando: pendientes.slice(0, 40),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "crm_conversaciones",
    {
      title: "Conversaciones del CRM",
      description:
        "Lista conversaciones con actividad en un rango de fechas (por defecto, hoy), de un asesor, solo las pendientes de responder o buscando por nombre/teléfono. Recorre todas las del rango (no solo las últimas 100).",
      inputSchema: {
        desde: YMD.optional(),
        hasta: YMD.optional(),
        asesor: z.string().optional(),
        solo_sin_responder: z.boolean().default(false),
        texto: z.string().optional().describe("Nombre o teléfono del cliente"),
        limite: z.number().int().min(1).max(300).default(50).describe("Cuántas devolver"),
      },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta, asesor, solo_sin_responder, texto, limite }: any) => {
      try {
        const team = await teamMap();
        const range = { desde: desde || todayEc(), hasta: hasta || todayEc() };
        const { conversations, complete } = await conversationsInRange({ ...range, assignedTo: await userIdByName(asesor), query: texto });
        let convs = conversations;
        if (solo_sin_responder) convs = convs.filter((c: any) => c.lastMessageDirection === "inbound");
        return json({
          rango: range,
          total: convs.length,
          revision_completa: complete,
          conversaciones: convs.slice(0, limite).map((c: any) => ({
            conversacion_id: c.id,
            contacto_id: c.contactId,
            cliente: c.fullName || c.contactName,
            telefono: c.phone || null,
            asesor: team.get(c.assignedTo) || "Sin asignar",
            canal: c.lastMessageType,
            ultimo_mensaje: String(c.lastMessageBody || "").slice(0, 200),
            de: c.lastMessageDirection === "inbound" ? "cliente" : "equipo",
            fecha: ec(c.lastMessageDate),
            sin_leer: Number(c.unreadCount) || 0,
            etiquetas: c.tags || [],
          })),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "crm_mensajes",
    {
      title: "Mensajes de una conversación",
      description: "Lee los mensajes de una conversación (para ver cómo atendió el asesor: tiempos, tono, si cerró la venta). Usa el conversacion_id de crm_conversaciones o crm_atencion.",
      inputSchema: { conversacion_id: z.string().min(5), limite: z.number().int().min(1).max(300).default(60) },
      annotations: READ_ONLY,
    },
    async ({ conversacion_id, limite }: any) => {
      try {
        const team = await teamMap();
        const msgs: any[] = [];
        let lastMessageId: string | undefined;
        while (msgs.length < limite) {
          const qs = new URLSearchParams({ limit: String(Math.min(100, limite - msgs.length)) });
          if (lastMessageId) qs.set("lastMessageId", lastMessageId);
          const d = await hl<any>(`/conversations/${encodeURIComponent(conversacion_id)}/messages?${qs}`);
          const page: any[] = d.messages?.messages || d.messages || [];
          msgs.push(...page);
          if (!d.messages?.nextPage || !page.length) break;
          lastMessageId = d.messages?.lastMessageId || page[page.length - 1]?.id;
        }
        return json(
          msgs
            .map((m) => ({
              fecha: ec(m.dateAdded),
              de: m.direction === "inbound" ? "cliente" : team.get(m.userId) || (m.source === "workflow" ? "automatización" : "equipo"),
              canal: m.messageType,
              texto: String(m.body || "").slice(0, 1000),
              adjuntos: (m.attachments || []).length || undefined,
            }))
            .reverse()
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "crm_buscar_contactos",
    {
      title: "Buscar contactos",
      description: "Busca contactos del CRM por nombre, teléfono o correo.",
      inputSchema: { texto: z.string().min(2), limite: z.number().int().min(1).max(50).default(10) },
      annotations: READ_ONLY,
    },
    async ({ texto, limite }: any) => {
      try {
        const team = await teamMap();
        const d = await hl<any>("/contacts/search", { method: "POST", body: { locationId: locationId(), pageLimit: limite, query: texto } });
        return json({
          total: d.total,
          contactos: (d.contacts || []).map((c: any) => ({
            contacto_id: c.id,
            nombre: [c.firstNameLowerCase || c.firstName, c.lastNameLowerCase || c.lastName].filter(Boolean).join(" ") || c.contactName,
            telefono: c.phone,
            correo: c.email,
            asesor: team.get(c.assignedTo) || null,
            etiquetas: c.tags || [],
            creado: ec(c.dateAdded),
            ultima_actividad: ec(c.lastActivity),
          })),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "crm_ver_contacto",
    { title: "Ver contacto", description: "Ficha completa de un contacto del CRM.", inputSchema: { contacto_id: z.string().min(5) }, annotations: READ_ONLY },
    async ({ contacto_id }: any) => {
      try {
        const team = await teamMap();
        const { contact: c } = await hl<any>(`/contacts/${encodeURIComponent(contacto_id)}`);
        return json({
          contacto_id: c.id,
          nombre: c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" "),
          telefono: c.phone,
          correo: c.email,
          asesor: team.get(c.assignedTo) || null,
          etiquetas: c.tags,
          origen: c.source,
          creado: ec(c.dateAdded),
          campos: (c.customFields || []).slice(0, 30),
          atribucion: c.attributionSource || null,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "crm_embudo",
    {
      title: "Embudo de ventas",
      description: "Cuántas oportunidades hay en cada etapa del embudo del CRM (Nuevo lead, Interesado, Pagado, Entregado, Venta perdida…), opcionalmente de un asesor.",
      inputSchema: { asesor: z.string().optional(), desde: YMD.optional().describe("Creadas desde"), hasta: YMD.optional() },
      annotations: READ_ONLY,
    },
    async ({ asesor, desde, hasta }: any) => {
      try {
        const uid = await userIdByName(asesor);
        const result: any[] = [];
        for (const p of await pipelines()) {
          for (const s of p.stages || []) {
            const qs = new URLSearchParams({ location_id: locationId(), pipeline_id: p.id, pipeline_stage_id: s.id, limit: "1" });
            if (uid) qs.set("assigned_to", uid);
            if (desde || hasta) {
              qs.set("date", mdy(desde || "2020-01-01"));
              qs.set("endDate", mdy(hasta || todayEc()));
            }
            const d = await hl<any>(`/opportunities/search?${qs}`);
            result.push({ embudo: p.name, etapa: s.name, oportunidades: d.meta?.total ?? 0 });
          }
        }
        return json({ asesor: asesor || "todos", creadas: desde || hasta ? { desde: desde || "inicio", hasta: hasta || todayEc() } : "todas", etapas: result });
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "crm_oportunidades",
    {
      title: "Oportunidades",
      description: "Lista oportunidades del CRM por etapa, estado (open/won/lost/abandoned), asesor o texto.",
      inputSchema: {
        etapa: z.string().optional().describe("Nombre de la etapa, p. ej. 'Interesado'"),
        estado: z.enum(["open", "won", "lost", "abandoned", "all"]).default("all"),
        asesor: z.string().optional(),
        texto: z.string().optional(),
        desde: YMD.optional().describe("Creadas desde"),
        hasta: YMD.optional(),
        limite: z.number().int().min(1).max(500).default(50),
      },
      annotations: READ_ONLY,
    },
    async ({ etapa, estado, asesor, texto, desde, hasta, limite }: any) => {
      try {
        const [team, stages] = await Promise.all([teamMap(), stageMap()]);
        const qs = new URLSearchParams({ location_id: locationId(), limit: "100" });
        if (desde || hasta) {
          qs.set("date", mdy(desde || "2020-01-01"));
          qs.set("endDate", mdy(hasta || todayEc()));
        }
        if (estado !== "all") qs.set("status", estado);
        const uid = await userIdByName(asesor);
        if (uid) qs.set("assigned_to", uid);
        if (texto) qs.set("q", texto);
        if (etapa) {
          const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
          const hit = [...stages].find(([, n]) => norm(n).includes(norm(etapa)));
          if (hit) qs.set("pipeline_stage_id", hit[0]);
        }
        // Páginas de 100 hasta juntar `limite`.
        const all: any[] = [];
        let total = 0;
        for (let page = 1; all.length < limite && page <= 10; page++) {
          qs.set("page", String(page));
          const d = await hl<any>(`/opportunities/search?${qs}`);
          total = d.meta?.total ?? total;
          all.push(...(d.opportunities || []));
          if (!d.meta?.nextPage) break;
        }
        return json({
          total,
          oportunidades: all.slice(0, limite).map((o: any) => ({
            oportunidad_id: o.id,
            nombre: o.name,
            contacto: o.contact?.name || null,
            telefono: o.contact?.phone || null,
            etapa: stages.get(o.pipelineStageId) || o.pipelineStageId,
            estado: o.status,
            valor: o.monetaryValue,
            asesor: team.get(o.assignedTo) || null,
            creada: ec(o.createdAt),
            ultimo_cambio: ec(o.lastStageChangeAt),
            origen: o.source || o.attributions?.[0]?.utmSessionSource || null,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "crm_citas",
    {
      title: "Citas del CRM",
      description: "Citas agendadas en los calendarios del CRM entre dos fechas (AAAA-MM-DD).",
      inputSchema: { desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
      annotations: READ_ONLY,
    },
    async ({ desde, hasta }: any) => {
      try {
        const team = await teamMap();
        const start = Date.parse(`${desde}T00:00:00-05:00`);
        const end = Date.parse(`${hasta}T23:59:59-05:00`);
        const cals = (await hl<any>(`/calendars/?locationId=${locationId()}`)).calendars || [];
        const events: any[] = [];
        for (const cal of cals) {
          const d = await hl<any>(`/calendars/events?locationId=${locationId()}&calendarId=${cal.id}&startTime=${start}&endTime=${end}`);
          for (const e of d.events || []) {
            events.push({ calendario: cal.name, titulo: e.title, inicio: ec(e.startTime), fin: ec(e.endTime), estado: e.appointmentStatus, asesor: team.get(e.assignedUserId) || null, contacto_id: e.contactId });
          }
        }
        events.sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
        return json({ desde, hasta, citas: events });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
