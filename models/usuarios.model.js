import { db } from "../database/connection.database.js";

// ============================================================================
// USUARIOS
// ============================================================================
// Cuentas de acceso. Cada una pertenece a un empleado (de ahí sale el
// nombre real) y tiene un rol que define qué módulos ve.
//
// ZONA DE TRABAJO — se maneja APARTE
//   Las cámaras asignadas viven en usuarios_camaras y se administran con
//   sus propios métodos (§ Zona de trabajo, más abajo). No se tocan al
//   crear o editar el usuario.
//
//   El motivo: usuarios_camaras tiene fecha_fin para conservar el
//   histórico. Si se manejara como un multi-select dentro del formulario,
//   al deseleccionar una cámara no quedaría claro si se borra el registro
//   o se cierra la asignación. Separarlo hace explícita esa diferencia.
//
// SOBRE EL HASH
//   password_hash NUNCA se devuelve en las consultas de lectura. Solo el
//   login lo trae (ver auth.model.js) para compararlo con bcrypt.
// ============================================================================

const SELECT_USUARIO = `
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
        -- Cuántas cámaras tiene asignadas ahora mismo.
        -- Sirve para marcar en la lista a los supervisores/operativos que
        -- quedaron sin zona de trabajo: esos no verán ningún dato.
        (SELECT COUNT(*) FROM usuarios_camaras uc
          WHERE uc.id_usuario = u.id_usuario AND uc.fecha_fin IS NULL
        ) AS camaras_asignadas,
        -- Admin y Coordinador ven todas las cámaras por su rol, así que
        -- no necesitan asignaciones.
        CASE WHEN u.id_role IN (1, 2) THEN TRUE ELSE FALSE END AS alcance_total
    FROM usuarios u
    JOIN roles     r ON r.id_role     = u.id_role
    JOIN empleados e ON e.id_empleado = u.id_empleado
`;

// ---------------------------------------------------------
// CONSULTAS
// ---------------------------------------------------------
const getUsuarios = async () => {
    const result = await db.query(
        `${SELECT_USUARIO} ORDER BY u.id_role, u.usuario`
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

// Verifica si un nombre de cuenta ya existe.
// Se consulta antes de insertar para dar un mensaje claro en vez de dejar
// que reviente el índice UNIQUE.
// Al editar se excluye el propio id, para que guardar sin cambiar el
// nombre no marque conflicto consigo mismo.
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

// Supervisores y operativos sin zona de trabajo asignada.
// Es el reporte que evita el clásico "el sistema no me carga nada":
// sin cámaras vigentes, esos roles no ven absolutamente ningún dato.
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
          AND uc.id_usuario IS NULL
        ORDER BY u.usuario
        `
    );
    return result.rows;
};

// ---------------------------------------------------------
// ALTA Y EDICIÓN
// ---------------------------------------------------------
// El hash llega ya calculado desde el controller: bcrypt es asíncrono y
// no tiene por qué vivir en la capa de datos.
const createUsuario = async ({ usuario, password_hash, id_empleado, id_role }) => {
    const result = await db.query(
        `
        INSERT INTO usuarios (usuario, password_hash, id_empleado, id_role)
        VALUES ($1, $2, $3, $4)
        RETURNING id_usuario, usuario, id_empleado, id_role
        `,
        [usuario, password_hash, id_empleado, id_role]
    );
    return result.rows[0];
};

// Actualiza cuenta, empleado y rol. La contraseña tiene su propio método:
// mezclarlas obligaría a reenviar el hash en cada edición.
const updateUsuario = async (id_usuario, { usuario, id_empleado, id_role }) => {
    const result = await db.query(
        `
        UPDATE usuarios
        SET usuario = $1, id_empleado = $2, id_role = $3
        WHERE id_usuario = $4
        RETURNING id_usuario, usuario, id_empleado, id_role
        `,
        [usuario, id_empleado, id_role, id_usuario]
    );
    return result.rows[0];
};

// Restablecer contraseña: lo usa un admin cuando alguien la olvida.
// El cambio de contraseña propia vive en auth.model.js y sí exige la
// anterior.
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

// Al borrar el usuario, usuarios_camaras se limpia sola (ON DELETE CASCADE).
// Las recepciones y movimientos que registró conservan su id_usuario porque
// esa FK no tiene cascade: el histórico no debe perderse.
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

// Asignaciones de un usuario: las vigentes y el histórico.
// El frontend distingue unas de otras con la columna 'vigente'.
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

// Asignar una cámara.
// ON CONFLICT DO NOTHING se apoya en el índice uq_usuario_camara_activa:
// reasignar algo que ya está vigente no duplica ni truena.
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
    // Si devuelve undefined es porque ya existía vigente: no es un error.
    return result.rows[0] ?? null;
};

// Dar de baja una asignación.
// Se marca fecha_fin en vez de borrar: así queda registro de que esa
// persona estuvo en esa cámara, útil para auditar movimientos viejos.
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

// Reemplaza toda la zona de trabajo de un golpe (transacción).
// Pensado para el modal: llega la lista final de cámaras y aquí se decide
// qué cerrar y qué abrir.
//
// Va en transacción porque son varias operaciones: si falla a medias, el
// usuario quedaría con una zona de trabajo inconsistente.
const reemplazarZonaTrabajo = async (id_usuario, camaras = []) => {
    const client = await db.connect();
    try {
        await client.query("BEGIN");

        const ids = camaras.map(Number).filter((n) => !isNaN(n));

        // 1) Cerrar las vigentes que ya no están en la lista nueva
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

        // 2) Abrir las nuevas. ON CONFLICT evita duplicar las que ya
        //    estaban vigentes y no se tocaron.
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
    createUsuario,
    updateUsuario,
    resetPassword,
    deleteUsuario,
    // zona de trabajo
    getZonaTrabajo,
    asignarCamara,
    quitarCamara,
    reemplazarZonaTrabajo,
    // roles
    getRoles
};

export default usuariosModel;
