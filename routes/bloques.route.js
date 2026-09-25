import { Router } from "express";
import { bloquesController } from "../controllers/bloques.controller.js";
import {
    validarBloque,
    validarLineaBloque,
    validarIdBloque,
    validarIdDetalleBloque
} from "../middlewares/bloques.middleware.js";
import { cargarAlcance } from "../middlewares/alcance.middleware.js";
import {
    verifyToken,
    verifyAdmin,
    verifySupervisor,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// BLOQUES FÍSICOS
// ver/armar = operativo+ · editar/desarmar = supervisor+ · eliminar = admin
// ============================================================================
// Un bloque es el montón de tarimas que el montacarguista arma junto dentro
// de la cámara, y que se pulpea como unidad.
//
// POR QUÉ ARMAR ES OPERATIVO
//   Es trabajo de piso puro: el montacarguista apila y registra. Igual que
//   el picking de despachos, si exigiera un rol superior se anotaría en
//   papel y se capturaría después.
//
// POR QUÉ EDITAR Y DESARMAR SUBE A SUPERVISOR
//   Desarmar un bloque con pulpeos rompe la unidad sobre la que se midió la
//   temperatura, y cambiar el código deja las etiquetas físicas sin
//   coincidir. No es una decisión de ejecución.
//
// ⚠️ LOS TOTALES LOS DERIVA UN TRIGGER
//   Cada operación sobre las líneas dispara trg_recalcular_totales_bloque,
//   que recalcula cantidad_tarimas y cantidad_cajas desde el detalle. El
//   backend nunca los escribe.
//
// EL ALCANCE SE RESUELVE POR EL CONTENIDO
//   bloques_fruta no tiene id_camara: el bloque se define por la fruta que
//   agrupa. Un bloque armado pertenece a las cámaras de sus procesos; uno
//   vacío lo puede continuar cualquiera. Mismo criterio que despachos.
//
//   Al agregar una línea, la cámara sale de la producción — no del body —
//   así que la valida el controller, no validarCamaraEnAlcance.
// ============================================================================

// ---- Consultas ----
//   ?estado=1   1 armado · 0 desarmado
//   ?fecha_desde=...   ?fecha_hasta=...   ?buscar=B001
router.get("/", verifyToken, verifyOperativo, cargarAlcance, bloquesController.getBloques);

// Devuelve el bloque con su composición y la bandera mezcla_procesos, que
// avisa si el pulpeo necesita desglose por lote.
router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdBloque, bloquesController.getBloqueById);

// ---- Encabezado ----
router.post("/", verifyToken, verifyOperativo, cargarAlcance, validarBloque, bloquesController.createBloque);

router.put("/:id", verifyToken, verifySupervisor, cargarAlcance, validarIdBloque, validarBloque, bloquesController.updateBloque);

// ---- Composición ----
// El controller bloquea cualquier cambio si el bloque ya salió en un
// despacho: su composición es parte de un documento de salida.
//
// La tabla tiene UNIQUE(id_bloque, id_produccion), así que un lote aparece
// una sola vez por bloque. Si llegan más tarimas del mismo, se edita la
// línea existente.
router.post(
    "/:id/lineas",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarIdBloque,
    validarLineaBloque,
    bloquesController.agregarLinea
);

router.put(
    "/:id/lineas/:id_detalle",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarIdBloque,
    validarIdDetalleBloque,
    validarLineaBloque,
    bloquesController.actualizarLinea
);

router.delete(
    "/:id/lineas/:id_detalle",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarIdBloque,
    validarIdDetalleBloque,
    bloquesController.quitarLinea
);

// ---- Desarmar (baja lógica) ----
// El montón se deshizo. Los pulpeos se conservan: son evidencia de la
// cadena de frío y tienen que seguir resolviendo a qué bloque pertenecían.
router.delete("/:id", verifyToken, verifySupervisor, cargarAlcance, validarIdBloque, bloquesController.desarmarBloque);

router.patch("/:id/rearmar", verifyToken, verifySupervisor, cargarAlcance, validarIdBloque, bloquesController.rearmarBloque);

// ---- Borrado físico ----
// Solo admin, y solo para un alta mal capturada que nunca se usó: el
// controller lo rechaza si hay pulpeos o líneas de despacho.
router.delete("/:id/eliminar", verifyToken, verifyAdmin, cargarAlcance, validarIdBloque, bloquesController.deleteBloque);

export default router;
