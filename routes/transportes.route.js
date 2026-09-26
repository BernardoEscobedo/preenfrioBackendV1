import { Router } from "express";
import { transportesController } from "../controllers/transportes.controller.js";
import transportesModel from "../models/transportes.model.js";
import {
    validarTransporte,
    validarInocuidad,
    validarIdTransporte
} from "../middlewares/transportes.middleware.js";
import { conservarCampos } from "../middlewares/conservar.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifySupervisor,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// TRANSPORTES
// ver = operativo+ · inocuidad = supervisor+ · crear/editar/baja = coordinador+
// ============================================================================
// Sin cargarAlcance: una unidad recoge en cualquier planta.
//
// POR QUÉ LA INOCUIDAD TIENE SU PROPIO ENDPOINT Y SU PROPIO GUARD
//   Es una decisión que se toma en el andén, con la unidad enfrente, y la
//   toma el SUPERVISOR de turno — no coordinación. Obligarlo a usar el PUT
//   completo significaría reenviar placas, celular y datos del operador solo
//   para marcar un rechazo: una invitación a errores de captura.
//
//   Por eso: PATCH /:id/inocuidad, con verifySupervisor y un middleware que
//   solo valida ese campo.
//
// ALTA Y EDICIÓN en coordinador: los datos de la unidad son los que
// aparecen en el documento de despacho y en el reclamo si algo sale mal.
//
// FILTROS DEL LISTADO
//   ?estado=1       solo activos (para dropdowns de despacho)
//   ?inocuidad=0    unidades rechazadas (reporte de inspección)
//   ?buscar=texto   línea, operador, placas o número económico
// ============================================================================

// ---- Consultas ----
router.get("/", verifyToken, verifyOperativo, transportesController.getTransportes);

router.get("/:id", verifyToken, verifyOperativo, validarIdTransporte, transportesController.getTransporteById);

// ---- Alta y edición ----
// El duplicado se mide por tracto + caja, ignorando guiones y espacios:
// "15AN7H" y "15-AN-7H" son la misma placa.
router.post("/", verifyToken, verifyCoordinador, validarTransporte, transportesController.createTransporte);

// ⚠️ conservarCampos va ANTES del validador, y aquí es crítico.
// Como la inocuidad tiene su propio PATCH, lo normal es que el formulario
// de edición NO la mande. Sin esto, el validador le ponía 1 por defecto:
// editar el celular del operador APROBABA una unidad que el supervisor
// había rechazado, y el bloqueo del cierre de despacho dejaba de protegerla.
router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    validarIdTransporte,
    conservarCampos(transportesModel.getTransporteById, ["inocuidad", "estado"]),
    validarTransporte,
    transportesController.updateTransporte
);

// ---- Inspección sanitaria ----
// Supervisor+: es quien revisa la caja en el andén.
router.patch("/:id/inocuidad", verifyToken, verifySupervisor, validarIdTransporte, validarInocuidad, transportesController.setInocuidad);

// ---- Baja ----
// Lógica (estado = 0): despachos.id_transporte sigue apuntando aquí y ante
// un reclamo hay que poder decir quién se llevó la fruta.
router.delete("/:id", verifyToken, verifyCoordinador, validarIdTransporte, transportesController.bajaTransporte);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, validarIdTransporte, transportesController.reactivarTransporte);

export default router;
