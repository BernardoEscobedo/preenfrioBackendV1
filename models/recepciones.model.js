import { db } from "../database/connection.database.js";

// ============================================================================
// RECEPCIONES
// ============================================================================
// Lo que REALMENTE llega al andén, contra lo que decía el plan. Relación
// 1..N con producción: un mismo proceso puede llegar en varios viajes.
//
// ⚠️ REGLA DE ORO DE ESTE MÓDULO
//   Este modelo NUNCA escribe en ocupaciones_camaras. Tres triggers hacen
//   todo el trabajo de inventario:
//
//     trg_sync_ocupacion_recepcion     AL INSERTAR: mete a la cámara lo que
//                                      quepa (tipo 1), manda el excedente a
//                                      la COLA (tipo 3) y, desde la v2.5,
//                                      escribe de vuelta tarimas_ingresadas
//
//     trg_revertir_recepcion  (v2.5)   AL CAMBIAR EL ESTADO: si se cancela,
//                                      descuenta lo que entró y cierra su
//                                      cola; si se reactiva, lo vuelve a
//                                      sumar
//
//     trg_actualizar_estado_produccion mueve la producción a estado 2
//                                      (en recepción) o 3 (recibida)
//
//   La lógica vive en la BD a propósito: así cualquier origen de datos
//   —este backend, una importación masiva, una corrección manual en
//   Supabase— mantiene las ocupaciones cuadradas.
//
// DIVISIÓN DENTRO / EN ESPERA
//   tarimas_recibidas   = lo que llegó al andén
//   tarimas_ingresadas  = lo que ENTRÓ físicamente a la cámara
//   La diferencia queda en la cola (tipo_ocupacion = 3), esperando espacio.
//
//   Si tarimas_ingresadas viene NULL, el trigger calcula lo que quepa con
//   fn_tarimas_disponibles y lo guarda. Si viene con número, se respeta: el
//   operador vio el patio y decidió.
//
// CONFIRMACIÓN Y ALERTAS (recepciones_cierres)
//   El operativo marca cada línea como COMPLETA o NO LLEGÓ. El trigger
//   trg_cierre_recepcion calcula plan contra recibido y deja la alerta al
//   coordinador si hay CUALQUIER diferencia (sin tolerancia). Una línea
//   completa no admite más recepciones hasta que el coordinador la reabra
//   (trg_proteger_linea_cerrada).
//
// ALCANCE POR CÁMARA
//   Los modelos reciben req.camaras y filtran por r.id_camara: la cámara
//   donde se recibió de verdad, que puede diferir de la planeada.
// ============================================================================

const SELECT_RECEPCION = `
    SELECT
        r.*,
        -- Trazabilidad completa sin que el front haga N+1 consultas
        p.codigo_lote,
        p.semana,
        p.fecha_empaque,
        p.fecha_entrega,
        p.cajas_procesadas    AS cajas_planeadas,
        p.estiba_pallets      AS tarimas_planeadas,
        p.id_camara           AS camara_planeada,
        f.codigo_finca,
        f.nombre              AS nombre_finca,
        pr.codigo_productor,
        pr.nombre             AS nombre_productor,
        s.codigo_sku,
        s.calidad             AS calidad_sku,
        cc.cliente,
        cc.cedis,
        cc.acronimo           AS acronimo_cc,
        cam.nombre_camara,
        cam.tipo_camara,
        -- Quién la registró: dato clave para auditar diferencias
        e.nombre              AS nombre_usuario,
        e.apellidos           AS apellidos_usuario,
        u.usuario,
        CASE r.estado
            WHEN 1 THEN 'Activa'
            WHEN 0 THEN 'Cancelada'
            ELSE 'Otro'
        END                   AS estado_texto,
        -- Lo que quedó esperando fuera de la cámara.
        -- COALESCE por las recepciones anteriores a la v2.5, cuando el
        -- trigger calculaba lo que entraba pero no lo escribía de vuelta.
        GREATEST(
            r.tarimas_recibidas - COALESCE(r.tarimas_ingresadas, r.tarimas_recibidas),
            0
        )                     AS tarimas_en_cola
    FROM recepciones r
    JOIN produccion    p   ON p.id_produccion = r.id_produccion
    JOIN fincas        f   ON f.id_finca      = p.id_finca
    JOIN productores   pr  ON pr.id_productor = p.id_productor
    JOIN sku_pt        s   ON s.id_sku        = p.id_sku
    JOIN cedis_cliente cc  ON cc.id_cc        = p.id_cc
    LEFT JOIN camaras  cam ON cam.id_camara   = r.id_camara
    LEFT JOIN usuarios u   ON u.id_usuario    = r.id_usuario
    LEFT JOIN empleados e  ON e.id_empleado   = u.id_empleado
`;

// ----------------------------------------------------------------------------
// Listado con filtros y alcance
// ----------------------------------------------------------------------------
// El filtro de alcance mira r.id_camara (dónde entró de verdad), no la
// planeada: si el camión se desvió a otra cámara, la recepción pertenece a
// quien la recibió.
const getRecepciones = async (
    {
        id_produccion = null,
        id_camara = null,
        estado = null,
        fecha_desde = null,
        fecha_hasta = null,
        buscar = null
    } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        ${SELECT_RECEPCION}
        WHERE ($1::INT IS NULL OR r.id_produccion = $1)
          AND ($2::INT IS NULL OR r.id_camara = $2)
          AND ($3::INT IS NULL OR r.estado = $3)
          AND ($4::DATE IS NULL OR r.fecha_recepcion >= $4)
          AND ($5::DATE IS NULL OR r.fecha_recepcion <= $5)
          AND ($6::INT[] IS NULL OR r.id_camara = ANY($6))
          AND ($7::TEXT IS NULL
               OR p.codigo_lote ILIKE '%' || $7 || '%'
               OR f.nombre ILIKE '%' || $7 || '%'
               OR cc.cliente ILIKE '%' || $7 || '%')
        ORDER BY r.fecha_recepcion DESC, r.hora_recepcion DESC, r.id_recepcion DESC
        `,
        [
            id_produccion,
            id_camara,
            estado,
            fecha_desde,
            fecha_hasta,
            camaras,
            buscar
        ]
    );
    return result.rows;
};

// Una recepción por id, SIN filtrar alcance.
// El controller compara después para distinguir 404 de 403.
const getRecepcionById = async (id_recepcion) => {
    const result = await db.query(
        `${SELECT_RECEPCION} WHERE r.id_recepcion = $1`,
        [id_recepcion]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Qué espera recibir el preenfrío
// ----------------------------------------------------------------------------
// Parte de vw_recepciones_esperadas (plan contra recibido) y le agrega el
// estado de la confirmación:
//
//   estado_recepcion
//     'pendiente'  no ha llegado nada
//     'no_llego'   el operativo marcó que no llegó (sigue abierta)
//     'parcial'    ya llegó algo, falta confirmar
//     'completa'   confirmada como completa (cerrada)
//
// Solo producción CON cámara asignada: lo que el coordinador no asignó no
// pasa por preenfrío y no se espera en el andén.
//
// solo_pendientes: oculta las líneas confirmadas. Antes se filtraba por
// tarimas_pendientes > 0, que escondía las líneas a granel (0 tarimas) y
// las que llegaron de más.
const getEsperadas = async (
    { semana = null, solo_pendientes = true, id_camara = null } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        SELECT
            v.*,
            c.id_cierre,
            c.fecha_hora          AS fecha_hora_cierre,
            c.diferencia_cajas    AS diferencia_cajas_cierre,
            c.diferencia_tarimas  AS diferencia_tarimas_cierre,
            c.alerta_estado,
            COALESCE(nl.veces, 0) AS veces_no_llego,
            nl.ultima             AS ultimo_no_llego,
            COALESCE(rc.viajes, 0) AS recepciones,
            CASE
                WHEN c.id_cierre IS NOT NULL                          THEN 'completa'
                WHEN v.cajas_recibidas > 0 OR v.tarimas_recibidas > 0 THEN 'parcial'
                WHEN nl.veces > 0                                     THEN 'no_llego'
                ELSE 'pendiente'
            END AS estado_recepcion
        FROM vw_recepciones_esperadas v
        LEFT JOIN recepciones_cierres c
               ON c.id_produccion = v.id_produccion AND c.tipo_cierre = 1 AND c.vigente
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::INT AS veces, MAX(fecha_cierre) AS ultima
            FROM recepciones_cierres
            WHERE id_produccion = v.id_produccion AND tipo_cierre = 2
        ) nl ON true
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::INT AS viajes
            FROM recepciones
            WHERE id_produccion = v.id_produccion AND estado = 1
        ) rc ON true
        WHERE v.id_camara IS NOT NULL
          AND ($1::INT IS NULL OR v.semana = $1)
          AND ($2::INT IS NULL OR v.id_camara = $2)
          AND ($3::INT[] IS NULL OR v.id_camara = ANY($3))
          AND ($4::BOOLEAN IS FALSE OR c.id_cierre IS NULL)
        ORDER BY v.fecha_empaque, v.codigo_lote, v.codigo_sku, v.id_produccion
        `,
        [semana, id_camara, camaras, solo_pendientes]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Alta — el INSERT que dispara los triggers
// ----------------------------------------------------------------------------
// Solo se escribe en 'recepciones'. Las ocupaciones y el estado de la
// producción los resuelve la BD.
//
// tarimas_ingresadas puede ir NULL: el trigger calcula lo que quepa y lo
// guarda. cajas_ingresadas se acepta por contrato con el frontend, pero el
// trigger reparte las cajas en proporción a las tarimas y sobrescribe el
// valor.
//
// Recibe el ejecutor (db o un cliente de transacción) para que la
// recepción por lote inserte varias líneas en una sola transacción.
const createRecepcion = async (
    {
        id_produccion,
        id_camara,
        fecha_recepcion,
        hora_recepcion,
        cajas_recibidas,
        tarimas_recibidas,
        tarimas_ingresadas,
        cajas_ingresadas,
        temperatura,
        id_usuario,
        observaciones
    },
    ejecutor = db
) => {
    const result = await ejecutor.query(
        `
        INSERT INTO recepciones (
            id_produccion, id_camara, fecha_recepcion, hora_recepcion,
            cajas_recibidas, tarimas_recibidas,
            tarimas_ingresadas, cajas_ingresadas,
            temperatura, id_usuario, observaciones
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
        `,
        [
            id_produccion,
            id_camara,
            fecha_recepcion,
            hora_recepcion,
            cajas_recibidas,
            tarimas_recibidas,
            tarimas_ingresadas ?? null,
            cajas_ingresadas ?? null,
            temperatura,
            id_usuario,
            observaciones
        ]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Edición — MUY limitada a propósito
// ----------------------------------------------------------------------------
// Solo se permiten datos administrativos: temperatura y observaciones.
//
// POR QUÉ NO SE EDITAN LAS CANTIDADES
//   trg_revertir_recepcion reacciona al cambio de ESTADO, no a un cambio de
//   cantidades. Un UPDATE de tarimas_recibidas cambiaría el número en la
//   tabla sin mover la ocupación correspondiente.
//
//   Si la cantidad estuvo mal, se cancela la recepción (eso sí libera la
//   cámara) y se captura otra. Además deja rastro de la corrección.
const updateRecepcion = async (
    id_recepcion,
    { temperatura, observaciones }
) => {
    const result = await db.query(
        `
        UPDATE recepciones
        SET temperatura = $2, observaciones = $3
        WHERE id_recepcion = $1
        RETURNING *
        `,
        [id_recepcion, temperatura, observaciones]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Cancelación
// ----------------------------------------------------------------------------
// estado = 0. Dispara dos triggers:
//   · trg_revertir_recepcion (v2.5) descuenta de la cámara lo que esta
//     recepción metió y cierra su fila de cola
//   · trg_actualizar_estado_produccion recalcula el estado de la producción
//
// Si la línea ya se confirmó como completa, trg_proteger_linea_cerrada lo
// rechaza: hay que reabrirla primero.
const cancelarRecepcion = async (id_recepcion) => {
    const result = await db.query(
        `
        UPDATE recepciones SET estado = 0
        WHERE id_recepcion = $1
        RETURNING *
        `,
        [id_recepcion]
    );
    return result.rows[0];
};

// Reactivar: trg_revertir_recepcion vuelve a sumar lo que había entrado. Lo
// que estaba en cola se suma directo a la cámara: la fila de espera no se
// reconstruye porque ya no se conoce su lugar en el orden.
const reactivarRecepcion = async (id_recepcion) => {
    const result = await db.query(
        `
        UPDATE recepciones SET estado = 1
        WHERE id_recepcion = $1
        RETURNING *
        `,
        [id_recepcion]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Ocupaciones generadas por una recepción
// ----------------------------------------------------------------------------
// Permite ver qué hicieron los triggers. Es la herramienta de diagnóstico
// cuando alguien pregunta "¿por qué mi fruta no está dentro?".
//
// ⚠️ La ocupación tipo 1 es COMPARTIDA entre todas las recepciones de la
// cámara y solo lleva el id de la primera que la creó. Por eso, para la
// segunda recepción en adelante, aquí solo aparece su fila de cola (si la
// hubo). Lo que entró se lee de recepciones.tarimas_ingresadas.
const getOcupacionesGeneradas = async (id_recepcion) => {
    const result = await db.query(
        `
        SELECT
            o.id_ocupacion,
            o.id_camara,
            c.nombre_camara,
            o.tipo_ocupacion,
            CASE o.tipo_ocupacion
                WHEN 1 THEN 'Dentro de cámara'
                WHEN 2 THEN 'Bloqueo por mantenimiento'
                WHEN 3 THEN 'En cola de espera'
                ELSE 'Otro'
            END AS tipo_texto,
            o.cantidad_tarimas,
            o.cantidad_cajas,
            o.fecha_inicio,
            o.hora_inicio,
            o.prioridad,
            o.estado,
            o.observaciones
        FROM ocupaciones_camaras o
        JOIN camaras c ON c.id_camara = o.id_camara
        WHERE o.id_recepcion = $1
        ORDER BY o.tipo_ocupacion, o.id_ocupacion
        `,
        [id_recepcion]
    );
    return result.rows;
};

// Capacidad de una cámara.
//
// ⚠️ Para comparar antes/después usa tarimas_ocupadas, no
// tarimas_disponibles: la segunda sale de fn_tarimas_disponibles, que nunca
// baja de 0 y vale 0 en mantenimiento.
const getDisponibilidad = async (id_camara, ejecutor = db) => {
    const result = await ejecutor.query(
        `
        SELECT
            c.id_camara,
            c.nombre_camara,
            c.capacidad_max_tarimas,
            c.estado,
            fn_tarimas_disponibles(c.id_camara) AS tarimas_disponibles,
            COALESCE(inv.tarimas_ocupadas, 0)   AS tarimas_ocupadas,
            EXISTS(
                SELECT 1 FROM ocupaciones_camaras
                WHERE id_camara = c.id_camara
                  AND tipo_ocupacion = 2 AND estado = 1
            ) AS en_mantenimiento
        FROM camaras c
        LEFT JOIN (
            SELECT id_camara, SUM(cantidad_tarimas) AS tarimas_ocupadas
            FROM ocupaciones_camaras
            WHERE tipo_ocupacion = 1 AND estado = 1
            GROUP BY id_camara
        ) inv ON inv.id_camara = c.id_camara
        WHERE c.id_camara = $1
        `,
        [id_camara]
    );
    return result.rows[0];
};

// ============================================================================
// RECEPCIÓN POR LOTE Y CONFIRMACIÓN
// ============================================================================

// Líneas a recibir, bloqueadas para que dos operativos no capturen la misma
// a la vez. Trae lo ya recibido y si hay una confirmación vigente.
const getLineasParaRecibir = async (ejecutor, ids) => {
    const result = await ejecutor.query(
        `
        SELECT
            p.id_produccion,
            p.codigo_lote,
            p.estado,
            p.id_camara,
            p.cajas_procesadas  AS cajas_planeadas,
            p.estiba_pallets    AS tarimas_planeadas,
            s.codigo_sku,
            cam.nombre_camara,
            COALESCE((SELECT SUM(r.cajas_recibidas) FROM recepciones r
                      WHERE r.id_produccion = p.id_produccion AND r.estado = 1), 0)::INT
                                AS cajas_recibidas,
            COALESCE((SELECT SUM(r.tarimas_recibidas) FROM recepciones r
                      WHERE r.id_produccion = p.id_produccion AND r.estado = 1), 0)::INT
                                AS tarimas_recibidas,
            (SELECT c.id_cierre FROM recepciones_cierres c
              WHERE c.id_produccion = p.id_produccion AND c.tipo_cierre = 1 AND c.vigente)
                                AS id_cierre_vigente
        FROM produccion p
        JOIN sku_pt s        ON s.id_sku      = p.id_sku
        LEFT JOIN camaras cam ON cam.id_camara = p.id_camara
        WHERE p.id_produccion = ANY($1::INT[])
        FOR UPDATE OF p
        `,
        [ids]
    );
    return result.rows;
};

// Recepciones recién insertadas, ya con lo que escribió el trigger
// (tarimas_ingresadas). Se lee dentro de la misma transacción.
const getResultadoRecepciones = async (ejecutor, ids) => {
    if (ids.length === 0) return [];
    const result = await ejecutor.query(
        `
        SELECT r.id_recepcion, r.id_produccion, r.id_camara,
               r.tarimas_recibidas, r.cajas_recibidas,
               COALESCE(r.tarimas_ingresadas, r.tarimas_recibidas) AS tarimas_ingresadas,
               GREATEST(r.tarimas_recibidas - COALESCE(r.tarimas_ingresadas, r.tarimas_recibidas), 0)
                   AS tarimas_en_cola,
               cam.nombre_camara
        FROM recepciones r
        LEFT JOIN camaras cam ON cam.id_camara = r.id_camara
        WHERE r.id_recepcion = ANY($1::INT[])
        `,
        [ids]
    );
    return result.rows;
};

// Confirmación COMPLETA. Plan, recibido y alerta los calcula el trigger.
const confirmarCompleta = async (ejecutor, { id_produccion, fecha_cierre, id_camara, observaciones, id_usuario }) => {
    const result = await ejecutor.query(
        `
        INSERT INTO recepciones_cierres (
            id_produccion, tipo_cierre, fecha_cierre, id_camara, observaciones, id_usuario
        )
        VALUES ($1, 1, $2, $3, $4, $5)
        RETURNING *
        `,
        [id_produccion, fecha_cierre, id_camara, observaciones, id_usuario]
    );
    return result.rows[0];
};

// "No llegó": la línea sigue abierta (puede llegar al día siguiente).
// Solo uno por línea y por día: repetirlo el mismo día no duplica la alerta.
const marcarNoLlego = async (ejecutor, { id_produccion, fecha_cierre, id_camara, observaciones, id_usuario }) => {
    const result = await ejecutor.query(
        `
        INSERT INTO recepciones_cierres (
            id_produccion, tipo_cierre, fecha_cierre, id_camara, observaciones, id_usuario
        )
        VALUES ($1, 2, $2, $3, $4, $5)
        ON CONFLICT (id_produccion, fecha_cierre) WHERE tipo_cierre = 2 DO NOTHING
        RETURNING *
        `,
        [id_produccion, fecha_cierre, id_camara, observaciones, id_usuario]
    );
    return result.rows[0];
};

// ============================================================================
// ALERTAS PARA EL COORDINADOR
// ============================================================================
const SELECT_ALERTA = `
    SELECT
        c.*,
        CASE c.tipo_cierre WHEN 1 THEN 'DIFERENCIA' ELSE 'NO_LLEGO' END AS tipo_alerta,
        CASE c.alerta_estado WHEN 1 THEN 'Pendiente' WHEN 2 THEN 'Atendida' ELSE 'Sin alerta' END
                              AS alerta_estado_texto,
        p.codigo_lote,
        p.semana,
        p.fecha_empaque,
        p.fecha_entrega,
        p.region,
        p.comentarios         AS comentarios_produccion,
        f.codigo_finca,
        f.nombre              AS nombre_finca,
        pr.codigo_productor,
        pr.nombre             AS nombre_productor,
        s.codigo_sku,
        s.calidad             AS calidad_sku,
        cc.cliente,
        cc.cedis,
        cc.acronimo           AS acronimo_cc,
        COALESCE(c.id_camara, p.id_camara) AS id_camara_alerta,
        cam.nombre_camara,
        u.usuario             AS usuario_registro,
        e.nombre              AS nombre_registro,
        e.apellidos           AS apellidos_registro,
        ua.usuario            AS usuario_atencion,
        ea.nombre             AS nombre_atencion,
        ea.apellidos          AS apellidos_atencion
    FROM recepciones_cierres c
    JOIN produccion    p   ON p.id_produccion = c.id_produccion
    JOIN fincas        f   ON f.id_finca      = p.id_finca
    JOIN productores   pr  ON pr.id_productor = p.id_productor
    JOIN sku_pt        s   ON s.id_sku        = p.id_sku
    JOIN cedis_cliente cc  ON cc.id_cc        = p.id_cc
    LEFT JOIN camaras  cam ON cam.id_camara   = COALESCE(c.id_camara, p.id_camara)
    LEFT JOIN usuarios u   ON u.id_usuario    = c.id_usuario
    LEFT JOIN empleados e  ON e.id_empleado   = u.id_empleado
    LEFT JOIN usuarios ua  ON ua.id_usuario   = c.alerta_atendida_por
    LEFT JOIN empleados ea ON ea.id_empleado  = ua.id_empleado
`;

// estado: 1 pendientes · 2 atendidas · null ambas
const getAlertas = async ({ estado = null } = {}, camaras = null) => {
    const result = await db.query(
        `
        ${SELECT_ALERTA}
        WHERE c.alerta_estado <> 0
          AND ($1::INT IS NULL OR c.alerta_estado = $1)
          AND ($2::INT[] IS NULL OR COALESCE(c.id_camara, p.id_camara) = ANY($2))
        ORDER BY c.alerta_estado, c.fecha_hora DESC
        LIMIT 500
        `,
        [estado, camaras]
    );
    return result.rows;
};

const getResumenAlertas = async (camaras = null) => {
    const result = await db.query(
        `
        SELECT
            COUNT(*) FILTER (WHERE c.alerta_estado = 1)::INT                     AS pendientes,
            COUNT(*) FILTER (WHERE c.alerta_estado = 1 AND c.tipo_cierre = 1)::INT AS diferencias,
            COUNT(*) FILTER (WHERE c.alerta_estado = 1 AND c.tipo_cierre = 2)::INT AS no_llego
        FROM recepciones_cierres c
        JOIN produccion p ON p.id_produccion = c.id_produccion
        WHERE ($1::INT[] IS NULL OR COALESCE(c.id_camara, p.id_camara) = ANY($1))
        `,
        [camaras]
    );
    return result.rows[0];
};

const getCierreById = async (id_cierre) => {
    const result = await db.query(`${SELECT_ALERTA} WHERE c.id_cierre = $1`, [id_cierre]);
    return result.rows[0];
};

// Devuelve undefined si ya estaba atendida (otro coordinador se adelantó)
const atenderAlerta = async (id_cierre, { comentario, id_usuario }) => {
    const result = await db.query(
        `
        UPDATE recepciones_cierres
        SET alerta_estado = 2,
            alerta_atendida_por = $2,
            alerta_fecha_atencion = CURRENT_TIMESTAMP,
            alerta_comentario = $3
        WHERE id_cierre = $1 AND alerta_estado = 1
        RETURNING id_cierre
        `,
        [id_cierre, id_usuario, comentario]
    );
    return result.rows[0];
};

// Reabrir una línea confirmada: vuelve a aceptar recepciones. Si su alerta
// seguía pendiente, se da por atendida con el motivo de la reapertura: es
// la acción que tomó el coordinador sobre esa diferencia.
const reabrirCierre = async (id_cierre, { motivo, id_usuario }) => {
    const result = await db.query(
        `
        UPDATE recepciones_cierres
        SET vigente = false,
            reabierto_por = $2,
            fecha_reapertura = CURRENT_TIMESTAMP,
            motivo_reapertura = $3,
            alerta_estado = CASE WHEN alerta_estado = 1 THEN 2 ELSE alerta_estado END,
            alerta_atendida_por = CASE WHEN alerta_estado = 1 THEN $2 ELSE alerta_atendida_por END,
            alerta_fecha_atencion = CASE WHEN alerta_estado = 1 THEN CURRENT_TIMESTAMP ELSE alerta_fecha_atencion END,
            alerta_comentario = CASE WHEN alerta_estado = 1 THEN 'Línea reabierta: ' || $3 ELSE alerta_comentario END
        WHERE id_cierre = $1 AND tipo_cierre = 1 AND vigente
        RETURNING id_cierre
        `,
        [id_cierre, id_usuario, motivo]
    );
    return result.rows[0];
};

const recepcionesModel = {
    getRecepciones,
    getRecepcionById,
    getEsperadas,
    createRecepcion,
    updateRecepcion,
    cancelarRecepcion,
    reactivarRecepcion,
    getOcupacionesGeneradas,
    getDisponibilidad,
    getLineasParaRecibir,
    getResultadoRecepciones,
    confirmarCompleta,
    marcarNoLlego,
    getAlertas,
    getResumenAlertas,
    getCierreById,
    atenderAlerta,
    reabrirCierre
};

export default recepcionesModel;
