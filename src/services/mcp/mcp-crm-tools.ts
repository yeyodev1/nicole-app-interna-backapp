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

async function recentConversations(max: number, assignedTo?: string) {
  const out: any[] = [];
  let startAfterDate: string | undefined;
  while (out.length < max) {
    const qs = new URLSearchParams({ locationId: locationId(), limit: String(Math.min(100, max - out.length)), sort: "desc", sortBy: "last_message_date" });
    if (assignedTo) qs.set("assignedTo", assignedTo);
    if (startAfterDate) qs.set("startAfterDate", startAfterDate);
    const d = await hl<any>(`/conversations/search?${qs}`);
    const page = d.conversations || [];
    out.push(...page);
    if (page.length < 100) break;
    const last = page[page.length - 1];
    startAfterDate = String(last.sort?.[0] ?? last.lastMessageDate ?? "");
    if (!startAfterDate) break;
  }
  return out;
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
        "Revisa las conversaciones más recientes del CRM (WhatsApp, Instagram, etc.) y resume por asesor: cuántas tiene, cuántas están sin responder (el último mensaje es del cliente), cuántas sin leer y las que más tiempo llevan esperando.",
      inputSchema: { revisar: z.number().int().min(20).max(500).default(200).describe("Cuántas conversaciones recientes revisar"), asesor: z.string().optional() },
      annotations: READ_ONLY,
    },
    async ({ revisar, asesor }: any) => {
      try {
        const team = await teamMap();
        const convs = await recentConversations(revisar, await userIdByName(asesor));
        const by: Record<string, any> = {};
        const pendientes: any[] = [];
        for (const c of convs) {
          const who = team.get(c.assignedTo) || (c.assignedTo ? c.assignedTo : "Sin asignar");
          by[who] ||= { conversaciones: 0, sin_responder: 0, sin_leer: 0, espera_max_horas: 0 };
          by[who].conversaciones++;
          if (Number(c.unreadCount) > 0) by[who].sin_leer++;
          if (c.lastMessageDirection === "inbound" && !c.isLastMessageInternalComment) {
            by[who].sin_responder++;
            const h = hoursSince(c.lastMessageDate) || 0;
            by[who].espera_max_horas = Math.max(by[who].espera_max_horas, h);
            pendientes.push({ conversacion_id: c.id, cliente: c.fullName || c.contactName, asesor: who, canal: c.lastMessageType, ultimo_mensaje: String(c.lastMessageBody || "").slice(0, 140), recibido: ec(c.lastMessageDate), horas_esperando: h });
          }
        }
        pendientes.sort((a, b) => (b.horas_esperando || 0) - (a.horas_esperando || 0));
        return json({ revisadas: convs.length, por_asesor: by, mas_tiempo_esperando: pendientes.slice(0, 25) });
      } catch (e) {
        return fail(e);
      }
    }
  );

  reg(server)(
    "crm_conversaciones",
    {
      title: "Conversaciones del CRM",
      description: "Lista conversaciones recientes, opcionalmente de un asesor, solo las pendientes de responder o buscando por nombre/teléfono.",
      inputSchema: {
        asesor: z.string().optional(),
        solo_sin_responder: z.boolean().default(false),
        texto: z.string().optional().describe("Nombre o teléfono del cliente"),
        limite: z.number().int().min(1).max(100).default(30),
      },
      annotations: READ_ONLY,
    },
    async ({ asesor, solo_sin_responder, texto, limite }: any) => {
      try {
        const team = await teamMap();
        const qs = new URLSearchParams({ locationId: locationId(), limit: "100", sort: "desc", sortBy: "last_message_date" });
        const uid = await userIdByName(asesor);
        if (uid) qs.set("assignedTo", uid);
        if (texto) qs.set("query", texto);
        const d = await hl<any>(`/conversations/search?${qs}`);
        let convs: any[] = d.conversations || [];
        if (solo_sin_responder) convs = convs.filter((c) => c.lastMessageDirection === "inbound");
        return json(
          convs.slice(0, limite).map((c) => ({
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
          }))
        );
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
      inputSchema: { conversacion_id: z.string().min(5), limite: z.number().int().min(1).max(100).default(40) },
      annotations: READ_ONLY,
    },
    async ({ conversacion_id, limite }: any) => {
      try {
        const team = await teamMap();
        const d = await hl<any>(`/conversations/${encodeURIComponent(conversacion_id)}/messages?limit=${limite}`);
        const msgs: any[] = d.messages?.messages || d.messages || [];
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
      inputSchema: { asesor: z.string().optional() },
      annotations: READ_ONLY,
    },
    async ({ asesor }: any) => {
      try {
        const uid = await userIdByName(asesor);
        const result: any[] = [];
        for (const p of await pipelines()) {
          for (const s of p.stages || []) {
            const qs = new URLSearchParams({ location_id: locationId(), pipeline_id: p.id, pipeline_stage_id: s.id, limit: "1" });
            if (uid) qs.set("assigned_to", uid);
            const d = await hl<any>(`/opportunities/search?${qs}`);
            result.push({ embudo: p.name, etapa: s.name, oportunidades: d.meta?.total ?? 0 });
          }
        }
        return json({ asesor: asesor || "todos", etapas: result });
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
        limite: z.number().int().min(1).max(100).default(30),
      },
      annotations: READ_ONLY,
    },
    async ({ etapa, estado, asesor, texto, limite }: any) => {
      try {
        const [team, stages] = await Promise.all([teamMap(), stageMap()]);
        const qs = new URLSearchParams({ location_id: locationId(), limit: String(limite) });
        if (estado !== "all") qs.set("status", estado);
        const uid = await userIdByName(asesor);
        if (uid) qs.set("assigned_to", uid);
        if (texto) qs.set("q", texto);
        if (etapa) {
          const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
          const hit = [...stages].find(([, n]) => norm(n).includes(norm(etapa)));
          if (hit) qs.set("pipeline_stage_id", hit[0]);
        }
        const d = await hl<any>(`/opportunities/search?${qs}`);
        return json({
          total: d.meta?.total,
          oportunidades: (d.opportunities || []).map((o: any) => ({
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
