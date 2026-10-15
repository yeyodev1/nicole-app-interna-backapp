import { Router } from "express";
import * as DeliveryPersonController from "../controllers/delivery-person.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = Router();

router.use(authMiddleware as any);

// GET /api/delivery-persons
router.get("/", DeliveryPersonController.getDeliveryPersons);

// POST /api/delivery-persons
router.post("/", DeliveryPersonController.createDeliveryPerson);

// PUT /api/delivery-persons/:id
router.put("/:id", DeliveryPersonController.updateDeliveryPerson);

// DELETE /api/delivery-persons/:id
router.post("/:id/delete", DeliveryPersonController.deleteDeliveryPerson); // Using POST for some safety or DELETE? 

export default router;
