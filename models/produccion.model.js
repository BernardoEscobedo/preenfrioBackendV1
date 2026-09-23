import { db } from "../database/connection.database.js";

// ============================================================================
// PRODUCCIÓN
// ============================================================================
// Cada renglón es una línea del plan diario de logística: qué finca empacó,
// cuánto, para qué cliente y a qué cámara de preenfrío va.
//
// PRIMER MÓDULO CON ALCANCE POR CÁMARA
//   Los catálogos anteriores no se filtraban porque un productor o un SKU no
//   pertenecen a una planta. La producción sí: id_camara define dónde se va
//   a enfriar esa fruta.
//
//   getProduccion recibe el arreglo desde cargarAlcance:
//       null   -> sin restricción (Admin / Coordinador)
//       [1,2]  -> solo esas cámaras (Supervisor / Operativo)
//
//   SOBRE LAS PRODUCCIONES SIN CÁMARA (id_camara NULL = CEDA directo)
//   Para un usuario con alcance limitado se EXCLUYEN. No es un descuido:
//   esa fruta no pasa por ningún preenfrío, así que nunca va a tocar su
//   operación. Mostrársela solo ensuciaría su pantalla de recepciones con
//   filas que jamás va a recibir. Admin y Coordinador sí las ven.
//
// EL CÓDIGO DE LOTE SE GENERA EN LA BD
//   No se arma en JavaScript: se llama a fn_generar_lote() dentro del mismo
//   INSERT, tomando zona, códigos y turno directo de los catálogos. Así el
//   lote no puede desincronizarse de la finca que lo originó, y si mañana
//   cambia el formato se cambia en un solo lugar.
//
//       Zona(1) Productor(2) Finca(3) - Semana(2) FechaDDMM(4) - Turno(1)
//       Ej: B12015-251806-1
//
// EL ESTADO NO SE TOCA DESDE AQUÍ
//   produccion.estado lo mantiene al día el trigger
//   trg_actualizar_estado_produccion según lo que se va recibiendo
//   (1 planeada → 2 en recepción → 3 recibida). Por eso updateProduccion NO
//   escribe esa columna: si lo hiciera, guardar un comentario podría
//   regresar a "planeada" una producción ya recibida.
//   La cancelación (estado 0) sí es manual y tiene su propio método.
// ============================================================================

// Los catálogos van resueltos en el SELECT para que el frontend no tenga
// que hacer una consulta por cada renglón de la tabla.
//
// 'calidad' se toma de sku_pt vía JOIN: produccion no la guarda a propósito,
// para que no pueda decir PRIMERA mientras su SKU dice otra cosa.
const SELECT_PRODUCCION = `
    SELECT
        p.*,
        f.codigo_finca,
        f.nombre            AS nombre_finca,
        f.org_inv_nombre,
        f.zona,
        CASE f.zona
            WHEN 1 THEN 'CHIAPAS'
            WHEN 2 THEN 'COLIMA'
            WHEN 3 THEN 'TABASCO'
            ELSE 'SIN ZONA'
        END                 AS zona_nombre,
        pr.codigo_productor,
        pr.nombre           AS nombre_productor,
        s.codigo_sku,
        s.calidad           AS calidad_sku,
        s.turno             AS turno_sku,
        cc.cliente,
        cc.cedis,
        cc.acronimo         AS acronimo_cc,
        cam.nombre_camara,
        cam.tipo_camara,
        -- NULL en id_camara significa CEDA directo: no pasa por preenfrío
        CASE WHEN p.id_camara IS NOT NULL THEN TRUE ELSE FALSE END AS se_preenfria,
        CASE p.estado
            WHEN 0 THEN 'Cancelada'
            WHEN 1 THEN 'Planeada'
            WHEN 2 THEN 'En recepción'
            WHEN 3 THEN 'Recibida'
            ELSE 'Otro'
        END                 AS estado_texto,
        -- Lo que ya llegó: permite mostrar el avance sin consultar aparte
        COALESCE(r.cajas_recibidas, 0)   AS cajas_recibidas,
        COALESCE(r.tarimas_recibidas, 0) AS tarimas_recibidas,
        COALESCE(r.num_recepciones, 0)   AS num_recepciones
    FROM produccion p
    JOIN fincas        f   ON f.id_finca      = p.id_finca
    JOIN productores   pr  ON pr.id_productor = p.id_productor
    JOIN sku_pt        s   ON s.id_sku        = p.id_sku
    JOIN cedis_cliente cc  ON cc.id_cc        = p.id_cc
    LEFT JOIN camaras  cam ON cam.id_camara   = p.id_camara
    LEFT JOIN (
        SELECT id_produccion,
               SUM(cajas_recibidas)   AS cajas_recibidas,
               SUM(tarimas_recibidas) AS tarimas_recibidas,
               COUNT(*)               AS num_recepciones
        FROM recepciones
        WHERE estado = 1
        GROUP BY id_produccion
    ) r ON r.id_produccion = p.id_produccion
`;

// ----------------------------------------------------------------------------
// Listado con filtros y alcance
// ----------------------------------------------------------------------------
// El patrón ($n::TIPO IS NULL OR ...) evita armar SQL dinámico: si el
// parámetro llega NULL la condición se cumple siempre y la misma query
// sirve para todos los casos.
//
// El filtro de alcance lleva una condición extra a las de los catálogos:
//   ($8::INT[] IS NULL OR p.id_camara = ANY($8))
// Al comparar con = ANY, las filas con id_camara NULL quedan fuera
// automáticamente, que es justo lo que se busca para el alcance limitado.
const getProduccion = async (
    {
        semana = null,
        estado = null,
        id_camara = null,
        id_finca = null,
        id_cc = null,
        fecha_desde = null,
        fecha_hasta = null,
        buscar = null
    } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        ${SELECT_PRODUCCION}
        WHERE ($1::INT IS NULL OR p.semana = $1)
          AND ($2::INT IS NULL OR p.estado = $2)
          AND ($3::INT IS NULL OR p.id_camara = $3)
          AND ($4::INT IS NULL OR p.id_finca = $4)
          AND ($5::INT IS NULL OR p.id_cc = $5)
          AND ($6::DATE IS NULL OR p.fecha_empaque >= $6)
          AND ($7::DATE IS NULL OR p.fecha_empaque <= $7)
          AND ($8::INT[] IS NULL OR p.id_camara = ANY($8))
          AND ($9::TEXT IS NULL
               OR p.codigo_lote ILIKE '%' || $9 || '%'
               OR f.nombre ILIKE '%' || $9 || '%'
               OR cc.cliente ILIKE '%' || $9 || '%'
               OR cc.acronimo ILIKE '%' || $9 || '%')
        ORDER BY p.fecha_empaque DESC, p.id_produccion DESC
        `,
        [
            semana,
            estado,
            id_camara,
            id_finca,
            id_cc,
            fecha_desde,
            fecha_hasta,
            camaras,
            buscar
        ]
    );
    return result.rows;
};

// Una producción por id, SIN filtrar por alcance.
// El controller compara el resultado después, para poder distinguir entre
// "no existe" (404) y "existe pero no es de tu planta" (403). Es el mismo
// criterio que usa camaras.model.js.
const getProduccionById = async (id_produccion) => {
    const result = await db.query(
        `${SELECT_PRODUCCION} WHERE p.id_produccion = $1`,
        [id_produccion]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Alta
// ----------------------------------------------------------------------------
// El codigo_lote se calcula dentro del propio INSERT: el SELECT cruza las
// tres tablas de catálogo (cada una devuelve una sola fila) y pasa sus
// valores a fn_generar_lote.
//
// Ventaja sobre generarlo en JavaScript: el lote SIEMPRE corresponde a la
// finca, el productor y el SKU que realmente se guardaron. No hay forma de
// que el backend mande un lote que no cuadre con las FK de su propia fila.
const createProduccion = async ({
    semana,
    region,
    id_finca,
    id_productor,
    fecha_empaque,
    transito,
    fecha_entrega,
    id_cc,
    id_sku,
    cajas_procesadas,
    estiba_pallets,
    comentarios,
    id_camara
}) => {
    const result = await db.query(
        `
        INSERT INTO produccion (
            semana, region, id_finca, id_productor, fecha_empaque,
            transito, fecha_entrega, id_cc, id_sku,
            cajas_procesadas, estiba_pallets, comentarios,
            id_camara, codigo_lote
        )
        SELECT
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12,
            $13,
            fn_generar_lote(f.zona, pr.codigo_productor, f.codigo_finca,
                            $1, $5, s.turno)
        FROM fincas f
        CROSS JOIN productores pr
        CROSS JOIN sku_pt s
        WHERE f.id_finca = $3
          AND pr.id_productor = $4
          AND s.id_sku = $9
        RETURNING *
        `,
        [
            semana,
            region,
            id_finca,
            id_productor,
            fecha_empaque,
            transito,
            fecha_entrega,
            id_cc,
            id_sku,
            cajas_procesadas,
            estiba_pallets,
            comentarios,
            id_camara
        ]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Edición
// ----------------------------------------------------------------------------
// OJO: NO escribe la columna 'estado'. La mantiene el trigger según lo
// recibido; si este UPDATE la tocara, guardar un comentario podría regresar
// a "planeada" una producción que ya está recibida.
//
// El codigo_lote se RECALCULA porque los datos que lo componen (finca,
// productor, SKU, semana, fecha de empaque) sí son editables. Dejarlo fijo
// haría que una corrección de fecha produjera un lote que ya no describe su
// propia fruta.
const updateProduccion = async (
    id_produccion,
    {
        semana,
        region,
        id_finca,
        id_productor,
        fecha_empaque,
        transito,
        fecha_entrega,
        id_cc,
        id_sku,
        cajas_procesadas,
        estiba_pallets,
        comentarios,
        id_camara
    }
) => {
    const result = await db.query(
        `
        UPDATE produccion p
        SET
            semana = $2,
            region = $3,
            id_finca = $4,
            id_productor = $5,
            fecha_empaque = $6,
            transito = $7,
            fecha_entrega = $8,
            id_cc = $9,
            id_sku = $10,
            cajas_procesadas = $11,
            estiba_pallets = $12,
            comentarios = $13,
            id_camara = $14,
            codigo_lote = fn_generar_lote(f.zona, pr.codigo_productor,
                                          f.codigo_finca, $2, $6, s.turno)
        FROM fincas f, productores pr, sku_pt s
        WHERE p.id_produccion = $1
          AND f.id_finca = $4
          AND pr.id_productor = $5
          AND s.id_sku = $10
        RETURNING p.*
        `,
        [
            id_produccion,
            semana,
            region,
            id_finca,
            id_productor,
            fecha_empaque,
            transito,
            fecha_entrega,
            id_cc,
            id_sku,
            cajas_procesadas,
            estiba_pallets,
            comentarios,
            id_camara
        ]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Reasignación de cámara
// ----------------------------------------------------------------------------
// Endpoint propio, separado del UPDATE completo, porque es la operación más
// frecuente del planeador: mover fruta de un preenfrío saturado a otro con
// espacio. Obligar a reenviar las quince columnas para cambiar una sola
// invitaba a errores de captura.
//
// Admite NULL para marcar "va directo a CEDA, sin preenfrío".
const reasignarCamara = async (id_produccion, id_camara) => {
    const result = await db.query(
        `
        UPDATE produccion SET id_camara = $2
        WHERE id_produccion = $1
        RETURNING *
        `,
        [id_produccion, id_camara]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Cancelación
// ----------------------------------------------------------------------------
// estado = 0. Es el único valor del ciclo de vida que se pone a mano: el
// trigger respeta el 0 y nunca lo pisa (su UPDATE lleva "AND estado <> 0").
//
// No se borra la fila: si ya hubo recepciones, sus ocupaciones y
// movimientos siguen apuntando aquí.
const cancelarProduccion = async (id_produccion) => {
    const result = await db.query(
        `
        UPDATE produccion SET estado = 0
        WHERE id_produccion = $1
        RETURNING *
        `,
        [id_produccion]
    );
    return result.rows[0];
};

// Reactivar una cancelada.
// Se recalcula el estado con el mismo criterio del trigger, en vez de
// asumir "planeada": si mientras estuvo cancelada quedaron recepciones
// activas, debe volver a 2 o 3, no a 1.
const reactivarProduccion = async (id_produccion) => {
    const result = await db.query(
        `
        UPDATE produccion p
        SET estado = CASE
            WHEN COALESCE(r.cajas, 0) <= 0            THEN 1
            WHEN COALESCE(r.cajas, 0) < p.cajas_procesadas THEN 2
            ELSE 3
        END
        FROM (
            SELECT COALESCE(SUM(cajas_recibidas), 0) AS cajas
            FROM recepciones
            WHERE id_produccion = $1 AND estado = 1
        ) r
        WHERE p.id_produccion = $1
        RETURNING p.*
        `,
        [id_produccion]
    );
    return result.rows[0];
};

// Recepciones ligadas: el controller las consulta antes de permitir editar
// o cancelar. Una producción con fruta ya recibida no debería cambiar de
// finca o de SKU sin que alguien lo note.
const getDependencias = async (id_produccion) => {
    const result = await db.query(
        `
        SELECT
            (SELECT COUNT(*) FROM recepciones
              WHERE id_produccion = $1 AND estado = 1) AS recepciones,
            (SELECT COUNT(*) FROM bloques_produccion_detalle
              WHERE id_produccion = $1) AS bloques,
            (SELECT COUNT(*) FROM despachos_detalle
              WHERE id_produccion = $1) AS lineas_despacho
        `,
        [id_produccion]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Resumen por semana — encabezado del dashboard de planeación
// ----------------------------------------------------------------------------
// Respeta el alcance: un supervisor ve el resumen de SU planta, no el de
// toda la empresa.
const getResumenSemana = async (semana, camaras = null) => {
    const result = await db.query(
        `
        SELECT
            p.semana,
            COUNT(*)                          AS total_lineas,
            SUM(p.cajas_procesadas)           AS cajas_planeadas,
            SUM(p.estiba_pallets)             AS tarimas_planeadas,
            COUNT(*) FILTER (WHERE p.estado = 1) AS planeadas,
            COUNT(*) FILTER (WHERE p.estado = 2) AS en_recepcion,
            COUNT(*) FILTER (WHERE p.estado = 3) AS recibidas,
            COUNT(*) FILTER (WHERE p.estado = 0) AS canceladas,
            COUNT(*) FILTER (WHERE p.id_camara IS NULL AND p.estado <> 0)
                                              AS sin_preenfrio
        FROM produccion p
        WHERE ($1::INT IS NULL OR p.semana = $1)
          AND ($2::INT[] IS NULL OR p.id_camara = ANY($2))
        GROUP BY p.semana
        ORDER BY p.semana DESC
        `,
        [semana, camaras]
    );
    return result.rows;
};

const produccionModel = {
    getProduccion,
    getProduccionById,
    createProduccion,
    updateProduccion,
    reasignarCamara,
    cancelarProduccion,
    reactivarProduccion,
    getDependencias,
    getResumenSemana
};

export default produccionModel;
