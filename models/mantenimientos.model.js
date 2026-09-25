import { db } from "../database/connection.database.js";

// ============================================================================
// MANTENIMIENTOS DE CÁMARA
// ============================================================================
// Paros TEMPORALES de una cámara: limpieza profunda, reparación del
// compresor, falla eléctrica. No confundir con camaras.estado = 0, que es
// la baja DEFINITIVA de la cámara.
//
// ⚠️ ESTE MÓDULO ES EL QUE BLOQUEA CAPACIDAD
//   trg_sync_ocupacion_mantenimiento reacciona al estado:
//
//     estado → 2 (en proceso)  crea una ocupación tipo 2 que consume TODA
//                              la capacidad de la cámara
//     estado → 3 (finalizado)  cierra esa ocupación y libera la cámara
//
//   Mientras existe esa ocupación, fn_tarimas_disponibles devuelve 0 aunque
//   la cámara esté vacía. Es la respuesta a "¿por qué toda la fruta se fue
//   a la cola si había espacio?".
//
// ⚠️ EL TRIGGER NO MANEJA EL ESTADO 4 (CANCELADO)
//   Solo tiene dos ramas: bloquear en 2 y liberar en 3. Si un mantenimiento
//   pasa de 2 a 4, la ocupación tipo 2 queda ACTIVA para siempre y la
//   cámara nunca se libera.
//
//   El controller lo impide: desde 'en proceso' solo se puede finalizar,
//   nunca cancelar. Cancelar queda reservado a los que siguen programados
//   (estado 1), que todavía no bloquearon nada.
//
//   Se resolvió en el backend y no en la BD porque tocar el trigger exige
//   una migración; si el caso se vuelve frecuente, la solución correcta es
//   agregarle la rama del 4.
//
// ESTADOS
//   1 = programado   agendado, la cámara sigue operando
//   2 = en proceso   bloquea TODA la capacidad
//   3 = finalizado   libera la cámara
//   4 = cancelado    solo desde 'programado'
//
// ALCANCE
//   La tabla SÍ tiene id_camara, así que es el caso simple:
//   validarCamaraEnAlcance("body") alcanza para las escrituras.
// ============================================================================

const SELECT_MANTENIMIENTO = `
    SELECT
        m.*,
        c.nombre_camara,
        c.tipo_camara,
        c.ubicacion,
        c.capacidad_max_tarimas,
        c.estado AS estado_camara,
        CASE m.estado
            WHEN 1 THEN 'Programado'
            WHEN 2 THEN 'En proceso'
            WHEN 3 THEN 'Finalizado'
            WHEN 4 THEN 'Cancelado'
            ELSE 'Otro'
        END AS estado_texto,
        CASE m.tipo
            WHEN 1 THEN 'Preventivo'
            WHEN 2 THEN 'Correctivo'
            WHEN 3 THEN 'Emergencia'
            ELSE 'Otro'
        END AS tipo_texto,
        CASE m.prioridad
            WHEN 1 THEN 'Alta'
            WHEN 2 THEN 'Media'
            WHEN 3 THEN 'Baja'
            ELSE 'Sin definir'
        END AS prioridad_texto,
        -- Horas que la cámara lleva o estuvo parada. Es el indicador que
        -- importa: cada hora de paro es capacidad que no se usó.
        CASE
            WHEN m.fecha_fin IS NOT NULL THEN
                ROUND(
                    EXTRACT(EPOCH FROM (
                        (m.fecha_fin + COALESCE(m.hora_fin, '00:00'::TIME))
                        - (m.fecha_inicio + m.hora_inicio)
                    )) / 3600,
                    1
                )
            WHEN m.estado = 2 THEN
                ROUND(
                    EXTRACT(EPOCH FROM (
                        CURRENT_TIMESTAMP - (m.fecha_inicio + m.hora_inicio)
                    )) / 3600,
                    1
                )
            ELSE NULL
        END AS horas_paro,
        -- La ocupación tipo 2 que generó el trigger. Si el mantenimiento
        -- está en proceso y esto viene NULL, algo salió mal.
        ocup.id_ocupacion AS id_ocupacion_bloqueo,
        ocup.estado       AS estado_bloqueo
    FROM mantenimientos m
    JOIN camaras c ON c.id_camara = m.id_camara
    LEFT JOIN LATERAL (
        SELECT o.id_ocupacion, o.estado
        FROM ocupaciones_camaras o
        WHERE o.id_mantenimiento = m.id_mantenimiento
          AND o.tipo_ocupacion = 2
        ORDER BY o.id_ocupacion DESC
        LIMIT 1
    ) ocup ON TRUE
`;

const getMantenimientos = async (
    {
        id_camara = null,
        estado = null,
        tipo = null,
        fecha_desde = null,
        fecha_hasta = null
    } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        ${SELECT_MANTENIMIENTO}
        WHERE ($1::INT IS NULL OR m.id_camara = $1)
          AND ($2::INT IS NULL OR m.estado = $2)
          AND ($3::INT IS NULL OR m.tipo = $3)
          AND ($4::DATE IS NULL OR m.fecha_inicio >= $4)
          AND ($5::DATE IS NULL OR m.fecha_inicio <= $5)
          AND ($6::INT[] IS NULL OR m.id_camara = ANY($6))
        ORDER BY
            -- Los activos arriba: son los que están afectando la operación
            CASE m.estado WHEN 2 THEN 0 WHEN 1 THEN 1 ELSE 2 END,
            m.fecha_inicio DESC, m.hora_inicio DESC
        LIMIT 500
        `,
        [id_camara, estado, tipo, fecha_desde, fecha_hasta, camaras]
    );
    return result.rows;
};

const getMantenimientoById = async (id_mantenimiento) => {
    const result = await db.query(
        `${SELECT_MANTENIMIENTO} WHERE m.id_mantenimiento = $1`,
        [id_mantenimiento]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Mantenimientos activos — los que están bloqueando cámaras ahora
// ----------------------------------------------------------------------------
// Es el reporte que explica por qué una cámara no recibe fruta.
const getActivos = async (camaras = null) => {
    const result = await db.query(
        `
        ${SELECT_MANTENIMIENTO}
        WHERE m.estado = 2
          AND ($1::INT[] IS NULL OR m.id_camara = ANY($1))
        ORDER BY m.fecha_inicio, m.hora_inicio
        `,
        [camaras]
    );
    return result.rows;
};

// Mantenimiento activo de una cámara concreta.
// El controller lo consulta antes de iniciar otro: dos ocupaciones tipo 2
// sobre la misma cámara dejarían una huérfana al finalizar la primera.
const getActivoPorCamara = async (id_camara, excluir_id = null) => {
    const result = await db.query(
        `
        SELECT m.id_mantenimiento, m.motivo, m.fecha_inicio, m.hora_inicio,
               m.estado
        FROM mantenimientos m
        WHERE m.id_camara = $1
          AND m.estado = 2
          AND ($2::INT IS NULL OR m.id_mantenimiento <> $2)
        LIMIT 1
        `,
        [id_camara, excluir_id]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Qué hay dentro de la cámara ahora mismo
// ----------------------------------------------------------------------------
// El controller lo consulta antes de iniciar un mantenimiento: bloquear una
// cámara con fruta adentro no la saca físicamente, solo impide que entre
// más. Hay que avisarlo.
const getContenidoCamara = async (id_camara) => {
    const result = await db.query(
        `
        SELECT
            COALESCE(SUM(o.cantidad_tarimas) FILTER (WHERE o.tipo_ocupacion = 1), 0)
                AS tarimas_dentro,
            COALESCE(SUM(o.cantidad_cajas) FILTER (WHERE o.tipo_ocupacion = 1), 0)
                AS cajas_dentro,
            COALESCE(SUM(o.cantidad_tarimas) FILTER (WHERE o.tipo_ocupacion = 3), 0)
                AS tarimas_en_cola,
            COUNT(*) FILTER (WHERE o.tipo_ocupacion = 3) AS procesos_en_cola
        FROM ocupaciones_camaras o
        WHERE o.id_camara = $1 AND o.estado = 1
        `,
        [id_camara]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Alta
// ----------------------------------------------------------------------------
// ⚠️ Si nace con estado 2, el trigger bloquea la cámara de inmediato.
// El controller valida antes que no haya otro mantenimiento activo.
const createMantenimiento = async ({
    id_camara,
    fecha_inicio,
    hora_inicio,
    fecha_fin,
    hora_fin,
    tipo,
    motivo,
    prioridad,
    estado
}) => {
    const result = await db.query(
        `
        INSERT INTO mantenimientos (
            id_camara, fecha_inicio, hora_inicio, fecha_fin, hora_fin,
            tipo, motivo, prioridad, estado
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
        `,
        [
            id_camara,
            fecha_inicio,
            hora_inicio,
            fecha_fin,
            hora_fin,
            tipo,
            motivo,
            prioridad,
            estado
        ]
    );
    return result.rows[0];
};

// Edición de datos administrativos. NO toca el estado: los cambios de
// estado van por sus propios métodos porque cada uno dispara el trigger de
// forma distinta.
const updateMantenimiento = async (
    id_mantenimiento,
    { fecha_inicio, hora_inicio, tipo, motivo, prioridad }
) => {
    const result = await db.query(
        `
        UPDATE mantenimientos
        SET fecha_inicio = $2,
            hora_inicio = $3,
            tipo = $4,
            motivo = $5,
            prioridad = $6
        WHERE id_mantenimiento = $1
        RETURNING *
        `,
        [id_mantenimiento, fecha_inicio, hora_inicio, tipo, motivo, prioridad]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Transiciones de estado
// ----------------------------------------------------------------------------
// Cada una va por su propio método porque el trigger reacciona distinto a
// cada valor. Mezclarlas en un update genérico haría muy fácil disparar un
// bloqueo sin querer.

// estado → 2. El trigger crea la ocupación tipo 2 que bloquea TODA la
// capacidad de la cámara.
//
// También se actualiza la fecha de inicio: si el mantenimiento se programó
// para las 8 y empezó a las 10, lo que importa para medir el paro es la
// hora real.
const iniciarMantenimiento = async (id_mantenimiento, { fecha, hora }) => {
    const result = await db.query(
        `
        UPDATE mantenimientos
        SET estado = 2,
            fecha_inicio = COALESCE($2::DATE, fecha_inicio),
            hora_inicio  = COALESCE($3::TIME, hora_inicio)
        WHERE id_mantenimiento = $1
        RETURNING *
        `,
        [id_mantenimiento, fecha, hora]
    );
    return result.rows[0];
};

// estado → 3. El trigger cierra la ocupación tipo 2 y libera la cámara.
//
// fecha_fin y hora_fin son obligatorias aquí: el trigger las escribe en la
// ocupación al cerrarla, y sin ellas el histórico queda sin la hora real de
// liberación.
const finalizarMantenimiento = async (id_mantenimiento, { fecha, hora }) => {
    const result = await db.query(
        `
        UPDATE mantenimientos
        SET estado = 3,
            fecha_fin = COALESCE($2::DATE, CURRENT_DATE),
            hora_fin  = COALESCE($3::TIME, CURRENT_TIME)
        WHERE id_mantenimiento = $1
        RETURNING *
        `,
        [id_mantenimiento, fecha, hora]
    );
    return result.rows[0];
};

// estado → 4. SOLO desde 'programado' (1).
//
// ⚠️ El trigger no tiene rama para el 4: cancelar uno que esté en proceso
// dejaría su ocupación tipo 2 activa para siempre. El controller lo impide.
const cancelarMantenimiento = async (id_mantenimiento) => {
    const result = await db.query(
        `
        UPDATE mantenimientos SET estado = 4
        WHERE id_mantenimiento = $1
        RETURNING *
        `,
        [id_mantenimiento]
    );
    return result.rows[0];
};

// Borrado físico. Solo para un alta mal capturada que nunca llegó a
// bloquear nada: si generó una ocupación, la FK lo impide.
const deleteMantenimiento = async (id_mantenimiento) => {
    const result = await db.query(
        `DELETE FROM mantenimientos WHERE id_mantenimiento = $1 RETURNING *`,
        [id_mantenimiento]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Ocupaciones de bloqueo huérfanas — diagnóstico
// ----------------------------------------------------------------------------
// Ocupaciones tipo 2 que siguen activas aunque su mantenimiento ya no esté
// en proceso. No deberían existir, pero el trigger no cubre el estado 4 y
// una cancelación hecha directo en la BD las dejaría así.
//
// Es la consulta que explica por qué una cámara sigue bloqueada sin
// mantenimiento visible.
const getBloqueosHuerfanos = async (camaras = null) => {
    const result = await db.query(
        `
        SELECT
            o.id_ocupacion,
            o.id_camara,
            c.nombre_camara,
            o.fecha_inicio,
            o.hora_inicio,
            o.observaciones,
            o.id_mantenimiento,
            m.estado        AS estado_mantenimiento,
            CASE m.estado
                WHEN 1 THEN 'Programado'
                WHEN 2 THEN 'En proceso'
                WHEN 3 THEN 'Finalizado'
                WHEN 4 THEN 'Cancelado'
                ELSE 'Sin mantenimiento ligado'
            END AS estado_texto
        FROM ocupaciones_camaras o
        JOIN camaras c ON c.id_camara = o.id_camara
        LEFT JOIN mantenimientos m ON m.id_mantenimiento = o.id_mantenimiento
        WHERE o.tipo_ocupacion = 2
          AND o.estado = 1
          AND (m.id_mantenimiento IS NULL OR m.estado <> 2)
          AND ($1::INT[] IS NULL OR o.id_camara = ANY($1))
        ORDER BY o.fecha_inicio
        `,
        [camaras]
    );
    return result.rows;
};

// Cierra a mano una ocupación de bloqueo huérfana. Es la salida de
// emergencia cuando una cámara quedó trabada.
const cerrarBloqueo = async (id_ocupacion) => {
    const result = await db.query(
        `
        UPDATE ocupaciones_camaras
        SET estado = 0,
            fecha_fin = CURRENT_DATE,
            hora_fin = CURRENT_TIME,
            observaciones = COALESCE(observaciones, '') ||
                ' · Liberado manualmente desde el módulo de mantenimientos'
        WHERE id_ocupacion = $1
          AND tipo_ocupacion = 2
          AND estado = 1
        RETURNING *
        `,
        [id_ocupacion]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Historial de paros por cámara
// ----------------------------------------------------------------------------
// Cuántas horas estuvo parada cada cámara y por qué. Es el insumo para
// decidir si un equipo ya necesita reemplazo.
const getResumenPorCamara = async (
    { fecha_desde = null, fecha_hasta = null } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        SELECT
            m.id_camara,
            c.nombre_camara,
            c.tipo_camara,
            COUNT(*)                                  AS total_mantenimientos,
            COUNT(*) FILTER (WHERE m.tipo = 1)        AS preventivos,
            COUNT(*) FILTER (WHERE m.tipo = 2)        AS correctivos,
            COUNT(*) FILTER (WHERE m.tipo = 3)        AS emergencias,
            COUNT(*) FILTER (WHERE m.estado = 2)      AS en_proceso,
            ROUND(SUM(
                CASE WHEN m.fecha_fin IS NOT NULL THEN
                    EXTRACT(EPOCH FROM (
                        (m.fecha_fin + COALESCE(m.hora_fin, '00:00'::TIME))
                        - (m.fecha_inicio + m.hora_inicio)
                    )) / 3600
                ELSE 0 END
            )::NUMERIC, 1) AS horas_paro_total
        FROM mantenimientos m
        JOIN camaras c ON c.id_camara = m.id_camara
        WHERE ($1::DATE IS NULL OR m.fecha_inicio >= $1)
          AND ($2::DATE IS NULL OR m.fecha_inicio <= $2)
          AND ($3::INT[] IS NULL OR m.id_camara = ANY($3))
        GROUP BY m.id_camara, c.nombre_camara, c.tipo_camara
        ORDER BY horas_paro_total DESC
        `,
        [fecha_desde, fecha_hasta, camaras]
    );
    return result.rows;
};

const mantenimientosModel = {
    getMantenimientos,
    getMantenimientoById,
    getActivos,
    getActivoPorCamara,
    getContenidoCamara,
    createMantenimiento,
    updateMantenimiento,
    iniciarMantenimiento,
    finalizarMantenimiento,
    cancelarMantenimiento,
    deleteMantenimiento,
    getBloqueosHuerfanos,
    cerrarBloqueo,
    getResumenPorCamara
};

export default mantenimientosModel;
