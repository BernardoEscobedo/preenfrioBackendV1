// ============================================================================
// RUTAS · PRODUCTORES
// ----------------------------------------------------------------------------
// Montaje en index.js:
//     app.use(`${API}/productores`, productoresRouter);
//
// URL final: http://localhost:3000/api/preenfrio/productores
//
// IMPORTANTE: las rutas se declaran con "/" y no con "/productores". El
// prefijo lo pone el app.use; repetirlo aquí genera URLs duplicadas del
// tipo /api/preenfrio/camaras/camaras.
//
// PERMISOS (jerarquía inclusiva: 1 Admin ⊂ 2 Coordinador ⊂ 3 Supervisor ⊂ 4 Operativo)
//   · LECTURA   → cualquier usuario autenticado. El preenfrío necesita ver
//                 el catálogo para capturar recepciones.
//   · ESCRITURA → roles 1 y 2. Un código de productor mal editado cambia el
//                 código de lote de toda su fruta; no es tarea de piso.
// ============================================================================

import { Router } from "express";
import { ProductoresController } from "../controllers/productores.controller.js";

// ⚠️ Ajustar la ruta y los nombres exportados según tu middleware de auth
import { verificarToken, verificarRol } from "../middlewares/auth.middleware.js";

const router = Router();

// Todas las rutas del módulo exigen sesión válida
router.use(verificarToken);

// ---------------------------------------------------------------- LECTURA
router.get("/", ProductoresController.listar);
router.get("/:id", ProductoresController.obtener);

// --------------------------------------------------------------- ESCRITURA
router.post("/", verificarRol([1, 2]), ProductoresController.crear);
router.put("/:id", verificarRol([1, 2]), ProductoresController.actualizar);

// Baja lógica (activo = 0). No borra la fila.
router.delete("/:id", verificarRol([1, 2]), ProductoresController.darDeBaja);

router.patch("/:id/reactivar", verificarRol([1, 2]), ProductoresController.reactivar);

export default router;
