import { db } from "../database/connection.database.js";

// ============================================================================
// MOVIMIENTOS DE INVENTARIO
// ============================================================================
// Bitácora del flujo físico de la fruta entre cámaras.
//
//   tipo 1 = ingreso a preenfrío        lo generan las recepciones
//   tipo 2 = preenfrío → conservación   ← el caso real de ESTE módulo
//   tipo 3 = salida por despacho        lo genera el detalle de despachos
//
// ⚠️ EL BACKEND NO TOCA ocupaciones_camaras
//   Un INSERT aquí dispara trg_sync_ocupacion_movimiento, que descuenta del
//   origen y suma al destino.
//
//   Desde la v2.5, un DELETE dispara trg_revertir_movimiento, que hace lo
//   contrario. Las dos vías viven en la BD.
//
// ────────────────────────────────────────────────────────────────────────
// v2.5 · LA CORRECCIÓN ES POR MOVIMIENTO INVERSO, NO POR BORRADO
// ────────────────────────────────────────────────────────────────────────
//   Técnicamente el DELETE ya es seguro: el trigger nuevo devuelve la
//   fruta. Pero se mantuvo como vía EXCEPCIONAL a propósito.
//
//   Borrar hace desaparecer el error. El movimiento inverso deja las dos
//   filas en la bitácora —el traslado y su corrección— y eso es lo que
//   sirve cuando alguien pregunta seis meses después por qué el inventario
//   de una cámara se movió dos veces el mismo día.
//
//   Es el mismo criterio que rige los pulpeos (una lectura no se edita, se
//   cancela y se toma otra) y la auditoría de despachos.
//
//   Por eso este modelo expone crearInverso(), y deleteMovimiento() queda
//   restringido a admin para los casos donde la fila nunca debió existir.
// ============================================================================

// ----------------------------------------------------------------------------
// Listado — lee vw_movimientos
// ----------------------------------------------------------------------------
// EL ALCANCE MIRA LAS DOS CÁMARAS
//   Un movimiento sale de una y entra a otra. Si el supervisor solo tiene
//   la de conservación, el traslado que llegó ahí SÍ es asunto suyo aunque
//   el origen no lo sea. Por eso la condición es OR y no AND.
const getMovimientos = async (
    {
        tipo_movimiento = null,
        id_produccion = null,
        id_camara = null,
        id_despacho = null,
        fecha_desde = null,
        fecha_hasta = null,
        buscar = null
    } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        SELECT * FROM vw_movimientos
        WHERE ($1::INT IS NULL OR tipo_movimiento = $1)
          AND ($2::INT IS NULL OR id_produccion = $2)
          AND ($3::INT IS NULL
               OR id_camara_origen = $3
               OR id_camara_destino = $3)
          AND ($4::INT IS NULL OR id_despacho = $4)
          AND ($5::DATE IS NULL OR fecha_movimiento >= $5)
          AND ($6::DATE IS NULL OR fecha_movimiento <= $6)
          AND ($7::INT[] IS NULL
               OR id_camara_origen = ANY($7)
               OR id_camara_destino = ANY($7))
          AND ($8::TEXT IS NULL
               OR codigo_lote ILIKE '%' || $8 || '%'
               OR nombre_finca ILIKE '%' || $8 || '%'
               OR cliente ILIKE '%' || $8 || '%'
               OR folio_despacho ILIKE '%' || $8 || '%')
        ORDER BY fecha_movimiento DESC, hora_movimiento DESC, id_movimiento DESC
        LIMIT 500
        `,
        [
            tipo_movimiento,
            id_produccion,
            id_camara,
            id_despacho,
            fecha_desde,
            fecha_hasta,
            camaras,
            buscar
        ]
    );
    return result.rows;
};

const getMovimientoById = async (id_movimiento) => {
    const result = await db.query(
        `SELECT * FROM vw_movimientos WHERE id_movimiento = $1`,
        [id_movimiento]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Qué se puede trasladar
// ----------------------------------------------------------------------------
// Fruta dentro de cámaras de preenfrío, candidata a pasar a conservación.
// Viene ordenada por criticidad (v2.3): lo que está más cerca de incumplir
// su cita conviene sacarlo primero para liberar espacio.
const getTrasladables = async ({ id_camara = null } = {}, camaras = null) => {
    const result = await db.query(
        `
        SELECT
            v.*,
            -- Horas que lleva enfriándose: el dato que decide si ya puede
            -- salir. Moverla antes de tiempo la manda caliente a conserva.
            ROUND(
                EXTRACT(EPOCH FROM (
                    CURRENT_TIMESTAMP - (v.fecha_ingreso + v.hora_ingreso)
                )) / 3600,
                1
            ) AS horas_en_preenfrio
        FROM vw_inventario_disponible v
        WHERE v.tipo_camara = 1
          AND ($1::INT IS NULL OR v.id_camara = $1)
          AND ($2::INT[] IS NULL OR v.id_camara = ANY($2))
        ORDER BY v.nivel_criticidad, v.fecha_empaque NULLS LAST
        `,
        [id_camara, camaras]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Alta
// ----------------------------------------------------------------------------
// Solo se escribe en movimientos_inventario. El descuento del origen y la
// suma al destino los hace trg_sync_ocupacion_movimiento.
const createMovimiento = async ({
    id_produccion,
    id_ocupacion_origen,
    tipo_movimiento,
    id_camara_origen,
    id_camara_destino,
    id_despacho,
    fecha_movimiento,
    hora_movimiento,
    cantidad_tarimas,
    cantidad_cajas,
    temperatura,
    id_usuario,
    observaciones
}) => {
    const result = await db.query(
        `
        INSERT INTO movimientos_inventario (
            id_produccion, id_ocupacion_origen, tipo_movimiento,
            id_camara_origen, id_camara_destino, id_despacho,
            fecha_movimiento, hora_movimiento,
            cantidad_tarimas, cantidad_cajas,
            temperatura, id_usuario, observaciones
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
        `,
        [
            id_produccion,
            id_ocupacion_origen,
            tipo_movimiento,
            id_camara_origen,
            id_camara_destino,
            id_despacho,
            fecha_movimiento,
            hora_movimiento,
            cantidad_tarimas,
            cantidad_cajas,
            temperatura,
            id_usuario,
            observaciones
        ]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// ⭐ v2.5 · MOVIMIENTO INVERSO — la vía oficial de corrección
// ----------------------------------------------------------------------------
// Crea un movimiento que deshace otro: mismas cantidades, cámaras
// intercambiadas.
//
// POR QUÉ ESTO Y NO UN DELETE
//   El resultado sobre el inventario es idéntico, pero la bitácora queda
//   distinta:
//
//     DELETE            la fila desaparece. Nadie sabe que hubo un error.
//     INVERSO           quedan dos filas: el traslado y su corrección, con
//                       fecha, hora, usuario y motivo.
//
//   Lo segundo es lo que sirve cuando alguien revisa por qué el inventario
//   de una cámara se movió dos veces el mismo día, o cuando hay que
//   explicarle a un cliente qué pasó con su fruta.
//
// SOBRE LA OCUPACIÓN DE ORIGEN DEL INVERSO
//   Se busca la ocupación activa de la cámara DESTINO del original: ahí es
//   donde está ahora la fruta. Puede no ser la misma fila que antes —si se
//   había cerrado, el trigger creó una nueva— por eso se consulta en vez de
//   asumirla.
const crearInverso = async ({
    original,
    fecha_movimiento,
    hora_movimiento,
    temperatura,
    id_usuario,
    motivo
}) => {
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        // La fruta está ahora en la cámara destino del movimiento original
        const ocupacion = await client.query(
            `
            SELECT id_ocupacion FROM ocupaciones_camaras
            WHERE id_camara = $1 AND tipo_ocupacion = 1 AND estado = 1
            LIMIT 1
            `,
            [original.id_camara_destino]
        );

        const idOcupacionOrigen = ocupacion.rows[0]?.id_ocupacion ?? null;

        const result = await client.query(
            `
            INSERT INTO movimientos_inventario (
                id_produccion, id_ocupacion_origen, tipo_movimiento,
                id_camara_origen, id_camara_destino,
                fecha_movimiento, hora_movimiento,
                cantidad_tarimas, cantidad_cajas,
                temperatura, id_usuario, observaciones
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *
            `,
            [
                original.id_produccion,
                idOcupacionOrigen,
                original.tipo_movimiento,
                // Cámaras intercambiadas: eso es lo que lo hace inverso
                original.id_camara_destino,
                original.id_camara_origen,
                fecha_movimiento,
                hora_movimiento,
                original.cantidad_tarimas,
                original.cantidad_cajas,
                temperatura,
                id_usuario,
                // La referencia al original es lo que hace auditable la
                // corrección: sin ella, las dos filas parecen dos traslados
                // independientes.
                `Reversa del movimiento #${original.id_movimiento} · ${motivo}`
            ]
        );

        await client.query("COMMIT");
        return result.rows[0];
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

// Busca si un movimiento ya fue revertido. Evita la doble corrección, que
// dejaría la fruta de vuelta en el destino equivocado.
const getReversaDe = async (id_movimiento) => {
    const result = await db.query(
        `
        SELECT id_movimiento, fecha_movimiento, hora_movimiento, observaciones
        FROM movimientos_inventario
        WHERE observaciones LIKE 'Reversa del movimiento #' || $1 || ' ·%'
        LIMIT 1
        `,
        [id_movimiento]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Borrado — vía EXCEPCIONAL
// ----------------------------------------------------------------------------
// v2.5: trg_revertir_movimiento ya devuelve la fruta al borrar, así que
// técnicamente es seguro. Pero se reserva a admin y para el caso donde la
// fila NUNCA debió existir: una captura duplicada, una prueba en
// producción.
//
// Para todo lo demás está crearInverso(), que deja rastro.
const deleteMovimiento = async (id_movimiento) => {
    const result = await db.query(
        `DELETE FROM movimientos_inventario WHERE id_movimiento = $1 RETURNING *`,
        [id_movimiento]
    );
    return result.rows[0];
};

// Si el movimiento generó una línea de despacho, no se toca suelto: el
// detalle lo referencia y la reversa correcta es fn_quitar_linea_despacho.
const getLineaDespachoLigada = async (id_movimiento) => {
    const result = await db.query(
        `
        SELECT dd.id_detalle, dd.id_despacho, d.folio_despacho, d.estado
        FROM despachos_detalle dd
        JOIN despachos d ON d.id_despacho = dd.id_despacho
        WHERE dd.id_movimiento = $1
        `,
        [id_movimiento]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Trazabilidad de un lote
// ----------------------------------------------------------------------------
// Todos los movimientos de una producción, en orden cronológico. Con la
// v2.5 aquí se ven también las correcciones, que es justo el punto.
const getTrazabilidad = async (id_produccion) => {
    const result = await db.query(
        `
        SELECT
            *,
            -- Marca las filas que son correcciones de otra
            CASE WHEN observaciones LIKE 'Reversa del movimiento #%'
                 THEN TRUE ELSE FALSE END AS es_reversa
        FROM vw_movimientos
        WHERE id_produccion = $1
        ORDER BY fecha_movimiento, hora_movimiento, id_movimiento
        `,
        [id_produccion]
    );
    return result.rows;
};

// Resumen por día y tipo. Alimenta el reporte operativo.
const getResumen = async (
    { fecha_desde = null, fecha_hasta = null } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        SELECT
            fecha_movimiento,
            tipo_movimiento,
            tipo_texto,
            COUNT(*)              AS movimientos,
            COUNT(*) FILTER (
                WHERE observaciones LIKE 'Reversa del movimiento #%'
            )                     AS reversas,
            SUM(cantidad_tarimas) AS tarimas,
            SUM(cantidad_cajas)   AS cajas,
            ROUND(AVG(temperatura), 2) AS temperatura_promedio
        FROM vw_movimientos
        WHERE ($1::DATE IS NULL OR fecha_movimiento >= $1)
          AND ($2::DATE IS NULL OR fecha_movimiento <= $2)
          AND ($3::INT[] IS NULL
               OR id_camara_origen = ANY($3)
               OR id_camara_destino = ANY($3))
        GROUP BY fecha_movimiento, tipo_movimiento, tipo_texto
        ORDER BY fecha_movimiento DESC, tipo_movimiento
        `,
        [fecha_desde, fecha_hasta, camaras]
    );
    return result.rows;
};

const movimientosModel = {
    getMovimientos,
    getMovimientoById,
    getTrasladables,
    createMovimiento,
    crearInverso,
    getReversaDe,
    deleteMovimiento,
    getLineaDespachoLigada,
    getTrazabilidad,
    getResumen
};

export default movimientosModel;
