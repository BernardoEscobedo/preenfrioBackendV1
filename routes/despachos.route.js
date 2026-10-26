import { Router } from "express";
import { despachosController } from "../controllers/despachos.controller.js";
import { despachoCompletoController } from "../controllers/despachoCompleto.controller.js";
import {
    validarDespacho,
    validarLinea,
    validarMotivo,
    validarInocuidadDespacho,
    validarIdDespacho,
    validarIdDetalle
} from "../middlewares/despachos.middleware.js";
import { validarDespachoCompleto } from "../middlewares/despachoCompleto.middleware.js";
import { cargarAlcance } from "../middlewares/alcance.middleware.js";
import {
    verifyToken,
    verifyAdmin,
    verifyCoordinador,
    verifySupervisor,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// DESPACHOS
// despachar (asistente) = operativo+ · ver/armar picking = operativo+
// inspeccionar/cerrar = supervisor+ · crear/editar = coordinador+
// reabrir/eliminar = admin
// ============================================================================
// ---- DESPACHO EN UN PASO (asistente) ----
//   GET  /tarimas    bloques con sus tarimas para elegir cuáles suben
//   POST /completo   registra y CIERRA en una sola transacción. La fruta
//                    sale por TARIMA de bloque, entera (completa, media o
//                    mixta), y la tarima sale de su bloque.
//
// ---- LA CADENA DE TRIGGERS ----
//   Agregar línea  → trg_despacho_detalle_movimiento (BEFORE INSERT)
//                    genera el movimiento tipo 3
//                  → trg_sync_ocupacion_movimiento descuenta la cámara
//                  → trg_cerrar_tarimas_sin_cajas cierra tarimas sobrantes
//                  → trg_recalcular_totales_despacho actualiza los totales
//
//   Quitar línea   → fn_quitar_linea_despacho borra la línea y su
//                    movimiento; trg_revertir_movimiento devuelve la fruta
//
// ---- CIERRE ----
//   trg_validar_cierre y trg_validar_cierre_full: sin líneas, inspección
//   pendiente o rechazada, full sin 2ª caja aprobada, o fruta de otro
//   cliente sin confirmar → no se cierra.
// ============================================================================

// ---- Consultas ----
// Las rutas con prefijo fijo van ANTES de "/:id".

router.get("/clientes-disponibles", verifyToken, verifyOperativo, cargarAlcance, despachosController.getClientesDisponibles);

// Tarimas de bloque para el asistente.   ?id_cc=3   ?todos=1
router.get("/tarimas", verifyToken, verifyOperativo, cargarAlcance, despachoCompletoController.getTarimas);

// Listado. Lee vw_despachos.
router.get("/", verifyToken, verifyOperativo, cargarAlcance, despachosController.getDespachos);

router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdDespacho, despachosController.getDespachoById);

router.get("/:id/disponible", verifyToken, verifyOperativo, cargarAlcance, validarIdDespacho, despachosController.getDisponible);

router.get("/:id/auditoria", verifyToken, verifyOperativo, cargarAlcance, validarIdDespacho, despachosController.getAuditoria);

// ---- ⭐ Despacho en un paso (asistente) ----
router.post(
    "/completo",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarDespachoCompleto,
    despachoCompletoController.crearDespachoCompleto
);

// ---- Documento (flujo por pasos, se conserva) ----
router.post("/", verifyToken, verifyCoordinador, cargarAlcance, validarDespacho, despachosController.createDespacho);

router.put("/:id", verifyToken, verifyCoordinador, cargarAlcance, validarIdDespacho, validarDespacho, despachosController.updateDespacho);

router.put(
    "/:id/corregir",
    verifyToken,
    verifyCoordinador,
    cargarAlcance,
    validarIdDespacho,
    validarMotivo,
    validarDespacho,
    despachosController.updateDespacho
);

// ---- Inspección de inocuidad (borradores) ----
router.patch(
    "/:id/inocuidad",
    verifyToken,
    verifySupervisor,
    cargarAlcance,
    validarIdDespacho,
    validarInocuidadDespacho,
    despachosController.registrarInocuidad
);

// ---- Picking (borradores) ----
router.post(
    "/:id/lineas",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarIdDespacho,
    validarLinea,
    despachosController.agregarLinea
);

router.delete(
    "/:id/lineas/:id_detalle",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarIdDespacho,
    validarIdDetalle,
    despachosController.quitarLinea
);

// ---- Cierre ----  con fruta de otro cliente: ?confirmar=1
router.patch("/:id/cerrar", verifyToken, verifySupervisor, cargarAlcance, validarIdDespacho, despachosController.cerrarDespacho);

// Reabrir a borrador. Solo admin, siempre con motivo, siempre auditado.
router.patch(
    "/:id/reabrir",
    verifyToken,
    verifyAdmin,
    cargarAlcance,
    validarIdDespacho,
    validarMotivo,
    despachosController.reabrirDespacho
);

// ---- Eliminar ----  solo borradores SIN líneas
router.delete("/:id", verifyToken, verifyAdmin, cargarAlcance, validarIdDespacho, despachosController.deleteDespacho);

export default router;
