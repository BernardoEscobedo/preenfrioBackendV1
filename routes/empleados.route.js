import { Router } from "express";
import { empleadosController } from "../controllers/empleados.controller.js";
import { validarEmpleado, validarIdEmpleado } from "../middlewares/empleados.middleware.js";
import { verifyToken, verifyAdmin, verifyCoordinador } from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// EMPLEADOS  ·  ver/crear/editar = coordinador+ · eliminar = admin
// ============================================================================
// Sin cargarAlcance: el personal es de toda la empresa, no de una planta.
// El acceso lo limita el rol, no la ubicación.

router.get("/empleados", verifyToken, verifyCoordinador, empleadosController.getEmpleados);

// Empleados sin cuenta: alimenta el dropdown del alta de usuarios
router.get("/sinusuario", verifyToken, verifyCoordinador, empleadosController.getSinUsuario);

router.get("/empleado/:id", verifyToken, verifyCoordinador, validarIdEmpleado, empleadosController.getEmpleadoById);

router.post("/registrarempleado", verifyToken, verifyCoordinador, validarEmpleado, empleadosController.createEmpleado);

router.put("/actualizarempleado/:id", verifyToken, verifyCoordinador, validarIdEmpleado, validarEmpleado, empleadosController.updateEmpleado);

// Eliminar queda en admin: borrar personal es irreversible y puede dejar
// registros históricos sin su responsable.
router.delete("/eliminarempleado/:id", verifyToken, verifyAdmin, validarIdEmpleado, empleadosController.deleteEmpleado);

export default router;
