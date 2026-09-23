import { Router } from "express";
import { ocupacionesController } from "../controllers/ocupaciones.controller.js";
import {
    validarPromocion,
    validarPrioridad,
    validarIdOcupacion
} from "../middlewares/ocupaciones.middleware.js";
import { cargarAlcance } from "../middlewares/alcance.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifySupervisor,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// OCUPACIONES Y COLA
// ver/promover = operativo+ · priorizar = supervisor+
// ============================================================================
// Este módulo NO da de alta ocupaciones: las generan los triggers de
// recepción y movimiento. Solo consulta y dispara las dos funciones de la
// BD que el operador necesita.
//
// POR QUÉ PROMOVER ES OPERATIVO
//   Es la continuación natural de recepcionar: se liberó espacio en la
//   cámara y hay que meter lo que está esperando en el patio. Quien lo hace
//   es el mismo operativo que recibió el camión, a la hora que sea.
//
//   El riesgo está acotado: fn_promover_de_cola nunca deja meter más de lo
//   que espera ni más de lo que cabe, y el alcance limita a sus cámaras.
//
// POR QUÉ PRIORIZAR SUBE A SUPERVISOR
//   Adelantar un lote significa SALTARSE el orden de antigüedad, y ese
//   orden existe por una razón: la fruta más vieja se echa a perder
//   primero. Quien rompe esa regla tiene que poder justificarla — por eso
//   el motivo es obligatorio y el rol es supervisor.
//
// NO SE USA validarCamaraEnAlcance
//   A diferencia de producción y recepciones, aquí NINGUNA acción recibe un
//   id_camara en el body. Se actúa sobre una ocupación que YA existe, así
//   que el controller valida el alcance contra la cámara de esa fila.
//
// ---- EL ORDEN DE LA COLA ----
//   1º prioridad DESC     los urgentes al frente
//   2º fecha_empaque ASC  la fruta más VIEJA primero
//   3º llegada            desempate
//   'posicion' = 1 es el siguiente en entrar.
// ============================================================================

// ---- Consultas ----
// Las rutas con prefijo fijo van ANTES de "/:id": si no, Express
// interpretaría "tablero" como un id y el middleware lo rechazaría.

// Capacidad, ocupado, en cola y mantenimiento por cámara.
//   ?tipo_camara=1        1 preenfrío · 2 conservación
//   ?solo_operativas=1    oculta las dadas de baja
router.get("/tablero", verifyToken, verifyOperativo, cargarAlcance, ocupacionesController.getTablero);

// Fruta esperando fuera, con su turno calculado.
//   ?id_camara=1
router.get("/cola", verifyToken, verifyOperativo, cargarAlcance, ocupacionesController.getCola);

// Lo que está FÍSICAMENTE dentro. Ordenado FEFO (la más vieja primero).
// Es la misma fuente que usará el picking de despachos.
//   ?id_camara=1   ?id_cc=3   ?buscar=texto
router.get("/inventario", verifyToken, verifyOperativo, cargarAlcance, ocupacionesController.getInventario);

// Ocupaciones cerradas, con las horas que la fruta estuvo dentro.
//   ?id_camara=1   ?fecha_desde=2026-09-01   ?fecha_hasta=2026-09-30
router.get("/historial", verifyToken, verifyOperativo, cargarAlcance, ocupacionesController.getHistorial);

router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdOcupacion, ocupacionesController.getOcupacionById);

// ---- Promover de la cola a la cámara ----
// Llama a fn_promover_de_cola, que hace los cinco pasos en una sola
// operación atómica: verificar espacio, calcular tarimas, repartir cajas en
// proporción, sumar a la cámara y descontar de la cola.
//
// ⚠️ La función devuelve TEXTO, no excepción. El controller lee el prefijo
// 'OK:' para decidir entre 200 y 409: sin eso, un rechazo por falta de
// espacio respondería 200 y el operador creería que su fruta entró.
router.post(
    "/:id/promover",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarIdOcupacion,
    validarPromocion,
    ocupacionesController.promoverDeCola
);

// ---- Prioridad en la cola ----
// Supervisor+: adelantar un lote rompe el orden de antigüedad.
// El motivo es obligatorio cuando la prioridad es mayor a 0.
router.patch(
    "/:id/prioridad",
    verifyToken,
    verifySupervisor,
    cargarAlcance,
    validarIdOcupacion,
    validarPrioridad,
    ocupacionesController.setPrioridad
);

export default router;
