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
    verifySupervisor,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// MANTENIMIENTOS DE CÁMARA
// ver = operativo+ · programar/iniciar/finalizar = supervisor+
// cancelar/editar = coordinador+ · liberar bloqueo = admin
// ============================================================================
// Paros TEMPORALES de una cámara. No confundir con camaras.estado = 0, que
// es la baja definitiva.
//
// ⚠️ ESTE MÓDULO BLOQUEA CAPACIDAD
//   Pasar a estado 2 dispara trg_sync_ocupacion_mantenimiento, que crea una
//   ocupación tipo 2 consumiendo TODA la capacidad. A partir de ahí
//   fn_tarimas_disponibles devuelve 0 y la fruta que llegue se va a la cola.
//
// ---- LAS TRANSICIONES VAN POR ENDPOINTS SEPARADOS ----
//   El trigger reacciona distinto a cada estado, así que mezclarlas en un
//   PUT genérico haría muy fácil bloquear una cámara por accidente al
//   guardar un formulario.
//
//     PATCH /:id/iniciar    1 → 2   bloquea la cámara
//     PATCH /:id/finalizar  2 → 3   la libera
//     DELETE /:id           1 → 4   cancela (solo si nunca inició)
//
// ---- v2.4 · EL TRIGGER CUBRE LOS TRES CAMINOS ----
//   El estado 4 también libera la cámara. Aun así, un mantenimiento en
//   proceso no se puede cancelar: ese paro ocurrió y tiene que quedar en el
//   histórico de horas de paro. Se cierra con "finalizar".
//
//   GET /bloqueos-huerfanos y POST /bloqueos/:id/liberar se conservan como
//   diagnóstico para ocupaciones tipo 2 creadas a mano sin mantenimiento
//   ligado, que el trigger no puede ver.
//
// ---- POR QUÉ INICIAR Y FINALIZAR SON SUPERVISOR ----
//   Es quien está en planta y ve al técnico llegar. Solo puede parar SUS
//   cámaras, así que el riesgo está acotado.
//
//   Cancelar sube a coordinador: implica que el paro ya no va a ocurrir, y
//   eso reorganiza la planeación de la semana.
//
// ---- EL ALCANCE, CASO SIMPLE ----
//   mantenimientos SÍ tiene id_camara, así que validarCamaraEnAlcance("body")
//   alcanza al crear. En las transiciones el controller valida contra la
//   cámara del registro existente.
// ============================================================================

// ---- Consultas ----
// Las rutas con prefijo fijo van ANTES de "/:id".

// Los que están bloqueando cámaras ahora mismo.
router.get("/activos", verifyToken, verifyOperativo, cargarAlcance, mantenimientosController.getActivos);

// Ocupaciones tipo 2 activas sin mantenimiento en proceso que las
// justifique. Diagnóstico de una cámara trabada.
router.get("/bloqueos-huerfanos", verifyToken, verifyOperativo, cargarAlcance, mantenimientosController.getBloqueosHuerfanos);

// Horas de paro por cámara. Insumo para decidir reemplazo de equipo.
//   ?fecha_desde=2026-01-01   ?fecha_hasta=2026-12-31
router.get("/resumen", verifyToken, verifyOperativo, cargarAlcance, mantenimientosController.getResumen);

// Listado. Los activos salen ordenados primero.
//   ?id_camara=1   ?estado=2   ?tipo=3
//   ?fecha_desde=...   ?fecha_hasta=...
router.get("/", verifyToken, verifyOperativo, cargarAlcance, mantenimientosController.getMantenimientos);

router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdMantenimiento, mantenimientosController.getMantenimientoById);

// ---- Alta ----
// estado 1 (programado) por defecto. Si nace en 2, la cámara se bloquea de
// inmediato y la respuesta avisa cuánta fruta quedó adentro. El middleware
// rechaza nacer en 2 con fecha futura.
router.post(
    "/",
    verifyToken,
    verifySupervisor,
    cargarAlcance,
    validarMantenimiento,
    validarCamaraEnAlcance("body"),
    mantenimientosController.createMantenimiento
);

// ---- Edición administrativa ----
// No toca el estado. El controller bloquea los ya finalizados o cancelados:
// son histórico y editarlos cambiaría las horas de paro reportadas.
router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    cargarAlcance,
    validarIdMantenimiento,
    validarEdicionMantenimiento,
    mantenimientosController.updateMantenimiento
);

// ---- Iniciar ----
// ⚠️ Dispara el bloqueo de TODA la capacidad de la cámara.
router.patch(
    "/:id/iniciar",
    verifyToken,
    verifySupervisor,
    cargarAlcance,
    validarIdMantenimiento,
    validarFechaTransicion,
    mantenimientosController.iniciarMantenimiento
);

// ---- Finalizar ----
// Libera la cámara. El controller rechaza un cierre anterior al inicio y
// verifica que el trigger haya cerrado la ocupación de bloqueo.
router.patch(
    "/:id/finalizar",
    verifyToken,
    verifySupervisor,
    cargarAlcance,
    validarIdMantenimiento,
    validarFechaTransicion,
    mantenimientosController.finalizarMantenimiento
);

// ---- Cancelar ----
// Solo desde 'programado'. Uno en proceso se finaliza, no se cancela.
router.delete("/:id", verifyToken, verifyCoordinador, cargarAlcance, validarIdMantenimiento, mantenimientosController.cancelarMantenimiento);

// ---- Salida de emergencia ----
// Libera a mano una ocupación de bloqueo huérfana. Solo admin, y el
// controller verifica que realmente sea huérfana: liberar el bloqueo de un
// mantenimiento ACTIVO dejaría la cámara recibiendo fruta mientras el
// técnico sigue trabajando adentro.
router.post(
    "/bloqueos/:id_ocupacion/liberar",
    verifyToken,
    verifyAdmin,
    cargarAlcance,
    mantenimientosController.liberarBloqueo
);

// ---- Borrado físico ----
// Solo para un alta mal capturada que nunca llegó a bloquear.
router.delete("/:id/eliminar", verifyToken, verifyAdmin, cargarAlcance, validarIdMantenimiento, mantenimientosController.deleteMantenimiento);

export default router;
