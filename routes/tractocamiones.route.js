import { Router } from "express";
import { tractocamionesController } from "../controllers/tractocamiones.controller.js";
import tractocamionesModel from "../models/tractocamiones.model.js";
import {
    validarTractocamion,
    validarIdTractocamion
} from "../middlewares/tractocamiones.middleware.js";
import { conservarCampos } from "../middlewares/conservar.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// TRACTOCAMIONES
// ver = operativo+ · crear/editar/baja = coordinador+
// ============================================================================
// Sin cargarAlcance: una unidad recoge en cualquier planta.
//
// FILTROS DEL LISTADO
//   ?estado=1             solo activos (para dropdowns)
//   ?id_linea_fletera=3   tractos de una línea
//   ?buscar=texto         placas, número económico o línea
// ============================================================================

// ---- Consultas ----
router.get("/", verifyToken, verifyOperativo, tractocamionesController.getTractocamiones);

router.get("/:id", verifyToken, verifyOperativo, validarIdTractocamion, tractocamionesController.getTractocamionById);

// ---- Alta y edición ----
// El duplicado se mide por placas, ignorando guiones y espacios.
router.post("/", verifyToken, verifyCoordinador, validarTractocamion, tractocamionesController.createTractocamion);

// conservarCampos va ANTES del validador: si el formulario no manda
// 'estado', se conserva el actual en vez de reactivar la unidad.
router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    validarIdTractocamion,
    conservarCampos(tractocamionesModel.getTractocamionById, ["estado"]),
    validarTractocamion,
    tractocamionesController.updateTractocamion
);

// ---- Baja ----
router.delete("/:id", verifyToken, verifyCoordinador, validarIdTractocamion, tractocamionesController.bajaTractocamion);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, validarIdTractocamion, tractocamionesController.reactivarTractocamion);

export default router;
