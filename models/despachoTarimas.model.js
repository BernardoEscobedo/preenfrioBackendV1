import { db } from "../database/connection.database.js";

// ============================================================================
// DESPACHO POR TARIMA DE BLOQUE
// ============================================================================
// El despacho sale por TARIMA FÍSICA armada en un bloque: completa, media o
// mixta (varios lotes). Nunca por bloque completo ni por cajas sueltas.
//
// Las consultas de escritura reciben el CLIENTE de la transacción del
// despacho completo.
// ============================================================================

const zona = () => process.env.ZONA_HORARIA || "America/Mexico_City";

// ----------------------------------------------------------------------------
// Tarimas disponibles para despachar
// ----------------------------------------------------------------------------
// Tarimas activas de bloques armados en las cámaras del alcance. Por defecto
// solo los bloques que tienen al menos una tarima con fruta del cliente.
const getTarimasDisponibles = async (id_cc, todos, camaras = null) =>
    (await db.query(
        `
        SELECT
            b.id_bloque, b.codigo_bloque, b.posiciones,
            t.id_tarima, t.posicion, t.id_camara, c.nombre_camara, c.tipo_camara,
            ROUND(EXTRACT(EPOCH FROM ((now() AT TIME ZONE $4) - t.fecha_hora_ingreso)) / 3600, 1) AS horas,
            up.temperatura_promedio AS ultima_temperatura,
            l.lotes,
            l.cajas::INT AS cajas,
            l.fecha_empaque
        FROM bloques_tarimas t
        JOIN bloques_fruta b ON b.id_bloque = t.id_bloque
        JOIN camaras c       ON c.id_camara = t.id_camara
        JOIN LATERAL (
            SELECT
                json_agg(json_build_object(
                    'id_produccion', d.id_produccion,
                    'cantidad_cajas', d.cantidad_cajas,
                    'codigo_lote', p.codigo_lote,
                    'codigo_sku', s.codigo_sku,
                    'calidad_sku', s.calidad,
                    'codigo_finca', f.codigo_finca,
                    'nombre_finca', f.nombre,
                    'codigo_productor', po.codigo_productor,
                    'id_cc', p.id_cc,
                    'acronimo_cc', cc.acronimo,
                    'fecha_empaque', p.fecha_empaque
                ) ORDER BY d.cantidad_cajas DESC, d.id_detalle) AS lotes,
                SUM(d.cantidad_cajas) AS cajas,
                MIN(p.fecha_empaque) AS fecha_empaque,
                BOOL_OR(p.id_cc = $1) AS del_cliente
            FROM bloques_tarimas_detalle d
            JOIN produccion p          ON p.id_produccion = d.id_produccion
            LEFT JOIN sku_pt s         ON s.id_sku        = p.id_sku
            LEFT JOIN fincas f         ON f.id_finca      = p.id_finca
            LEFT JOIN productores po   ON po.id_productor = p.id_productor
            LEFT JOIN cedis_cliente cc ON cc.id_cc        = p.id_cc
            WHERE d.id_tarima = t.id_tarima
        ) l ON l.lotes IS NOT NULL
        LEFT JOIN LATERAL (
            SELECT p.temperatura_promedio FROM pulpeos p
            WHERE p.id_tarima = t.id_tarima AND p.estado = 1
            ORDER BY p.fecha_hora DESC, p.id_pulpeo DESC LIMIT 1
        ) up ON TRUE
        WHERE t.estado = 1 AND b.estado = 1 AND c.estado = 1
          AND ($3::INT[] IS NULL OR t.id_camara = ANY($3))
          AND (
              $2::BOOLEAN
              OR EXISTS (
                  SELECT 1 FROM bloques_tarimas t2
                  JOIN bloques_tarimas_detalle d2 ON d2.id_tarima = t2.id_tarima
                  JOIN produccion p2 ON p2.id_produccion = d2.id_produccion
                  WHERE t2.id_bloque = b.id_bloque AND t2.estado = 1 AND p2.id_cc = $1
              )
          )
        ORDER BY l.fecha_empaque NULLS LAST, b.codigo_bloque, t.posicion
        `,
        [id_cc, todos, camaras, zona()]
    )).rows;

// Fruta del cliente en cámara que NO está armada en bloques (no debería
// existir: se avisa para que la armen).
const getSinBloque = async (id_cc, camaras = null) =>
    (await db.query(
        `
        WITH inv AS (
            SELECT id_camara, id_produccion, SUM(cajas_disponibles)::INT AS cajas
            FROM vw_inventario_disponible
            WHERE id_cc = $1 AND id_produccion IS NOT NULL
              AND ($2::INT[] IS NULL OR id_camara = ANY($2))
            GROUP BY id_camara, id_produccion
        ),
        blo AS (
            SELECT t.id_camara, d.id_produccion, SUM(d.cantidad_cajas)::INT AS cajas
            FROM bloques_tarimas t
            JOIN bloques_fruta b ON b.id_bloque = t.id_bloque
            JOIN bloques_tarimas_detalle d ON d.id_tarima = t.id_tarima
            WHERE t.estado = 1 AND b.estado = 1
            GROUP BY t.id_camara, d.id_produccion
        )
        SELECT COUNT(*)::INT AS lotes,
               COALESCE(SUM(inv.cajas - COALESCE(blo.cajas, 0)), 0)::INT AS cajas
        FROM inv
        LEFT JOIN blo ON blo.id_camara = inv.id_camara AND blo.id_produccion = inv.id_produccion
        WHERE inv.cajas - COALESCE(blo.cajas, 0) > 0
        `,
        [id_cc, camaras]
    )).rows[0];

// ----------------------------------------------------------------------------
// Dentro de la transacción
// ----------------------------------------------------------------------------

// Tarimas elegidas, bloqueadas, con sus lotes
const bloquearTarimas = async (c, ids) =>
    (await c.query(
        `
        SELECT t.id_tarima, t.posicion, t.id_camara, t.estado, t.id_bloque,
               b.codigo_bloque, b.estado AS estado_bloque, cam.nombre_camara,
               COALESCE((
                   SELECT json_agg(json_build_object(
                       'id_produccion', d.id_produccion,
                       'cantidad_cajas', d.cantidad_cajas,
                       'codigo_lote', p.codigo_lote,
                       'id_cc', p.id_cc,
                       'cliente', cc.cliente,
                       'cedis', cc.cedis
                   ) ORDER BY d.cantidad_cajas DESC, d.id_detalle)
                   FROM bloques_tarimas_detalle d
                   JOIN produccion p ON p.id_produccion = d.id_produccion
                   LEFT JOIN cedis_cliente cc ON cc.id_cc = p.id_cc
                   WHERE d.id_tarima = t.id_tarima
               ), '[]'::json) AS lotes
        FROM bloques_tarimas t
        JOIN bloques_fruta b ON b.id_bloque = t.id_bloque
        JOIN camaras cam     ON cam.id_camara = t.id_camara
        WHERE t.id_tarima = ANY($1::INT[])
        ORDER BY t.id_tarima
        FOR UPDATE OF t
        `,
        [ids]
    )).rows;

// Montones del lote dentro de la cámara, los más antiguos primero
const getOcupacionesLote = async (c, id_camara, id_produccion) =>
    (await c.query(
        `
        SELECT o.id_ocupacion, o.cantidad_tarimas, o.cantidad_cajas
        FROM ocupaciones_camaras o
        JOIN recepciones r ON r.id_recepcion = o.id_recepcion
        WHERE o.id_camara = $1 AND r.id_produccion = $2
          AND o.tipo_ocupacion = 1 AND o.estado = 1 AND o.trazabilidad_verificada
          AND o.cantidad_cajas > 0
        ORDER BY o.fecha_inicio, o.hora_inicio, o.id_ocupacion
        FOR UPDATE OF o
        `,
        [id_camara, id_produccion]
    )).rows;

// Las tarimas salen del bloque con el despacho
const retirarTarimas = async (c, ids, id_despacho) => {
    await c.query(
        `UPDATE bloques_tarimas
         SET estado = 0, id_despacho = $2,
             fecha_hora_retiro = (now() AT TIME ZONE $3)::TIMESTAMP
         WHERE id_tarima = ANY($1::INT[])`,
        [ids, id_despacho, zona()]
    );
};

// Bloques que se quedaron sin tarimas: desarmados
const cerrarBloquesVacios = async (c, ids_bloque) =>
    (await c.query(
        `UPDATE bloques_fruta b SET estado = 0
         WHERE b.id_bloque = ANY($1::INT[]) AND b.estado = 1
           AND NOT EXISTS (SELECT 1 FROM bloques_tarimas t WHERE t.id_bloque = b.id_bloque AND t.estado = 1)
         RETURNING codigo_bloque`,
        [ids_bloque]
    )).rows.map((r) => r.codigo_bloque);

const despachoTarimasModel = {
    getTarimasDisponibles,
    getSinBloque,
    bloquearTarimas,
    getOcupacionesLote,
    retirarTarimas,
    cerrarBloquesVacios
};

export default despachoTarimasModel;
