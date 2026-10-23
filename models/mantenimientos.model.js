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
//     estado → 4 (cancelado)   también la cierra (v2.4)
//
//   v3: con el bloqueo activo la cámara NO RECIBE FRUTA. Lo garantizan en la
//   BD trg_recepcion_camara_bloqueada y trg_movimiento_camara_bloqueada.
//
// v3 · PROGRAMADOS
//   Un preventivo programado (estado 1) se inicia solo a su hora:
//   fn_activar_mantenimientos_programados, llamada por
//   utils/mantenimientosProgramados.js.
//
// ESTADOS
//   1 = programado   agendado, la cámara sigue operando
//   2 = en proceso   bloquea TODA la capacidad
//   3 = finalizado   libera la cámara
//   4 = cancelado    solo desde 'programado' (criterio del controller)
//
// "AHORA" EN LA ZONA DE OPERACIÓN
//   fecha_inicio/hora_inicio se capturan en hora local. Las horas de paro se
//   calculan contra (now() AT TIME ZONE zona), no contra CURRENT_TIMESTAMP:
//   con la BD en UTC, un paro en proceso salía con 6 horas de más.
//
// ALCANCE
//   La tabla SÍ tiene id_camara: validarCamaraEnAlcance("body") alcanza para
//   las escrituras.
// ============================================================================

/** Zona de operación como literal SQL seguro (viene del .env). */
const zonaSQL = () => {
    const z = process.env.ZONA_HORARIA || "America/Mexico_City";
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(z) ? `'${z}'` : "'America/Mexico_City'";
};

const ahoraSQL = () => `(now() AT TIME ZONE ${zonaSQL()})`;

const selectMantenimiento = () => `
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
                ROUND(EXTRACT(EPOCH FROM (
                    (m.fecha_fin + COALESCE(m.hora_fin, '00:00'::TIME))
                    - (m.fecha_inicio + m.hora_inicio)
                )) / 3600, 1)
            WHEN m.estado = 2 THEN
                ROUND(EXTRACT(EPOCH FROM (
                    ${ahoraSQL()} - (m.fecha_inicio + m.hora_inicio)
                )) / 3600, 1)
            ELSE NULL
        END AS horas_paro,
        -- Programados: cuántas horas faltan para que bloquee
        CASE WHEN m.estado = 1 THEN
            ROUND(EXTRACT(EPOCH FROM (
                (m.fecha_inicio + m.hora_inicio) - ${ahoraSQL()}
            )) / 3600, 1)
        END AS horas_para_inicio,
        ur.usuario  AS usuario_registro,
        er.nombre   AS nombre_registro,
        er.apellidos AS apellidos_registro,
        uc.usuario  AS usuario_cierre,
        ec.nombre   AS nombre_cierre,
        ec.apellidos AS apellidos_cierre,
        -- La ocupación tipo 2 que generó el trigger. Si el mantenimiento
        -- está en proceso y esto viene NULL, algo salió mal.
        ocup.id_ocupacion AS id_ocupacion_bloqueo,
        ocup.estado       AS estado_bloqueo
    FROM mantenimientos m
    JOIN camaras c ON c.id_camara = m.id_camara
    LEFT JOIN usuarios  ur ON ur.id_usuario  = m.id_usuario_registro
    LEFT JOIN empleados er ON er.id_empleado = ur.id_empleado
    LEFT JOIN usuarios  uc ON uc.id_usuario  = m.id_usuario_cierre
    LEFT JOIN empleados ec ON ec.id_empleado = uc.id_empleado
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
        ${selectMantenimiento()}
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
        `${selectMantenimiento()} WHERE m.id_mantenimiento = $1`,
        [id_mantenimiento]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Mantenimientos activos — los que están bloqueando cámaras ahora
// ----------------------------------------------------------------------------
const getActivos = async (camaras = null) => {
    const result = await db.query(
        `
        ${selectMantenimiento()}
        WHERE m.estado = 2
          AND ($1::INT[] IS NULL OR m.id_camara = ANY($1))
        ORDER BY m.fecha_inicio, m.hora_inicio
        `,
        [camaras]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Tablero: cada cámara con su situación
// ----------------------------------------------------------------------------
// Operando / fuera de servicio / con preventivo programado, y la fruta que
// tiene dentro y en cola. La pantalla principal del módulo.
const getTablero = async (camaras = null) => {
    const result = await db.query(
        `
        SELECT
            c.id_camara, c.nombre_camara, c.tipo_camara, c.ubicacion,
            c.capacidad_max_tarimas,
            public.fn_camara_bloqueada(c.id_camara) AS bloqueada,
            act.id_mantenimiento AS id_activo,
            act.tipo             AS tipo_activo,
            act.motivo           AS motivo_activo,
            act.fecha_inicio     AS fecha_inicio_activo,
            act.hora_inicio      AS hora_inicio_activo,
            CASE WHEN act.id_mantenimiento IS NOT NULL THEN
                ROUND(EXTRACT(EPOCH FROM (${ahoraSQL()} - (act.fecha_inicio + act.hora_inicio))) / 3600, 1)
            END AS horas_paro,
            prog.id_mantenimiento AS id_programado,
            prog.motivo           AS motivo_programado,
            prog.fecha_inicio     AS fecha_programado,
            prog.hora_inicio      AS hora_programado,
            COALESCE(inv.tarimas, 0)::INT AS tarimas_dentro,
            COALESCE(inv.cajas, 0)::INT   AS cajas_dentro,
            COALESCE(cola.tarimas, 0)::INT AS tarimas_en_cola
        FROM camaras c
        LEFT JOIN LATERAL (
            SELECT id_mantenimiento, tipo, motivo, fecha_inicio, hora_inicio
            FROM mantenimientos
            WHERE id_camara = c.id_camara AND estado = 2
            ORDER BY fecha_inicio, hora_inicio LIMIT 1
        ) act ON TRUE
        LEFT JOIN LATERAL (
            SELECT id_mantenimiento, motivo, fecha_inicio, hora_inicio
            FROM mantenimientos
            WHERE id_camara = c.id_camara AND estado = 1
            ORDER BY fecha_inicio, hora_inicio LIMIT 1
        ) prog ON TRUE
        LEFT JOIN LATERAL (
            SELECT SUM(cantidad_tarimas) AS tarimas, SUM(cantidad_cajas) AS cajas
            FROM ocupaciones_camaras
            WHERE id_camara = c.id_camara AND tipo_ocupacion = 1 AND estado = 1
        ) inv ON TRUE
        LEFT JOIN LATERAL (
            SELECT SUM(cantidad_tarimas) AS tarimas
            FROM ocupaciones_camaras
            WHERE id_camara = c.id_camara AND tipo_ocupacion = 3 AND estado = 1
        ) cola ON TRUE
        WHERE c.estado = 1
          AND ($1::INT[] IS NULL OR c.id_camara = ANY($1))
        ORDER BY c.tipo_camara, c.nombre_camara
        `,
        [camaras]
    );
    return result.rows;
};

// Fruta dentro de la cámara, por lote: lo que hay que reubicar cuando la
// cámara se para.
const getFrutaDentro = async (id_camara) => {
    const result = await db.query(
        `
        SELECT id_ocupacion, id_produccion, codigo_lote, codigo_sku, calidad_sku,
               codigo_productor, codigo_finca, nombre_finca, acronimo_cc,
               fecha_empaque, fecha_entrega, tarimas_disponibles, cajas_disponibles,
               nivel_criticidad, criticidad_texto
        FROM vw_inventario_disponible
        WHERE id_camara = $1
        ORDER BY nivel_criticidad, fecha_empaque NULLS LAST, id_ocupacion
        `,
        [id_camara]
    );
    return result.rows;
};

// Mantenimiento activo de una cámara concreta.
// Dos mantenimientos en proceso sobre la misma cámara dejarían uno sin
// ocupación de bloqueo propia.
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
// Qué hay dentro de la cámara ahora mismo (totales)
// ----------------------------------------------------------------------------
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
const createMantenimiento = async ({
    id_camara,
    fecha_inicio,
    hora_inicio,
    fecha_fin,
    hora_fin,
    tipo,
    motivo,
    prioridad,
    estado,
    observaciones,
    id_usuario
}) => {
    const result = await db.query(
        `
        INSERT INTO mantenimientos (
            id_camara, fecha_inicio, hora_inicio, fecha_fin, hora_fin,
            tipo, motivo, prioridad, estado,
            observaciones, id_usuario_registro, fecha_hora_registro
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, ${ahoraSQL()})
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
            estado,
            observaciones,
            id_usuario
        ]
    );
    return result.rows[0];
};

// Edición de datos administrativos. NO toca el estado.
const updateMantenimiento = async (
    id_mantenimiento,
    { fecha_inicio, hora_inicio, tipo, motivo, prioridad, observaciones }
) => {
    const result = await db.query(
        `
        UPDATE mantenimientos
        SET fecha_inicio = $2,
            hora_inicio = $3,
            tipo = $4,
            motivo = $5,
            prioridad = $6,
            observaciones = $7
        WHERE id_mantenimiento = $1
        RETURNING *
        `,
        [id_mantenimiento, fecha_inicio, hora_inicio, tipo, motivo, prioridad, observaciones]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Transiciones de estado
// ----------------------------------------------------------------------------
// Cada una va por su propio método porque el trigger reacciona distinto a
// cada valor.

// estado → 2. El trigger bloquea TODA la capacidad de la cámara.
// La fecha/hora de inicio se ajusta a la real si viene.
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
const finalizarMantenimiento = async (id_mantenimiento, { fecha, hora, comentario, id_usuario }) => {
    const result = await db.query(
        `
        UPDATE mantenimientos
        SET estado = 3,
            fecha_fin = $2::DATE,
            hora_fin  = $3::TIME,
            comentario_cierre = $4,
            id_usuario_cierre = $5
        WHERE id_mantenimiento = $1
        RETURNING *
        `,
        [id_mantenimiento, fecha, hora, comentario, id_usuario]
    );
    return result.rows[0];
};

// estado → 4. Solo desde 'programado' (criterio del controller).
const cancelarMantenimiento = async (id_mantenimiento, { comentario, id_usuario }) => {
    const result = await db.query(
        `
        UPDATE mantenimientos
        SET estado = 4,
            comentario_cierre = COALESCE($2, comentario_cierre),
            id_usuario_cierre = $3
        WHERE id_mantenimiento = $1
        RETURNING *
        `,
        [id_mantenimiento, comentario, id_usuario]
    );
    return result.rows[0];
};

// Borrado físico. Solo para un alta mal capturada que nunca bloqueó nada.
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

// Cierra a mano una ocupación de bloqueo huérfana.
const cerrarBloqueo = async (id_ocupacion) => {
    const result = await db.query(
        `
        UPDATE ocupaciones_camaras
        SET estado = 0,
            fecha_fin = ${ahoraSQL()}::DATE,
            hora_fin = ${ahoraSQL()}::TIME,
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
// Los cancelados no suman horas: nunca llegaron a bloquear.
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
                CASE WHEN m.fecha_fin IS NOT NULL AND m.estado = 3 THEN
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
    getTablero,
    getFrutaDentro,
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
