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
// El despacho es un DOCUMENTO; el picking es lo que lleva. Un mismo
// despacho puede cargar fruta de varias cámaras, por eso se arma desde el
// documento y no desde cada cámara.
//
// ---- DESPACHO EN UN PASO (asistente) ----
//   POST /completo registra todo y lo CIERRA en una sola transacción:
//   altas rápidas (operador, tracto, cajas), servicio de transporte,
//   documento, inspección por caja, picking y cierre. Así funciona el
//   andén: si la caja está bien, se carga y sale.
//
//   Lo puede hacer quien despacha (operativo+). El alcance se valida sobre
//   cada cámara de la que sale fruta.
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
// ---- CIERRE ----
//   Bloqueos duros (trg_validar_cierre y trg_validar_cierre_full):
//     · sin líneas de picking                 → no se cierra
//     · inspección pendiente o rechazada      → no se cierra
//     · unidad full sin la 2ª caja aprobada   → no se cierra
//     · fruta de otro cliente                 → exige confirmación y queda
//                                               auditado
//
// ---- POR QUÉ REABRIR ES ADMIN ----
//   Significa que el documento se cerró por error. Siempre con motivo y
//   siempre registrado en la auditoría.
// ============================================================================

// ---- Consultas ----
// Las rutas con prefijo fijo van ANTES de "/:id".

// Dropdown de destinos: solo clientes con fruta en las cámaras del alcance,
// ordenados por criticidad.
router.get("/clientes-disponibles", verifyToken, verifyOperativo, cargarAlcance, despachosController.getClientesDisponibles);

// Stock disponible para armar un despacho nuevo.
//   ?id_cc=3          fruta planeada para ese cliente/CEDIS
//   ?todos=1          incluye la de otros clientes (marcada)
router.get("/inventario", verifyToken, verifyOperativo, cargarAlcance, despachoCompletoController.getInventario);

// Listado. Lee vw_despachos.
//   ?estado=1   ?id_cc=3   ?id_transporte=2
//   ?fecha_desde=...   ?fecha_hasta=...
//   ?inocuidad=1 | 0 | pendiente
//   ?buscar=texto   folio, cliente, orden de venta, cita o placas
router.get("/", verifyToken, verifyOperativo, cargarAlcance, despachosController.getDespachos);

// Documento completo: encabezado (con su inspección), picking, auditoría y
// las líneas cuyo cliente no coincide con el del despacho.
router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdDespacho, despachosController.getDespachoById);

// Fruta que se puede subir a este despacho, ordenada por criticidad y FEFO.
//   ?todos=1 → incluye fruta de otros clientes, marcada con
//              es_de_otro_cliente para que no pase inadvertida
router.get("/:id/disponible", verifyToken, verifyOperativo, cargarAlcance, validarIdDespacho, despachosController.getDisponible);

router.get("/:id/auditoria", verifyToken, verifyOperativo, cargarAlcance, validarIdDespacho, despachosController.getAuditoria);

// ---- ⭐ Despacho en un paso (asistente) ----
// Va ANTES de "/:id" por ser un prefijo fijo.
router.post(
    "/completo",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarDespachoCompleto,
    despachoCompletoController.crearDespachoCompleto
);

// ---- Documento (flujo por pasos, se conserva) ----
// El folio lo genera la BD con fn_generar_folio_despacho (secuencia desde
// 70000). Nace en borrador con la inspección PENDIENTE.
router.post("/", verifyToken, verifyCoordinador, cargarAlcance, validarDespacho, despachosController.createDespacho);

// Editar el encabezado de un BORRADOR. Si cambia el transporte, la BD borra
// la inspección y hay que volver a revisar la caja.
router.put("/:id", verifyToken, verifyCoordinador, cargarAlcance, validarIdDespacho, validarDespacho, despachosController.updateDespacho);

// Corregir un despacho CERRADO. Exige motivo y registra auditoría con el
// snapshot de lo que cambió. No admite cambiar el transporte.
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
//   body: { inocuidad: 1 | 0, inocuidad_observaciones?: "texto" }
router.patch(
    "/:id/inocuidad",
    verifyToken,
    verifySupervisor,
    cargarAlcance,
    validarIdDespacho,
    validarInocuidadDespacho,
    despachosController.registrarInocuidad
);

// ---- Picking ----
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
// fn_quitar_linea_despacho devuelve TEXTO, no excepción.
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
// Con fruta de otro cliente: ?confirmar=1
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
