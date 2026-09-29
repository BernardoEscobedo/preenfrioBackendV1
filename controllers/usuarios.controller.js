import bcrypt from "bcrypt";
import usuariosModel from "../models/usuarios.model.js";

// ============================================================================
// USUARIOS
// ============================================================================
// Módulo reservado al administrador.
//
// DESHABILITAR ES LA VÍA NORMAL DE BAJA
//   Corta el acceso en la siguiente petición (verifyToken valida contra la
//   BD) y conserva la autoría de todo lo que la cuenta registró.
//
// v3.0 · HISTORIAL
//   Deshabilitar exige motivo; habilitar lo acepta opcional. Los dos
//   quedan en historial_estados (GET /bajas/historial) con quién y cuándo.
// ============================================================================

const SALT_ROUNDS = 10;

// ---------------------------------------------------------
// CONSULTAS
// ---------------------------------------------------------

const getUsuarios = async (req, res) => {
    try {
        const usuarios = await usuariosModel.getUsuarios();
        res.status(200).json(usuarios);
    } catch (error) {
        console.error("Error al obtener usuarios:", error);
        res.status(500).json({ error: "Error al obtener los usuarios" });
    }
};

const getUsuarioById = async (req, res) => {
    try {
        const usuario = await usuariosModel.getUsuarioById(req.params.id);

        if (!usuario) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        res.status(200).json(usuario);
    } catch (error) {
        console.error("Error al obtener usuario:", error);
        res.status(500).json({ error: "Error al obtener el usuario" });
    }
};

const getRoles = async (req, res) => {
    try {
        const roles = await usuariosModel.getRoles();
        res.status(200).json(roles);
    } catch (error) {
        console.error("Error al obtener roles:", error);
        res.status(500).json({ error: "Error al obtener los roles" });
    }
};

const getSinCamaras = async (req, res) => {
    try {
        const usuarios = await usuariosModel.getSinCamaras();
        res.status(200).json(usuarios);
    } catch (error) {
        console.error("Error al obtener usuarios sin cámaras:", error);
        res.status(500).json({ error: "Error al obtener los usuarios" });
    }
};

// ---------------------------------------------------------
// ALTA Y EDICIÓN
// ---------------------------------------------------------

const createUsuario = async (req, res) => {
    try {
        const { usuario, password, id_empleado, id_role } = req.body;

        if (await usuariosModel.existeUsuario(usuario)) {
            return res.status(409).json({
                error: `El usuario "${usuario}" ya existe`
            });
        }

        const empleado = await usuariosModel.getEstadoEmpleado(Number(id_empleado));

        if (!empleado) {
            return res.status(409).json({ error: "El empleado indicado no existe" });
        }

        // Una cuenta nueva para alguien dado de baja sería un acceso abierto
        // para quien ya no trabaja aquí.
        if (Number(empleado.estado) === 0) {
            return res.status(409).json({
                error: `${empleado.nombre} ${empleado.apellidos} está dado de baja. Reactívalo primero en el módulo de bajas.`
            });
        }

        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

        const nuevo = await usuariosModel.createUsuario({
            usuario,
            password_hash,
            id_empleado: Number(id_empleado),
            id_role: Number(id_role)
        });

        const completo = await usuariosModel.getUsuarioById(nuevo.id_usuario);

        const avisos = [];

        if ([3, 4].includes(Number(id_role))) {
            avisos.push("Asigna su zona de trabajo: sin cámaras asignadas no verá ningún dato.");
        }

        res.status(201).json({ usuario: completo, avisos });
    } catch (error) {
        console.error("Error al crear usuario:", error);

        if (error.code === "23505") {
            return res.status(409).json({ error: "Ese nombre de usuario ya existe" });
        }

        if (error.code === "23503") {
            return res.status(409).json({
                error: "El empleado o el rol indicados no existen"
            });
        }

        res.status(500).json({ error: "Error al crear el usuario" });
    }
};

const updateUsuario = async (req, res) => {
    try {
        const { id } = req.params;
        const { usuario, id_empleado, id_role } = req.body;

        const existente = await usuariosModel.getUsuarioById(id);

        if (!existente) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        if (await usuariosModel.existeUsuario(usuario, Number(id))) {
            return res.status(409).json({
                error: `El usuario "${usuario}" ya está en uso por otra cuenta`
            });
        }

        const dejaDeSerAdmin =
            Number(existente.id_role) === 1 && Number(id_role) !== 1;

        if (dejaDeSerAdmin && Number(existente.estado) === 1) {
            const otrosAdmins = await usuariosModel.contarAdminsActivos(Number(id));

            if (otrosAdmins === 0) {
                return res.status(409).json({
                    error: "No puedes quitarle el rol de administrador: es el único admin activo del sistema."
                });
            }
        }

        await usuariosModel.updateUsuario(id, {
            usuario,
            id_empleado: Number(id_empleado),
            id_role: Number(id_role)
        });

        const completo = await usuariosModel.getUsuarioById(id);
        const cambioRol = Number(existente.id_role) !== Number(id_role);

        res.status(200).json({
            ...completo,
            aviso: cambioRol
                ? "El nuevo rol aplica desde la siguiente acción del usuario, sin que tenga que volver a iniciar sesión."
                : null
        });
    } catch (error) {
        console.error("Error al actualizar usuario:", error);

        if (error.code === "23505") {
            return res.status(409).json({ error: "Ese nombre de usuario ya existe" });
        }

        if (error.code === "23503") {
            return res.status(409).json({
                error: "El empleado o el rol indicados no existen"
            });
        }

        res.status(500).json({ error: "Error al actualizar el usuario" });
    }
};

// PATCH /api/preenfrio/usuarios/deshabilitar/:id   (motivo obligatorio)
const deshabilitarUsuario = async (req, res) => {
    try {
        const { id } = req.params;

        if (Number(id) === Number(req.id_usuario)) {
            return res.status(409).json({
                error: "No puedes deshabilitar tu propia cuenta"
            });
        }

        const existente = await usuariosModel.getUsuarioById(id);

        if (!existente) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        if (Number(existente.estado) === 0) {
            return res.status(409).json({
                error: "La cuenta ya está deshabilitada"
            });
        }

        if (Number(existente.id_role) === 1) {
            const otrosAdmins = await usuariosModel.contarAdminsActivos(Number(id));

            if (otrosAdmins === 0) {
                return res.status(409).json({
                    error: "No puedes deshabilitar al único administrador activo del sistema."
                });
            }
        }

        const cuenta = await usuariosModel.setEstado(id, 0, {
            id_usuario_accion: req.id_usuario,
            motivo: req.body.motivo
        });

        res.status(200).json({
            mensaje: `Cuenta "${cuenta.usuario}" deshabilitada. Pierde el acceso en su siguiente acción. Quedó registrado en el historial.`,
            usuario: cuenta
        });
    } catch (error) {
        console.error("Error al deshabilitar usuario:", error);
        res.status(500).json({ error: "Error al deshabilitar el usuario" });
    }
};

// PATCH /api/preenfrio/usuarios/habilitar/:id   (motivo opcional)
const habilitarUsuario = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await usuariosModel.getUsuarioById(id);

        if (!existente) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        if (Number(existente.estado) === 1) {
            return res.status(409).json({
                error: "La cuenta ya está habilitada"
            });
        }

        // Si la persona ya no trabaja aquí, su cuenta no debe volver a abrirse
        if (Number(existente.empleado_estado) === 0) {
            return res.status(409).json({
                error: `${existente.nombre_empleado} ${existente.apellidos_empleado} está dado de baja como empleado. Reactívalo primero en el módulo de bajas.`
            });
        }

        const cuenta = await usuariosModel.setEstado(id, 1, {
            id_usuario_accion: req.id_usuario,
            motivo: req.body.motivo
        });

        const sinZona =
            [3, 4].includes(Number(existente.id_role)) &&
            Number(existente.camaras_asignadas) === 0;

        res.status(200).json({
            mensaje: `Cuenta "${cuenta.usuario}" habilitada.`,
            usuario: cuenta,
            aviso: sinZona
                ? "No tiene cámaras asignadas: no verá ningún dato hasta que le asignes su zona de trabajo."
                : null
        });
    } catch (error) {
        console.error("Error al habilitar usuario:", error);
        res.status(500).json({ error: "Error al habilitar el usuario" });
    }
};

const resetPassword = async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;

        if (!password || String(password).length < 6) {
            return res.status(400).json({
                error: "La contraseña debe tener al menos 6 caracteres"
            });
        }

        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
        const actualizado = await usuariosModel.resetPassword(id, password_hash);

        if (!actualizado) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        res.status(200).json({
            mensaje: `Contraseña restablecida para "${actualizado.usuario}"`
        });
    } catch (error) {
        console.error("Error al restablecer la contraseña:", error);
        res.status(500).json({ error: "Error al restablecer la contraseña" });
    }
};

// Solo cuentas creadas por error, sin registros. Para dar de baja: deshabilitar.
const deleteUsuario = async (req, res) => {
    try {
        const { id } = req.params;

        if (Number(id) === Number(req.id_usuario)) {
            return res.status(409).json({
                error: "No puedes eliminar tu propia cuenta"
            });
        }

        const existente = await usuariosModel.getUsuarioById(id);

        if (!existente) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        if (Number(existente.id_role) === 1 && Number(existente.estado) === 1) {
            const otrosAdmins = await usuariosModel.contarAdminsActivos(Number(id));

            if (otrosAdmins === 0) {
                return res.status(409).json({
                    error: "No puedes eliminar al único administrador activo del sistema."
                });
            }
        }

        const eliminado = await usuariosModel.deleteUsuario(id);

        res.status(200).json({
            mensaje: "Usuario eliminado correctamente",
            usuario: eliminado
        });
    } catch (error) {
        console.error("Error al eliminar usuario:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "No se puede eliminar: la cuenta ya tiene registros (recepciones, movimientos, evidencias o historial). Deshabilítala: pierde el acceso y el histórico se conserva."
            });
        }

        res.status(500).json({ error: "Error al eliminar el usuario" });
    }
};

// ---------------------------------------------------------
// ZONA DE TRABAJO
// ---------------------------------------------------------

const getZonaTrabajo = async (req, res) => {
    try {
        const { id } = req.params;
        const usuario = await usuariosModel.getUsuarioById(id);

        if (!usuario) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        const zona = await usuariosModel.getZonaTrabajo(id);

        res.status(200).json({
            usuario: {
                id_usuario: usuario.id_usuario,
                usuario: usuario.usuario,
                rol: usuario.rol,
                id_role: usuario.id_role,
                estado: usuario.estado,
                nombre_empleado: usuario.nombre_empleado,
                apellidos_empleado: usuario.apellidos_empleado,
                alcance_total: usuario.alcance_total
            },
            nota: usuario.alcance_total
                ? "Este rol ve todas las cámaras: no necesita asignaciones."
                : null,
            camaras: zona
        });
    } catch (error) {
        console.error("Error al obtener la zona de trabajo:", error);
        res.status(500).json({ error: "Error al obtener la zona de trabajo" });
    }
};

const guardarZonaTrabajo = async (req, res) => {
    try {
        const { id } = req.params;
        const { camaras } = req.body;

        if (!Array.isArray(camaras)) {
            return res.status(400).json({
                error: 'El campo "camaras" debe ser un arreglo de ids'
            });
        }

        const usuario = await usuariosModel.getUsuarioById(id);

        if (!usuario) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        const zona = await usuariosModel.reemplazarZonaTrabajo(id, camaras);
        const vigentes = zona.filter((z) => z.vigente);
        const deBaja = vigentes.filter((z) => Number(z.camara_estado) === 0);

        res.status(200).json({
            mensaje: vigentes.length > 0
                ? `Zona de trabajo actualizada: ${vigentes.length} cámara(s)`
                : "Zona de trabajo vacía: este usuario no verá ningún dato",
            avisos: deBaja.length > 0
                ? [`${deBaja.map((z) => z.nombre_camara).join(", ")} está(n) dada(s) de baja: no la(s) verá hasta que se reactive(n).`]
                : [],
            camaras: zona
        });
    } catch (error) {
        console.error("Error al guardar la zona de trabajo:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "Alguna de las cámaras indicadas no existe"
            });
        }

        res.status(500).json({ error: "Error al guardar la zona de trabajo" });
    }
};

const asignarCamara = async (req, res) => {
    try {
        const { id } = req.params;
        const { id_camara } = req.body;

        if (!id_camara || isNaN(Number(id_camara))) {
            return res.status(400).json({
                error: 'El campo "id_camara" es obligatorio y debe ser numérico'
            });
        }

        const asignada = await usuariosModel.asignarCamara(id, Number(id_camara));

        if (!asignada) {
            return res.status(200).json({
                mensaje: "Esa cámara ya estaba asignada a este usuario"
            });
        }

        res.status(201).json({
            mensaje: "Cámara asignada correctamente",
            asignacion: asignada
        });
    } catch (error) {
        console.error("Error al asignar la cámara:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "El usuario o la cámara indicados no existen"
            });
        }

        res.status(500).json({ error: "Error al asignar la cámara" });
    }
};

const quitarCamara = async (req, res) => {
    try {
        const { id, id_camara } = req.params;

        const quitada = await usuariosModel.quitarCamara(id, Number(id_camara));

        if (!quitada) {
            return res.status(404).json({
                error: "Ese usuario no tiene esa cámara asignada"
            });
        }

        res.status(200).json({
            mensaje: "Asignación dada de baja",
            asignacion: quitada
        });
    } catch (error) {
        console.error("Error al quitar la cámara:", error);
        res.status(500).json({ error: "Error al quitar la cámara" });
    }
};

export const usuariosController = {
    getUsuarios,
    getUsuarioById,
    getRoles,
    getSinCamaras,
    createUsuario,
    updateUsuario,
    deshabilitarUsuario,
    habilitarUsuario,
    resetPassword,
    deleteUsuario,
    getZonaTrabajo,
    guardarZonaTrabajo,
    asignarCamara,
    quitarCamara
};
