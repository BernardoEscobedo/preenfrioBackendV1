import { db } from "../database/connection.database.js";

// ============================================================================
// BAJAS DE CÁMARAS Y EMPLEADOS · HISTORIAL
// ============================================================================
// Toda baja es LÓGICA (estado = 0). El registro sigue existiendo para que
// recepciones, movimientos, despachos y pulpeos viejos sigan resolviendo a
// qué cámara o a qué persona se refieren.
//
// ⚠️ Este modelo NO escribe en historial_estados. Lo hace el trigger
// fn_registrar_cambio_estado al detectar el cambio de estado. Los métodos
// que cambian el estado reciben el `client` de conContextoAuditoria para
// que el trigger lea el usuario y el motivo de la transacción.
//
// Dar de baja a un empleado deshabilita su cuenta: también lo hace un
// trigger (fn_baja_empleado_cascada), en la misma transacción.
// ============================================================================

// ----------------------------------------------------------------------------
// CÁMARAS
// ----------------------------------------------------------------------------

const getCamara = async (id_camara) => {
    const result = await db.query(
        `SELECT * FROM camaras WHERE id_camara = $1`,
        [id_camara]
    );
    return result.rows[0];
};

// Lo que impide o condiciona dar de baja una cámara.
//
//   tarimas_dentro          fruta física adentro: hay que sacarla primero
//   tarimas_en_cola         fruta esperando en el patio para entrar
//   mantenimiento_activo    paro en proceso: se finaliza antes
//   producciones_pendientes plan que todavía espera llegar a esta cámara
//   usuarios_asignados      supervisores/operativos que dejarán de verla
const getImpedimentosCamara = async (id_camara) => {
    const result = await db.query(
        `
        SELECT
            COALESCE((
                SELECT SUM(cantidad_tarimas) FROM ocupaciones_camaras
                WHERE id_camara = $1 AND tipo_ocupacion = 1 AND estado = 1
            ), 0)::INT AS tarimas_dentro,
            COALESCE((
                SELECT SUM(cantidad_tarimas) FROM ocupaciones_camaras
                WHERE id_camara = $1 AND tipo_ocupacion = 3 AND estado = 1
            ), 0)::INT AS tarimas_en_cola,
            EXISTS (
                SELECT 1 FROM mantenimientos
                WHERE id_camara = $1 AND estado = 2
            ) AS mantenimiento_activo,
            (
                SELECT COUNT(*) FROM produccion
                WHERE id_camara = $1 AND estado IN (1, 2)
            )::INT AS producciones_pendientes,
            (
                SELECT COUNT(*) FROM usuarios_camaras uc
                JOIN usuarios u ON u.id_usuario = uc.id_usuario
                WHERE uc.id_camara = $1
                  AND uc.fecha_fin IS NULL
                  AND u.estado = 1
            )::INT AS usuarios_asignados
        `,
        [id_camara]
    );
    return result.rows[0];
};

// Cambia el estado dentro de la transacción de auditoría.
const setEstadoCamara = async (client, id_camara, estado) => {
    const result = await client.query(
        `UPDATE camaras SET estado = $1 WHERE id_camara = $2 RETURNING *`,
        [estado, id_camara]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// EMPLEADOS
// ----------------------------------------------------------------------------

// El empleado con su cuenta (si tiene). Hace falta para saber si la baja
// va a deshabilitar a un administrador.
const getEmpleado = async (id_empleado) => {
    const result = await db.query(
        `
        SELECT
            e.*,
            u.id_usuario,
            u.usuario,
            u.id_role,
            u.estado AS usuario_estado
        FROM empleados e
        LEFT JOIN usuarios u ON u.id_empleado = e.id_empleado
        WHERE e.id_empleado = $1
        `,
        [id_empleado]
    );
    return result.rows[0];
};

// Admins habilitados que NO pertenecen a este empleado. Si da 0, la baja
// dejaría el sistema sin nadie que pueda administrarlo.
const contarOtrosAdminsActivos = async (id_empleado) => {
    const result = await db.query(
        `
        SELECT COUNT(*)::INT AS total
        FROM usuarios
        WHERE id_role = 1
          AND estado = 1
          AND id_empleado <> $1
        `,
        [id_empleado]
    );
    return result.rows[0].total;
};

// Cambia el estado dentro de la transacción de auditoría. Si es baja, el
// trigger deshabilita también la cuenta.
const setEstadoEmpleado = async (client, id_empleado, estado) => {
    const result = await client.query(
        `UPDATE empleados SET estado = $1 WHERE id_empleado = $2 RETURNING *`,
        [estado, id_empleado]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// HISTORIAL (solo admin)
// ----------------------------------------------------------------------------
// Lee vw_historial_estados. Incluye bajas y reactivaciones de cámaras,
// empleados y usuarios.
//
// 'hecho_fuera_del_sistema' marca los cambios sin usuario: se hicieron por
// SQL directo, no desde la aplicación. Conviene revisarlos.
const getHistorial = async ({
    tabla = null,
    id_registro = null,
    accion = null,
    fecha_desde = null,
    fecha_hasta = null
} = {}) => {
    const result = await db.query(
        `
        SELECT *
        FROM vw_historial_estados
        WHERE ($1::TEXT IS NULL OR tabla = $1)
          AND ($2::INT IS NULL OR id_registro = $2)
          AND ($3::TEXT IS NULL OR accion = $3)
          AND ($4::DATE IS NULL OR fecha_hora::DATE >= $4)
          AND ($5::DATE IS NULL OR fecha_hora::DATE <= $5)
        ORDER BY fecha_hora DESC, id_historial DESC
        LIMIT 500
        `,
        [tabla, id_registro, accion, fecha_desde, fecha_hasta]
    );
    return result.rows;
};

// Registros dados de baja actualmente, de las tres tablas. Es la pantalla de
// "papelera" del admin: desde aquí se reactiva.
const getDadosDeBaja = async () => {
    const result = await db.query(
        `
        SELECT 'camaras' AS tabla, id_camara AS id_registro,
               nombre_camara || ' (' || ubicacion || ')' AS descripcion
        FROM camaras WHERE estado = 0

        UNION ALL

        SELECT 'empleados', id_empleado, nombre || ' ' || apellidos
        FROM empleados WHERE estado = 0

        UNION ALL

        SELECT 'usuarios', id_usuario, usuario
        FROM usuarios WHERE estado = 0

        ORDER BY 1, 3
        `
    );

    // Se adjunta la última baja de cada uno (quién y por qué)
    const ultimas = await db.query(
        `
        SELECT DISTINCT ON (tabla, id_registro)
               tabla, id_registro, motivo, fecha_hora, usuario,
               nombre_empleado, apellidos_empleado
        FROM vw_historial_estados
        WHERE accion = 'BAJA'
        ORDER BY tabla, id_registro, fecha_hora DESC
        `
    );

    const indice = new Map(
        ultimas.rows.map((u) => [`${u.tabla}:${u.id_registro}`, u])
    );

    return result.rows.map((r) => ({
        ...r,
        ultima_baja: indice.get(`${r.tabla}:${r.id_registro}`) ?? null
    }));
};

const bajasModel = {
    getCamara,
    getImpedimentosCamara,
    setEstadoCamara,
    getEmpleado,
    contarOtrosAdminsActivos,
    setEstadoEmpleado,
    getHistorial,
    getDadosDeBaja
};

export default bajasModel;
