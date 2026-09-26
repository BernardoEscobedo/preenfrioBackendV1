import { Router } from "express";
import { cedisController } from "../controllers/cedis.controller.js";
import cedisModel from "../models/cedis.model.js";
import { validarCedis, validarIdCedis } from "../middlewares/cedis.middleware.js";
import { conservarCampos } from "../middlewares/conservar.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// CEDIS / CLIENTE  ·  ver = operativo+ · crear/editar/baja = coordinador+
// ============================================================================
// Rutas REST: el prefijo lo pone index.js (app.use(`${API}/cedis`)), así que
// aquí se declaran con "/".
//
// Sin cargarAlcance: un cliente es el DESTINO de la fruta, no el lugar donde
// se enfría. El recorte por cámara empieza en producción y recepciones.
//
// ESCRITURA en coordinador porque 'acronimo' es la llave que cruza con el
// Excel de planeación semanal. Cambiarlo rompe el enlace con las hojas que
// ya circulan, y un duplicado mandaría la fruta al CEDIS equivocado sin que
// el sistema lo note.
//
// FILTROS DEL LISTADO
//   ?estado=1       solo activos (para dropdowns)
//   ?buscar=texto   cliente, cedis o acrónimo
// ============================================================================

// ---- Consultas ----
router.get("/", verifyToken, verifyOperativo, cedisController.getCedis);

// Búsqueda por la llave de negocio. La usa la importación del Excel, que
// trae el acrónimo y no el id.
// Va ANTES de "/:id" porque si no, Express interpretaría "acronimo" como
// un id y el middleware lo rechazaría por no ser numérico.
router.get("/acronimo/:acronimo", verifyToken, verifyOperativo, cedisController.getByAcronimo);

router.get("/:id", verifyToken, verifyOperativo, validarIdCedis, cedisController.getCedisById);

// ---- Alta y edición ----
// El controller valida dos duplicados: el acrónimo (único en la BD) y la
// pareja cliente + cedis, que no lo es pero tampoco debe repetirse.
router.post("/", verifyToken, verifyCoordinador, validarCedis, cedisController.createCedis);

// conservarCampos va ANTES del validador: si el formulario no manda
// 'estado', se conserva el actual en vez de reactivar el destino.
router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    validarIdCedis,
    conservarCampos(cedisModel.getCedisById, ["estado"]),
    validarCedis,
    cedisController.updateCedis
);

// ---- Baja ----
// Lógica (estado = 0): produccion.id_cc y despachos.id_cc siguen apuntando aquí
router.delete("/:id", verifyToken, verifyCoordinador, validarIdCedis, cedisController.bajaCedis);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, validarIdCedis, cedisController.reactivarCedis);

export default router;
