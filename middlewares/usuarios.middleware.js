// ============================================================================
// VALIDACIONES DE USUARIOS
// ============================================================================
// El nombre de cuenta se normaliza a minúsculas y sin espacios: evita que
// "Bernardo" y "bernardo" convivan como cuentas distintas y que un espacio
// invisible al final impida iniciar sesión.
// ============================================================================

const ROLES_VALIDOS = [1, 2, 3, 4];

// Valida el alta (exige contraseña)
export const validarUsuarioNuevo = (req, res, next) => {
    const { usuario, password, id_empleado, id_role } = req.body;

    const errorBase = validarCamposBase(req.body);
    if (errorBase) {
        return res.status(400).json({ error: errorBase });
    }

    if (!password || typeof password !== "string") {
        return res.status(400).json({
            error: 'El campo "password" es obligatorio'
        });
    }
    if (password.length < 6) {
        return res.status(400).json({
            error: "La contraseña debe tener al menos 6 caracteres"
        });
    }

    normalizar(req.body);
    next();
};

// Valida la edición (la contraseña se cambia con su propio endpoint)
export const validarUsuarioEdicion = (req, res, next) => {
    const errorBase = validarCamposBase(req.body);
    if (errorBase) {
        return res.status(400).json({ error: errorBase });
    }
    normalizar(req.body);
    next();
};

// Campos comunes al alta y a la edición
function validarCamposBase({ usuario, id_empleado, id_role }) {
    if (!usuario || typeof usuario !== "string" || usuario.trim() === "") {
        return 'El campo "usuario" es obligatorio';
    }
    if (usuario.trim().length < 3) {
        return "El nombre de usuario debe tener al menos 3 caracteres";
    }
    if (usuario.length > 60) {
        return "El nombre de usuario no puede exceder 60 caracteres";
    }
    // Sin espacios ni caracteres raros: el usuario se teclea en un tablet
    // de planta, donde un espacio invisible es difícil de detectar.
    if (!/^[a-zA-Z0-9._-]+$/.test(usuario.trim())) {
        return "El usuario solo puede contener letras, números, punto, guion y guion bajo";
    }

    if (!id_empleado || isNaN(Number(id_empleado))) {
        return 'El campo "id_empleado" es obligatorio y debe ser numérico';
    }

    if (!id_role || isNaN(Number(id_role))) {
        return 'El campo "id_role" es obligatorio y debe ser numérico';
    }
    if (!ROLES_VALIDOS.includes(Number(id_role))) {
        return "El rol debe ser 1 (Admin), 2 (Coordinador), 3 (Supervisor) o 4 (Operativo)";
    }

    return null;
}

// Normaliza el nombre de cuenta para que no haya duplicados por mayúsculas
function normalizar(body) {
    body.usuario = String(body.usuario).trim().toLowerCase();
}

export const validarIdUsuario = (req, res, next) => {
    const { id } = req.params;
    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de usuario debe ser un número válido"
        });
    }
    next();
};
