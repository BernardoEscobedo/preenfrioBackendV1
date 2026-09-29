import { Router } from "express";
import { empleadosController } from "../controllers/empleados.controller.js";
import { validarEmpleado, validarIdEmpleado } from "../middlewares/empleados.middleware.js";
import { verifyToken, verifyCoordinador } from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// EMPLEADOS  ·  ver/crear/editar = coordinador+
// ============================================================================
// Sin cargarAlcance: el personal es de toda la empresa, no de una planta.
// El acceso lo limita el rol, no la ubicación.
//
// v3.0 · YA NO HAY BORRADO
//   La ruta DELETE /eliminarempleado/:id se retiró: borrar personal dejaba
//   registros históricos sin su responsable. La baja es lógica y vive en el
//   módulo de bajas (solo admin), con motivo obligatorio y registro en el
//   historial. Dar de baja a un empleado deshabilita también su cuenta.
//
//       PATCH /api/preenfrio/bajas/empleados/:id
//       PATCH /api/preenfrio/bajas/empleados/:id/reactivar
// ============================================================================

// Incluye a los dados de baja al final: es la pantalla del catálogo.
router.get("/empleados", verifyToken, verifyCoordinador, empleadosController.getEmpleados);

// Empleados ACTIVOS sin cuenta: alimenta el dropdown del alta de usuarios
router.get("/sinusuario", verifyToken, verifyCoordinador, empleadosController.getSinUsuario);

router.get("/empleado/:id", verifyToken, verifyCoordinador, validarIdEmpleado, empleadosController.getEmpleadoById);

router.post("/registrarempleado", verifyToken, verifyCoordinador, validarEmpleado, empleadosController.createEmpleado);

router.put("/actualizarempleado/:id", verifyToken, verifyCoordinador, validarIdEmpleado, validarEmpleado, empleadosController.updateEmpleado);

export default router;
