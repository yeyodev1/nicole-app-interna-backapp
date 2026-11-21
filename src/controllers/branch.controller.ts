import type { Response, NextFunction } from "express";
import { Branch } from "../models/branch.model";
import { AuthRequest } from "../types/AuthRequest";
import {
  BRANCH_SETTINGS_ROLES,
  branchHasHistory,
  exactNameRegex,
  normalizeCompany,
} from "../utils/branch-company";

const SETTINGS_DENIED = "Solo el Jefe de Operaciones y los administradores pueden cambiar los puntos de venta.";
const COMPANY_INVALID = "Empresa no válida: usa \"nicole\" (La Finestra) o \"sucree\" (Sucrenda).";

/** Crear, editar y desactivar sucursales: mismo criterio que los Ajustes de inventario (cada controlador valida el rol). */
function guard(req: AuthRequest, res: Response): boolean {
  const role = String((req as any).user?.role || "").toUpperCase();
  if (BRANCH_SETTINGS_ROLES.includes(role)) return true;
  res.status(403).send({ message: SETTINGS_DENIED });
  return false;
}

export async function getBranches(
  _req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const branches = await Branch.find().sort({ sortOrder: 1, name: 1 }).lean();
    // Sucursales anteriores al campo: son de La Finestra.
    const data = branches.map((b: any) => ({ ...b, company: normalizeCompany(b.company) || "nicole" }));
    res.status(200).send({
      message: "Branches retrieved successfully.",
      data,
    });
  } catch (error) {
    next(error);
  }
}

export async function createBranch(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    if (!guard(req, res)) return;
    const { name, isActive, sortOrder, company } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).send({ message: "Branch name is required." });
      return;
    }

    const companyValue = company === undefined ? "nicole" : normalizeCompany(company);
    if (!companyValue) {
      res.status(400).send({ message: COMPANY_INVALID });
      return;
    }

    // Sin distinguir mayúsculas: "Entre rios" y "Entre Ríos" no deben convivir por error de tipeo.
    const existing = await Branch.findOne({ name: exactNameRegex(name) });
    if (existing) {
      res.status(409).send({ message: "A branch with this name already exists." });
      return;
    }

    const branch = await Branch.create({
      name: name.trim(),
      isActive: isActive !== false,
      sortOrder: sortOrder ?? 0,
      company: companyValue,
    });

    res.status(201).send({
      message: "Branch created successfully.",
      data: branch,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateBranch(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    if (!guard(req, res)) return;
    const { id } = req.params;
    const { name, isActive, sortOrder, company } = req.body;

    const branch = await Branch.findById(id);
    if (!branch) {
      res.status(404).send({ message: "Branch not found." });
      return;
    }

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        res.status(400).send({ message: "Branch name cannot be empty." });
        return;
      }
      const newName = name.trim();
      if (newName !== branch.name) {
        const duplicate = await Branch.findOne({ name: exactNameRegex(newName), _id: { $ne: id } });
        if (duplicate) {
          res.status(409).send({ message: "A branch with this name already exists." });
          return;
        }
        // Pedidos, cierres y despachos guardan el nombre como texto: renombrar dejaría ese historial huérfano.
        if (await branchHasHistory(branch.name)) {
          res.status(409).send({
            message: `"${branch.name}" ya tiene pedidos o cierres guardados con ese nombre; no se puede renombrar. Crea un punto de venta nuevo y desactiva este.`,
          });
          return;
        }
        branch.name = newName;
      }
    }
    if (company !== undefined) {
      const companyValue = normalizeCompany(company);
      if (!companyValue) {
        res.status(400).send({ message: COMPANY_INVALID });
        return;
      }
      branch.company = companyValue;
    }
    if (isActive !== undefined) branch.isActive = isActive;
    if (sortOrder !== undefined) branch.sortOrder = sortOrder;

    await branch.save();

    res.status(200).send({
      message: "Branch updated successfully.",
      data: branch,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Con historial la sucursal no se borra: se desactiva y conserva sus pedidos y cierres
 * (decisión de Operaciones, 21/11/2026). Solo se borra de verdad una creada por error, sin movimientos.
 */
export async function deleteBranch(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    if (!guard(req, res)) return;
    const { id } = req.params;
    const branch = await Branch.findById(id);
    if (!branch) {
      res.status(404).send({ message: "Branch not found." });
      return;
    }
    if (await branchHasHistory(branch.name)) {
      branch.isActive = false;
      await branch.save();
      res.status(200).send({
        message: `"${branch.name}" tiene historial: quedó desactivada, no borrada.`,
        data: branch,
        deactivated: true,
      });
      return;
    }
    await branch.deleteOne();
    res.status(200).send({ message: "Branch deleted successfully.", deactivated: false });
  } catch (error) {
    next(error);
  }
}
