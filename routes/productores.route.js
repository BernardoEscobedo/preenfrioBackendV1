import { Router } from "express";
import { productoresController } from "../controllers/productores.controller.js";
import productoresModel from "../models/productores.model.js";
import {
    validarProductor,
    validarIdProductor
} from "../middlewares/productores.middleware.js";
import { conservarCampos } from "../middlewares/conservar.middleware.js";
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
// Filtros opcionales: ?estado=1 · ?buscar=texto
//
// Ojo: el filtro es ?estado, no ?activo. Desde la v2.2 la columna se llama
// estado; un ?activo=1 se ignora en silencio y devuelve también los dados
// de baja.
router.get("/", verifyToken, verifyOperativo, productoresController.getProductores);

router.get("/:id", verifyToken, verifyOperativo, validarIdProductor, productoresController.getProductorById);

// ---- Alta y edición ----
// El controller valida que el código no esté duplicado antes de insertar
router.post("/", verifyToken, verifyCoordinador, validarProductor, productoresController.createProductor);

// conservarCampos va ANTES del validador: si el formulario no manda
// 'estado', se conserva el actual en vez de reactivar al productor.
// El alias { activo: "estado" } respeta a los clientes viejos que todavía
// mandan 'activo'.
router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    validarIdProductor,
    conservarCampos(productoresModel.getProductorById, ["estado"], { activo: "estado" }),
    validarProductor,
    productoresController.updateProductor
);

// ---- Baja ----
// Lógica (estado = 0), no física: fincas y produccion referencian esta tabla
router.delete("/:id", verifyToken, verifyCoordinador, validarIdProductor, productoresController.bajaProductor);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, validarIdProductor, productoresController.reactivarProductor);

export default router;
