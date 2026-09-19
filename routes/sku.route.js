// ============================================================================
// RUTAS · SKU DE PRODUCTO TERMINADO
// ----------------------------------------------------------------------------
// Montaje en index.js:
//     app.use(`${API}/sku`, skuRouter);
//
// URL final: http://localhost:3000/api/preenfrio/sku
//
// PERMISOS
//   · LECTURA   → cualquier usuario autenticado.
//   · ESCRITURA → roles 1 (Admin) y 2 (Coordinador). El turno del SKU es el
//                 último dígito del código de lote y la calidad se resuelve
//                 por JOIN desde produccion: no se toca desde piso.
//   · DELETE    → solo rol 1 (Admin). Es borrado FÍSICO, no lógico, porque
//                 sku_pt no tiene columna de estado.
//
// CAMPO CALCULADO
//   Cada SKU devuelve "cajas_por_tarima": 42 para la familia CPL0813, 48
//   para el resto. Se calcula en el modelo para que el dashboard, el front
//   y la importación del Excel usen exactamente el mismo criterio.
// ============================================================================

import { Router } from "express";
import { SkuController } from "../controllers/sku.controller.js";

// ⚠️ Ajustar la ruta y los nombres exportados según tu middleware de auth
import { verificarToken, verificarRol } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(verificarToken);

// ---------------------------------------------------------------- LECTURA
router.get("/", SkuController.listar);
router.get("/:id", SkuController.obtener);

// --------------------------------------------------------------- ESCRITURA
router.post("/", verificarRol([1, 2]), SkuController.crear);
router.put("/:id", verificarRol([1, 2]), SkuController.actualizar);

// Borrado FÍSICO. El controlador lo bloquea si hay producciones ligadas.
router.delete("/:id", verificarRol([1]), SkuController.eliminar);

export default router;
