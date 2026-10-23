import { Router } from "express";
import { temporalesController as c } from "../controllers/temporales.controller.js";
import { validarReubicar, validarIdTemporal } from "../middlewares/temporales.middleware.js";
import { cargarAlcance } from "../middlewares/alcance.middleware.js";
import { ampliarAlcanceTemporales } from "../utils/alcanceTemporales.js";
import { verifyToken, verifyOperativo } from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// CAJAS TEMPORALES (resguardo en caja de línea fletera) · operativo+
// ============================================================================
// Una caja es una cámara temporal (tipo 3): la fruta sigue en el inventario.
//
//   GET  /                         cajas abiertas
//   GET  /destinos?excluir=        cámaras operando
//   GET  /recepcion/:id_camara     dónde recibir si la planeada está parada
//   POST /reubicar                 sacar TODA la fruta de una cámara
//   GET  /:id/fruta                lotes dentro de una caja
//   POST /:id/cerrar               cerrar una caja vacía
// ============================================================================

const base = [verifyToken, verifyOperativo, cargarAlcance, ampliarAlcanceTemporales];

router.get("/", ...base, c.getAbiertas);
router.get("/destinos", ...base, c.getDestinos);
router.get("/recepcion/:id_camara", ...base, c.getDestinosRecepcion);
router.post("/reubicar", ...base, validarReubicar, c.reubicar);
router.get("/:id/fruta", ...base, validarIdTemporal, c.getFruta);
router.post("/:id/cerrar", ...base, validarIdTemporal, c.cerrar);

export default router;
