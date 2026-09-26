import { Router } from "express";
import { despachosController } from "../controllers/despachos.controller.js";
import {
    validarDespacho,
    validarLinea,
    validarMotivo,
    validarIdDespacho,
    validarIdDetalle
} from "../middlewares/despachos.middleware.js";
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
// ver/armar picking = operativo+ · cerrar = supervisor+
// crear/editar = coordinador+ · reabrir/eliminar = admin
// ============================================================================
// El despacho es un DOCUMENTO; el picking es lo que lleva. Un mismo
// despacho puede cargar fruta de varias cámaras, por eso se arma desde el
// documento y no desde cada cámara.
//
// ---- LA CADENA DE TRIGGERS ----
//   Agregar línea  → trg_despacho_detalle_movimiento (BEFORE INSERT)
//                    genera el movimiento tipo 3
//                  → trg_sync_ocupacion_movimiento descuenta la cámara
//                  → trg_recalcular_totales_despacho actualiza los totales
//
//   Quitar línea   → fn_quitar_linea_despacho borra la línea y su
//                    movimiento
//                  → trg_revertir_movimiento (v2.5) devuelve la fruta y
//                    reabre la ocupación
//
//   El backend NUNCA toca ocupaciones_camaras: una sola vía de descuento y
//   una sola vía de reversa, las dos en la BD.
//
// ---- POR QUÉ ARMAR EL PICKING ES OPERATIVO ----
//   Es trabajo de andén: el montacarguista sube tarimas y las va
//   registrando. El riesgo está acotado: no puede subir más de lo que hay
//   en la cámara ni tocar cámaras fuera de su alcance.
//
// ---- POR QUÉ CERRAR ES SUPERVISOR ----
//   Cerrar es declarar que el camión salió. Es el punto donde se aplican los
//   bloqueos duros:
//     · sin líneas de picking        → no se cierra
//     · transporte con inocuidad 0   → no se cierra
//     · fruta de otro cliente        → exige ?confirmar=1 y queda auditado
//
// ---- POR QUÉ REABRIR ES ADMIN ----
//   Significa que el documento se cerró por error. Siempre con motivo y
//   siempre registrado en la auditoría.
//
// ---- EL ALCANCE SOBRE UN DOCUMENTO SIN CÁMARA ----
//   El despacho no tiene cámara: la tienen sus líneas. Un despacho armado
//   pertenece a quien puso la fruta; uno vacío lo puede continuar
//   cualquiera. No se usa validarCamaraEnAlcance porque ninguna acción
//   recibe un id_camara en el body: siempre se deduce de la ocupación.
// ============================================================================

// ---- Consultas ----
// Las rutas con prefijo fijo van ANTES de "/:id".

// Dropdown del picking: solo clientes con fruta en las cámaras del alcance,
// ordenados por criticidad.
router.get("/clientes-disponibles", verifyToken, verifyOperativo, cargarAlcance, despachosController.getClientesDisponibles);

// Listado. Lee vw_despachos.
//   ?estado=1   ?id_cc=3   ?id_transporte=2
//   ?fecha_desde=...   ?fecha_hasta=...
//   ?buscar=texto   folio, cliente, orden de venta, cita o placas
router.get("/", verifyToken, verifyOperativo, cargarAlcance, despachosController.getDespachos);

// Documento completo: encabezado, picking, auditoría y las líneas cuyo
// cliente no coincide con el del despacho.
router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdDespacho, despachosController.getDespachoById);

// Fruta que se puede subir a este despacho, ordenada por criticidad y FEFO.
//   ?todos=1 → incluye fruta de otros clientes, marcada con
//              es_de_otro_cliente para que no pase inadvertida
router.get("/:id/disponible", verifyToken, verifyOperativo, cargarAlcance, validarIdDespacho, despachosController.getDisponible);

router.get("/:id/auditoria", verifyToken, verifyOperativo, cargarAlcance, validarIdDespacho, despachosController.getAuditoria);

// ---- Documento ----
// El folio lo genera la BD con fn_generar_folio_despacho (secuencia desde
// 70000). Calcularlo con MAX(folio)+1 abriría una ventana de carrera.
router.post("/", verifyToken, verifyCoordinador, cargarAlcance, validarDespacho, despachosController.createDespacho);

// Editar el encabezado de un BORRADOR. No toca los totales: los deriva el
// trigger desde el detalle.
router.put("/:id", verifyToken, verifyCoordinador, cargarAlcance, validarIdDespacho, validarDespacho, despachosController.updateDespacho);

// Corregir un despacho CERRADO. Exige motivo y registra auditoría con el
// snapshot de lo que cambió.
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

// ---- Picking ----
// ⚠️ Agregar una línea descuenta la cámara vía la cadena de triggers.
// El controller valida antes que no se suba más de lo que hay: el trigger
// usa GREATEST(cantidad - movida, 0), así que un exceso dejaría la cámara
// en cero y el documento diría que salieron tarimas inexistentes.
router.post(
    "/:id/lineas",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarIdDespacho,
    validarLinea,
    despachosController.agregarLinea
);

// Quitar una línea: la fruta regresa a su cámara vía trg_revertir_movimiento.
//
// ⚠️ fn_quitar_linea_despacho devuelve TEXTO, no excepción. El controller
// lee el prefijo 'OK:' para decidir entre 200 y 409.
router.delete(
    "/:id/lineas/:id_detalle",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarIdDespacho,
    validarIdDetalle,
    despachosController.quitarLinea
);

// ---- Cierre ----
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

// ---- Eliminar ----
// Solo borradores SIN líneas.
router.delete("/:id", verifyToken, verifyAdmin, cargarAlcance, validarIdDespacho, despachosController.deleteDespacho);

export default router;
