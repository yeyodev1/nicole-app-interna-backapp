import { createHash, timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";

/**
 * Protege las rutas máquina-a-máquina que llama la tienda online (`/api/web-orders`).
 *
 * La tienda manda la clave compartida en el header `x-api-key`; aquí se compara con
 * `WEB_ORDERS_API_KEY`. Se comparan los hashes SHA-256 de ambas con `timingSafeEqual`
 * para que el tiempo de respuesta no revele ni el contenido ni el largo de la clave.
 *
 * La tienda de Sucrée (mismo dueño) usa su propia clave, `WEB_ORDERS_API_KEY_SUCREE`,
 * para poder revocarla sin tocar la de Nicole.
 *
 * Sin la variable configurada la integración queda apagada (503) en vez de abierta.
 */
export function webOrdersApiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expectedKey = process.env.WEB_ORDERS_API_KEY;

  if (!expectedKey) {
    res.status(HttpStatusCode.ServiceUnavailable).send({
      message: "La integración con la tienda online no está configurada (falta WEB_ORDERS_API_KEY).",
    });
    return;
  }

  const providedKey = req.headers["x-api-key"];
  if (typeof providedKey !== "string" || !providedKey) {
    res.status(HttpStatusCode.Unauthorized).send({ message: "Falta la clave de acceso (x-api-key)." });
    return;
  }

  const providedHash = createHash("sha256").update(providedKey).digest();
  const validKeys = [expectedKey, process.env.WEB_ORDERS_API_KEY_SUCREE].filter((k): k is string => !!k);
  const matches = validKeys.some((key) =>
    timingSafeEqual(createHash("sha256").update(key).digest(), providedHash),
  );

  if (!matches) {
    res.status(HttpStatusCode.Unauthorized).send({ message: "Clave de acceso inválida." });
    return;
  }

  next();
}
