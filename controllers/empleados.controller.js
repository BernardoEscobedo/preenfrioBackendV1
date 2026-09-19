import empleadosModel from "../models/empleados.model.js";

// ============================================================================
// EMPLEADOS
// ============================================================================
// Catálogo sin alcance por cámara: el personal es de toda la empresa, no de
// una planta. El acceso lo limita el rol (coordinador+), no la ubicación.
// ============================================================================

// GET /api/preenfrio/empleados/empleados
const getEmpleados = async (req, res) => {
    try {
        const empleados = await empleadosModel.getEmpleados();
        res.status(200).json(empleados);
    } catch (error) {
        console.error("Error al obtener empleados:", error);
        res.status(500).json({ error: "Error al obtener los empleados" });
    }
};

// GET /api/preenfrio/empleados/empleado/:id
const getEmpleadoById = async (req, res) => {
    try {
        const { id } = req.params;
        const empleado = await empleadosModel.getEmpleadoById(id);
        if (!empleado) {
            return res.status(404).json({ error: "Empleado no encontrado" });
        }
        res.status(200).json(empleado);
    } catch (error) {
        console.error("Error al obtener empleado:", error);
        res.status(500).json({ error: "Error al obtener el empleado" });
    }
};

// GET /api/preenfrio/empleados/sinusuario
// Alimenta el dropdown del alta de usuarios: solo empleados sin cuenta.
const getSinUsuario = async (req, res) => {
    try {
        const empleados = await empleadosModel.getSinUsuario();
        res.status(200).json(empleados);
    } catch (error) {
        console.error("Error al obtener empleados sin usuario:", error);
        res.status(500).json({ error: "Error al obtener los empleados" });
    }
};

// POST /api/preenfrio/empleados/registrarempleado
const createEmpleado = async (req, res) => {
    try {
        const nuevo = await empleadosModel.createEmpleado(req.body);
        res.status(201).json(nuevo);
    } catch (error) {
        console.error("Error al crear empleado:", error);
        res.status(500).json({
            error: "Error al crear el empleado" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/empleados/actualizarempleado/:id
const updateEmpleado = async (req, res) => {
    try {
        const { id } = req.params;
        const actualizado = await empleadosModel.updateEmpleado(id, req.body);
        if (!actualizado) {
            return res.status(404).json({ error: "Empleado no encontrado" });
        }
        res.status(200).json(actualizado);
    } catch (error) {
        console.error("Error al actualizar empleado:", error);
        res.status(500).json({ error: "Error al actualizar el empleado" });
    }
};

// DELETE /api/preenfrio/empleados/eliminarempleado/:id
const deleteEmpleado = async (req, res) => {
    try {
        const { id } = req.params;
        const eliminado = await empleadosModel.deleteEmpleado(id);
        if (!eliminado) {
            return res.status(404).json({ error: "Empleado no encontrado" });
        }
        res.status(200).json({
            mensaje: "Empleado eliminado correctamente",
            empleado: eliminado
        });
    } catch (error) {
        console.error("Error al eliminar empleado:", error);
        // Un empleado con cuenta no se puede borrar: se explica el motivo
        // en vez de devolver un 500 mudo.
        if (error.code === "23503") {
            return res.status(409).json({
                error: "No se puede eliminar: el empleado tiene una cuenta de usuario. Elimina primero el usuario."
            });
        }
        res.status(500).json({ error: "Error al eliminar el empleado" });
    }
};

export const empleadosController = {
    getEmpleados,
    getEmpleadoById,
    getSinUsuario,
    createEmpleado,
    updateEmpleado,
    deleteEmpleado
};
