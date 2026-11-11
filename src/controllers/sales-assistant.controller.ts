import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { SalesAssistantAnalysisModel, SalesAssistantMarkModel } from "../models/sales-assistant.model";
import { AuthRequest } from "../types/AuthRequest";
import { aiConfigured, rangeStart, runSalesAnalysis } from "../services/sales-assistant.service";

/** Asistente de ventas: solo los roles comerciales (y gerencia) lo ven y lo usan. */
const ALLOWED_ROLES = ["admin", "superadmin", "sales", "SALES_MANAGER", "SALES_REP"];
/** Un análisis "en curso" más viejo que esto se da por caído (Vercel corta a los 60 s). */
const RUNNING_STALE_MS = 2 * 60 * 1000;

function allowed(req: AuthRequest, res: Response): boolean {
  if (req.user && ALLOWED_ROLES.includes(req.user.role)) return true;
  res.status(HttpStatusCode.Forbidden).send({ message: "El asistente de ventas es solo para el equipo comercial." });
  return false;
}

const who = (req: AuthRequest) => ({ id: req.user?.id, name: req.user?.name || req.user?.email || "Usuario" });

/** Une el análisis con las casillas vigentes de los comerciales. */
async function withMarks(analysis: any) {
  if (!analysis) return null;
  const keys = (analysis.items || []).map((i: any) => i.key);
  const marks = keys.length ? await SalesAssistantMarkModel.find({ key: { $in: keys } }).lean() : [];
  const byKey = new Map(marks.map((m) => [m.key, m]));
  return {
    ...analysis,
    items: (analysis.items || []).map((i: any) => {
      const m = byKey.get(i.key);
      return { ...i, mark: m ? { read: m.read, status: m.status, by: m.by?.name, at: m.updatedAt } : null };
    }),
  };
}

/** GET /api/sales-assistant/latest — último análisis terminado (o null). */
export async function getLatest(req: AuthRequest, res: Response, _next: NextFunction) {
  if (!allowed(req, res)) return;
  try {
    const [latest, running] = await Promise.all([
      SalesAssistantAnalysisModel.findOne({ status: "DONE" }).sort({ createdAt: -1 }).lean(),
      SalesAssistantAnalysisModel.findOne({ status: "RUNNING", createdAt: { $gt: new Date(Date.now() - RUNNING_STALE_MS) } })
        .select("by createdAt")
        .lean(),
    ]);
    res.status(HttpStatusCode.Ok).send({ analysis: await withMarks(latest), running: running || null, aiConfigured: aiConfigured() });
  } catch (error) {
    console.error("❌ Error en sales-assistant getLatest:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo leer el asistente de ventas." });
  }
}

/** GET /api/sales-assistant/history — últimos 20 análisis (sin detalle). */
export async function getHistory(req: AuthRequest, res: Response, _next: NextFunction) {
  if (!allowed(req, res)) return;
  try {
    const list = await SalesAssistantAnalysisModel.find({ status: "DONE" })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("createdAt from to by conversationsRead items.group")
      .lean();
    res.status(HttpStatusCode.Ok).send({
      analyses: list.map((a: any) => ({
        _id: a._id,
        createdAt: a.createdAt,
        from: a.from,
        to: a.to,
        by: a.by,
        conversationsRead: a.conversationsRead,
        counts: (a.items || []).reduce((acc: Record<string, number>, i: any) => ({ ...acc, [i.group]: (acc[i.group] || 0) + 1 }), {}),
      })),
    });
  } catch (error) {
    console.error("❌ Error en sales-assistant getHistory:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo leer el historial." });
  }
}

/** GET /api/sales-assistant/analyses/:id */
export async function getAnalysis(req: AuthRequest, res: Response, _next: NextFunction) {
  if (!allowed(req, res)) return;
  try {
    const id = String(req.params.id);
    if (!Types.ObjectId.isValid(id)) {
      res.status(HttpStatusCode.NotFound).send({ message: "Análisis no encontrado." });
      return;
    }
    const analysis = await SalesAssistantAnalysisModel.findById(id).lean();
    if (!analysis) {
      res.status(HttpStatusCode.NotFound).send({ message: "Análisis no encontrado." });
      return;
    }
    res.status(HttpStatusCode.Ok).send({ analysis: await withMarks(analysis), aiConfigured: aiConfigured() });
  } catch (error) {
    console.error("❌ Error en sales-assistant getAnalysis:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo leer el análisis." });
  }
}

/** POST /api/sales-assistant/analyze — corre un análisis nuevo (desde ayer 17:00 hasta ahora). */
export async function analyze(req: AuthRequest, res: Response, _next: NextFunction) {
  if (!allowed(req, res)) return;
  const running = await SalesAssistantAnalysisModel.findOne({
    status: "RUNNING",
    createdAt: { $gt: new Date(Date.now() - RUNNING_STALE_MS) },
  }).lean();
  if (running) {
    res.status(HttpStatusCode.Conflict).send({ message: `${running.by?.name || "Alguien"} ya está analizando. Espera un momento.` });
    return;
  }

  const to = new Date();
  const from = rangeStart(to.getTime());
  const doc = await SalesAssistantAnalysisModel.create({ status: "RUNNING", from, to, by: who(req) });
  try {
    const result = await runSalesAnalysis(from);
    doc.set({ status: "DONE", items: result.items, conversationsRead: result.conversationsRead, warnings: result.warnings });
    await doc.save();
    res.status(HttpStatusCode.Ok).send({ analysis: await withMarks(doc.toObject()), aiConfigured: aiConfigured() });
  } catch (error) {
    console.error("❌ Error en sales-assistant analyze:", error);
    doc.set({ status: "ERROR", error: (error as Error).message?.slice(0, 300) });
    await doc.save().catch(() => undefined);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo completar el análisis. Intenta de nuevo." });
  }
}

/** PUT /api/sales-assistant/marks/:key — casillas Leído / Gestionado / No se gestiona. */
export async function setMark(req: AuthRequest, res: Response, _next: NextFunction) {
  if (!allowed(req, res)) return;
  try {
    const key = String(req.params.key || "").slice(0, 200);
    const { read, status } = req.body || {};
    if (!key || (status !== null && status !== undefined && !["GESTIONADO", "NO_GESTIONAR"].includes(status))) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Datos inválidos." });
      return;
    }
    const finalStatus = status ?? null;
    // Gestionado o "no se gestiona" implica que ya se leyó.
    const finalRead = finalStatus ? true : !!read;
    const mark = await SalesAssistantMarkModel.findOneAndUpdate(
      { key },
      { read: finalRead, status: finalStatus, by: who(req) },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    res.status(HttpStatusCode.Ok).send({ mark: { read: mark!.read, status: mark!.status, by: mark!.by?.name, at: mark!.updatedAt } });
  } catch (error) {
    console.error("❌ Error en sales-assistant setMark:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo guardar la casilla." });
  }
}
