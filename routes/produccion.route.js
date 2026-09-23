import { Router } from "express";
import { produccionController } from "../controllers/produccion.controller.js";
import {
    validarProduccion,
    validarReasignacion,
    validarIdProduccion
} from "../middlewares/produccion.middleware.js";
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
// PRODUCCIÓN
// ver = operativo+ · reasignar cámara = supervisor+ · crear/editar/cancelar = coordinador+
// ============================================================================
// PRIMER MÓDULO CON cargarAlcance
// ============================================================================
// Los catálogos de los bloques 3 y 4 no lo usaban porque un productor o un
// SKU no pertenecen a una planta. La producción sí: id_camara define dónde
// se va a enfriar esa fruta.
//
// EL ALCANCE VA EN DOS CAPAS, Y LAS DOS HACEN FALTA
//
//   cargarAlcance                  → arma req.camaras. El modelo lo usa
//                                    para filtrar la LECTURA en el SQL.
//
//   validarCamaraEnAlcance("body") → revisa el id_camara que llega en el
//                                    CUERPO de la petición, antes de
//                                    escribir.
//
//   Sin la segunda, un operativo de Doña Nelly podría planear fruta en
//   Fortaleza mandando ese id a mano desde Postman: el filtro de lectura
//   esconde los datos, pero no impide escribirlos. Es la primera vez en
//   todo el proyecto que esa función se vuelve necesaria.
//
//   Cuando id_camara llega NULL (CEDA directo), validarCamaraEnAlcance deja
//   pasar: no hay cámara que validar.
//
// POR QUÉ REASIGNAR CÁMARA ES SUPERVISOR Y NO COORDINADOR
//   Es la decisión de piso más frecuente: el preenfrío se saturó y hay que
//   mandar la fruta a la otra cámara AHORA, no esperar a que coordinación
//   conteste. El supervisor ve el patio; solo puede mover entre las cámaras
//   de su alcance, así que el riesgo está acotado.
//
//   Crear y editar líneas del plan sí se queda en coordinador: ahí se
//   define el código de lote, el cliente y las cantidades comprometidas.
//
// FILTROS DEL LISTADO
//   ?semana=38            semana operativa
//   ?estado=1             1 planeada · 2 en recepción · 3 recibida · 0 cancelada
//   ?id_camara=1          una cámara concreta (dentro del alcance)
//   ?id_finca=3           &id_cc=5
//   ?fecha_desde=2026-09-14&fecha_hasta=2026-09-20
//   ?buscar=texto         código de lote, finca, cliente o acrónimo
// ============================================================================

// ---- Consultas ----
// El resumen va ANTES de "/:id": si no, Express interpretaría "resumen"
// como un id y validarIdProduccion lo rechazaría por no ser numérico.
router.get("/resumen", verifyToken, verifyOperativo, cargarAlcance, produccionController.getResumenSemana);

router.get("/", verifyToken, verifyOperativo, cargarAlcance, produccionController.getProduccion);

router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdProduccion, produccionController.getProduccionById);

// ---- Alta y edición ----
// Cadena completa: sesión → rol → alcance del usuario → formato del body →
// alcance de la cámara que viene en el body → controller.
//
// El controller valida además que el productor sea el dueño de la finca:
// si no cuadran, el código de lote mezclaría el código de un productor con
// la finca de otro.
router.post(
    "/",
    verifyToken,
    verifyCoordinador,
    cargarAlcance,
    validarProduccion,
    validarCamaraEnAlcance("body"),
    produccionController.createProduccion
);

router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    cargarAlcance,
    validarIdProduccion,
    validarProduccion,
    validarCamaraEnAlcance("body"),
    produccionController.updateProduccion
);

// ---- Reasignación de cámara ----
// Supervisor+: decisión de piso cuando un preenfrío se satura.
// El controller la bloquea si la producción ya recibió fruta: moverla en el
// plan no reubica nada físicamente, y el resultado sería un plan que miente
// sobre dónde está el producto.
router.patch(
    "/:id/camara",
    verifyToken,
    verifySupervisor,
    cargarAlcance,
    validarIdProduccion,
    validarReasignacion,
    validarCamaraEnAlcance("body"),
    produccionController.reasignarCamara
);

// ---- Cancelación ----
// estado = 0. No borra la fila: si ya hubo recepciones, sus ocupaciones y
// movimientos siguen apuntando aquí.
router.delete("/:id", verifyToken, verifyCoordinador, cargarAlcance, validarIdProduccion, produccionController.cancelarProduccion);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, cargarAlcance, validarIdProduccion, produccionController.reactivarProduccion);

export default router;
