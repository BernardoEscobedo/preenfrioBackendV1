import bcrypt from "bcrypt";
import authModel from "../models/auth.model.js";
import { firmarToken } from "../middlewares/jwt.middleware.js";

// ============================================================================
// AUTENTICACIÓN
// ============================================================================
// SOBRE LOS MENSAJES DE ERROR
//   El login responde lo mismo para "usuario inexistente" y "contraseña
//   incorrecta". Distinguirlos le confirmaría a un atacante qué cuentas
//   existen, y no le aporta nada al usuario legítimo.
// ============================================================================

// POST /api/preenfrio/auth/login
const login = async (req, res) => {
    try {
        const { usuario, password } = req.body;

        if (!usuario || !password) {
            return res.status(400).json({
                error: "Usuario y contraseña son obligatorios"
            });
        }

        const encontrado = await authModel.buscarPorUsuario(usuario.trim());

        // Mismo mensaje en ambos casos, a propósito
        if (!encontrado) {
            return res.status(401).json({
                error: "Usuario o contraseña incorrectos"
            });
        }

        const coincide = await bcrypt.compare(password, encontrado.password_hash);
        if (!coincide) {
            return res.status(401).json({
                error: "Usuario o contraseña incorrectos"
            });
        }

        const token = firmarToken(encontrado);
        const camaras = encontrado.camaras ?? [];

        // El hash NUNCA sale del backend
        const { password_hash, ...datosUsuario } = encontrado;

        res.status(200).json({
            token,
            usuario: {
                ...datosUsuario,
                // Se manda con los dos nombres porque el frontend lee
                // 'role' en unos lados e 'id_role' en otros.
                role: encontrado.id_role,
                // El dashboard saluda con el nombre del empleado,
                // no con el de la cuenta.
                nombre_empleado: encontrado.nombre_empleado,
                camaras,
                // Distingue quién ve todas las plantas y quién solo la suya
                alcance_total: [1, 2].includes(Number(encontrado.id_role))
            }
        });
    } catch (error) {
        console.error("Error en el login:", error);
        res.status(500).json({ error: "Error al iniciar sesión" });
    }
};

// GET /api/preenfrio/auth/perfil
// Refresca los datos de la sesión sin obligar a re-loguearse. Útil cuando
// un admin cambia las cámaras asignadas y el cambio debe verse ya.
const getPerfil = async (req, res) => {
    try {
        const perfil = await authModel.getPerfil(req.id_usuario);
        if (!perfil) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }
        res.status(200).json({
            ...perfil,
            role: perfil.id_role,
            alcance_total: [1, 2].includes(Number(perfil.id_role))
        });
    } catch (error) {
        console.error("Error al obtener el perfil:", error);
        res.status(500).json({ error: "Error al obtener el perfil" });
    }
};

// GET /api/preenfrio/auth/miscamaras
const getMisCamaras = async (req, res) => {
    try {
        const camaras = await authModel.getCamarasAsignadas(req.id_usuario);
        res.status(200).json(camaras);
    } catch (error) {
        console.error("Error al obtener las cámaras del usuario:", error);
        res.status(500).json({ error: "Error al obtener tus cámaras" });
    }
};

// PATCH /api/preenfrio/auth/cambiarpassword
// El usuario cambia SU propia contraseña. Para restablecer la de otro está
// el módulo de Usuarios (solo admin).
const cambiarPassword = async (req, res) => {
    try {
        const { password_actual, password_nueva } = req.body;

        if (!password_actual || !password_nueva) {
            return res.status(400).json({
                error: "Debes indicar la contraseña actual y la nueva"
            });
        }
        if (String(password_nueva).length < 6) {
            return res.status(400).json({
                error: "La contraseña nueva debe tener al menos 6 caracteres"
            });
        }

        // Se pide la actual aunque la sesión sea válida: evita que alguien
        // cambie la contraseña en un equipo que quedó abierto.
        const hashActual = await authModel.getHash(req.id_usuario);
        if (!hashActual) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        const coincide = await bcrypt.compare(password_actual, hashActual);
        if (!coincide) {
            return res.status(401).json({
                error: "La contraseña actual no es correcta"
            });
        }

        const nuevoHash = await bcrypt.hash(password_nueva, 10);
        await authModel.actualizarPassword(req.id_usuario, nuevoHash);

        res.status(200).json({ mensaje: "Contraseña actualizada correctamente" });
    } catch (error) {
        console.error("Error al cambiar la contraseña:", error);
        res.status(500).json({ error: "Error al cambiar la contraseña" });
    }
};

export const authController = {
    login,
    getPerfil,
    getMisCamaras,
    cambiarPassword
};
