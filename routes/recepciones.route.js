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
// Usa vw_recepciones_esperadas, que ya cruza el plan contra lo recibido y
// calcula el pendiente. Se consulta la vista en vez de rearmar el JOIN aquí
// para que el dashboard y este módulo no calculen distinto.
//
// solo_pendientes: oculta lo que ya llegó completo. Es lo que quiere ver el
// andén; el listado completo sirve para revisar la semana.
const getEsperadas = async (
    { semana = null, solo_pendientes = true, id_camara = null } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        SELECT * FROM vw_recepciones_esperadas
        WHERE ($1::INT IS NULL OR semana = $1)
          AND ($2::INT IS NULL OR id_camara = $2)
          AND ($3::INT[] IS NULL OR id_camara = ANY($3))
          AND ($4::BOOLEAN IS FALSE OR tarimas_pendientes > 0)
        ORDER BY fecha_entrega NULLS LAST, fecha_empaque
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
const createRecepcion = async ({
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
}) => {
    const result = await db.query(
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
            tarimas_ingresadas,
            cajas_ingresadas,
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
// Si parte de esa fruta ya se movió a conservación o se despachó, la cámara
// solo descuenta lo que todavía tiene (el trigger corta con GREATEST para no
// quedar en negativo). El controller compara antes y después para avisarlo.
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
const getDisponibilidad = async (id_camara) => {
    const result = await db.query(
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

const recepcionesModel = {
    getRecepciones,
    getRecepcionById,
    getEsperadas,
    createRecepcion,
    updateRecepcion,
    cancelarRecepcion,
    reactivarRecepcion,
    getOcupacionesGeneradas,
    getDisponibilidad
};

export default recepcionesModel;
