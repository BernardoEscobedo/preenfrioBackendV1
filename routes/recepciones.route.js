import { Router } from "express";
import { recepcionesController } from "../controllers/recepciones.controller.js";
import {
    validarRecepcion,
    validarEdicionRecepcion,
    validarIdRecepcion
} from "../middlewares/recepciones.middleware.js";
import {
    cargarAlcance,
    validarCamaraEnAlcance
} from "../middlewares/alcance.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifySupervisor,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// RECEPCIONES
// ver/registrar = operativo+ · editar = supervisor+ · cancelar = coordinador+
// ============================================================================
// POR QUÉ REGISTRAR ES OPERATIVO
//   Quien recibe el camión a las 3 de la mañana es el operativo de turno,
//   no coordinación. Si registrar exigiera un rol superior, la captura se
//   haría en papel y se pasaría al sistema horas después.
//
//   El alcance acota el riesgo: solo puede recibir en SUS cámaras.
//
// POR QUÉ CANCELAR SUBE A COORDINADOR
//   Desde la v2.5, cancelar sí libera la cámara (trg_revertir_recepcion).
//   Pero si parte de esa fruta ya se movió a conservación o se despachó, la
//   cámara solo descuenta lo que todavía tiene, y el inventario queda por
//   revisar a mano. Además cambia el estado de la producción. No es una
//   operación de piso.
//
// EDITAR ES SUPERVISOR
//   Solo se tocan temperatura y observaciones. Las cantidades no se editan
//   nunca: el trigger reacciona al estado, no a las cantidades. Para
//   corregir un número se cancela y se vuelve a capturar.
//
// ---- EL ALCANCE, EN DOS CAPAS ----
//   cargarAlcance                  → filtra la LECTURA en el SQL
//   validarCamaraEnAlcance("body") → revisa el id_camara del body
//
//   Cuidado: cuando el body NO trae cámara, el controller la HEREDA de la
//   producción, y validarCamaraEnAlcance ya no puede verla. Por eso el
//   controller vuelve a validar el alcance sobre la cámara heredada.
//
// FILTROS DEL LISTADO
//   ?id_produccion=5      recepciones de un proceso
//   ?id_camara=1          &estado=1
//   ?fecha_desde=2026-09-20&fecha_hasta=2026-09-23
//   ?buscar=texto         código de lote, finca o cliente
// ============================================================================

// ---- Consultas ----
// Las rutas con prefijo fijo van ANTES de "/:id".

// Lo que el preenfrío espera recibir. Pantalla principal del andén.
//   ?semana=39      ?id_camara=1      ?todas=1 (incluye lo ya completo)
router.get("/esperadas", verifyToken, verifyOperativo, cargarAlcance, recepcionesController.getEsperadas);

// Capacidad de una cámara. El frontend la consulta al abrir el modal para
// avisar de antemano cuánto va a quedar en cola.
router.get("/disponibilidad/:id_camara", verifyToken, verifyOperativo, cargarAlcance, recepcionesController.getDisponibilidad);

router.get("/", verifyToken, verifyOperativo, cargarAlcance, recepcionesController.getRecepciones);

// Devuelve además las ocupaciones que generaron los triggers: es la
// respuesta a "¿por qué mi fruta quedó en cola?".
router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdRecepcion, recepcionesController.getRecepcionById);

// ---- Registrar ----
// ⚠️ Este INSERT dispara triggers en la BD:
//     trg_sync_ocupacion_recepcion     reparte entre cámara y cola, y
//                                      guarda cuánto entró (v2.5)
//     trg_actualizar_estado_produccion mueve la producción a estado 2 o 3
//
// El backend NO escribe en ocupaciones_camaras. La respuesta relee lo que
// hicieron los triggers y lo informa en "resultado".
//
// El id_usuario sale del token, nunca del body: es quien firma la recepción.
router.post(
    "/",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarRecepcion,
    validarCamaraEnAlcance("body"),
    recepcionesController.createRecepcion
);

// ---- Editar ----
// Solo temperatura y observaciones.
router.put(
    "/:id",
    verifyToken,
    verifySupervisor,
    cargarAlcance,
    validarIdRecepcion,
    validarEdicionRecepcion,
    recepcionesController.updateRecepcion
);

// ---- Cancelar ----
// estado = 0. trg_revertir_recepcion (v2.5) libera la cámara y cierra la
// cola de esta recepción; la producción recalcula su estado. La respuesta
// compara la ocupación antes y después y avisa si no se pudo liberar todo
// porque la fruta ya se había movido.
router.delete("/:id", verifyToken, verifyCoordinador, cargarAlcance, validarIdRecepcion, recepcionesController.cancelarRecepcion);

// Reactivar: vuelve a ocupar la cámara. Lo que estaba en cola se suma
// directo a la cámara y puede dejarla sobreocupada; la respuesta lo avisa.
router.patch("/:id/reactivar", verifyToken, verifyCoordinador, cargarAlcance, validarIdRecepcion, recepcionesController.reactivarRecepcion);

export default router;
