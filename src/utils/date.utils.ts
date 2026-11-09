/**
 * Utility for handling dates in Ecuador Time (UTC-5)
 */

/**
 * Returns the current date and time in Ecuador (UTC-5).
 */
export function getEcuadorNow(): Date {
  const now = new Date();
  // Ecuador is UTC-5
  return new Date(now.getTime() - (5 * 3600000));
}

/**
 * Fecha (YYYY-MM-DD) de la jornada operativa en Ecuador.
 * Entre las 00:00 y las 05:59 sigue siendo la jornada del día anterior.
 */
export function getOperationalDateStr(): string {
  const ecNow = getEcuadorNow();
  if (ecNow.getUTCHours() < 6) {
    ecNow.setUTCDate(ecNow.getUTCDate() - 1);
  }
  return ecNow.toISOString().split("T")[0];
}

/**
 * Creates MongoDB-compatible date ranges for Ecuador boundaries.
 * @param dateStr Format YYYY-MM-DD
 * @param isFullTimestamp If true, adds 5 hours to the UTC conversion to align with EC midnight.
 *                        This is used for fields like createdAt which are stored as full timestamps.
 */
export function getECDateRange(dateStr: string, isFullTimestamp: boolean) {
  const [y, m, d] = dateStr.split('-').map(Number);

  if (isFullTimestamp) {
    // For fields like createdAt (full timestamp)
    // 00:00:00 local EC = 05:00:00 UTC
    // 23:59:59 local EC = 04:59:59 UTC (next day)
    return {
      startDate: new Date(Date.UTC(y, m - 1, d, 5, 0, 0, 0)),
      endDate: new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) + (5 * 3600000))
    };
  } else {
    // For fields like deliveryDate (stored as UTC 00:00:00)
    // We treat the date string as the literal day boundary in UTC.
    return {
      startDate: new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0)),
      endDate: new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999))
    };
  }
}

/**
 * DEPRECATED: Use getECDateRange instead.
 * Kept for backward compatibility if needed by other services.
 */
export function getEcuadorDateRange(date: Date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  return {
    startDate: new Date(`${dateStr}T00:00:00.000Z`),
    endDate: new Date(`${dateStr}T23:59:59.999Z`)
  };
}
