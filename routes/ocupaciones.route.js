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
// ---- EL ORDEN DE LA COLA (v2.3) ----
//   1º prioridad manual      override del supervisor
//   2º nivel de criticidad   días de holgura contra la cita
//   3º fecha de empaque      FEFO dentro del mismo nivel
//   4º llegada               desempate
//
//   holgura = días para la cita − tránsito − días de preenfrío
//
//       NIVEL 1  CRÍTICA   holgura ≤ 0 · o fruta con 5+ días de empacada
//       NIVEL 2  URGENTE   holgura = 1
//       NIVEL 3  NORMAL    holgura 2 a 4
//       NIVEL 4  HOLGADA   holgura 5+ · o sin cita asignada
//
//   La cita define el nivel; la antigüedad decide el turno dentro del
//   nivel. Así no se incumple algo de nivel 1 por atender un nivel 3, pero
//   entre dos críticas entra primero la más vieja.
//
// POR QUÉ PROMOVER ES OPERATIVO
//   Es la continuación natural de recepcionar: se liberó espacio y hay que
//   meter lo que está esperando. Lo hace el mismo operativo que recibió el
//   camión, a la hora que sea.
//
//   El riesgo está acotado: fn_promover_de_cola nunca deja meter más de lo
//   que espera ni más de lo que cabe, y el alcance limita a sus cámaras.
//   Si se salta el orden sugerido, el sistema lo permite pero lo avisa.
//
// POR QUÉ PRIORIZAR SUBE A SUPERVISOR
//   La prioridad manual gana sobre la criticidad calculada, así que puede
//   colocar fruta holgada delante de fruta con la cita encima. Quien lo
//   haga tiene que poder justificarlo — de ahí que el motivo sea
//   obligatorio.
//
//   Con la criticidad automática esto debería usarse mucho menos que antes:
//   los casos que se resolvían a mano ahora salen solos en el orden.
//
// NO SE USA validarCamaraEnAlcance
//   A diferencia de producción y recepciones, aquí ninguna acción recibe un
//   id_camara en el body. Se actúa sobre una ocupación que YA existe, así
//   que el controller valida el alcance contra la cámara de esa fila.
// ============================================================================

// ---- Consultas ----
// Las rutas con prefijo fijo van ANTES de "/:id": si no, Express
// interpretaría "tablero" como un id y el middleware lo rechazaría.

// Capacidad, ocupado, en cola y mantenimiento por cámara.
// v2.3: incluye tarimas_criticas_en_cola y ordena primero las cámaras con
// fruta que no puede esperar.
//   ?tipo_camara=1        1 preenfrío · 2 conservación
//   ?solo_operativas=1    oculta las dadas de baja
router.get("/tablero", verifyToken, verifyOperativo, cargarAlcance, ocupacionesController.getTablero);

// Fruta esperando fuera, con su turno y su nivel de criticidad.
//   ?id_camara=1
//   ?nivel_maximo=1   solo lo crítico
//   ?nivel_maximo=2   crítico y urgente
router.get("/cola", verifyToken, verifyOperativo, cargarAlcance, ocupacionesController.getCola);

// ⭐ Reporte de arranque de turno: solo nivel 1, agrupado por tipo de
// problema. Responde "¿qué se me está incumpliendo ahora mismo?".
//   CITA_VENCIDA  ya no llega; hay que avisar al cliente
//   SALE_HOY      todavía se salva si se despacha hoy
//   FRUTA_VIEJA   revisar calidad, quizá ya no sirve
router.get("/criticas", verifyToken, verifyOperativo, cargarAlcance, ocupacionesController.getCriticas);

// Lo que está FÍSICAMENTE dentro. v2.3: ordenado por criticidad y luego
// FEFO, para no sacar fruta vieja con cita lejana dejando adentro la que
// vence mañana. Es la misma fuente que usará el picking de despachos.
//   ?id_camara=1   ?id_cc=3   ?nivel_maximo=2   ?buscar=texto
router.get("/inventario", verifyToken, verifyOperativo, cargarAlcance, ocupacionesController.getInventario);

// Ocupaciones cerradas, con horas en cámara y si se cumplió la cita.
// El porcentaje de cumplimiento permite medir si la criticidad está
// sirviendo o si se sigue incumpliendo igual.
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
//
// v2.3: si se promueve dejando atrás fruta más crítica, la respuesta lo
// advierte en "avisos". No se bloquea: puede haber una razón válida que el
// sistema no conoce.
router.post(
    "/:id/promover",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarIdOcupacion,
    validarPromocion,
    ocupacionesController.promoverDeCola
);

// ---- Prioridad manual en la cola ----
// Supervisor+: gana sobre la criticidad calculada, así que puede colocar
// fruta holgada delante de fruta con la cita encima.
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
