// ============================================================================
// VALIDACIONES DE EMPLEADOS
// ============================================================================
// Las cuatro columnas son NOT NULL en la BD. Se validan aquí para devolver
// un mensaje claro en vez de dejar que Postgres responda con un error
// técnico que el usuario no entiende.
// ============================================================================

export const validarEmpleado = (req, res, next) => {
    const { nombre, apellidos, turno, zona } = req.body;

    if (!nombre || typeof nombre !== "string" || nombre.trim() === "") {
        return res.status(400).json({
            error: 'El campo "nombre" es obligatorio'
        });
    }
    if (nombre.length > 60) {
        return res.status(400).json({
            error: 'El campo "nombre" no puede exceder 60 caracteres'
        });
    }

    if (!apellidos || typeof apellidos !== "string" || apellidos.trim() === "") {
        return res.status(400).json({
            error: 'El campo "apellidos" es obligatorio'
        });
    }
    if (apellidos.length > 80) {
        return res.status(400).json({
            error: 'El campo "apellidos" no puede exceder 80 caracteres'
        });
    }

    if (!turno || typeof turno !== "string" || turno.trim() === "") {
        return res.status(400).json({
            error: 'El campo "turno" es obligatorio (ej. DIURNO, NOCTURNO, COMPLETO)'
        });
    }

    if (!zona || typeof zona !== "string" || zona.trim() === "") {
        return res.status(400).json({
            error: 'El campo "zona" es obligatorio (ej. TAPACHULA, CHIAPAS)'
        });
    }

    // Se normaliza aquí para no repetir .trim() en el modelo
    req.body.nombre = nombre.trim();
    req.body.apellidos = apellidos.trim();
    req.body.turno = turno.trim();
    req.body.zona = zona.trim();

    next();
};

export const validarIdEmpleado = (req, res, next) => {
    const { id } = req.params;
    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de empleado debe ser un número válido"
        });
    }
    next();
};
