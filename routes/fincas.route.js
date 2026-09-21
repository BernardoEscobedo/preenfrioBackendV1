import { Router } from "express";
import { FincasController } from "../controllers/fincas.controller.js";
import {
    verifyToken,
    verifyCoordinador
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// FINCAS  ·  ver = operativo+  ·  crear/editar/baja = coordinador+
// ----------------------------------------------------------------------------
// Montaje en index.js:
//     app.use(`${API}/fincas`, fincasRouter);
// URL final: /api/preenfrio/fincas
//
// POR QUÉ LA ESCRITURA ES COORDINADOR+
//   fincas.zona define la LETRA INICIAL del código de lote:
//       1 → A (Chiapas) · 2 → B (Colima) · 3 → C (Tabasco) · otra → X
//   Y codigo_finca aporta 3 de los 15 dígitos. Un error aquí corrompe la
//   trazabilidad de toda la fruta de esa finca.
//
// FILTROS DISPONIBLES EN EL GET
//   ?id_productor=3   fincas de un productor (selects encadenados)
//   ?zona=1           1=Chiapas · 2=Colima · 3=Tabasco
//   ?estado=1         solo activas
//   ?buscar=texto     código, nombre u organización
// ============================================================================

router.use(verifyToken);

// ---------------------------------------------------------------- LECTURA
router.get("/", FincasController.listar);
router.get("/:id", FincasController.obtener);

// --------------------------------------------------------------- ESCRITURA
router.post("/", verifyCoordinador, FincasController.crear);
router.put("/:id", verifyCoordinador, FincasController.actualizar);

// Baja LÓGICA (estado = 0). produccion.id_finca sigue apuntando aquí.
router.delete("/:id", verifyCoordinador, FincasController.darDeBaja);

router.patch("/:id/reactivar", verifyCoordinador, FincasController.reactivar);

export default router;
