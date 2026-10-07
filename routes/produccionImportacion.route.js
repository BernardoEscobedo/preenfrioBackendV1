import { Router } from "express";
import { produccionImportacionController as c } from "../controllers/produccionImportacion.controller.js";
import {
    validarCargaImportacion,
    validarAsignacionCamara,
    validarFiltrosSinCamara
} from "../middlewares/produccionImportacion.middleware.js";
import { verifyToken, verifyCoordinador } from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// PRODUCCIÓN · IMPORTACIÓN DESDE EXCEL Y ASIGNACIÓN DE PREENFRÍO
// Todo es coordinador+: aquí se carga el plan y se decide el preenfrío.
// ============================================================================
// Sin cargarAlcance: la producción importada todavía no tiene cámara, así
// que no pertenece a ninguna planta hasta que el coordinador la asigna.
//
//   GET   /catalogos       fincas, SKU y destinos para corregir filas
//   POST  /vista-previa    evalúa el Excel sin guardar
//   POST  /confirmar       guarda las filas ✅ y ⚠️ (sin cámara)
//   GET   /sin-camara      producción sin preenfrío (?semana ?fecha_empaque)
//   GET   /camaras         preenfríos operativos con su ocupación
//   PATCH /asignar-camara  { ids, id_camara }
// ============================================================================

router.get("/catalogos", verifyToken, verifyCoordinador, c.getCatalogos);

router.post("/vista-previa", verifyToken, verifyCoordinador, validarCargaImportacion, c.vistaPrevia);

router.post("/confirmar", verifyToken, verifyCoordinador, validarCargaImportacion, c.confirmar);

router.get("/sin-camara", verifyToken, verifyCoordinador, validarFiltrosSinCamara, c.getSinCamara);

router.get("/camaras", verifyToken, verifyCoordinador, c.getCamaras);

router.patch("/asignar-camara", verifyToken, verifyCoordinador, validarAsignacionCamara, c.asignarCamara);

export default router;
