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
// ver = operativo+ · crear/editar/baja = coordinador+ · eliminar = admin
// ============================================================================
// v2.2 · SE SEPARAN LAS DOS BAJAS
//   DELETE /:id           baja LÓGICA (estado = 0)  → coordinador+
//   DELETE /:id/eliminar  borrado FÍSICO            → admin
//
//   Antes solo existía el borrado físico y quedaba bloqueado en cuanto
//   alguna producción usara el SKU, que en la práctica es siempre. Ahora
//   descontinuar un empaque es una operación normal de coordinación, y el
//   borrado real queda para corregir altas mal capturadas que nunca se
//   usaron. Dos rutas distintas para que una acción irreversible no
//   comparta botón con una reversible.
//
// CAMPOS CALCULADOS EN LA RESPUESTA
//   "cajas_por_tarima": 42 en la familia CPL0813, 48 en el resto. Se calcula
//   en el modelo para que el dashboard, el frontend y la importación del
//   Excel usen el mismo criterio sin replicar la regla.
//
//   "total_producciones": la pantalla lo usa para saber si un SKU admite
//   borrado físico o solo baja lógica.
//
// FILTROS DEL LISTADO
//   ?estado=1         solo activos (para dropdowns)
//   ?turno=1          1 o 2
//   ?calidad=PRIMERA  coincidencia parcial
//   ?buscar=texto     código o calidad
// ============================================================================

// ---- Consultas ----
router.get("/", verifyToken, verifyOperativo, skuController.getSkus);

router.get("/:id", verifyToken, verifyOperativo, validarIdSku, skuController.getSkuById);

// ---- Alta y edición ----
// El duplicado se mide por código + calidad: el mismo empaque en PRIMERA y
// en SEGUNDA son dos SKU válidos con turnos distintos.
router.post("/", verifyToken, verifyCoordinador, validarSku, skuController.createSku);

router.put("/:id", verifyToken, verifyCoordinador, validarIdSku, validarSku, skuController.updateSku);

// ---- Baja lógica (vía normal) ----
router.delete("/:id", verifyToken, verifyCoordinador, validarIdSku, skuController.bajaSku);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, validarIdSku, skuController.reactivarSku);

// ---- Borrado físico (excepcional) ----
// Solo admin. El controller lo rechaza si hay producciones ligadas.
router.delete("/:id/eliminar", verifyToken, verifyAdmin, validarIdSku, skuController.deleteSku);

export default router;
