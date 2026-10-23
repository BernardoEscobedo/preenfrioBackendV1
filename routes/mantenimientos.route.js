import { Router } from "express";
import { mantenimientosController } from "../controllers/mantenimientos.controller.js";
import {
    validarMantenimiento,
    validarEdicionMantenimiento,
    validarFechaTransicion,
    validarIdMantenimiento
} from "../middlewares/mantenimientos.middleware.js";
import {
    cargarAlcance,
    validarCamaraEnAlcance
} from "../middlewares/alcance.middleware.js";
import {
    verifyToken,
    verifyAdmin,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// MANTENIMIENTOS DE CÁMARA
// ver/registrar/iniciar/finalizar = operativo+ · cancelar/editar = coordinador+
// liberar bloqueo = admin
// ============================================================================
// Paros TEMPORALES de una cámara. No confundir con camaras.estado = 0, que
// es la baja definitiva.
//
// ⚠️ ESTE MÓDULO BLOQUEA LA CÁMARA
//   En estado 2 la cámara queda fuera de servicio: 0 espacios, y la BD
//   rechaza recepciones y traslados hacia ella (v3).
//
//   Preventivo  se programa (estado 1) y bloquea A SU HORA
//               (fn_activar_mantenimientos_programados)
//   Correctivo  / emergencia: nace en estado 2 y bloquea al registrarlo
//
// ---- LAS TRANSICIONES VAN POR ENDPOINTS SEPARADOS ----
//     PATCH /:id/iniciar    1 → 2   iniciar ya un preventivo
//     PATCH /:id/finalizar  2 → 3   la cámara vuelve a operar
//     DELETE /:id           1 → 4   cancela un preventivo programado
//
// ---- POR QUÉ REGISTRAR ES OPERATIVO ----
//   Una falla se reporta en el momento, y quien la ve es el personal de
//   piso. El alcance acota el riesgo: solo sus cámaras.
//   Cancelar y editar siguen en coordinador: reorganizan la planeación.
// ============================================================================

// ---- Consultas ----
// Las rutas con prefijo fijo van ANTES de "/:id".

// Cada cámara con su situación y la fruta que tiene dentro.
router.get("/tablero", verifyToken, verifyOperativo, cargarAlcance, mantenimientosController.getTablero);

// Lotes dentro de una cámara (para reubicarlos).
router.get("/camara/:id_camara/fruta", verifyToken, verifyOperativo, cargarAlcance, mantenimientosController.getFrutaDentro);

// Los que están bloqueando cámaras ahora mismo.
router.get("/activos", verifyToken, verifyOperativo, cargarAlcance, mantenimientosController.getActivos);

// Ocupaciones tipo 2 activas sin mantenimiento en proceso. Diagnóstico.
router.get("/bloqueos-huerfanos", verifyToken, verifyOperativo, cargarAlcance, mantenimientosController.getBloqueosHuerfanos);

// Horas de paro por cámara.   ?fecha_desde=   ?fecha_hasta=
router.get("/resumen", verifyToken, verifyOperativo, cargarAlcance, mantenimientosController.getResumen);

// Historial.   ?id_camara=1   ?estado=2   ?tipo=1   ?fecha_desde=   ?fecha_hasta=
router.get("/", verifyToken, verifyOperativo, cargarAlcance, mantenimientosController.getMantenimientos);

router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdMantenimiento, mantenimientosController.getMantenimientoById);

// ---- Alta ----
router.post(
    "/",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarMantenimiento,
    validarCamaraEnAlcance("body"),
    mantenimientosController.createMantenimiento
);

// ---- Edición administrativa ----
router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    cargarAlcance,
    validarIdMantenimiento,
    validarEdicionMantenimiento,
    mantenimientosController.updateMantenimiento
);

// ---- Iniciar ya un preventivo ----
router.patch(
    "/:id/iniciar",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarIdMantenimiento,
    validarFechaTransicion,
    mantenimientosController.iniciarMantenimiento
);

// ---- Finalizar ----  body: { fecha?, hora?, comentario? }
router.patch(
    "/:id/finalizar",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarIdMantenimiento,
    validarFechaTransicion,
    mantenimientosController.finalizarMantenimiento
);

// ---- Cancelar (solo programados) ----  body: { comentario? }
router.delete("/:id", verifyToken, verifyCoordinador, cargarAlcance, validarIdMantenimiento, mantenimientosController.cancelarMantenimiento);

// ---- Salida de emergencia (admin) ----
router.post(
    "/bloqueos/:id_ocupacion/liberar",
    verifyToken,
    verifyAdmin,
    cargarAlcance,
    mantenimientosController.liberarBloqueo
);

// ---- Borrado físico (admin) ----
router.delete("/:id/eliminar", verifyToken, verifyAdmin, cargarAlcance, validarIdMantenimiento, mantenimientosController.deleteMantenimiento);

export default router;
