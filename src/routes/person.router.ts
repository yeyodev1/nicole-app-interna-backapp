import express from "express";
import * as PersonController from "../controllers/person.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = express.Router();

router.use(authMiddleware as any);

// GET /api/persons
router.get("/", PersonController.getPerson);

// POST /api/persons
router.post("/", PersonController.createPerson);

export default router;
