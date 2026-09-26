import { db } from "../database/connection.database.js";

// ============================================================================
// DESPACHOS
// ============================================================================
// El despacho es un DOCUMENTO: folio, transporte, cita y cliente. El picking
// (qué fruta se sube) vive en despachos_detalle, y puede venir de VARIAS
// cámaras: por eso se arma desde el documento y no desde cada cámara.
//
// ⚠️ UNA SOLA VÍA DE DESCUENTO
//   Agregar una línea de picking dispara trg_despacho_detalle_movimiento
//   (BEFORE INSERT), que genera el movimiento tipo 3. Es ESE movimiento —
//   con su propio trigger — el que descuenta la cámara.
//
//   Quitar una línea borra ese movimiento, y trg_revertir_movimiento (v2.5)
//   devuelve la fruta. Este modelo NUNCA escribe en ocupaciones_camaras.
//
// ⚠️ LOS TOTALES NO SE CAPTURAN
//   despachos.cantidad_tarimas y cantidad_cajas los mantiene
//   trg_recalcular_totales_despacho sumando el detalle.
//
// ESTADOS
//   1 = borrador  se puede editar, agregar líneas y eliminar
//   2 = cerrado   ya salió; solo admite corrección auditada
//
//   NO existe "cancelado" a propósito: un despacho o salió o no salió.
//
// ALCANCE POR CÁMARA
//   El documento no tiene cámara — la tienen sus líneas. Un supervisor ve
//   los despachos que llevan fruta de SUS cámaras, más los borradores
//   vacíos (que todavía no tienen planta asignada).
//
// CORRECCIÓN DE LA AUDITORÍA
//   getDisponibleParaPicking no tenía ORDER BY y confiaba en el orden de la
//   vista. En PostgreSQL, en cuanto se aplica un WHERE sobre una vista, ese
//   orden deja de estar garantizado: el picking podía dejar de mostrar
//   primero lo crítico sin que nadie lo notara.
// ============================================================================

// ----------------------------------------------------------------------------
// Listado — lee vw_despachos
// ----------------------------------------------------------------------------
// EL FILTRO DE ALCANCE ES POR EXISTENCIA DE LÍNEA
//   · EXISTS     → alguna de sus líneas sale de una cámara del alcance
//   · NOT EXISTS → es un borrador todavía sin líneas
const getDespachos = async (
    {
        estado = null,
        id_cc = null,
        id_transporte = null,
        fecha_desde = null,
        fecha_hasta = null,
        buscar = null
    } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        SELECT * FROM vw_despachos v
        WHERE ($1::INT IS NULL OR v.estado = $1)
          AND ($2::INT IS NULL OR v.id_cc = $2)
          AND ($3::INT IS NULL OR v.id_transporte = $3)
          AND ($4::DATE IS NULL OR v.fecha_despacho >= $4)
          AND ($5::DATE IS NULL OR v.fecha_despacho <= $5)
          AND ($6::TEXT IS NULL
               OR v.folio_despacho ILIKE '%' || $6 || '%'
               OR v.cliente ILIKE '%' || $6 || '%'
               OR v.orden_venta ILIKE '%' || $6 || '%'
               OR v.cita ILIKE '%' || $6 || '%'
               OR v.placas_caja ILIKE '%' || $6 || '%')
          AND (
              $7::INT[] IS NULL
              OR EXISTS (
                  SELECT 1 FROM despachos_detalle dd
                  WHERE dd.id_despacho = v.id_despacho
                    AND dd.id_camara_origen = ANY($7)
              )
              OR NOT EXISTS (
                  SELECT 1 FROM despachos_detalle dd
                  WHERE dd.id_despacho = v.id_despacho
              )
          )
        ORDER BY v.fecha_despacho DESC, v.id_despacho DESC
        LIMIT 500
        `,
        [estado, id_cc, id_transporte, fecha_desde, fecha_hasta, buscar, camaras]
    );
    return result.rows;
};

// Un despacho por id, sin filtrar alcance.
// El controller compara después para distinguir 404 de 403.
const getDespachoById = async (id_despacho) => {
    const result = await db.query(
        `SELECT * FROM vw_despachos WHERE id_despacho = $1`,
        [id_despacho]
    );
    return result.rows[0];
};

// El picking completo, con la trazabilidad de cada línea.
const getDetalle = async (id_despacho) => {
    const result = await db.query(
        `
        SELECT * FROM vw_despachos_detalle
        WHERE id_despacho = $1
        ORDER BY id_detalle
        `,
        [id_despacho]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Alta del documento
// ----------------------------------------------------------------------------
// El folio se genera en la BD con fn_generar_folio_despacho(), que consume
// la secuencia seq_folio_despacho (numeración de negocio desde 70000).
// Calcularlo con MAX(folio)+1 abriría una ventana de carrera.
//
// Nace en estado 1 (borrador).
const createDespacho = async ({
    id_transporte,
    fecha_despacho,
    hora_salida,
    id_cc,
    orden_venta,
    cita,
    fecha_cita,
    temperatura_salida,
    observaciones
}) => {
    const result = await db.query(
        `
        INSERT INTO despachos (
            folio_despacho, id_transporte, fecha_despacho, hora_salida,
            id_cc, orden_venta, cita, fecha_cita,
            temperatura_salida, observaciones, estado
        )
        VALUES (
            fn_generar_folio_despacho(), $1, $2, $3,
            $4, $5, $6, $7,
            $8, $9, 1
        )
        RETURNING *
        `,
        [
            id_transporte,
            fecha_despacho,
            hora_salida,
            id_cc,
            orden_venta,
            cita,
            fecha_cita,
            temperatura_salida,
            observaciones
        ]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Edición del encabezado
// ----------------------------------------------------------------------------
// NO toca cantidad_tarimas ni cantidad_cajas: los deriva el trigger.
// Tampoco el folio ni el estado, que tienen su propia vía.
const updateDespacho = async (
    id_despacho,
    {
        id_transporte,
        fecha_despacho,
        hora_salida,
        id_cc,
        orden_venta,
        cita,
        fecha_cita,
        temperatura_salida,
        observaciones
    }
) => {
    const result = await db.query(
        `
        UPDATE despachos
        SET
            id_transporte = $2,
            fecha_despacho = $3,
            hora_salida = $4,
            id_cc = $5,
            orden_venta = $6,
            cita = $7,
            fecha_cita = $8,
            temperatura_salida = $9,
            observaciones = $10
        WHERE id_despacho = $1
        RETURNING *
        `,
        [
            id_despacho,
            id_transporte,
            fecha_despacho,
            hora_salida,
            id_cc,
            orden_venta,
            cita,
            fecha_cita,
            temperatura_salida,
            observaciones
        ]
    );
    return result.rows[0];
};

// Cerrar: el camión salió.
const cerrarDespacho = async (id_despacho) => {
    const result = await db.query(
        `UPDATE despachos SET estado = 2 WHERE id_despacho = $1 RETURNING *`,
        [id_despacho]
    );
    return result.rows[0];
};

// Reabrir a borrador. Solo admin, y siempre con auditoría.
const reabrirDespacho = async (id_despacho) => {
    const result = await db.query(
        `UPDATE despachos SET estado = 1 WHERE id_despacho = $1 RETURNING *`,
        [id_despacho]
    );
    return result.rows[0];
};

// Eliminar el documento. Solo si está en borrador Y sin líneas: con líneas
// hay que quitarlas primero para devolver la fruta a las cámaras.
const deleteDespacho = async (id_despacho) => {
    const result = await db.query(
        `DELETE FROM despachos WHERE id_despacho = $1 RETURNING *`,
        [id_despacho]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// PICKING — agregar línea
// ----------------------------------------------------------------------------
// ⚠️ Este INSERT dispara trg_despacho_detalle_movimiento (BEFORE INSERT),
// que crea el movimiento tipo 3 y escribe su id en NEW.id_movimiento. Ese
// movimiento, a su vez, dispara el trigger que descuenta la cámara.
const agregarLinea = async ({
    id_despacho,
    id_produccion,
    id_ocupacion_origen,
    id_camara_origen,
    id_bloque,
    cantidad_tarimas,
    cantidad_cajas,
    temperatura,
    observaciones
}) => {
    const result = await db.query(
        `
        INSERT INTO despachos_detalle (
            id_despacho, id_produccion, id_ocupacion_origen,
            id_camara_origen, id_bloque,
            cantidad_tarimas, cantidad_cajas, temperatura, observaciones
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
        `,
        [
            id_despacho,
            id_produccion,
            id_ocupacion_origen,
            id_camara_origen,
            id_bloque,
            cantidad_tarimas,
            cantidad_cajas,
            temperatura,
            observaciones
        ]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// PICKING — quitar línea
// ----------------------------------------------------------------------------
// Llama a fn_quitar_linea_despacho. Desde la v2.5 la función ya no devuelve
// la fruta por su cuenta: verifica que el despacho siga en borrador, borra
// la línea y borra el movimiento tipo 3. Ese borrado dispara
// trg_revertir_movimiento, que devuelve la fruta a su ocupación de origen y
// la reabre si se había cerrado.
//
// Así hay una sola vía de reversa: si la función también devolviera la
// fruta, la cámara recuperaría el doble.
//
// ⚠️ Devuelve TEXTO, no excepción: 'OK: ...' o el motivo del rechazo. El
// controller lo interpreta.
const quitarLinea = async (id_detalle) => {
    const result = await db.query(
        `SELECT fn_quitar_linea_despacho($1) AS resultado`,
        [id_detalle]
    );
    return result.rows[0].resultado;
};

const getLineaById = async (id_detalle) => {
    const result = await db.query(
        `SELECT * FROM vw_despachos_detalle WHERE id_detalle = $1`,
        [id_detalle]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Coherencia del picking contra el documento
// ----------------------------------------------------------------------------
// Líneas cuyo cliente NO coincide con el del despacho: subir al camión de
// Walmart fruta planeada para Chedraui. El CEDIS la rechaza en el andén o
// se factura mal.
const getLineasDeOtroCliente = async (id_despacho) => {
    const result = await db.query(
        `
        SELECT
            dd.id_detalle,
            dd.cantidad_tarimas,
            p.codigo_lote,
            cc_linea.cliente AS cliente_fruta,
            cc_linea.cedis   AS cedis_fruta,
            cc_desp.cliente  AS cliente_despacho,
            cc_desp.cedis    AS cedis_despacho
        FROM despachos_detalle dd
        JOIN despachos      d        ON d.id_despacho   = dd.id_despacho
        JOIN cedis_cliente  cc_desp  ON cc_desp.id_cc   = d.id_cc
        LEFT JOIN produccion p       ON p.id_produccion = dd.id_produccion
        LEFT JOIN cedis_cliente cc_linea ON cc_linea.id_cc = p.id_cc
        WHERE dd.id_despacho = $1
          AND p.id_cc IS NOT NULL
          AND p.id_cc <> d.id_cc
        `,
        [id_despacho]
    );
    return result.rows;
};

// Cámaras que aportaron fruta a este despacho. El controller la usa para
// validar el alcance sobre un documento que ya tiene picking.
const getCamarasDelDespacho = async (id_despacho) => {
    const result = await db.query(
        `
        SELECT DISTINCT id_camara_origen
        FROM despachos_detalle
        WHERE id_despacho = $1 AND id_camara_origen IS NOT NULL
        `,
        [id_despacho]
    );
    return result.rows.map((r) => Number(r.id_camara_origen));
};

// ----------------------------------------------------------------------------
// AUDITORÍA
// ----------------------------------------------------------------------------
// Un despacho cerrado no se elimina, pero sí admite corregir datos
// administrativos. Cada corrección exige motivo y queda registrada.
const registrarAuditoria = async ({
    id_despacho,
    estado_al_editar,
    motivo,
    cambios,
    id_usuario
}) => {
    const result = await db.query(
        `
        INSERT INTO despachos_auditoria (
            id_despacho, estado_al_editar, motivo, cambios, id_usuario
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [id_despacho, estado_al_editar, motivo, cambios, id_usuario]
    );
    return result.rows[0];
};

const getAuditoria = async (id_despacho) => {
    const result = await db.query(
        `
        SELECT * FROM vw_despachos_auditoria
        WHERE id_despacho = $1
        ORDER BY fecha_hora DESC
        `,
        [id_despacho]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Clientes con fruta disponible — dropdown del picking
// ----------------------------------------------------------------------------
// ⚠️ No se usa vw_clientes_con_inventario directo: esa vista agrega TODO el
// inventario y ofrecería clientes cuya fruta está en otra planta. Se
// recalcula el agregado con el filtro de alcance aplicado.
const getClientesConInventario = async (camaras = null) => {
    const result = await db.query(
        `
        SELECT
            id_cc,
            cliente,
            cedis,
            acronimo_cc,
            COUNT(*)                 AS procesos,
            SUM(tarimas_disponibles) AS tarimas_disponibles,
            SUM(cajas_disponibles)   AS cajas_disponibles,
            MIN(fecha_entrega)       AS fecha_entrega_proxima,
            MIN(fecha_empaque)       AS fecha_empaque_mas_antigua,
            MIN(nivel_criticidad)    AS nivel_criticidad,
            MIN(holgura_dias)        AS holgura_minima
        FROM vw_inventario_disponible
        WHERE id_cc IS NOT NULL
          AND ($1::INT[] IS NULL OR id_camara = ANY($1))
        GROUP BY id_cc, cliente, cedis, acronimo_cc
        ORDER BY MIN(nivel_criticidad), cliente, cedis
        `,
        [camaras]
    );
    return result.rows;
};

// Fruta disponible para armar el picking.
// Criticidad y luego FEFO (v2.3): lo que está más cerca de incumplir su cita
// aparece primero. El ORDER BY va explícito: el de la vista deja de estar
// garantizado en cuanto se aplica el WHERE.
const getDisponibleParaPicking = async (id_cc, camaras = null) => {
    const result = await db.query(
        `
        SELECT * FROM vw_inventario_disponible
        WHERE ($1::INT IS NULL OR id_cc = $1)
          AND ($2::INT[] IS NULL OR id_camara = ANY($2))
        ORDER BY nivel_criticidad ASC,
                 fecha_empaque ASC NULLS LAST,
                 id_ocupacion ASC
        `,
        [id_cc, camaras]
    );
    return result.rows;
};

const despachosModel = {
    getDespachos,
    getDespachoById,
    getDetalle,
    createDespacho,
    updateDespacho,
    cerrarDespacho,
    reabrirDespacho,
    deleteDespacho,
    agregarLinea,
    quitarLinea,
    getLineaById,
    getLineasDeOtroCliente,
    getCamarasDelDespacho,
    registrarAuditoria,
    getAuditoria,
    getClientesConInventario,
    getDisponibleParaPicking
};

export default despachosModel;
