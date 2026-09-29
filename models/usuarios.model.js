import { db } from "../database/connection.database.js";
import { conContextoAuditoria } from "../utils/auditoriaContexto.js";

// ============================================================================
// USUARIOS
// ============================================================================
// Cuentas de acceso. Cada una pertenece a un empleado (de ahí sale el
// nombre real) y tiene un rol que define qué módulos ve.
//
// ZONA DE TRABAJO — se maneja APARTE (§ Zona de trabajo). usuarios_camaras
// conserva el histórico con fecha_fin.
//
// SOBRE EL HASH
//   password_hash NUNCA se devuelve en las consultas de lectura. Solo el
//   login lo trae (auth.model.js).
//
// ESTADO DE LA CUENTA
//   1 habilitada · 0 deshabilitada. verifyToken consulta esta columna en
//   cada petición: el corte surte efecto al instante.
//
// v3.0 · HISTORIAL
//   Cada habilitación o deshabilitación queda en historial_estados por
//   trigger. setEstado fija el usuario y el motivo con
//   conContextoAuditoria para que el trigger los registre.
//
//   Si el empleado se da de baja (módulo de bajas), su cuenta se
//   deshabilita sola por trigger y también queda en el historial.
// ============================================================================

const SELECT_USUARIO = `
    SELECT
        u.id_usuario,
        u.usuario,
        u.id_role,
        r.tipo              AS rol,
        u.estado,
        CASE u.estado
            WHEN 1 THEN 'Habilitada'
            WHEN 0 THEN 'Deshabilitada'
            ELSE 'Otro'
        END                 AS estado_texto,
        u.id_empleado,
        e.nombre            AS nombre_empleado,
        e.apellidos         AS apellidos_empleado,
        e.estado            AS empleado_estado,
        e.turno,
        e.zona,
        (SELECT COUNT(*) FROM usuarios_camaras uc
          WHERE uc.id_usuario = u.id_usuario AND uc.fecha_fin IS NULL
        ) AS camaras_asignadas,
        CASE WHEN u.id_role IN (1, 2) THEN TRUE ELSE FALSE END AS alcance_total
    FROM usuarios u
    JOIN roles     r ON r.id_role     = u.id_role
    JOIN empleados e ON e.id_empleado = u.id_empleado
`;

// ---------------------------------------------------------
// CONSULTAS
// ---------------------------------------------------------

// Las deshabilitadas salen al final
const getUsuarios = async () => {
    const result = await db.query(
        `${SELECT_USUARIO} ORDER BY u.estado DESC, u.id_role, u.usuario`
    );
    return result.rows;
};

const getUsuarioById = async (id_usuario) => {
    const result = await db.query(
        `${SELECT_USUARIO} WHERE u.id_usuario = $1`,
        [id_usuario]
    );
    return result.rows[0];
};

// Una cuenta deshabilitada sigue ocupando su nombre.
const existeUsuario = async (usuario, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_usuario FROM usuarios
        WHERE LOWER(usuario) = LOWER($1)
          AND ($2::INT IS NULL OR id_usuario <> $2)
        `,
        [usuario, id_excluir]
    );
    return result.rows.length > 0;
};

// Supervisores y operativos HABILITADOS sin zona de trabajo: no verán nada.
const getSinCamaras = async () => {
    const result = await db.query(
        `
        SELECT
            u.id_usuario, u.usuario, u.id_role, r.tipo AS rol,
            e.nombre AS nombre_empleado, e.apellidos AS apellidos_empleado
        FROM usuarios u
        JOIN roles     r ON r.id_role     = u.id_role
        JOIN empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN usuarios_camaras uc
               ON uc.id_usuario = u.id_usuario AND uc.fecha_fin IS NULL
        WHERE u.id_role IN (3, 4)
          AND u.estado = 1
          AND uc.id_usuario IS NULL
        ORDER BY u.usuario
        `
    );
    return result.rows;
};

// Admins habilitados sin contar al indicado. Nunca dejar el sistema sin admin.
const contarAdminsActivos = async (id_excluir = null) => {
    const result = await db.query(
        `
        SELECT COUNT(*)::INT AS total
        FROM usuarios
        WHERE id_role = 1
          AND estado = 1
          AND ($1::INT IS NULL OR id_usuario <> $1)
        `,
        [id_excluir]
    );
    return result.rows[0].total;
};

// Estado del empleado al que se le va a ligar una cuenta. Una cuenta nueva
// para alguien dado de baja sería un acceso abierto para quien ya no
// trabaja aquí.
const getEstadoEmpleado = async (id_empleado) => {
    const result = await db.query(
        `SELECT estado, nombre, apellidos FROM empleados WHERE id_empleado = $1`,
        [id_empleado]
    );
    return result.rows[0];
};

// ---------------------------------------------------------
// ALTA Y EDICIÓN
// ---------------------------------------------------------

const createUsuario = async ({ usuario, password_hash, id_empleado, id_role }) => {
    const result = await db.query(
        `
        INSERT INTO usuarios (usuario, password_hash, id_empleado, id_role)
        VALUES ($1, $2, $3, $4)
        RETURNING id_usuario, usuario, id_empleado, id_role, estado
        `,
        [usuario, password_hash, id_empleado, id_role]
    );
    return result.rows[0];
};

// La contraseña y el estado tienen sus propios métodos.
const updateUsuario = async (id_usuario, { usuario, id_empleado, id_role }) => {
    const result = await db.query(
        `
        UPDATE usuarios
        SET usuario = $1, id_empleado = $2, id_role = $3
        WHERE id_usuario = $4
        RETURNING id_usuario, usuario, id_empleado, id_role, estado
        `,
        [usuario, id_empleado, id_role, id_usuario]
    );
    return result.rows[0];
};

// Habilitar (1) o deshabilitar (0). Queda en el historial con quién lo
// hizo y por qué.
const setEstado = async (id_usuario, estado, { id_usuario_accion, motivo }) => {
    return conContextoAuditoria(
        { id_usuario: id_usuario_accion, motivo },
        async (client) => {
            const result = await client.query(
                `
                UPDATE usuarios SET estado = $1
                WHERE id_usuario = $2
                RETURNING id_usuario, usuario, id_role, estado
                `,
                [estado, id_usuario]
            );
            return result.rows[0];
        }
    );
};

const resetPassword = async (id_usuario, password_hash) => {
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

// Solo prospera con cuentas sin registros (altas por error). La FK de
// recepciones, movimientos, evidencias e historial lo impide si ya operó.
const deleteUsuario = async (id_usuario) => {
    const result = await db.query(
        `DELETE FROM usuarios WHERE id_usuario = $1 RETURNING id_usuario, usuario`,
        [id_usuario]
    );
    return result.rows[0];
};

// ---------------------------------------------------------
// ZONA DE TRABAJO (usuarios_camaras)
// ---------------------------------------------------------

const getZonaTrabajo = async (id_usuario) => {
    const result = await db.query(
        `
        SELECT
            uc.id_usuario_camara,
            uc.id_usuario,
            uc.id_camara,
            c.nombre_camara,
            c.tipo_camara,
            c.ubicacion,
            c.estado AS camara_estado,
            uc.fecha_asignacion,
            uc.fecha_fin,
            CASE WHEN uc.fecha_fin IS NULL THEN TRUE ELSE FALSE END AS vigente
        FROM usuarios_camaras uc
        JOIN camaras c ON c.id_camara = uc.id_camara
        WHERE uc.id_usuario = $1
        ORDER BY uc.fecha_fin NULLS FIRST, c.tipo_camara, c.nombre_camara
        `,
        [id_usuario]
    );
    return result.rows;
};

// ON CONFLICT se apoya en uq_usuario_camara_activa
const asignarCamara = async (id_usuario, id_camara) => {
    const result = await db.query(
        `
        INSERT INTO usuarios_camaras (id_usuario, id_camara)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        RETURNING *
        `,
        [id_usuario, id_camara]
    );
    return result.rows[0] ?? null;
};

// Cierra la asignación (fecha_fin), no la borra.
const quitarCamara = async (id_usuario, id_camara) => {
    const result = await db.query(
        `
        UPDATE usuarios_camaras
        SET fecha_fin = CURRENT_TIMESTAMP
        WHERE id_usuario = $1
          AND id_camara = $2
          AND fecha_fin IS NULL
        RETURNING *
        `,
        [id_usuario, id_camara]
    );
    return result.rows[0];
};

// Reemplaza la zona completa en una transacción.
const reemplazarZonaTrabajo = async (id_usuario, camaras = []) => {
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        const ids = camaras.map(Number).filter((n) => !isNaN(n));

        await client.query(
            `
            UPDATE usuarios_camaras
            SET fecha_fin = CURRENT_TIMESTAMP
            WHERE id_usuario = $1
              AND fecha_fin IS NULL
              AND NOT (id_camara = ANY($2::INT[]))
            `,
            [id_usuario, ids]
        );

        for (const id_camara of ids) {
            await client.query(
                `
                INSERT INTO usuarios_camaras (id_usuario, id_camara)
                VALUES ($1, $2)
                ON CONFLICT DO NOTHING
                `,
                [id_usuario, id_camara]
            );
        }

        await client.query("COMMIT");
        return await getZonaTrabajo(id_usuario);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

// ---------------------------------------------------------
// ROLES (catálogo de solo lectura)
// ---------------------------------------------------------

const getRoles = async () => {
    const result = await db.query(`SELECT * FROM roles ORDER BY id_role`);
    return result.rows;
};

const usuariosModel = {
    getUsuarios,
    getUsuarioById,
    existeUsuario,
    getSinCamaras,
    contarAdminsActivos,
    getEstadoEmpleado,
    createUsuario,
    updateUsuario,
    setEstado,
    resetPassword,
    deleteUsuario,
    getZonaTrabajo,
    asignarCamara,
    quitarCamara,
    reemplazarZonaTrabajo,
    getRoles
};

export default usuariosModel;
