import { Router } from "express";
import { productoresController } from "../controllers/productores.controller.js";
import {
    validarProductor,
    validarIdProductor
} from "../middlewares/productores.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// PRODUCTORES  ·  ver = operativo+ · crear/editar/baja = coordinador+
// ============================================================================
// Rutas REST: el prefijo lo pone index.js (app.use(`${API}/productores`)),
// así que aquí se declaran con "/" y no con "/productores". Repetirlo
// generaría URLs duplicadas del tipo /api/preenfrio/productores/productores.
//
// Sin cargarAlcance: un productor no pertenece a un preenfrío. El recorte
// por cámara empieza en producción y recepciones.
//
// VER queda en operativo porque este catálogo alimenta los dropdowns de
// producción: sin él, no se podría capturar de qué productor viene la fruta.
//
// ESCRITURA sube a coordinador: codigo_productor aporta 2 de los 15 dígitos
// del código de lote. Editarlo cambia el lote de toda la fruta de ese
// productor, no es decisión de piso.
// ============================================================================

// ---- Consultas ----
// Filtros opcionales: ?activo=1 · ?buscar=texto
router.get("/", verifyToken, verifyOperativo, productoresController.getProductores);

router.get("/:id", verifyToken, verifyOperativo, validarIdProductor, productoresController.getProductorById);

// ---- Alta y edición ----
// El controller valida que el código no esté duplicado antes de insertar
router.post("/", verifyToken, verifyCoordinador, validarProductor, productoresController.createProductor);

router.put("/:id", verifyToken, verifyCoordinador, validarIdProductor, validarProductor, productoresController.updateProductor);

// ---- Baja ----
// Lógica (activo = 0), no física: fincas y produccion referencian esta tabla
router.delete("/:id", verifyToken, verifyCoordinador, validarIdProductor, productoresController.bajaProductor);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, validarIdProductor, productoresController.reactivarProductor);

export default router;
