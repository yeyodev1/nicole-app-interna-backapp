import { models } from "../models";
import { ContificoService } from "./contifico.service";
import { buildContificoCategoryMaps, resolveProduct } from "../utils/contifico-categorias.util";
import { normalizeString } from "../utils/string.utils";
import CustomError from "../errors/customError.error";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Orden 2: comentarios de anomalías del Detalle del Día (Orden 8: enlazados por código). */
export class PosAnomalyNoteService {
  private contifico = new ContificoService("nicole");

  async list(from: string, to: string) {
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new CustomError("from y to (AAAA-MM-DD) son obligatorios.", 400);
    return models.posAnomalyNotes.find({ date: { $gte: from, $lte: to } }).sort({ date: 1, branch: 1, productName: 1 }).lean();
  }

  /** Crea o actualiza (upsert por sucursal + día + producto: editar no duplica). */
  async save(data: { branch?: string; date?: string; productName?: string; descuadre?: number; comment?: string }, user: string) {
    const branch = String(data.branch || "").trim();
    const date = String(data.date || "");
    const productName = String(data.productName || "").trim();
    const comment = String(data.comment || "").trim();
    if (!branch || !productName || !DATE_RE.test(date)) throw new CustomError("branch, date (AAAA-MM-DD) y productName son obligatorios.", 400);
    if (!comment) throw new CustomError("El comentario no puede estar vacío.", 400);
    if (comment.length > 500) throw new CustomError("El comentario admite máximo 500 caracteres.", 400);

    const prod = resolveProduct(await buildContificoCategoryMaps(this.contifico), productName);
    const branchKey = normalizeString(branch);
    const productKey = prod.codigo || normalizeString(productName);
    return models.posAnomalyNotes.findOneAndUpdate(
      { branchKey, date, productKey },
      {
        $set: { branch, productName: prod.nombre, codigo: prod.codigo, descuadre: Number(data.descuadre) || 0, comment, updatedBy: user },
        $setOnInsert: { branchKey, date, productKey, createdBy: user },
      },
      { upsert: true, new: true, runValidators: true }
    ).lean();
  }
}
