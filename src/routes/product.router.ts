import express from "express";
import * as ProductController from "../controllers/product.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = express.Router();

// GET /api/products — protegido por auth para leer contificoSource del usuario
router.get("/", authMiddleware, ProductController.getProducts);

router.get("/categories", authMiddleware, ProductController.getCategories);

// Mapa producto → categoría tal cual Contífico (para Excel y resumen de producción)
router.get("/category-map", authMiddleware, ProductController.getContificoCategoryMap);

export default router;
