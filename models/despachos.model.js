import { db } from "../database/connection.database.js";

// ============================================================================
// DESPACHOS
// ============================================================================
// El despacho es un DOCUMENTO: folio, transporte, cita y cliente. El picking
// (quÃ© fruta se sube) vive en despachos_detalle, y puede venir de VARIAS
// cÃ¡maras: por eso se arma desde el documento y no desde cada cÃ¡mara.
//
// âš ï¸ UNA SOLA VÃA DE DESCUENTO
//   Agregar una lÃ­nea de picking dispara trg_despacho_detalle_movimiento
//   (BEFORE INSERT), que genera el movimiento tipo 3. Es ESE movimiento â€”
//   con su propio trigger â€” el que descuenta la cÃ¡mara.
//
//   Quitar una lÃ­nea borra ese movimiento, y trg_revertir_movimiento (v2.5)
//   devuelve la fruta. Este modelo NUNCA escribe en ocupaciones_camaras.
//
// âš ï¸ LOS TOTALES NO SE CAPTURAN
//   despachos.cantidad_tarimas y cantidad_cajas los mantiene
//   trg_recalcular_totales_despacho sumando el detalle.
//
// âš ï¸ INOCUIDAD POR DESPACHO
//   La inspecciÃ³n de la unidad se guarda en el propio despacho:
//       inocuidad                NULL pendiente Â· 0 rechazada Â· 1 aprobada
//       inocuidad_fecha          la pone la BD (trg_validar_cierre)
//       inocuidad_id_usuario     el usuario de la sesiÃ³n
//       inocuidad_observaciones  texto libre
//
//   trg_validar_cierre (BEFORE INSERT OR UPDATE) ademÃ¡s:
//     Â· borra la inspecciÃ³n si cambia el transporte de un borrador
//     Â· impide cambiar transporte o inspecciÃ³n de un despacho cerrado
//     Â· no deja cerrar sin lÃ­neas ni sin inocuidad = 1
//     Â· no deja cerrar con fruta de otro cliente salvo que la transacciÃ³n
//       traiga app.confirmar_reasignacion = '1'
//
// ESTADOS
//   1 = borrador  se puede editar, agregar lÃ­neas, inspeccionar y eliminar
//   2 = cerrado   ya saliÃ³; solo admite correcciÃ³n auditada
//
//   NO existe "cancelado" a propÃ³sito: un despacho o saliÃ³ o no saliÃ³.
//
// ALCANCE POR CÃMARA
//   El documento no tiene cÃ¡mara â€” la tienen sus lÃ­neas. Un supervisor ve
//   los despachos que llevan fruta de SUS cÃ¡maras, mÃ¡s los borradores
//   vacÃ­os (que todavÃ­a no tienen planta asignada).
//
// CORRECCIÃ“N DE LA AUDITORÃA
//   getDisponibleParaPicking no tenÃ­a ORDER BY y confiaba en el orden de la
//   vista. En PostgreSQL, en cuanto se aplica un WHERE sobre una vista, ese
//   orden deja de estar garantizado: el picking podÃ­a dejar de mostrar
//   primero lo crÃ­tico sin que nadie lo notara.
// ============================================================================

// ----------------------------------------------------------------------------
// Listado â€” lee vw_despachos
// ----------------------------------------------------------------------------
// EL FILTRO DE ALCANCE ES POR EXISTENCIA DE LÃNEA
//   Â· EXISTS     â†’ alguna de sus lÃ­neas sale de una cÃ¡mara del alcance
//   Â· NOT EXISTS â†’ es un borrador todavÃ­a sin lÃ­neas
//
// ?inocuidad: 1 aprobada Â· 0 rechazada Â· 'pendiente' sin inspecciÃ³n
const getDespachos = async (
    {
        estado = null,
        id_cc = null,
        id_transporte = null,
        fecha_desde = null,
        fecha_hasta = null,
        buscar = null,
        inocuidad = null,
        inocuidad_pendiente = false
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
          AND ($8::INT IS NULL OR v.inocuidad = $8)
          AND ($9::BOOLEAN IS FALSE OR v.inocuidad IS NULL)
        ORDER BY v.fecha_despacho DESC, v.id_despacho DESC
        LIMIT 500
        `,
        [
            estado,
            id_cc,
            id_transporte,
            fecha_desde,
            fecha_hasta,
            buscar,
            camaras,
            inocuidad,
            inocuidad_pendiente
        ]
    );
    return result.rows;
};

// Un despacho por id, sin filtrar alcance.
// El controller compara despuÃ©s para distinguir 404 de 403.
const getDespachoById = async (id_despacho) => {
    const result = await db.query(
        `SELECT * FROM vw_despachos WHERE id_despacho = $1`,
        [id_despacho]
    );
    return result.rows[0];
};

// El picking completo, con la trazabilidad de cada lÃ­nea.
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
// la secuencia seq_folio_despacho (numeraciÃ³n de negocio desde 70000).
// Calcularlo con MAX(folio)+1 abrirÃ­a una ventana de carrera.
//
// Nace en estado 1 (borrador) y con la inspecciÃ³n PENDIENTE (inocuidad
// NULL): trg_validar_cierre exige que se cree en borrador.
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
// EdiciÃ³n del encabezado
// ----------------------------------------------------------------------------
// NO toca cantidad_tarimas ni cantidad_cajas: los deriva el trigger.
// Tampoco el folio, el estado ni la inspecciÃ³n, que tienen su propia vÃ­a.
//
// âš ï¸ Si cambia id_transporte en un borrador, trg_validar_cierre BORRA la
// inspecciÃ³n: la caja que se revisÃ³ ya no es la que va a cargar.
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

// ----------------------------------------------------------------------------
// INSPECCIÃ“N DE INOCUIDAD
// ----------------------------------------------------------------------------
// Solo borradores (estado = 1). La fecha NO se manda: la asigna
// trg_validar_cierre con CURRENT_TIMESTAMP. El usuario sale de la sesiÃ³n.
//
// Devuelve undefined si el despacho no existe o ya no estÃ¡ en borrador.
const registrarInocuidad = async (
    id_despacho,
    { inocuidad, id_usuario, observaciones }
) => {
    const result = await db.query(
        `
        UPDATE despachos
        SET inocuidad = $1,
            inocuidad_id_usuario = $2,
            inocuidad_observaciones = $3
        WHERE id_despacho = $4 AND estado = 1
        RETURNING *
        `,
        [inocuidad, id_usuario, observaciones, id_despacho]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// AuditorÃ­a (uso interno)
// ----------------------------------------------------------------------------
// Recibe el ejecutor (db o un cliente dentro de transacciÃ³n) para poder
// registrarse junto con el cierre.
const insertarAuditoria = async (
    ejecutor,
    { id_despacho, estado_al_editar, motivo, cambios, id_usuario }
) => {
    const result = await ejecutor.query(
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

// ----------------------------------------------------------------------------
// Cerrar: el camiÃ³n saliÃ³.
// ----------------------------------------------------------------------------
// Va en TRANSACCIÃ“N por dos motivos:
//
//   1. trg_validar_cierre rechaza el cierre con fruta de otro cliente salvo
//      que la MISMA transacciÃ³n traiga app.confirmar_reasignacion = '1'.
//      set_config(..., true) solo vive dentro de la transacciÃ³n: con un
//      UPDATE suelto, ?confirmar=1 nunca llegaba a la BD y el cierre
//      reventaba.
//
//   2. Si se cerrÃ³ con reasignaciÃ³n, la auditorÃ­a se guarda en la misma
//      transacciÃ³n: o quedan las dos cosas o ninguna.
const cerrarDespacho = async (
    id_despacho,
    { confirmarReasignacion = false, auditoria = null } = {}
) => {
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        await client.query(
            `SELECT set_config('app.confirmar_reasignacion', $1, true)`,
            [confirmarReasignacion ? "1" : ""]
        );

        const result = await client.query(
            `UPDATE despachos SET estado = 2 WHERE id_despacho = $1 RETURNING *`,
            [id_despacho]
        );

        if (result.rows[0] && auditoria) {
            await insertarAuditoria(client, { id_despacho, ...auditoria });
        }

        await client.query("COMMIT");
        return result.rows[0];
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

// Reabrir a borrador. Solo admin, y siempre con auditorÃ­a.
// La inspecciÃ³n se conserva: la unidad no cambiÃ³ por reabrir el documento.
const reabrirDespacho = async (id_despacho) => {
    const result = await db.query(
        `UPDATE despachos SET estado = 1 WHERE id_despacho = $1 RETURNING *`,
        [id_despacho]
    );
    return result.rows[0];
};

// Eliminar el documento. Solo si estÃ¡ en borrador Y sin lÃ­neas: con lÃ­neas
// hay que quitarlas primero para devolver la fruta a las cÃ¡maras.
const deleteDespacho = async (id_despacho) => {
    const result = await db.query(
        `DELETE FROM despachos WHERE id_despacho = $1 RETURNING *`,
        [id_despacho]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// PICKING â€” agregar lÃ­nea
// ----------------------------------------------------------------------------
// âš ï¸ Este INSERT dispara trg_despacho_detalle_movimiento (BEFORE INSERT),
// que crea el movimiento tipo 3 y escribe su id en NEW.id_movimiento. Ese
// movimiento, a su vez, dispara el trigger que descuenta la cÃ¡mara.
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
// PICKING â€” quitar lÃ­nea
// ----------------------------------------------------------------------------
// Llama a fn_quitar_linea_despacho. Desde la v2.5 la funciÃ³n ya no devuelve
// la fruta por su cuenta: verifica que el despacho siga en borrador, borra
// la lÃ­nea y borra el movimiento tipo 3. Ese borrado dispara
// trg_revertir_movimiento, que devuelve la fruta a su ocupaciÃ³n de origen y
// la reabre si se habÃ­a cerrado.
//
// AsÃ­ hay una sola vÃ­a de reversa: si la funciÃ³n tambiÃ©n devolviera la
// fruta, la cÃ¡mara recuperarÃ­a el doble.
//
// âš ï¸ Devuelve TEXTO, no excepciÃ³n: 'OK: ...' o el motivo del rechazo. El
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
// LÃ­neas cuyo cliente NO coincide con el del despacho: subir al camiÃ³n de
// Walmart fruta planeada para Chedraui. El CEDIS la rechaza en el andÃ©n o
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

// CÃ¡maras que aportaron fruta a este despacho. El controller la usa para
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
// AUDITORÃA
// ----------------------------------------------------------------------------
// Un despacho cerrado no se elimina, pero sÃ­ admite corregir datos
// administrativos. Cada correcciÃ³n exige motivo y queda registrada.
const registrarAuditoria = async (datos) => insertarAuditoria(db, datos);

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
// Clientes con fruta disponible â€” dropdown del picking
// ----------------------------------------------------------------------------
// âš ï¸ No se usa vw_clientes_con_inventario directo: esa vista agrega TODO el
// inventario y ofrecerÃ­a clientes cuya fruta estÃ¡ en otra planta. Se
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
// Criticidad y luego FEFO (v2.3): lo que estÃ¡ mÃ¡s cerca de incumplir su cita
// aparece primero. El ORDER BY va explÃ­cito: el de la vista deja de estar
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
    registrarInocuidad,
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