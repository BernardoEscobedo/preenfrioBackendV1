import { db } from "../database/connection.database.js";

// ============================================================================
// RECEPCIONES
// ============================================================================
// Lo que REALMENTE llega al andén, contra lo que decía el plan. Relación
// 1..N con producción: un mismo proceso puede llegar en varios viajes.
//
// ⚠️ REGLA DE ORO DE ESTE MÓDULO
//   Este modelo NUNCA escribe en ocupaciones_camaras. Un INSERT aquí
//   dispara DOS triggers que hacen todo el trabajo de inventario:
//
//     trg_sync_ocupacion_recepcion     mete a la cámara lo que quepa
//                                      (tipo 1) y manda el excedente a la
//                                      COLA de esa misma cámara (tipo 3)
//
//     trg_actualizar_estado_produccion mueve la producción a estado 2
//                                      (en recepción) o 3 (recibida)
//
//   La lógica vive en la BD a propósito: así cualquier origen de datos
//   —este backend, una importación masiva, una corrección manual en
//   Supabase— mantiene las ocupaciones cuadradas. Si el backend también
//   descontara, tendríamos doble descuento en cuanto alguien insertara por
//   otra vía.
//
// DIVISIÓN DENTRO / EN ESPERA
//   tarimas_recibidas   = lo que llegó al andén
//   tarimas_ingresadas  = lo que ENTRA físicamente a la cámara
//   La diferencia queda en la cola (tipo_ocupacion = 3), esperando espacio.
//
//   Si tarimas_ingresadas viene NULL, el trigger calcula automáticamente lo
//   que quepa con fn_tarimas_disponibles. Si viene con número, se respeta:
//   el operador vio el patio y decidió.
//
// ALCANCE POR CÁMARA
//   Igual que producción: los modelos reciben req.camaras y filtran.
//   La cámara de la recepción puede diferir de la planeada — al llegar el
//   camión, el supervisor decide dónde cabe realmente.
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
        -- COALESCE porque tarimas_ingresadas admite NULL (el trigger lo
        -- calculó solo y no lo escribió de vuelta).
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
// tarimas_ingresadas / cajas_ingresadas pueden ir NULL: el trigger calcula
// lo que quepa. Se mandan con valor cuando el operador confirmó en el modal
// cuántas tarimas metió de verdad.
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
//   trg_sync_ocupacion_recepcion es AFTER INSERT, no AFTER UPDATE. Cambiar
//   tarimas_recibidas por UPDATE modificaría el número en la tabla pero
//   NO movería la ocupación correspondiente: la cámara seguiría con las
//   tarimas originales y el inventario quedaría descuadrado en silencio.
//
//   Si la cantidad estuvo mal, se cancela la recepción y se captura otra.
//   Es más trabajo, pero deja rastro de la corrección.
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
// estado = 0. Dispara trg_actualizar_estado_produccion (que solo suma las
// recepciones activas), así que la producción recalcula su estado sola.
//
// ⚠️ LO QUE ESTO **NO** HACE
//   NO devuelve las tarimas de la cámara. trg_sync_ocupacion_recepcion es
//   AFTER INSERT: al cancelar no se dispara nada que revierta la ocupación.
//
//   Es una limitación conocida del esquema. El controller avisa en la
//   respuesta para que el supervisor ajuste el inventario a mano o con un
//   movimiento. Documentarlo es mejor que simularlo: si el backend
//   descontara por su cuenta, tendríamos dos fuentes de verdad peleándose.
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
// Permite ver qué hicieron los triggers: cuánto entró a cámara (tipo 1) y
// cuánto quedó en cola (tipo 3). Es la herramienta de diagnóstico cuando
// alguien pregunta "¿por qué mi fruta no está dentro?".
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

// Capacidad libre de una cámara, ANTES de recibir.
// El controller la consulta para avisar cuánto va a quedar en cola si el
// camión trae más de lo que cabe.
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
