import { Router } from "express";
import { operadoresController } from "../controllers/operadores.controller.js";
import operadoresModel from "../models/operadores.model.js";
import {
    validarOperador,
    validarIdOperador
} from "../middlewares/operadores.middleware.js";
import { conservarCampos } from "../middlewares/conservar.middleware.js";
import {
    verifyToken,
    verifyCoordinador,
    verifyOperativo
} from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// OPERADORES
// ver = operativo+ · crear/editar/baja = coordinador+
// ============================================================================
// Sin cargarAlcance: un operador recoge en cualquier planta.
//
// FILTROS DEL LISTADO
//   ?estado=1             solo activos (para dropdowns)
//   ?id_linea_fletera=3   operadores de una línea
//   ?buscar=texto         nombre, celular o línea
// ============================================================================

// ---- Consultas ----
router.get("/", verifyToken, verifyOperativo, operadoresController.getOperadores);

router.get("/:id", verifyToken, verifyOperativo, validarIdOperador, operadoresController.getOperadorById);

// ---- Alta y edición ----
// El duplicado se mide por celular.
router.post("/", verifyToken, verifyCoordinador, validarOperador, operadoresController.createOperador);

// conservarCampos va ANTES del validador: si el formulario no manda
// 'estado', se conserva el actual en vez de reactivar al operador.
router.put(
    "/:id",
    verifyToken,
    verifyCoordinador,
    validarIdOperador,
    conservarCampos(operadoresModel.getOperadorById, ["estado"]),
    validarOperador,
    operadoresController.updateOperador
);

// ---- Baja ----
router.delete("/:id", verifyToken, verifyCoordinador, validarIdOperador, operadoresController.bajaOperador);

router.patch("/:id/reactivar", verifyToken, verifyCoordinador, validarIdOperador, operadoresController.reactivarOperador);

export default router;
