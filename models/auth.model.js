import { db } from "../database/connection.database.js";

// ============================================================================
// AUTENTICACIÓN
// ============================================================================
// El login necesita más que las credenciales: trae el rol (para permisos),
// el nombre del empleado (para el saludo del dashboard) y las cámaras
// asignadas (para que el frontend sepa qué mostrar).
//
// Todo en una sola consulta: si el login hiciera tres viajes a la BD, el
// arranque de sesión se sentiría lento sin necesidad.
// ============================================================================

/**
 * Busca un usuario por su nombre de cuenta.
 * Devuelve el hash para que el controller lo compare con bcrypt —
 * la comparación NUNCA se hace en SQL.
 */
const buscarPorUsuario = async (usuario) => {
    const result = await db.query(
        `
        SELECT
            u.id_usuario,
            u.usuario,
            u.password_hash,
            u.id_role,
            r.tipo              AS rol,
            u.id_empleado,
            e.nombre            AS nombre_empleado,
            e.apellidos         AS apellidos_empleado,
            e.turno,
            e.zona,
            -- Cámaras visibles según el rol y sus asignaciones vigentes.
            -- El frontend las usa para mostrar avisos del tipo
            -- "solo ves tus cámaras"; la restricción real vive en el backend.
            fn_camaras_usuario(u.id_usuario) AS camaras
        FROM usuarios u
        JOIN roles     r ON r.id_role     = u.id_role
        JOIN empleados e ON e.id_empleado = u.id_empleado
        WHERE u.usuario = $1
        `,
        [usuario]
    );
    return result.rows[0];
};

/**
 * Perfil del usuario de la sesión, sin el hash.
 * Se usa para refrescar los datos sin obligar a volver a iniciar sesión.
 */
const getPerfil = async (id_usuario) => {
    const result = await db.query(
        `
        SELECT
            u.id_usuario,
            u.usuario,
            u.id_role,
            r.tipo              AS rol,
            u.id_empleado,
            e.nombre            AS nombre_empleado,
            e.apellidos         AS apellidos_empleado,
            e.turno,
            e.zona,
            fn_camaras_usuario(u.id_usuario) AS camaras
        FROM usuarios u
        JOIN roles     r ON r.id_role     = u.id_role
        JOIN empleados e ON e.id_empleado = u.id_empleado
        WHERE u.id_usuario = $1
        `,
        [id_usuario]
    );
    return result.rows[0];
};

/**
 * Nombres de las cámaras asignadas, para mostrarlas en el dashboard.
 * Va aparte del login porque no siempre hacen falta.
 */
const getCamarasAsignadas = async (id_usuario) => {
    const result = await db.query(
        `
        SELECT c.id_camara, c.nombre_camara, c.tipo_camara, c.ubicacion
        FROM camaras c
        WHERE c.id_camara = ANY(fn_camaras_usuario($1))
        ORDER BY c.tipo_camara, c.nombre_camara
        `,
        [id_usuario]
    );
    return result.rows;
};

/**
 * Solo el hash, para verificar la contraseña actual al cambiarla.
 */
const getHash = async (id_usuario) => {
    const result = await db.query(
        `SELECT password_hash FROM usuarios WHERE id_usuario = $1`,
        [id_usuario]
    );
    return result.rows[0]?.password_hash ?? null;
};

const actualizarPassword = async (id_usuario, password_hash) => {
    const result = await db.query(
        `
        UPDATE usuarios SET password_hash = $1
        WHERE id_usuario = $2
        RETURNING id_usuario, usuario
        `,
        [password_hash, id_usuario]
    );
    return result.rows[0];
};

const authModel = {
    buscarPorUsuario,
    getPerfil,
    getCamarasAsignadas,
    getHash,
    actualizarPassword
};

export default authModel;
