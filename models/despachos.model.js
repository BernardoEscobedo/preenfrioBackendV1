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
//   Este modelo NUNCA escribe en ocupaciones_camaras. Si lo hiciera,
//   tendríamos doble descuento: el de aquí y el del movimiento.
//
// ⚠️ LOS TOTALES NO SE CAPTURAN
//   despachos.cantidad_tarimas y cantidad_cajas los mantiene
//   trg_recalcular_totales_despacho sumando el detalle. Por eso el INSERT y
//   el UPDATE del encabezado no los tocan.
//
// ESTADOS
//   1 = borrador  se puede editar, agregar líneas y eliminar
//   2 = cerrado   ya salió; solo admite corrección auditada
//
//   NO existe "cancelado" a propósito: un despacho o salió o no salió.
//   Marcarlo como cancelado sin revertir el inventario generaba descuadres
//   silenciosos.
//
// ALCANCE POR CÁMARA
//   El documento no tiene cámara — la tienen sus líneas. Un supervisor ve
//   los despachos que llevan fruta de SUS cámaras, más los borradores
//   vacíos (que todavía no tienen planta asignada).
// ============================================================================

// ----------------------------------------------------------------------------
// Listado — lee vw_despachos
// ----------------------------------------------------------------------------
// La vista ya resuelve cliente, CEDIS, transporte y los conteos de líneas,
// fotos y ediciones.
//
// EL FILTRO DE ALCANCE ES POR EXISTENCIA DE LÍNEA
//   Un despacho pertenece a quien puso la fruta. La condición tiene dos
//   partes:
//     · EXISTS  → alguna de sus líneas sale de una cámara del alcance
//     · NOT EXISTS → es un borrador todavía sin líneas, así que no tiene
//                    planta asignada y cualquiera puede continuarlo
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

// El picking completo. Lee vw_despachos_detalle, que trae la trazabilidad
// de cada línea: lote, finca, productor, SKU y cámara de origen.
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
//
// Generarlo aquí con un SELECT MAX(folio)+1 abriría una ventana de carrera:
// dos despachos simultáneos tomarían el mismo número. La secuencia no.
//
// Nace en estado 1 (borrador): sin líneas todavía, el camión aún no carga.
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
// NO toca cantidad_tarimas ni cantidad_cajas: esos los deriva el trigger
// desde el detalle. Tampoco el folio ni el estado, que tienen su propia vía.
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

// Cerrar: el camión salió. A partir de aquí solo se admiten correcciones
// administrativas auditadas.
const cerrarDespacho = async (id_despacho) => {
    const result = await db.query(
        `UPDATE despachos SET estado = 2 WHERE id_despacho = $1 RETURNING *`,
        [id_despacho]
    );
    return result.rows[0];
};

// Reabrir a borrador. Solo admin, y siempre con auditoría: significa que el
// documento se cerró por error.
const reabrirDespacho = async (id_despacho) => {
    const result = await db.query(
        `UPDATE despachos SET estado = 1 WHERE id_despacho = $1 RETURNING *`,
        [id_despacho]
    );
    return result.rows[0];
};

// Eliminar el documento. Solo si está en borrador Y sin líneas: con líneas
// habría que devolver la fruta a las cámaras, y para eso está
// fn_quitar_linea_despacho.
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
//
// Por eso aquí NO se toca ocupaciones_camaras: el descuento ya viene por
// esa cadena. Tocarlo sería descontar dos veces.
//
// id_camara_origen e id_produccion se pueden omitir: el trigger los deduce
// de la ocupación. Se mandan de todos modos porque el controller ya los
// consultó para validar, y dejarlos explícitos hace el registro legible.
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
// Llama a fn_quitar_linea_despacho, que hace la reversa completa en una
// sola operación atómica:
//   1. Devuelve tarimas y cajas a la ocupación de origen
//   2. La reabre si se había cerrado al vaciarse
//   3. Borra la línea del detalle
//   4. Borra el movimiento tipo 3 asociado
//
// Es la única reversa real del sistema: a recepciones y movimientos les
// falta, porque sus triggers son AFTER INSERT y no revierten al borrar.
//
// ⚠️ Devuelve TEXTO, no excepción: 'OK: ...' o el motivo del rechazo (por
// ejemplo, que el despacho ya esté cerrado). El controller lo interpreta.
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
// Devuelve las líneas cuyo cliente NO coincide con el del despacho.
//
// El caso que detecta: subir al camión de Walmart fruta que estaba planeada
// para Chedraui. El CEDIS la rechaza en el andén o se factura mal, y el
// costo del error es el viaje completo.
//
// No se bloquea al agregar la línea porque la fruta SÍ se reasigna entre
// clientes y bloquear volvería el sistema inusable — pero cerrar el
// despacho sin revisarlo sería peor.
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
// administrativos: placas mal escritas, la orden de venta que llegó tarde.
// Cada corrección exige motivo y queda registrada.
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
// Evita ofrecer los 40 del catálogo cuando solo hay fruta para tres.
//
// ⚠️ Para usuarios con alcance limitado NO se usa vw_clientes_con_inventario
// directo: esa vista agrega TODO el inventario, así que ofrecería clientes
// cuya fruta está en otra planta. Se recalcula el agregado con el filtro
// aplicado.
//
// v2.3: incluye nivel_criticidad, así el dropdown marca de una cuáles
// clientes tienen fruta que ya no puede esperar.
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

// Fruta disponible para armar el picking de un cliente concreto.
// Viene de vw_inventario_disponible, ordenada por criticidad y luego FEFO
// (v2.3): lo que está más cerca de incumplir su cita aparece primero.
const getDisponibleParaPicking = async (id_cc, camaras = null) => {
    const result = await db.query(
        `
        SELECT * FROM vw_inventario_disponible
        WHERE ($1::INT IS NULL OR id_cc = $1)
          AND ($2::INT[] IS NULL OR id_camara = ANY($2))
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
