import { Router } from "express";
import { produccionController } from "../controllers/produccion.controller.js";
import produccionModel from "../models/produccion.model.js";
import {
    validarProduccion,
    validarReasignacion,
    validarIdProduccion
} from "../middlewares/produccion.middleware.js";
import { conservarCampos } from "../middlewares/conservar.middleware.js";
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
// PRIMER MÓDULO CON cargarAlcance: id_camara define dónde se va a enfriar
// esa fruta.
//
// EL ALCANCE VA EN DOS CAPAS, Y LAS DOS HACEN FALTA
//   cargarAlcance                  → arma req.camaras; el modelo filtra la
//                                    LECTURA en el SQL
//   validarCamaraEnAlcance("body") → revisa el id_camara del body antes de
//                                    escribir
//
//   Cuando id_camara llega NULL (CEDA directo), validarCamaraEnAlcance deja
//   pasar: no hay cámara que validar.
//
// REASIGNAR CÁMARA ES SUPERVISOR: es la decisión de piso más frecuente
// cuando un preenfrío se satura. Crear y editar se queda en coordinador:
// ahí se define el código de lote, el cliente y las cantidades.
//
// FILTROS DEL LISTADO
//   ?semana=38   ?estado=1   ?id_camara=1   ?id_finca=3   ?id_cc=5
//   ?fecha_desde=2026-09-14&fecha_hasta=2026-09-20
//   ?buscar=texto   código de lote, finca, cliente o acrónimo
// ============================================================================

// Campos opcionales: en el PUT, si el formulario no los manda, se conservan
// los actuales. Sin esto, id_camara pasaba a NULL (CEDA directo) y
// fecha_entrega se perdía.
const CAMPOS_OPCIONALES = [
    "region",
    "transito",
    "fecha_entrega",
    "comentarios",
    "id_camara",
    "cajas_procesadas",
    "estiba_pallets"
];

// ---- Consultas ----
// El resumen va ANTES de "/:id" para que "resumen" no se tome como id.
router.get("/resumen", verifyToken, verifyOperativo, cargarAlcance, produccionController.getResumenSemana);

router.get("/", verifyToken, verifyOperativo, cargarAlcance, produccionController.getProduccion);

router.get("/:id", verifyToken, verifyOperativo, cargarAlcance, validarIdProduccion, produccionController.getProduccionById);

// ---- Alta y edición ----
// El controller valida además que el productor sea el dueño de la finca.
router.post(
    "/",
    verifyToken,
    verifyCoordinador,
    cargarAlcance,
    validarProduccion,
    validarCamaraEnAlcance("body"),
    produccionController.createProduccion
);

// conservarCampos va ANTES del validador y de validarCamaraEnAlcance: así
// ambos trabajan sobre los valores finales que se van a guardar.
router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    cargarAlcance,
    validarIdProduccion,
    conservarCampos(produccionModel.getProduccionById, CAMPOS_OPCIONALES),
    validarProduccion,
    validarCamaraEnAlcance("body"),
    produccionController.updateProduccion
);

// ---- Reasignación de cámara ----
// El controller la bloquea si la producción ya recibió fruta.
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
// estado = 0. No borra la fila.
router.delete("/:id", verifyToken, verifyCoordinador, cargarAlcance, validarIdProduccion, produccionController.cancelarProduccion);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, cargarAlcance, validarIdProduccion, produccionController.reactivarProduccion);

export default router;
