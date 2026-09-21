import { Router } from "express";
import { ProductoresController } from "../controllers/productores.controller.js";
import {
    verifyToken,
    verifyCoordinador
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// PRODUCTORES  ·  ver = operativo+  ·  crear/editar/baja = coordinador+
// ----------------------------------------------------------------------------
// Las rutas se declaran con "/" porque el prefijo lo pone index.js:
//     app.use(`${API}/productores`, productoresRouter);
// URL final: /api/preenfrio/productores
//
// POR QUÉ LA ESCRITURA ES COORDINADOR+
//   El código de lote de 15 dígitos toma los ÚLTIMOS 2 DÍGITOS del
//   codigo_productor (ver fn_generar_lote). Editarlo cambia el lote de toda
//   la fruta de ese productor: no es una tarea de piso.
//
// NO SE FILTRA POR CÁMARA
//   Un productor no pertenece a un preenfrío, así que este módulo no usa
//   cargarAlcance. El recorte por cámara aplica de produccion/recepciones
//   en adelante.
// ============================================================================

// Sesión válida para todo el módulo
router.use(verifyToken);

// ---------------------------------------------------------------- LECTURA
// Sin verificador de rol extra: el preenfrío necesita el catálogo completo
// para capturar recepciones y producción.
router.get("/", ProductoresController.listar);
router.get("/:id", ProductoresController.obtener);

// --------------------------------------------------------------- ESCRITURA
router.post("/", verifyCoordinador, ProductoresController.crear);
router.put("/:id", verifyCoordinador, ProductoresController.actualizar);

// Baja LÓGICA (activo = 0). Nunca DELETE físico: fincas.id_productor y
// produccion.id_productor apuntan aquí y se perdería la trazabilidad.
router.delete("/:id", verifyCoordinador, ProductoresController.darDeBaja);

router.patch("/:id/reactivar", verifyCoordinador, ProductoresController.reactivar);

export default router;
