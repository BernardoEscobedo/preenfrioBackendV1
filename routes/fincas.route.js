import { Router } from "express";
import { fincasController } from "../controllers/fincas.controller.js";
import { validarFinca, validarIdFinca } from "../middlewares/fincas.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// FINCAS  ·  ver = operativo+ · crear/editar/baja = coordinador+
// ============================================================================
// Sin cargarAlcance: la finca es el ORIGEN de la fruta, no su destino.
//
// ESCRITURA en coordinador porque fincas.zona define la LETRA INICIAL del
// código de lote (1→A Chiapas · 2→B Colima · 3→C Tabasco) y codigo_finca
// aporta otros 3 dígitos. Un error aquí no avisa: los lotes salen mal y se
// descubre semanas después, con fruta ya despachada.
//
// FILTROS DEL LISTADO
//   ?id_productor=3   fincas de un productor (selects encadenados)
//   ?zona=1           1=Chiapas · 2=Colima · 3=Tabasco
//   ?estado=1         solo activas
//   ?buscar=texto     código, nombre u organización
// ============================================================================

// ---- Consultas ----
router.get("/", verifyToken, verifyOperativo, fincasController.getFincas);

router.get("/:id", verifyToken, verifyOperativo, validarIdFinca, fincasController.getFincaById);

// ---- Alta y edición ----
// El controller verifica que el productor exista, esté activo y que el
// código no se repita dentro de ese mismo productor
router.post("/", verifyToken, verifyCoordinador, validarFinca, fincasController.createFinca);

router.put("/:id", verifyToken, verifyCoordinador, validarIdFinca, validarFinca, fincasController.updateFinca);

// ---- Baja ----
// Lógica (estado = 0): produccion.id_finca sigue apuntando aquí
router.delete("/:id", verifyToken, verifyCoordinador, validarIdFinca, fincasController.bajaFinca);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, validarIdFinca, fincasController.reactivarFinca);

export default router;
