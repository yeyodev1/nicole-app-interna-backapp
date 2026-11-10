import { Request, Response } from "express";
import { HttpStatusCode } from "axios";
import { FutureSalesService } from "../services/future-sales.service";


const futureSalesService = new FutureSalesService();


/** GET /api/production/future-sales?window=0&source=nicole|sucree */
export async function getFutureSales(req: Request, res: Response): Promise<void> {
  try {
    const window = Number(req.query.window || 0);
    const raw = String(req.query.source || "");
    const source = raw === "nicole" || raw === "sucree" ? raw : undefined;
    const data = await futureSalesService.getFutureSales(window, source);
    res.status(HttpStatusCode.Ok).send({ message: "Ventas a futuro.", data });
  } catch (error: any) {
    console.error("Error en ventas a futuro:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo cargar ventas a futuro.", error: error.message });
  }
}
