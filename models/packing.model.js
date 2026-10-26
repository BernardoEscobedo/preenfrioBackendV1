import { db } from "../database/connection.database.js";

// ============================================================================
// PACKING LIST DEL DESPACHO
// ============================================================================
// Encabezado (vw_despachos), tarimas físicas que subieron (bloques_tarimas
// con id_despacho) y resumen por lote (despachos_detalle).
// ============================================================================

const getEncabezado = async (id_despacho) =>
    (await db.query(`SELECT * FROM vw_despachos WHERE id_despacho = $1`, [id_despacho])).rows[0];

// Tarimas que subieron, con sus lotes y el último pulpeo
const getTarimas = async (id_despacho) =>
    (await db.query(
        `
        SELECT t.id_tarima, t.posicion, b.codigo_bloque, c.nombre_camara,
               up.temperatura_promedio AS temperatura,
               COALESCE(json_agg(json_build_object(
                   'codigo_lote', p.codigo_lote,
                   'codigo_sku', s.codigo_sku,
                   'calidad_sku', s.calidad,
                   'codigo_productor', po.codigo_productor,
                   'codigo_finca', f.codigo_finca,
                   'nombre_finca', f.nombre,
                   'fecha_empaque', p.fecha_empaque,
                   'cajas', d.cantidad_cajas
               ) ORDER BY d.cantidad_cajas DESC, d.id_detalle) FILTER (WHERE d.id_detalle IS NOT NULL), '[]') AS lotes,
               COALESCE(SUM(d.cantidad_cajas), 0)::INT AS cajas
        FROM bloques_tarimas t
        JOIN bloques_fruta b ON b.id_bloque = t.id_bloque
        JOIN camaras c       ON c.id_camara = t.id_camara
        LEFT JOIN bloques_tarimas_detalle d ON d.id_tarima = t.id_tarima
        LEFT JOIN produccion p   ON p.id_produccion = d.id_produccion
        LEFT JOIN sku_pt s       ON s.id_sku        = p.id_sku
        LEFT JOIN fincas f       ON f.id_finca      = p.id_finca
        LEFT JOIN productores po ON po.id_productor = p.id_productor
        LEFT JOIN LATERAL (
            SELECT pu.temperatura_promedio FROM pulpeos pu
            WHERE pu.id_tarima = t.id_tarima AND pu.estado = 1
            ORDER BY pu.fecha_hora DESC, pu.id_pulpeo DESC LIMIT 1
        ) up ON TRUE
        WHERE t.id_despacho = $1
        GROUP BY t.id_tarima, t.posicion, b.codigo_bloque, c.nombre_camara, up.temperatura_promedio
        ORDER BY b.codigo_bloque, t.posicion
        `,
        [id_despacho]
    )).rows;

// Resumen por lote (lo que se descontó del inventario)
const getLotes = async (id_despacho) =>
    (await db.query(
        `
        SELECT p.codigo_lote, s.codigo_sku, s.calidad AS calidad_sku,
               po.codigo_productor, f.codigo_finca, f.nombre AS nombre_finca,
               p.fecha_empaque,
               SUM(dd.cantidad_tarimas)::INT AS tarimas,
               SUM(dd.cantidad_cajas)::INT   AS cajas
        FROM despachos_detalle dd
        JOIN produccion p        ON p.id_produccion = dd.id_produccion
        LEFT JOIN sku_pt s       ON s.id_sku        = p.id_sku
        LEFT JOIN fincas f       ON f.id_finca      = p.id_finca
        LEFT JOIN productores po ON po.id_productor = p.id_productor
        WHERE dd.id_despacho = $1
        GROUP BY p.codigo_lote, s.codigo_sku, s.calidad, po.codigo_productor,
                 f.codigo_finca, f.nombre, p.fecha_empaque
        ORDER BY s.codigo_sku, p.codigo_lote
        `,
        [id_despacho]
    )).rows;

const getCamaras = async (id_despacho) =>
    (await db.query(
        `SELECT DISTINCT id_camara_origen FROM despachos_detalle
         WHERE id_despacho = $1 AND id_camara_origen IS NOT NULL`,
        [id_despacho]
    )).rows.map((r) => Number(r.id_camara_origen));

// Placas de la segunda caja (unidad full), si existe la columna en la vista
const getCaja2 = async (id_caja) =>
    id_caja
        ? (await db.query(`SELECT placas, numero_economico FROM cajas_refrigeradas WHERE id_caja_refrigerada = $1`, [id_caja])).rows[0]
        : null;

export default { getEncabezado, getTarimas, getLotes, getCamaras, getCaja2 };
