import { Router } from "express";
import { skuController } from "../controllers/sku.controller.js";
import { validarSku, validarIdSku } from "../middlewares/sku.middleware.js";
import {
    verifyToken,
    verifyAdmin,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// SKU DE PRODUCTO TERMINADO
// ver = operativo+ · crear/editar = coordinador+ · eliminar = admin
// ============================================================================
// ELIMINAR sube a admin porque es el único catálogo del bloque cuya baja es
// FÍSICA: sku_pt no tiene columna de estado. El controller ya bloquea el
// borrado si hay producciones ligadas, pero el guard añade una segunda
// barrera sobre una acción irreversible.
//
// CAMPO CALCULADO EN LA RESPUESTA
//   Cada SKU trae "cajas_por_tarima": 42 en la familia CPL0813, 48 en el
//   resto. Se calcula en el modelo para que el dashboard, el frontend y la
//   importación del Excel usen el mismo criterio sin replicar la regla.
//
//   También trae "total_producciones": la pantalla lo usa para deshabilitar
//   el botón de borrar antes de que el usuario lo intente.
// ============================================================================

// ---- Consultas ----
// Filtros: ?turno=1 · ?calidad=PRIMERA · ?buscar=texto
router.get("/", verifyToken, verifyOperativo, skuController.getSkus);

router.get("/:id", verifyToken, verifyOperativo, validarIdSku, skuController.getSkuById);

// ---- Alta y edición ----
// El duplicado se mide por código + calidad: el mismo empaque en PRIMERA y
// en SEGUNDA son dos SKU válidos con turnos distintos.
router.post("/", verifyToken, verifyCoordinador, validarSku, skuController.createSku);

router.put("/:id", verifyToken, verifyCoordinador, validarIdSku, validarSku, skuController.updateSku);

// ---- Baja ----
// FÍSICA. El controller verifica dependencias antes de ejecutarla.
router.delete("/:id", verifyToken, verifyAdmin, validarIdSku, skuController.deleteSku);

export default router;
