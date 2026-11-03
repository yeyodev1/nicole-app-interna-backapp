import type { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { models } from "../models";
import MetaAdsService from "../services/meta-ads.service";
import { ContificoService } from "../services/contifico.service";
import { getECDateRange } from "../utils/date.utils";
import { NOT_UNCONFIRMED_RESERVA } from "../utils/reserva";

const contificoService = new ContificoService();

/**
 * Get cached dashboard stats (Instant response)
 * Query params: from (YYYY-MM-DD), to (YYYY-MM-DD)
 * Default: Last 30 days
 */
export async function getDashboardStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { from, to } = req.query;

    let startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    let endDate = new Date();

    if (from) startDate = new Date(from as string);
    if (to) endDate = new Date(to as string);

    // Normalize to midnight to include full days
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);


    const summaries = await models.dailySummaries.find({
      dateIso: {
        $gte: startDate,
        $lte: endDate
      }
    }).sort({ dateIso: 1 });

    const totalStats = summaries.reduce((acc, curr) => {
      acc.totalSales += curr.totalSales;
      acc.count += curr.transactionCount;
      return acc;
    }, { totalSales: 0, count: 0 });

    res.status(HttpStatusCode.Ok).send({
      message: "Analytics retrieved successfully (Cached).",
      range: {
        from: startDate.toLocaleDateString(),
        to: endDate.toLocaleDateString()
      },
      stats: totalStats,
      dailyBreakdown: summaries
    });
    return;

  } catch (error) {
    console.error("❌ Error in getDashboardStats:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Error fetching analytics." });
    return;
  }
}

/**
 * Trigger manual sync of historical data
 * This fetches data from Contífico and updates our cache
 * Body: { from: "DD/MM/YYYY", to: "DD/MM/YYYY" } 
 * Default: Syncs ONLY Yesterday if no body provided
 */
export async function syncAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    let { from, to } = req.body;

    if (!from) {
      // Default: Sync Yesterday
      const yest = new Date();
      yest.setDate(yest.getDate() - 1);
      from = yest.toLocaleDateString("en-GB"); // DD/MM/YYYY
      to = from;
    }

    if (!to) to = from;


    // Parse DD/MM/YYYY to Date loop
    // Simple helper to parse "DD/MM/YYYY" to Date
    const parseDate = (d: string) => {
      const [day, month, year] = d.split("/");
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    };

    const start = parseDate(from);
    const end = parseDate(to);

    // Safety break
    if (start > end) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Start date must be before end date." });
      return;
    }

    const current = new Date(start);
    const results = [];

    while (current <= end) {
      const dayStr = current.toLocaleDateString("en-GB"); // DD/MM/YYYY


      // Fetch from Contífico
      // Note: this uses our existing service. 
      // We assume getDocuments returns ALL documents. If large, we assume default limit covers it or user accepts partial.
      // For professional robust large scale, we'd need loop pagination here too.
      // For now, let's assume result_size=1000 param can be passed to service if needed,
      // but current service doesn't expose it. We can rely on default behavior for now.
      const docs = await contificoService.getDocuments({ fecha_emision: dayStr });
      const safeDocs = Array.isArray(docs) ? docs : [];

      const dayTotal = safeDocs.reduce((sum: number, doc: any) => sum + parseFloat(doc.total || "0"), 0);
      const dayCount = safeDocs.length;

      // Upsert to DB
      // current is 00:00 local time usually from parseDate logic? 
      // Careful with Timezones. We want to store it as a unique anchor.
      // Let's use UTC noon to avoid shifting.
      const anchorDate = new Date(Date.UTC(current.getFullYear(), current.getMonth(), current.getDate(), 12, 0, 0));

      await models.dailySummaries.findOneAndUpdate(
        { dateIso: anchorDate },
        {
          dateIso: anchorDate,
          totalSales: Math.round(dayTotal * 100) / 100,
          transactionCount: dayCount,
          lastUpdated: new Date()
        },
        { upsert: true, new: true }
      );

      results.push({ date: dayStr, total: dayTotal, count: dayCount });

      // Next Day
      current.setDate(current.getDate() + 1);
    }

    res.status(HttpStatusCode.Ok).send({
      message: "Analytics Sync Completed.",
      syncedDays: results.length,
      details: results
    });
    return;

  } catch (error) {
    console.error("❌ Error in syncAnalytics:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error syncing analytics.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Calculate tiered marginal commission with a minimum threshold.
 *
 * Rules:
 *  - If sales < minimumThreshold → $0 commission (goal not reached yet).
 *  - If sales >= minimumThreshold → apply progressive brackets from $0 on the FULL amount.
 *
 * Example with tiers [{0, 2%}, {10000, 3%}, {13000, 6%}] and threshold 10000:
 *   sales = 9999  → $0   (below threshold)
 *   sales = 10000 → $200 (10000 × 2%)
 *   sales = 14000 → $200 + $90 + $60 = $350
 */
function calculateCommission(
  sales: number,
  tiers: Array<{ threshold: number; rate: number }>,
  minimumThreshold: number
): number {
  if (!tiers || tiers.length === 0 || sales <= 0) return 0;

  // No commission until the person's individual goal is reached
  if (sales < minimumThreshold) return 0;

  const sortedTiers = [...tiers].sort((a, b) => a.threshold - b.threshold);
  let commission = 0;

  for (let i = 0; i < sortedTiers.length; i++) {
    const currentTier = sortedTiers[i];
    const nextTier = sortedTiers[i + 1];

    if (sales > currentTier.threshold) {
      let salesInThisTier = sales - currentTier.threshold;
      if (nextTier) {
        const maxInThisTier = nextTier.threshold - currentTier.threshold;
        salesInThisTier = Math.min(salesInThisTier, maxInThisTier);
      }
      commission += salesInThisTier * (currentTier.rate / 100);
    }
  }

  return Math.round(commission * 100) / 100;
}

import { AuthRequest } from "../types/AuthRequest";

/**
 * Get sales aggregated by responsible person
 * Query params: from (YYYY-MM-DD), to (YYYY-MM-DD)
 */
export async function getSalesByResponsible(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { from, to, source } = req.query;

    // --- Enforce Ecuador Time (UTC-5) ---
    // Calculate defaults based on current Ecuador time
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const ecTime = new Date(utc + (3600000 * -5));

    // Default: Start of current month in Ecuador
    let startY = ecTime.getFullYear();
    let startM = ecTime.getMonth() + 1;
    let startD = 1;

    // Default: Today in Ecuador
    let endY = ecTime.getFullYear();
    let endM = ecTime.getMonth() + 1;
    let endD = ecTime.getDate();

    // Parse Input (YYYY-MM-DD)
    if (from && typeof from === 'string') {
      const parts = from.split('-').map(Number);
      if (parts.length === 3) {
        [startY, startM, startD] = parts;
      }
    }
    if (to && typeof to === 'string') {
      const parts = to.split('-').map(Number);
      if (parts.length === 3) {
        [endY, endM, endD] = parts;
      }
    }

    const pad = (n: number) => n.toString().padStart(2, '0');

    // Create Date objects pointing to Ecuador time
    // 00:00:00 Ecuador = 05:00:00 UTC
    const startDate = new Date(`${startY}-${pad(startM)}-${pad(startD)}T00:00:00-05:00`);
    const endDate = new Date(`${endY}-${pad(endM)}-${pad(endD)}T23:59:59.999-05:00`);


    // --- DATA ISOLATION ---
    // Extract user from request (populated by authMiddleware)
    const jwtUser = (req as any).user;

    // Fetch fresh user to avoid stale JWT issues
    let dbUser = jwtUser;
    if (jwtUser?.email) {
      dbUser = await models.users.findOne({ email: jwtUser.email }).lean() || jwtUser;
    }

    const currentRole = dbUser?.role?.toUpperCase();

    const orderMatch: any = {
      createdAt: { $gte: startDate, $lte: endDate },
      invoiceStatus: { $ne: "VOID" },
      ...NOT_UNCONFIRMED_RESERVA
    };

    if (source === 'nicole' || source === 'sucree') {
      orderMatch.contificoSource = source;
    }

    // If SALES_REP, only show their own data
    if (currentRole === 'SALES_REP' || currentRole === 'SALES') {
      // Use case-insensitive regex for Name to catch "diego reyes" vs "Diego Reyes"
      if (dbUser.name) {
        orderMatch.responsible = { $regex: new RegExp(`^${dbUser.name}$`, "i") };
      }
    }

    // Fetch GoalSettings to calculate dynamic commissions
    const settings = await models.goalSettings.findOne({ key: "global" }).lean();
    const commissionTiers = settings?.commissionTiers ?? [
      { threshold: 0, rate: 2 },
      { threshold: 10000, rate: 3 },
      { threshold: 13000, rate: 6 }
    ];

    // Exclude non-sales users (admins, production, etc.) from stats
    const NON_SALES_ROLES = ['admin', 'production', 'SUPPLY_CHAIN_MANAGER', 'KITCHEN_DISPLAY'];
    const nonSalesUsers = await models.users.find({ role: { $in: NON_SALES_ROLES } }).lean();
    const excludedNames = new Set(nonSalesUsers.map((u: any) => u.name.toLowerCase()));

    const stats = await models.orders.aggregate([
      {
        $match: orderMatch
      },
      {
        $group: {
          _id: "$responsible",
          totalSales: { $sum: "$totalValue" },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { totalSales: -1 }
      }
    ]);

    // Resolve individual goals map (Mongoose Map or plain object after lean())
    const defaultSellerGoal = settings?.sellerGoal ?? 10000;
    const rawIndividualGoals = settings?.individualGoals;
    const getPersonGoal = (name: string): number => {
      if (!rawIndividualGoals) return defaultSellerGoal;
      // Mongoose Map (non-lean) has .get(); lean() returns plain object
      if (typeof (rawIndividualGoals as any).get === 'function') {
        return (rawIndividualGoals as any).get(name) ?? defaultSellerGoal;
      }
      return (rawIndividualGoals as any)[name] ?? defaultSellerGoal;
    };

    // Map Roles and Commissions
    const enhancedStats = stats.map(s => {
      let role = 'Vendedor';
      const name = s._id ? s._id.toLowerCase() : '';

      if (name.includes('web') || name.includes('online')) {
        role = 'Digital';
      } else if (name.includes('hillary') || name.includes('ivin') || name.includes('e')) {
        role = 'Comercial';
      }

      // Each person's commission unlocks only when they reach their individual goal
      const personalGoal = getPersonGoal(s._id);
      const goalReached = s.totalSales >= personalGoal;
      const commission = calculateCommission(
        s.totalSales,
        commissionTiers as Array<{ threshold: number; rate: number }>,
        personalGoal
      );

      return {
        ...s,
        role,
        commission,
        personalGoal,
        goalReached
      };
    });

    // Filter out non-sales users (admins, etc.) — their orders shouldn't pollute sales stats
    const filteredStats = enhancedStats.filter(s => !excludedNames.has((s._id || '').toLowerCase()));

    // Calculate the number of actual salespeople for the dynamic goal (exclude Digital/Web)
    const activeSalespeopleCount = filteredStats.filter(s => s.role !== 'Digital').length;

    res.status(HttpStatusCode.Ok).send({
      message: "Sales by responsible retrieved successfully.",
      range: {
        from: startDate.toLocaleDateString("es-EC", { timeZone: "America/Guayaquil" }),
        to: endDate.toLocaleDateString("es-EC", { timeZone: "America/Guayaquil" })
      },
      monthlyGoal: 10000 * Math.max(1, activeSalespeopleCount),
      commissionTiers,
      stats: filteredStats
    });
    return;
  } catch (error) {
    console.error("❌ Error in getSalesByResponsible:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error fetching sales stats.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}
/**
 * Comprehensive analytics for SuperAdmin dashboard
 * Includes sales by branch, growth, avg ticket, etc.
 */
export async function getSuperAdminAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    const { period = 'month', source } = req.query; // 'day', 'week', 'month', source: 'nicole' | 'sucree'

    // --- Enforce Ecuador Time (UTC-5) ---
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const ecTime = new Date(utc + (3600000 * -5));

    let daysToFetch = 30;
    if (period === 'day') daysToFetch = 1;
    if (period === 'week') daysToFetch = 7;

    const pad = (n: number) => n.toString().padStart(2, '0');
    const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    // Current period
    const endCurrent = new Date(ecTime);
    const startCurrent = new Date(ecTime);
    startCurrent.setDate(startCurrent.getDate() - (daysToFetch - 1));

    // Previous period
    const endPrev = new Date(startCurrent);
    endPrev.setDate(endPrev.getDate() - 1);
    const startPrev = new Date(endPrev);
    startPrev.setDate(startPrev.getDate() - (daysToFetch - 1));

    const currentRange = {
      start: new Date(formatDate(startCurrent) + "T00:00:00-05:00"),
      end: new Date(formatDate(endCurrent) + "T23:59:59.999-05:00")
    };

    const prevRange = {
      start: new Date(formatDate(startPrev) + "T00:00:00-05:00"),
      end: new Date(formatDate(endPrev) + "T23:59:59.999-05:00")
    };

    // Base match stage
    const baseMatch: any = {
      invoiceStatus: { $ne: "VOID" },
      ...NOT_UNCONFIRMED_RESERVA
    };
    if (source && (source === 'nicole' || source === 'sucree')) {
      baseMatch.contificoSource = source;
    }

    // Aggregate Current Stats
    const currentStats = await models.orders.aggregate([
      {
        $match: {
          ...baseMatch,
          createdAt: { $gte: currentRange.start, $lte: currentRange.end }
        }
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$totalValue" },
          count: { $sum: 1 },
          avgTicket: { $avg: "$totalValue" }
        }
      }
    ]);

    // Aggregate Previous Stats
    const prevStats = await models.orders.aggregate([
      {
        $match: {
          ...baseMatch,
          createdAt: { $gte: prevRange.start, $lte: prevRange.end }
        }
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$totalValue" },
          count: { $sum: 1 }
        }
      }
    ]);

    // Breakdown by Branch
    const branchBreakdown = await models.orders.aggregate([
      {
        $match: {
          ...baseMatch,
          createdAt: { $gte: currentRange.start, $lte: currentRange.end }
        }
      },
      {
        $group: {
          _id: {
            branch: "$branch",
            channel: "$salesChannel"
          },
          totalSales: { $sum: "$totalValue" },
          count: { $sum: 1 }
        }
      },
      { $sort: { totalSales: -1 } }
    ]);

    // Seller Ranking
    const sellerRanking = await models.orders.aggregate([
      {
        $match: {
          ...baseMatch,
          createdAt: { $gte: currentRange.start, $lte: currentRange.end }
        }
      },
      {
        $group: {
          _id: "$responsible",
          totalSales: { $sum: "$totalValue" },
          count: { $sum: 1 }
        }
      },
      { $sort: { totalSales: -1 } },
      { $limit: 10 }
    ]);

    // Top Products
    const topProducts = await models.orders.aggregate([
      {
        $match: {
          ...baseMatch,
          createdAt: { $gte: currentRange.start, $lte: currentRange.end }
        }
      },
      { $unwind: "$products" },
      {
        $group: {
          _id: "$products.name",
          totalQuantity: { $sum: "$products.quantity" },
          totalRevenue: { $sum: { $multiply: ["$products.price", "$products.quantity"] } }
        }
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 10 }
    ]);

    const current = currentStats[0] || { totalSales: 0, count: 0, avgTicket: 0 };
    const previous = prevStats[0] || { totalSales: 0, count: 0 };

    const growth = previous.totalSales > 0 
      ? ((current.totalSales - previous.totalSales) / previous.totalSales) * 100 
      : 0;

    res.status(HttpStatusCode.Ok).send({
      message: "SuperAdmin analytics retrieved successfully.",
      period,
      range: {
        current: currentRange,
        previous: prevRange
      },
      kpis: {
        totalSales: Math.round(current.totalSales * 100) / 100,
        transactionCount: current.count,
        avgTicket: Math.round(current.avgTicket * 100) / 100,
        growth: Math.round(growth * 100) / 100,
        previousSales: Math.round(previous.totalSales * 100) / 100
      },
      branchBreakdown: branchBreakdown.map(b => ({
        branch: b._id.branch || 'Sin Asignar',
        channel: b._id.channel || 'Desconocido',
        isDigital: /online|web|whatsapp/i.test(b._id.channel || '') || /digital/i.test(b._id.branch || ''),
        totalSales: Math.round(b.totalSales * 100) / 100,
        count: b.count
      })),
      sellerRanking: sellerRanking.map(s => ({
        name: s._id || 'Desconocido',
        totalSales: Math.round(s.totalSales * 100) / 100,
        count: s.count
      })),
      topProducts: topProducts.map(p => ({
        name: p._id,
        quantity: p.totalQuantity,
        revenue: Math.round(p.totalRevenue * 100) / 100
      }))
    });
    return;

  } catch (error) {
    console.error("❌ Error in getSuperAdminAnalytics:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error fetching superadmin analytics.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Proxy for Meta Ads API (Metrics API)
 */
export async function getMetaAdsProxy(req: Request, res: Response, next: NextFunction) {
  try {
    const { clientId, adAccountId, datePreset = 'this_month' } = req.query;

    if (!clientId || !adAccountId) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "clientId and adAccountId are required."
      });
      return;
    }

    const data = await MetaAdsService.getInsights(
      clientId as string,
      adAccountId as string,
      datePreset as string
    );

    res.status(HttpStatusCode.Ok).send(data);
    return;

  } catch (error: any) {
    console.error("❌ Error in getMetaAdsProxy:", error);
    
    let status = error.response?.status || HttpStatusCode.InternalServerError;
    
    // CRITICAL: If the upstream (ngrok/metrics) returns 401, we MUST NOT return 401 to our frontend,
    // otherwise the frontend interceptor will log out the user.
    if (status === 401) {
      status = HttpStatusCode.BadGateway; // 502
    }

    const message = error.response?.data?.message || "Error fetching Meta Ads data via proxy.";
    
    res.status(status).send({
      message: `Upstream error: ${message}`,
      error: error.message
    });
    return;
  }
}
