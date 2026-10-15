/**
 * Teléfonos de Ecuador. El asesor puede escribir "0991234567", "099 123 4567" o
 * "+593 99 123 4567": todo se guarda igual, en formato local (09XXXXXXXX), para
 * que el buscador y el WhatsApp encuentren siempre al mismo cliente.
 */
export function normalizeEcPhone(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/[\s().-]/g, "");
  const national = /^\+?593(\d+)$/.exec(raw)?.[1] ?? raw.replace(/^0/, "");
  if (/^9\d{8}$/.test(national)) return `0${national}`; // celular
  if (/^[2-7]\d{7}$/.test(national)) return `0${national}`; // fijo
  return "";
}

/**
 * Regex para buscar un teléfono sin importar cómo quedó guardado (09…, +593…,
 * con espacios). Compara los últimos 8–9 dígitos. Devuelve null si el texto no
 * parece un teléfono.
 */
export function phoneSearchRegex(search: string): RegExp | null {
  const digits = String(search).replace(/\D/g, "");
  if (digits.length < 6) return null;
  const national = digits.startsWith("593") ? digits.slice(3) : digits.replace(/^0/, "");
  if (national.length < 6) return null;
  // Entre dígitos puede haber espacios, guiones o puntos.
  return new RegExp(national.split("").join("[\\s.-]*") + "$");
}
