import { Router } from "express";
import { lineasFleterasController } from "../controllers/lineasFleteras.controller.js";
import lineasFleterasModel from "../models/lineasFleteras.model.js";
import {
    validarLineaFletera,
    validarIdLineaFletera
} from "../middlewares/lineasFleteras.middleware.js";
import { conservarCampos } from "../middlewares/conservar.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// LÍNEAS FLETERAS
// ver = operativo+ · crear/editar/baja = coordinador+
// ============================================================================
// Sin cargarAlcance: una línea trabaja para todas las plantas.
//
// FILTROS DEL LISTADO
//   ?estado=1       solo activas (para dropdowns)
//   ?buscar=texto   razón social, RFC o teléfono
// ============================================================================

// ---- Consultas ----
router.get("/", verifyToken, verifyOperativo, lineasFleterasController.getLineas);

router.get("/:id", verifyToken, verifyOperativo, validarIdLineaFletera, lineasFleterasController.getLineaById);

// ---- Alta y edición ----
// El duplicado se mide por RFC, ignorando espacios y guiones.
router.post("/", verifyToken, verifyCoordinador, validarLineaFletera, lineasFleterasController.createLinea);

// conservarCampos va ANTES del validador: si el formulario no manda
// 'estado', se conserva el actual en vez de reactivar la línea.
router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    validarIdLineaFletera,
    conservarCampos(lineasFleterasModel.getLineaById, ["estado"]),
    validarLineaFletera,
    lineasFleterasController.updateLinea
);

// ---- Baja ----
router.delete("/:id", verifyToken, verifyCoordinador, validarIdLineaFletera, lineasFleterasController.bajaLinea);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, validarIdLineaFletera, lineasFleterasController.reactivarLinea);

export default router;
