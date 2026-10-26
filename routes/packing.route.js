import { Router } from "express";
import { getPacking } from "../controllers/packing.controller.js";
import { cargarAlcance } from "../middlewares/alcance.middleware.js";
import { verifyToken, verifyOperativo } from "../middlewares/jwt.middleware.js";

// ============================================================================
// PACKING LIST · GET /api/preenfrio/packing/:id_despacho
// ============================================================================
const router = Router();
router.get("/:id_despacho", verifyToken, verifyOperativo, cargarAlcance, getPacking);
export default router;
