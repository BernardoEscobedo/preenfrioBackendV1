import { Router } from "express";
import { movimientosController } from "../controllers/movimientos.controller.js";
import {
    validarMovimiento,
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
// ver = operativo+ · trasladar = supervisor+ · eliminar = admin
// ============================================================================
// Bitácora del flujo físico entre cámaras.
//
//   tipo 1 = ingreso a preenfrío        lo genera la recepción
//   tipo 2 = preenfrío → conservación   ← lo ÚNICO que crea este módulo
//   tipo 3 = salida por despacho        lo genera el detalle de despachos
//
//   Los tipos 1 y 3 no se pueden capturar a mano desde aquí: habría dos
//   vías para el mismo hecho y la cámara terminaría con el doble de fruta.
//   El middleware lo bloquea.
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
//   deduce de id_ocupacion_origen. Sin esa tercera validación, un
//   supervisor podría sacar fruta de una planta ajena mandando una
//   ocupación que no le corresponde.
//
// POR QUÉ TRASLADAR ES SUPERVISOR Y NO OPERATIVO
//   A diferencia de recepcionar o promover de la cola, aquí se decide que
//   la fruta YA TERMINÓ su ciclo de preenfrío. Sacarla antes de tiempo la
//   manda caliente a conservación y compromete la calidad de todo el lote.
//   Es criterio técnico, no ejecución.
//
// POR QUÉ ELIMINAR ES ADMIN
//   La tabla es una bitácora inmutable. Borrar una fila NO devuelve la
//   fruta (el trigger es AFTER INSERT), así que deja el inventario
//   descuadrado hasta que alguien lo corrija a mano. La vía recomendada es
//   registrar el movimiento inverso, no borrar.
// ============================================================================

// ---- Consultas ----
// Las rutas con prefijo fijo van ANTES de "/:id": si no, Express
// interpretaría "trasladables" como un id.

// Fruta dentro de cámaras de PREENFRÍO, candidata a pasar a conservación.
// Es el origen del formulario. Viene ordenada por criticidad (v2.3) e
// incluye horas_en_preenfrio: los dos datos que decide el supervisor.
//   ?id_camara=1
router.get("/trasladables", verifyToken, verifyOperativo, cargarAlcance, movimientosController.getTrasladables);

// Cuánta fruta se movió por día y tipo. Reporte operativo.
//   ?fecha_desde=2026-09-01   ?fecha_hasta=2026-09-30
router.get("/resumen", verifyToken, verifyOperativo, cargarAlcance, movimientosController.getResumen);

// Todos los movimientos de un lote, en orden cronológico.
// Es la respuesta a "¿por dónde pasó esta fruta?" ante un reclamo.
router.get("/trazabilidad/:id_produccion", verifyToken, verifyOperativo, cargarAlcance, movimientosController.getTrazabilidad);

// Bitácora general. Lee vw_movimientos, que ya resuelve nombres de cámaras,
// folio de despacho, lote, finca, SKU, cliente y quién lo registró.
//   ?tipo_movimiento=2   ?id_produccion=5   ?id_camara=1
//   ?fecha_desde=...     ?fecha_hasta=...   ?buscar=texto
router.get("/", verifyToken, verifyOperativo, cargarAlcance, movimientosController.getMovimientos);

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

// ---- Eliminar de la bitácora ----
// Solo admin. El controller bloquea los movimientos que pertenecen a un
// despacho (tienen su propia reversa con fn_quitar_linea_despacho) y los
// que generó una recepción.
//
// La respuesta advierte que el borrado NO devolvió la fruta.
router.delete("/:id", verifyToken, verifyAdmin, cargarAlcance, validarIdMovimiento, movimientosController.deleteMovimiento);

export default router;
