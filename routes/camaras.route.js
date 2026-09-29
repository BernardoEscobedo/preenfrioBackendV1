import { Router } from "express";
import { camarasController } from "../controllers/camaras.controller.js";
import { validarCamara, validarIdCamara } from "../middlewares/camaras.middleware.js";
import { cargarAlcance } from "../middlewares/alcance.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// CÁMARAS  ·  ver = operativo+ · crear/editar = coordinador+
// ============================================================================
// VER queda en operativo porque este catálogo alimenta los DROPDOWNS de
// todo el sistema: sin él, un operativo no podría elegir la cámara destino
// al mover inventario. El alcance garantiza que solo vea las suyas.
//
// CREAR y EDITAR suben a coordinador: la capacidad que se define aquí es el
// tope que respetan los triggers de recepción y cola. Capturarla mal
// descuadra la operación de toda la planta, no es decisión de piso.
//
// v3.0 · YA NO HAY BORRADO
//   La ruta DELETE /eliminarcamara/:id_camara se retiró. La baja es lógica
//   y vive en el módulo de bajas (solo admin), que exige motivo, verifica
//   que la cámara esté vacía y deja registro en el historial:
//
//       PATCH /api/preenfrio/bajas/camaras/:id
//       PATCH /api/preenfrio/bajas/camaras/:id/reactivar
// ============================================================================

// ---- Consultas (filtradas por alcance) ----
// Incluye las dadas de baja al final: es también la pantalla del catálogo.
router.get("/camaras", verifyToken, verifyOperativo, cargarAlcance, camarasController.getCamaras);

// Por tipo: 1=preenfrío · 2=conservación. Solo operativas: alimenta
// dropdowns como el destino al mover a conserva.
router.get("/tipo/:tipo", verifyToken, verifyOperativo, cargarAlcance, camarasController.getCamarasByTipo);

// El controller valida el alcance sobre el resultado
router.get("/camara/:id_camara", verifyToken, verifyOperativo, cargarAlcance, validarIdCamara, camarasController.getCamaraById);

// ---- Alta y edición ----
router.post("/registrarcamara", verifyToken, verifyCoordinador, validarCamara, camarasController.createCamara);

// El controller impide bajar la capacidad por debajo de lo que la cámara
// ya tiene dentro
router.put("/actualizarcamara/:id_camara", verifyToken, verifyCoordinador, validarIdCamara, validarCamara, camarasController.updateCamara);

export default router;
