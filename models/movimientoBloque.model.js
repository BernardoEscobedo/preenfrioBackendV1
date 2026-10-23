import { zona } from "./tarimas.model.js";

// ============================================================================
// TRASLADO DE BLOQUE · preenfrío → conservación
// ============================================================================
// Todas reciben el CLIENTE de la transacción: el inventario y la ubicación
// de las tarimas se mueven juntos o no se mueve nada.
//
// El inventario se mueve como siempre: un INSERT tipo 2 en
// movimientos_inventario por cada ocupación de origen, y
// trg_sync_ocupacion_movimiento descuenta el preenfrío y suma la conserva.
// ============================================================================

export const PREFIJO_OBSERVACION = "Traslado bloque";

const getCamara = async (c, id) =>
    (await c.query(`SELECT id_camara, nombre_camara, tipo_camara, estado FROM camaras WHERE id_camara = $1`, [id])).rows[0];

const getBloque = async (c, id_bloque) =>
    (await c.query(`SELECT id_bloque, codigo_bloque, estado, posiciones FROM bloques_fruta WHERE id_bloque = $1 FOR UPDATE`, [id_bloque])).rows[0];

// Tarimas activas del bloque con sus lotes, bloqueadas
const getTarimas = async (c, id_bloque) =>
    (await c.query(
        `
        SELECT t.id_tarima, t.posicion, t.id_camara,
               COALESCE(json_agg(json_build_object(
                   'id_produccion', d.id_produccion,
                   'cantidad_cajas', d.cantidad_cajas,
                   'codigo_lote', p.codigo_lote
               ) ORDER BY d.cantidad_cajas DESC, d.id_detalle)
               FILTER (WHERE d.id_detalle IS NOT NULL), '[]') AS lotes
        FROM bloques_tarimas t
        LEFT JOIN bloques_tarimas_detalle d ON d.id_tarima = t.id_tarima
        LEFT JOIN produccion p              ON p.id_produccion = d.id_produccion
        WHERE t.id_bloque = $1 AND t.estado = 1
        GROUP BY t.id_tarima
        ORDER BY t.posicion
        `,
        [id_bloque]
    )).rows;

const bloquearTarimas = async (c, ids) => {
    await c.query(`SELECT 1 FROM bloques_tarimas WHERE id_tarima = ANY($1::INT[]) FOR UPDATE`, [ids]);
};

// Ocupaciones (montones con trazabilidad) del lote dentro de la cámara,
// las más antiguas primero. Mismo criterio que vw_inventario_disponible.
const getOcupacionesLote = async (c, id_camara, id_produccion) =>
    (await c.query(
        `
        SELECT o.id_ocupacion, o.cantidad_tarimas, o.cantidad_cajas
        FROM ocupaciones_camaras o
        JOIN recepciones r ON r.id_recepcion = o.id_recepcion
        WHERE o.id_camara = $1 AND r.id_produccion = $2
          AND o.tipo_ocupacion = 1 AND o.estado = 1 AND o.trazabilidad_verificada
          AND (o.cantidad_tarimas > 0 OR o.cantidad_cajas > 0)
        ORDER BY o.fecha_inicio, o.hora_inicio, o.id_ocupacion
        FOR UPDATE OF o
        `,
        [id_camara, id_produccion]
    )).rows;

const crearMovimiento = async (c, d) =>
    (await c.query(
        `
        INSERT INTO movimientos_inventario (
            id_produccion, id_ocupacion_origen, tipo_movimiento,
            id_camara_origen, id_camara_destino, id_despacho,
            fecha_movimiento, hora_movimiento,
            cantidad_tarimas, cantidad_cajas,
            temperatura, id_usuario, observaciones
        )
        VALUES ($1, $2, 2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id_movimiento
        `,
        [d.id_produccion, d.id_ocupacion_origen, d.id_camara_origen, d.id_camara_destino,
         d.fecha, d.hora, d.tarimas, d.cajas, d.temperatura, d.id_usuario, d.observaciones]
    )).rows[0];

const moverTarimas = async (c, ids, id_camara, fecha_hora) => {
    await c.query(
        `UPDATE bloques_tarimas SET id_camara = $2, fecha_hora_traslado = $3 WHERE id_tarima = ANY($1::INT[])`,
        [ids, id_camara, fecha_hora]
    );
};

const setCamaraBloque = async (c, id_bloque, id_camara) => {
    await c.query(`UPDATE bloques_fruta SET id_camara = $2 WHERE id_bloque = $1`, [id_bloque, id_camara]);
};

const ahoraLocal = async (c) =>
    (await c.query(
        `SELECT to_char((now() AT TIME ZONE $1), 'YYYY-MM-DD') AS fecha,
                to_char((now() AT TIME ZONE $1), 'HH24:MI:SS') AS hora`,
        [zona()]
    )).rows[0];

const movimientoBloqueModel = {
    getCamara,
    getBloque,
    getTarimas,
    bloquearTarimas,
    getOcupacionesLote,
    crearMovimiento,
    moverTarimas,
    setCamaraBloque,
    ahoraLocal
};

export default movimientoBloqueModel;
