// ============================================================================
// RUTAS · FINCAS
// ----------------------------------------------------------------------------
// Montaje en index.js:
//     app.use(`${API}/fincas`, fincasRouter);
//
// URL final: http://localhost:3000/api/preenfrio/fincas
//
// PERMISOS
//   · LECTURA   → cualquier usuario autenticado.
//   · ESCRITURA → roles 1 (Admin) y 2 (Coordinador). La zona de la finca
//                 define la LETRA del código de lote (A/B/C); editarla mal
//                 corrompe la trazabilidad de toda su fruta.
//
// FILTROS ÚTILES EN EL GET
//   ?id_productor=3   fincas de un productor (para selects encadenados)
//   ?zona=1           1=Chiapas · 2=Colima · 3=Tabasco
//   ?estado=1         solo activas
//   ?buscar=texto     código, nombre u organización
// ============================================================================

import { Router } from "express";
import { FincasController } from "../controllers/fincas.controller.js";

// ⚠️ Ajustar la ruta y los nombres exportados según tu middleware de auth
import { verificarToken, verificarRol } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verificarToken);

// ---------------------------------------------------------------- LECTURA
router.get("/", FincasController.listar);
router.get("/:id", FincasController.obtener);

// --------------------------------------------------------------- ESCRITURA
router.post("/", verificarRol([1, 2]), FincasController.crear);
router.put("/:id", verificarRol([1, 2]), FincasController.actualizar);

// Baja lógica (estado = 0). produccion.id_finca sigue apuntando aquí.
router.delete("/:id", verificarRol([1, 2]), FincasController.darDeBaja);

router.patch("/:id/reactivar", verificarRol([1, 2]), FincasController.reactivar);

export default router;
