import { Router } from "express";
import { tarimasController as c } from "../controllers/tarimas.controller.js";
import {
    validarArmado,
    validarAgregarTarimas,
    validarSesionPulpeo,
    validarConfirmarPulpeo,
    validarIdNumerico
} from "../middlewares/tarimas.middleware.js";
import { cargarAlcance } from "../middlewares/alcance.middleware.js";
import { verifyToken, verifySupervisor, verifyOperativo } from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// BLOQUES POR TARIMA Y PULPEOS
// ver/armar/pulpear = operativo+ · retirar tarima = supervisor+
// ============================================================================
//   GET   /?id_camara=1                    bloques con sus tarimas y semáforo
//   GET   /lotes?id_camara=1               lotes dentro de la cámara (armar)
//   POST  /bloques                         armar bloque (10 o 12 posiciones)
//   POST  /bloques/:id/tarimas             completar posiciones libres
//   GET   /:id/pulpeos                     historial de la tarima
//   PATCH /:id/retirar                     la tarima salió del bloque
//   POST  /:id/pulpeo/sesion               pulpeo · paso 1 (foto obligatoria)
//   POST  /pulpeo/confirmar                pulpeo · paso 3
//
// El traslado del bloque a conservación está en Movimientos:
//   POST /movimientos/bloque
// Las fotos se ven con: GET /evidencias/pulpeos/archivo/:id_evidencia/url
// Cancelar un pulpeo sigue en DELETE /pulpeos/:id (coordinador).
// ============================================================================

router.get("/", verifyToken, verifyOperativo, cargarAlcance, c.getBloques);
router.get("/lotes", verifyToken, verifyOperativo, cargarAlcance, c.getLotes);

router.post("/bloques", verifyToken, verifyOperativo, cargarAlcance, validarArmado, c.armarBloque);
router.post("/bloques/:id/tarimas", verifyToken, verifyOperativo, cargarAlcance, validarIdNumerico, validarAgregarTarimas, c.agregarTarimas);

// Prefijo fijo antes de "/:id"
router.post("/pulpeo/confirmar", verifyToken, verifyOperativo, cargarAlcance, validarConfirmarPulpeo, c.confirmarPulpeo);

router.get("/:id/pulpeos", verifyToken, verifyOperativo, cargarAlcance, validarIdNumerico, c.getHistorial);
router.patch("/:id/retirar", verifyToken, verifySupervisor, cargarAlcance, validarIdNumerico, c.retirarTarima);
router.post("/:id/pulpeo/sesion", verifyToken, verifyOperativo, cargarAlcance, validarIdNumerico, validarSesionPulpeo, c.crearSesionPulpeo);

export default router;
