import { Router } from "express";
import { bajasController } from "../controllers/bajas.controller.js";
import { validarMotivoBaja, validarIdBaja } from "../middlewares/bajas.middleware.js";
import { verifyToken, verifyAdmin } from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// BAJAS DE CÁMARAS Y EMPLEADOS · HISTORIAL      ·      SOLO ADMIN
// ============================================================================
// Reemplaza el borrado físico. Toda baja:
//   · es lógica (estado = 0): el histórico sigue resolviendo nombres
//   · exige motivo (mínimo 10 caracteres)
//   · queda en historial_estados con usuario, fecha y foto del registro
//
// La cuenta de usuario se deshabilita en su propio módulo
// (PATCH /usuarios/deshabilitar/:id), pero su historial también aparece
// aquí.
// ============================================================================

// ---- Consultas ----
// Historial de bajas y reactivaciones de cámaras, empleados y usuarios.
//   ?tabla=camaras   ?id_registro=3   ?accion=BAJA
//   ?fecha_desde=2026-09-01&fecha_hasta=2026-09-30
router.get("/historial", verifyToken, verifyAdmin, bajasController.getHistorial);

// Todo lo que está dado de baja ahora, con quién y por qué.
router.get("/inactivos", verifyToken, verifyAdmin, bajasController.getDadosDeBaja);

// ---- Cámaras ----
// Solo si está vacía, sin cola, sin mantenimiento en proceso y sin
// producción pendiente de llegar.
router.patch("/camaras/:id", verifyToken, verifyAdmin, validarIdBaja, validarMotivoBaja(), bajasController.bajaCamara);

router.patch("/camaras/:id/reactivar", verifyToken, verifyAdmin, validarIdBaja, validarMotivoBaja(false), bajasController.reactivarCamara);

// ---- Empleados ----
// La baja deshabilita su cuenta. La reactivación NO la habilita.
router.patch("/empleados/:id", verifyToken, verifyAdmin, validarIdBaja, validarMotivoBaja(), bajasController.bajaEmpleado);

router.patch("/empleados/:id/reactivar", verifyToken, verifyAdmin, validarIdBaja, validarMotivoBaja(false), bajasController.reactivarEmpleado);

export default router;
