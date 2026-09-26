import bcrypt from "bcrypt";
import usuariosModel from "../models/usuarios.model.js";

// ============================================================================
// USUARIOS
// ============================================================================
// Módulo reservado al administrador: crear cuentas implica repartir accesos
// y definir qué cámaras ve cada quien.
//
// La ZONA DE TRABAJO (cámaras asignadas) se administra con endpoints
// propios, no al crear/editar el usuario. Ver § Zona de trabajo.
//
// AUDITORÍA · DESHABILITAR CUENTAS
//   Hasta ahora la única forma de quitarle el acceso a alguien era
//   borrarlo, y eso fallaba en cuanto tuviera registros (la FK protege el
//   histórico). Poner estado = 0 exigía entrar a la BD.
//
//   Ahora hay dos endpoints: deshabilitar y habilitar. Junto con la
//   validación contra la BD en verifyToken, el corte surte efecto en la
//   siguiente petición del usuario, aunque su token siga vigente.
//
//   Se protege un caso: nadie puede dejar el sistema sin ningún
//   administrador activo, ni deshabilitándolo ni bajándole el rol.
// ============================================================================

const SALT_ROUNDS = 10;

// ---------------------------------------------------------
// CONSULTAS
// ---------------------------------------------------------

// GET /api/preenfrio/usuarios/usuarios
const getUsuarios = async (req, res) => {
    try {
        const usuarios = await usuariosModel.getUsuarios();
        res.status(200).json(usuarios);
    } catch (error) {
        console.error("Error al obtener usuarios:", error);
        res.status(500).json({ error: "Error al obtener los usuarios" });
    }
};

// GET /api/preenfrio/usuarios/usuario/:id
const getUsuarioById = async (req, res) => {
    try {
        const { id } = req.params;
        const usuario = await usuariosModel.getUsuarioById(id);

        if (!usuario) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        res.status(200).json(usuario);
    } catch (error) {
        console.error("Error al obtener usuario:", error);
        res.status(500).json({ error: "Error al obtener el usuario" });
    }
};

// GET /api/preenfrio/usuarios/roles
const getRoles = async (req, res) => {
    try {
        const roles = await usuariosModel.getRoles();
        res.status(200).json(roles);
    } catch (error) {
        console.error("Error al obtener roles:", error);
        res.status(500).json({ error: "Error al obtener los roles" });
    }
};

// GET /api/preenfrio/usuarios/sincamaras
// Supervisores y operativos habilitados sin zona de trabajo: no ven ningún
// dato. Conviene revisarlo después de dar de alta personal.
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

// POST /api/preenfrio/usuarios/registrarusuario
const createUsuario = async (req, res) => {
    try {
        const { usuario, password, id_empleado, id_role } = req.body;

        // Se valida antes de insertar para dar un mensaje claro en vez de
        // dejar que reviente el índice UNIQUE.
        if (await usuariosModel.existeUsuario(usuario)) {
            return res.status(409).json({
                error: `El usuario "${usuario}" ya existe`
            });
        }

        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

        const nuevo = await usuariosModel.createUsuario({
            usuario,
            password_hash,
            id_empleado: Number(id_empleado),
            id_role: Number(id_role)
        });

        // Se devuelve el registro completo (con rol y nombre del empleado)
        // para que el frontend no tenga que recargar la lista.
        const completo = await usuariosModel.getUsuarioById(nuevo.id_usuario);

        // Aviso útil: los roles 3 y 4 sin cámaras no verán nada.
        const necesitaZona = [3, 4].includes(Number(id_role));

        res.status(201).json({
            usuario: completo,
            aviso: necesitaZona
                ? "Asigna su zona de trabajo: sin cámaras asignadas no verá ningún dato."
                : null
        });
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

        res.status(500).json({
            error: "Error al crear el usuario" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/usuarios/actualizarusuario/:id
// No toca la contraseña, el estado ni la zona de trabajo: cada uno tiene su
// endpoint.
const updateUsuario = async (req, res) => {
    try {
        const { id } = req.params;
        const { usuario, id_empleado, id_role } = req.body;

        const existente = await usuariosModel.getUsuarioById(id);

        if (!existente) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        // Se excluye el propio id: guardar sin cambiar el nombre no debe
        // marcar conflicto consigo mismo.
        if (await usuariosModel.existeUsuario(usuario, Number(id))) {
            return res.status(409).json({
                error: `El usuario "${usuario}" ya está en uso por otra cuenta`
            });
        }

        // Bajarle el rol al último admin activo dejaría el sistema sin
        // nadie que pueda administrar cuentas.
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

        const actualizado = await usuariosModel.updateUsuario(id, {
            usuario,
            id_empleado: Number(id_empleado),
            id_role: Number(id_role)
        });

        if (!actualizado) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        const completo = await usuariosModel.getUsuarioById(id);

        // Con la validación contra la BD, el nuevo rol aplica en la
        // siguiente petición: ya no hay que esperar a que venza el token.
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

// PATCH /api/preenfrio/usuarios/deshabilitar/:id
// Corta el acceso sin perder la autoría de lo que esa cuenta registró.
// Es la vía normal para dar de baja a alguien: el borrado falla en cuanto
// la cuenta tiene recepciones o movimientos, que es casi siempre.
const deshabilitarUsuario = async (req, res) => {
    try {
        const { id } = req.params;

        // Deshabilitarse a sí mismo cortaría la sesión a media operación, y
        // si es el único admin dejaría el sistema sin administración.
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

        const cuenta = await usuariosModel.setEstado(id, 0);

        res.status(200).json({
            mensaje: `Cuenta "${cuenta.usuario}" deshabilitada. Pierde el acceso en su siguiente acción, aunque tenga la sesión abierta.`,
            usuario: cuenta
        });
    } catch (error) {
        console.error("Error al deshabilitar usuario:", error);
        res.status(500).json({ error: "Error al deshabilitar el usuario" });
    }
};

// PATCH /api/preenfrio/usuarios/habilitar/:id
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

        const cuenta = await usuariosModel.setEstado(id, 1);

        // Un supervisor u operativo sin zona vigente no verá nada al volver
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

// PATCH /api/preenfrio/usuarios/resetpassword/:id
// Lo usa el admin cuando alguien olvida su contraseña. No pide la anterior;
// para el cambio propio está /auth/cambiarpassword, que sí la exige.
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

// DELETE /api/preenfrio/usuarios/eliminarusuario/:id
// Solo prospera con cuentas que nunca registraron nada (altas por error).
// Para dar de baja a alguien, la vía es deshabilitar.
const deleteUsuario = async (req, res) => {
    try {
        const { id } = req.params;

        // Nadie debe poder borrarse a sí mismo: dejaría la sesión activa
        // con una cuenta inexistente, y si es el único admin, sin acceso.
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

        // Recepciones, movimientos y despachos guardan quién los registró.
        // Esa FK no tiene cascade a propósito: el histórico no debe perderse.
        if (error.code === "23503") {
            return res.status(409).json({
                error: "No se puede eliminar: el usuario tiene registros asociados (recepciones, movimientos o evidencias). Deshabilítalo en su lugar: pierde el acceso y el histórico se conserva."
            });
        }

        res.status(500).json({ error: "Error al eliminar el usuario" });
    }
};

// ---------------------------------------------------------
// ZONA DE TRABAJO
// ---------------------------------------------------------

// GET /api/preenfrio/usuarios/zonatrabajo/:id
// Devuelve las asignaciones vigentes y el histórico.
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
            // Admin y Coordinador ven todo por su rol: las asignaciones no
            // les cambian nada. Se avisa para que no se configure de más.
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

// POST /api/preenfrio/usuarios/zonatrabajo/:id
// Reemplaza la zona completa: llega la lista final de cámaras y el modelo
// cierra las que sobran y abre las que faltan.
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

        res.status(200).json({
            mensaje: vigentes.length > 0
                ? `Zona de trabajo actualizada: ${vigentes.length} cámara(s)`
                : "Zona de trabajo vacía: este usuario no verá ningún dato",
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

// POST /api/preenfrio/usuarios/zonatrabajo/:id/camara
// Agrega UNA cámara sin tocar las demás.
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

        // null significa que ya estaba vigente: no es un error, solo aviso.
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

// DELETE /api/preenfrio/usuarios/zonatrabajo/:id/camara/:id_camara
// Da de baja la asignación marcando fecha_fin. No se borra el registro:
// así queda constancia de que esa persona estuvo en esa cámara.
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
    // zona de trabajo
    getZonaTrabajo,
    guardarZonaTrabajo,
    asignarCamara,
    quitarCamara
};
