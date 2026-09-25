import { Router } from "express";
import { pulpeosController } from "../controllers/pulpeos.controller.js";
import {
    validarPulpeo,
    validarEdicionPulpeo,
    validarIdPulpeo
} from "../middlewares/pulpeos.middleware.js";
import { cargarAlcance } from "../middlewares/alcance.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifySupervisor,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// PULPEOS — CONTROL DE TEMPERATURA
// ver/registrar = operativo+ · editar = supervisor+ · cancelar = coordinador+
// ============================================================================
// El pulpeo mide temperatura DENTRO de la fruta: el termómetro de aguja
// entra a la pulpa, no mide el aire de la cámara. Es el dato que respalda
// la cadena de frío ante el cliente.
//
// POR QUÉ REGISTRAR ES OPERATIVO
//   Se toma cada pocas horas durante todo el ciclo, incluidas las
//   madrugadas. Quien tiene el termómetro en la mano es el operativo de
//   turno. Si exigiera un rol superior, las mediciones se anotarían en
//   papel — y el papel se pierde justo cuando hay un reclamo.
//
// POR QUÉ CANCELAR SUBE A COORDINADOR
//   Cancelar una lectura la saca de la evidencia. Puede ser legítimo (un
//   termómetro descalibrado), pero también es la forma de hacer desaparecer
//   una medición incómoda. No es decisión de piso.
//
// LAS TEMPERATURAS NO SE EDITAN
//   Una lectura es un hecho puntual, no un dato corregible. El PUT solo
//   toca número y observaciones. Si la medición estuvo mal, se cancela y se
//   toma otra: así queda rastro de la corrección en lugar de borrarla.
//
// EL ALCANCE
//   Se resuelve por las cámaras donde está la fruta del bloque, igual que
//   en el módulo de bloques. No se usa validarCamaraEnAlcance porque
//   ninguna acción recibe un id_camara en el body.
// ============================================================================

// ---- Consultas ----
// Las rutas con prefijo fijo van ANTES de "/:id".

// ⭐ Bloques que necesitan medición: nunca pulpeados, sin lectura reciente,
// o fuera de objetivo. Es el reporte de pendientes del turno.
//   ?horas=4   umbral de horas sin medición (4 por defecto)
router.get("/pendientes", verifyToken, verifyOperativo, cargarAlcance, pulpeosController.getPendientes);

// ⭐ Curva de enfriamiento de un bloque: todas las mediciones en orden, con
// las horas transcurridas desde el armado y cuánto bajó entre una y otra.
// Es el gráfico que demuestra la cadena de frío ante el cliente.
router.get("/curva/:id_bloque", verifyToken, verifyOperativo, cargarAlcance, pulpeosController.getCurva);

// Listado general.
//   ?id_bloque=3          ?estado=1
//   ?fuera_de_objetivo=1  solo las que no alcanzaron su objetivo
//   ?fecha_desde=...      ?fecha_hasta=...
router.get("/", verifyToken, verifyOperativo, cargarAlcance, pulpeosController.getPulpeos);

// Devuelve el pulpeo con su desglose por proceso.
router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdPulpeo, pulpeosController.getPulpeoById);

// ---- Registrar ----
// El pulpeo y su detalle se guardan EN TRANSACCIÓN: un pulpeo sin detalle
// cuando el bloque mezcla lotes es una medición que no se puede atribuir, y
// un detalle huérfano no significa nada.
//
// El controller valida que cada línea del detalle corresponda a un proceso
// que realmente está en el bloque: medir fruta que no está en el montón
// contaminaría la evidencia.
//
// numero_pulpeo es opcional: si no viene, se calcula el siguiente de la
// secuencia del bloque.
//
// id_usuario sale del token, nunca del body: es quien firma la medición.
router.post(
    "/",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarPulpeo,
    pulpeosController.createPulpeo
);

// ---- Editar ----
// Solo número y observaciones. Las temperaturas son evidencia.
router.put(
    "/:id",
    verifyToken,
    verifySupervisor,
    cargarAlcance,
    validarIdPulpeo,
    validarEdicionPulpeo,
    pulpeosController.updatePulpeo
);

// ---- Cancelar (baja lógica) ----
// Para una lectura errónea. La fila se conserva: borrarla dejaría un hueco
// inexplicable en la secuencia de mediciones del bloque.
router.delete("/:id", verifyToken, verifyCoordinador, cargarAlcance, validarIdPulpeo, pulpeosController.cancelarPulpeo);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, cargarAlcance, validarIdPulpeo, pulpeosController.reactivarPulpeo);

export default router;
