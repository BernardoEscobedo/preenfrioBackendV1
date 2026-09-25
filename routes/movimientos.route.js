import { Router } from "express";
import { movimientosController } from "../controllers/movimientos.controller.js";
import {
    validarMovimiento,
    validarReversa,
    validarIdMovimiento
} from "../middlewares/movimientos.middleware.js";
import {
    cargarAlcance,
    validarCamaraEnAlcance
} from "../middlewares/alcance.middleware.js";
import {
    verifyToken,
    verifyAdmin,
    verifySupervisor,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// MOVIMIENTOS DE INVENTARIO
// ver = operativo+ · trasladar/revertir = supervisor+ · eliminar = admin
// ============================================================================
// Bitácora del flujo físico entre cámaras.
//
//   tipo 1 = ingreso a preenfrío        lo genera la recepción
//   tipo 2 = preenfrío → conservación   ← lo ÚNICO que crea este módulo
//   tipo 3 = salida por despacho        lo genera el detalle de despachos
//
// ---- EL ALCANCE, EN TRES PUNTOS ----
//   Es el primer módulo donde hay que validar DOS cámaras.
//
//   cargarAlcance                          filtra la LECTURA. La condición
//                                          es OR sobre origen y destino: si
//                                          el traslado llegó a tu cámara,
//                                          es asunto tuyo aunque el origen
//                                          no lo sea.
//
//   validarCamaraEnAlcance("body",         valida la cámara DESTINO, que sí
//       "id_camara_destino")               viene en el body.
//
//   El controller valida la cámara ORIGEN, que NO viene en el body: se
//   deduce de id_ocupacion_origen.
//
// ────────────────────────────────────────────────────────────────────────
// v2.5 · DOS VÍAS DE CORRECCIÓN, Y NO SON EQUIVALENTES
// ────────────────────────────────────────────────────────────────────────
//   POST /:id/revertir   ← LA VÍA OFICIAL. supervisor+
//       Crea un movimiento inverso. El inventario queda igual que si se
//       hubiera borrado, pero la bitácora conserva las dos filas: el
//       traslado y su corrección, con fecha, usuario y motivo.
//
//   DELETE /:id          ← EXCEPCIONAL. admin, con motivo obligatorio
//       Borra la fila. Desde la v2.5 el trigger devuelve la fruta, así que
//       es seguro para el inventario — pero borra también la evidencia de
//       que hubo un error.
//
//       Se reserva para filas que NUNCA debieron existir: una captura
//       duplicada, una prueba que se coló a producción.
//
//   POR QUÉ SE MANTIENE ESTA DISTINCIÓN
//     Un inventario que cuadra no basta: hay que poder explicar CÓMO llegó
//     a cuadrar. Es el mismo criterio de los pulpeos (una lectura errónea
//     se cancela, no se borra) y de la auditoría de despachos.
//
// ---- POR QUÉ TRASLADAR ES SUPERVISOR ----
//   Aquí se decide que la fruta YA TERMINÓ su ciclo de preenfrío. Sacarla
//   antes de tiempo la manda caliente a conservación y compromete la
//   calidad de todo el lote. Es criterio técnico, no ejecución.
// ============================================================================

// ---- Consultas ----
// Las rutas con prefijo fijo van ANTES de "/:id".

// Fruta dentro de cámaras de PREENFRÍO, candidata a pasar a conservación.
// Es el origen del formulario. Viene ordenada por criticidad (v2.3) e
// incluye horas_en_preenfrio: los dos datos que decide el supervisor.
//   ?id_camara=1
router.get("/trasladables", verifyToken, verifyOperativo, cargarAlcance, movimientosController.getTrasladables);

// Cuánta fruta se movió por día y tipo. Incluye el conteo de reversas: si
// son muchas, algo está fallando en la captura.
//   ?fecha_desde=2026-09-01   ?fecha_hasta=2026-09-30
router.get("/resumen", verifyToken, verifyOperativo, cargarAlcance, movimientosController.getResumen);

// Todos los movimientos de un lote, en orden cronológico, con las reversas
// marcadas. Es la respuesta a "¿por dónde pasó esta fruta?" ante un
// reclamo — y ahí es donde el movimiento inverso demuestra su valor frente
// al borrado.
router.get("/trazabilidad/:id_produccion", verifyToken, verifyOperativo, cargarAlcance, movimientosController.getTrazabilidad);

// Bitácora general. Lee vw_movimientos, que ya resuelve nombres de cámaras,
// folio de despacho, lote, finca, SKU, cliente y quién lo registró.
//   ?tipo_movimiento=2   ?id_produccion=5   ?id_camara=1
//   ?fecha_desde=...     ?fecha_hasta=...   ?buscar=texto
router.get("/", verifyToken, verifyOperativo, cargarAlcance, movimientosController.getMovimientos);

// Devuelve además si el movimiento ya fue revertido, y por cuál.
router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdMovimiento, movimientosController.getMovimientoById);

// ---- Registrar traslado ----
// ⚠️ Este INSERT dispara trg_sync_ocupacion_movimiento, que descuenta de la
// ocupación de origen (cerrándola si queda en cero) y suma a la cámara
// destino. El backend NO escribe en ocupaciones_camaras.
//
// El controller valida antes de insertar que no se mueva más de lo que hay:
// el trigger usa GREATEST(cantidad - movida, 0), así que un exceso no
// reventaría — dejaría el origen en cero y sumaría de más al destino,
// inventando fruta.
router.post(
    "/",
    verifyToken,
    verifySupervisor,
    cargarAlcance,
    validarMovimiento,
    validarCamaraEnAlcance("body", "id_camara_destino"),
    movimientosController.createMovimiento
);

// ---- ⭐ Revertir · LA VÍA OFICIAL DE CORRECCIÓN ----
// Crea el movimiento inverso: mismas cantidades, cámaras intercambiadas.
//
// El motivo es obligatorio (mínimo 10 caracteres) y queda en las
// observaciones junto con la referencia al original. Sin él, la reversa
// sería tan opaca como un borrado.
//
// El controller bloquea:
//   · revertir dos veces el mismo movimiento
//   · revertir uno de recepción (tipo 1) o de despacho (tipo 3): esos
//     tienen su propia reversa en sus módulos
//   · revertir cuando la fruta ya se movió del destino
router.post(
    "/:id/revertir",
    verifyToken,
    verifySupervisor,
    cargarAlcance,
    validarIdMovimiento,
    validarReversa,
    movimientosController.revertirMovimiento
);

// ---- Eliminar · VÍA EXCEPCIONAL ----
// Solo admin, y con motivo obligatorio aunque la fila vaya a desaparecer:
// queda en el log del servidor, que es el único rastro que quedará.
//
// El controller bloquea los movimientos que pertenecen a un despacho
// (tienen su propia reversa con fn_quitar_linea_despacho) y los que generó
// una recepción.
//
// La respuesta advierte que la fila se eliminó de la bitácora y sugiere
// usar /revertir para correcciones auditables.
router.delete("/:id", verifyToken, verifyAdmin, cargarAlcance, validarIdMovimiento, movimientosController.deleteMovimiento);

export default router;
