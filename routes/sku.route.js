import { Router } from "express";
import { SkuController } from "../controllers/sku.controller.js";
import {
    verifyToken,
    verifyAdmin,
    verifyCoordinador
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// SKU DE PRODUCTO TERMINADO  ·  ver = operativo+  ·  crear/editar = coordinador+
//                            ·  eliminar = admin
// ----------------------------------------------------------------------------
// Montaje en index.js:
//     app.use(`${API}/sku`, skuRouter);
// URL final: /api/preenfrio/sku
//
// POR QUÉ EL DELETE ES SOLO ADMIN
//   sku_pt NO tiene columna de estado, así que la única baja posible es el
//   DELETE físico. El controlador lo bloquea con 409 si alguna producción lo
//   referencia, pero aun así se reserva al rol 1: produccion resuelve la
//   calidad por JOIN contra esta tabla.
//
// CAMPO CALCULADO EN LA RESPUESTA
//   Cada SKU devuelve "cajas_por_tarima": 42 para la familia CPL0813, 48
//   para el resto. Se calcula en el modelo para que el dashboard, el front
//   y la importación del Excel usen el mismo criterio sin replicar el if.
//
// TURNO
//   Es el ÚLTIMO dígito del código de lote y propiedad FIJA del SKU (depende
//   de la calidad, no del día de trabajo). Solo admite 1 o 2.
// ============================================================================

router.use(verifyToken);

// ---------------------------------------------------------------- LECTURA
router.get("/", SkuController.listar);
router.get("/:id", SkuController.obtener);

// --------------------------------------------------------------- ESCRITURA
router.post("/", verifyCoordinador, SkuController.crear);
router.put("/:id", verifyCoordinador, SkuController.actualizar);

// Borrado FÍSICO. El controlador valida dependencias antes de ejecutarlo.
router.delete("/:id", verifyAdmin, SkuController.eliminar);

export default router;
