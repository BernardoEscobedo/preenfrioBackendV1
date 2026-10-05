import { Router } from "express";
import { transportesController } from "../controllers/transportes.controller.js";
import transportesModel from "../models/transportes.model.js";
import {
    validarTransporte,
    validarIdTransporte
} from "../middlewares/transportes.middleware.js";
import { conservarCampos } from "../middlewares/conservar.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// TRANSPORTES
// ver = operativo+ · crear/editar/baja = coordinador+
// ============================================================================
// Sin cargarAlcance: una unidad recoge en cualquier planta.
//
// UN TRANSPORTE ES UN SERVICIO
//   Se arma con cuatro IDs de catálogo: línea fletera, operador,
//   tractocamión y caja refrigerada. Los catálogos tienen sus propias rutas:
//     /lineas-fleteras · /operadores · /tractocamiones · /cajas-refrigeradas
//
// ⚠️ SE RETIRÓ PATCH /:id/inocuidad
//   La inspección ya no es un dato del transporte: se registra en cada
//   despacho con PATCH /despachos/:id/inocuidad (supervisor+). Una caja
//   aprobada ayer no está aprobada hoy.
//
// ALTA Y EDICIÓN en coordinador: los datos del servicio son los que
// aparecen en el documento de despacho y en el reclamo si algo sale mal.
//
// FILTROS DEL LISTADO
//   ?estado=1             solo activos
//   ?completos=1          solo servicios con sus cuatro catálogos activos
//                         (dropdown de despacho)
//   ?id_linea_fletera=3   servicios de una línea
//   ?buscar=texto         línea, RFC, operador, placas o número económico
// ============================================================================

// ---- Consultas ----
router.get("/", verifyToken, verifyOperativo, transportesController.getTransportes);

router.get("/:id", verifyToken, verifyOperativo, validarIdTransporte, transportesController.getTransporteById);

// ---- Alta y edición ----
// El duplicado se mide por la combinación completa de los cuatro IDs.
router.post("/", verifyToken, verifyCoordinador, validarTransporte, transportesController.createTransporte);

// conservarCampos va ANTES del validador: si el formulario no manda
// 'estado', se conserva el actual en vez de reactivar el servicio.
//
// Si el servicio ya tiene despachos, NO se puede cambiar su combinación:
// el controller responde 409 y la BD lo respalda con
// trg_proteger_transporte_asignado.
router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    validarIdTransporte,
    conservarCampos(transportesModel.getTransporteById, ["estado"]),
    validarTransporte,
    transportesController.updateTransporte
);

// ---- Baja ----
// Lógica (estado = 0): despachos.id_transporte sigue apuntando aquí y ante
// un reclamo hay que poder decir quién se llevó la fruta.
router.delete("/:id", verifyToken, verifyCoordinador, validarIdTransporte, transportesController.bajaTransporte);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, validarIdTransporte, transportesController.reactivarTransporte);

export default router;
