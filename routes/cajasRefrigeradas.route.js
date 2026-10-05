import { Router } from "express";
import { cajasRefrigeradasController } from "../controllers/cajasRefrigeradas.controller.js";
import cajasRefrigeradasModel from "../models/cajasRefrigeradas.model.js";
import {
    validarCajaRefrigerada,
    validarIdCajaRefrigerada
} from "../middlewares/cajasRefrigeradas.middleware.js";
import { conservarCampos } from "../middlewares/conservar.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// CAJAS REFRIGERADAS
// ver = operativo+ · crear/editar/baja = coordinador+
// ============================================================================
// Sin cargarAlcance: una caja recoge en cualquier planta.
//
// La inspección de inocuidad NO se registra aquí: es por despacho
// (PATCH /despachos/:id/inocuidad).
//
// FILTROS DEL LISTADO
//   ?estado=1             solo activas (para dropdowns)
//   ?id_linea_fletera=3   cajas de una línea
//   ?buscar=texto         placas, número económico o línea
// ============================================================================

// ---- Consultas ----
router.get("/", verifyToken, verifyOperativo, cajasRefrigeradasController.getCajas);

router.get("/:id", verifyToken, verifyOperativo, validarIdCajaRefrigerada, cajasRefrigeradasController.getCajaById);

// ---- Alta y edición ----
// El duplicado se mide por placas, ignorando guiones y espacios.
router.post("/", verifyToken, verifyCoordinador, validarCajaRefrigerada, cajasRefrigeradasController.createCaja);

// conservarCampos va ANTES del validador: si el formulario no manda
// 'estado', se conserva el actual en vez de reactivar la caja.
router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    validarIdCajaRefrigerada,
    conservarCampos(cajasRefrigeradasModel.getCajaById, ["estado"]),
    validarCajaRefrigerada,
    cajasRefrigeradasController.updateCaja
);

// ---- Baja ----
router.delete("/:id", verifyToken, verifyCoordinador, validarIdCajaRefrigerada, cajasRefrigeradasController.bajaCaja);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, validarIdCajaRefrigerada, cajasRefrigeradasController.reactivarCaja);

export default router;
