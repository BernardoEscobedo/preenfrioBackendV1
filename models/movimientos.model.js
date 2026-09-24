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
// ⚠️ ESTE MÓDULO SOLO CREA MOVIMIENTOS TIPO 2
//   Los otros dos los generan triggers de sus propios módulos. Permitir
//   crearlos a mano desde aquí significaría dos vías para el mismo hecho:
//   un ingreso registrado por recepción Y otro capturado manualmente
//   dejarían la cámara con el doble de fruta de la que llegó.
//
// ⚠️ EL BACKEND NO TOCA ocupaciones_camaras
//   Un INSERT aquí dispara trg_sync_ocupacion_movimiento, que:
//     A) descuenta de la OCUPACIÓN DE ORIGEN concreta y la cierra si queda
//        en cero
//     B) suma a la cámara destino, creando la ocupación si no existía
//
//   Igual que en recepciones: la lógica de inventario vive en la BD para
//   que cualquier origen de datos mantenga las ocupaciones cuadradas.
//
// POR QUÉ id_ocupacion_origen ES OBLIGATORIO AQUÍ
//   El trigger tiene un camino alterno: si no se manda la ocupación
//   exacta, busca "la activa de la cámara origen" con LIMIT 1. Eso funciona
//   cuando hay un solo montón, pero descuenta del equivocado en cuanto
//   conviven varios procesos en la misma cámara.
//
//   Por eso este modelo siempre manda id_ocupacion_origen: es la única
//   forma de descontar del montón correcto y no descuadrar la trazabilidad.
//
// TABLA INMUTABLE
//   Sin columna 'estado' y sin método de update: un movimiento ocurrió o no
//   ocurrió. Solo INSERT y DELETE.
// ============================================================================

// ----------------------------------------------------------------------------
// Listado — lee vw_movimientos
// ----------------------------------------------------------------------------
// La vista ya resuelve nombres de cámaras, folio de despacho, lote, finca,
// SKU, cliente y quién lo registró. Se consulta en vez de rearmar el JOIN
// para que este módulo y los reportes no calculen distinto.
//
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

// Un movimiento por id, sin filtrar alcance.
// El controller compara después para distinguir 404 de 403.
const getMovimientoById = async (id_movimiento) => {
    const result = await db.query(
        `SELECT * FROM vw_movimientos WHERE id_movimiento = $1`,
        [id_movimiento]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Qué se puede trasladar — origen del formulario
// ----------------------------------------------------------------------------
// Fruta que está DENTRO de cámaras de preenfrío (tipo_camara = 1) y por
// tanto es candidata a pasar a conservación.
//
// Se apoya en vw_inventario_disponible, que desde la v2.3 ya viene ordenada
// por criticidad y luego FEFO: lo que está más cerca de incumplir su cita
// aparece primero, que es justo lo que conviene sacar del preenfrío para
// liberar espacio.
const getTrasladables = async ({ id_camara = null } = {}, camaras = null) => {
    const result = await db.query(
        `
        SELECT
            v.*,
            -- Horas que lleva enfriándose. Es el dato que decide si ya
            -- puede salir: mover fruta que no terminó su ciclo la manda
            -- a conservación todavía caliente.
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
// Alta — el INSERT que dispara el trigger
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
// Borrado — la única corrección posible
// ----------------------------------------------------------------------------
// La tabla no admite UPDATE: no hay columna de estado ni método para
// editarla. Si un movimiento se capturó mal, se borra y se vuelve a
// registrar.
//
// ⚠️ EL DELETE **NO** REVIERTE LA OCUPACIÓN
//   trg_sync_ocupacion_movimiento es AFTER INSERT. Al borrar no se dispara
//   nada: la fruta sigue contada en el destino y descontada del origen.
//
//   Es la misma limitación que tiene cancelar una recepción. Se documenta
//   en vez de resolverla en el backend porque poner a este modelo a
//   devolver tarimas crearía una segunda fuente de verdad tocando
//   ocupaciones_camaras, y tarde o temprano se pelearía con los triggers.
//
//   La corrección real es registrar el movimiento INVERSO, que sí pasa por
//   el trigger y deja rastro de que hubo una corrección.
const deleteMovimiento = async (id_movimiento) => {
    const result = await db.query(
        `DELETE FROM movimientos_inventario WHERE id_movimiento = $1 RETURNING *`,
        [id_movimiento]
    );
    return result.rows[0];
};

// Si el movimiento generó una línea de despacho, no se puede borrar suelto:
// el detalle lo referencia y además hay que devolver la fruta a la cámara.
// Para eso existe fn_quitar_linea_despacho.
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
// Todos los movimientos de una producción, en orden cronológico. Es la
// respuesta a "¿por dónde pasó esta fruta?" cuando hay un reclamo.
const getTrazabilidad = async (id_produccion) => {
    const result = await db.query(
        `
        SELECT * FROM vw_movimientos
        WHERE id_produccion = $1
        ORDER BY fecha_movimiento, hora_movimiento, id_movimiento
        `,
        [id_produccion]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Resumen por día y tipo
// ----------------------------------------------------------------------------
// Cuánta fruta se movió, de qué manera. Alimenta el reporte operativo.
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
    deleteMovimiento,
    getLineaDespachoLigada,
    getTrazabilidad,
    getResumen
};

export default movimientosModel;
