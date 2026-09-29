import { Router } from "express";
import { evidenciasController } from "../controllers/evidencias.controller.js";
import {
    validarSolicitudCarga,
    validarConfirmacion,
    validarOrigen,
    validarIdEvidencia
} from "../middlewares/evidencias.middleware.js";
import { cargarAlcance } from "../middlewares/alcance.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// EVIDENCIAS · FOTOS Y VIDEOS EN SHAREPOINT
// ver/subir = operativo+ · eliminar = coordinador+ (con reglas extra)
// ============================================================================
// :origen = despachos | pulpeos
//
// FLUJO DE CARGA (el archivo nunca pasa por este servidor)
//   1. POST /:origen/:id/sesion     → upload_url + token_carga
//   2. PUT directo a upload_url     → SharePoint devuelve el "id" del archivo
//   3. POST /confirmar              → { token_carga, item_id }
//
// SUBIR ES OPERATIVO: quien toma la foto del camión cargado o del
// termómetro es quien está en el andén.
//
// ELIMINAR tiene reglas extra en el controller:
//   · despacho en borrador → coordinador+
//   · despacho cerrado     → solo admin
//   · pulpeo               → solo admin
// ============================================================================

// Va antes de las rutas con :origen para que "confirmar" no se tome como origen
router.post(
    "/confirmar",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarConfirmacion,
    evidenciasController.confirmarCarga
);

// Enlace temporal para mostrar el archivo
router.get(
    "/:origen/archivo/:id_evidencia/url",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarOrigen,
    validarIdEvidencia,
    evidenciasController.obtenerUrl
);

router.delete(
    "/:origen/archivo/:id_evidencia",
    verifyToken,
    verifyCoordinador,
    cargarAlcance,
    validarOrigen,
    validarIdEvidencia,
    evidenciasController.eliminar
);

// Evidencias de un despacho o de un pulpeo
router.get(
    "/:origen/:id",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarOrigen,
    validarIdEvidencia,
    evidenciasController.listar
);

// Paso 1: pedir la sesión de carga
//   body: { tipo_archivo, nombre_original, mime_type, tamano_bytes,
//           descripcion, id_pulpeo_detalle? }
router.post(
    "/:origen/:id/sesion",
    verifyToken,
    verifyOperativo,
    cargarAlcance,
    validarOrigen,
    validarIdEvidencia,
    validarSolicitudCarga,
    evidenciasController.crearSesion
);

export default router;
