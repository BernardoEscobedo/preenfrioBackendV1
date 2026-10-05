import { db } from "../database/connection.database.js";

// ============================================================================
// TRANSPORTES
// ============================================================================
// Cada fila es un SERVICIO: la combinación LÍNEA + OPERADOR + TRACTO + CAJA
// tal como se presenta en el andén. Desde la etapa 1 de catálogos, cada pieza
// vive en su propia tabla y aquí solo se guardan sus cuatro IDs:
//
//     id_linea_fletera     → lineas_fleteras
//     id_operador          → operadores
//     id_tractocamion      → tractocamiones
//     id_caja_refrigerada  → cajas_refrigeradas
//
// ⚠️ LAS COLUMNAS ANTIGUAS SIGUEN EXISTIENDO (y son NOT NULL)
//   razon_social, nombre_operador, celular, placas_tracto, placas_caja,
//   no_economico_caja e inocuidad todavía están en la tabla con NOT NULL.
//   Hasta que se retiren con su propia migración, el alta y la edición las
//   llenan COPIANDO el dato de los catálogos dentro del mismo INSERT/UPDATE.
//   Nadie las captura a mano y las consultas de este model NO las leen salvo
//   como respaldo de registros antiguos que aún no tienen sus cuatro IDs.
//
// ⚠️ LA INOCUIDAD YA NO VIVE AQUÍ
//   Se registra en CADA DESPACHO (despachos.inocuidad). La columna
//   transportes.inocuidad solo se llena con 0 para cumplir el NOT NULL del
//   esquema anterior: ya no la consulta ninguna función ni el cierre del
//   despacho, y no significa "inspección aprobada" ni "rechazada".
//
// ⚠️ UN SERVICIO USADO NO CAMBIA DE COMBINACIÓN
//   trg_proteger_transporte_asignado rechaza cambiar cualquiera de los
//   cuatro IDs si el transporte ya tiene despachos. Si cambió la caja o el
//   operador, se crea otro servicio y se asigna al borrador; así la
//   inspección de un despacho nunca queda ligada a una caja distinta.
//
// LA BAJA ES LÓGICA
//   despachos.id_transporte apunta aquí: borrar una fila dejaría despachos
//   históricos sin poder decir quién se llevó la fruta.
// ============================================================================

// Columnas legibles del servicio. Para registros antiguos sin catálogos se
// usa la columna anterior como respaldo (COALESCE), así la pantalla y el
// histórico siguen mostrando quién era la unidad.
const SELECT_TRANSPORTE = `
    SELECT
        t.id_transporte,
        t.estado,
        t.id_linea_fletera,
        t.id_operador,
        t.id_tractocamion,
        t.id_caja_refrigerada,
        COALESCE(lf.razon_social, t.razon_social)       AS razon_social,
        lf.rfc                                          AS rfc_linea_fletera,
        lf.telefono_contacto,
        COALESCE(op.nombre, t.nombre_operador)          AS nombre_operador,
        COALESCE(op.celular, t.celular)                 AS celular,
        COALESCE(tr.placas, t.placas_tracto)            AS placas_tracto,
        tr.numero_economico                             AS no_economico_tracto,
        COALESCE(cr.placas, t.placas_caja)              AS placas_caja,
        COALESCE(cr.numero_economico, t.no_economico_caja) AS no_economico_caja,
        cr.largo_pies                                   AS largo_caja_pies,
        -- Los cuatro IDs capturados: requisito para usarlo en un despacho y
        -- para registrar la inspección de inocuidad.
        (t.id_linea_fletera IS NOT NULL AND t.id_operador IS NOT NULL
         AND t.id_tractocamion IS NOT NULL AND t.id_caja_refrigerada IS NOT NULL
        ) AS catalogos_completos,
        -- Las cuatro piezas siguen activas en su catálogo
        COALESCE(lf.estado = 1 AND op.estado = 1
                 AND tr.estado = 1 AND cr.estado = 1, FALSE) AS catalogos_activos,
        (SELECT COUNT(*) FROM despachos d
          WHERE d.id_transporte = t.id_transporte
        ) AS total_despachos,
        -- Último viaje: sirve para detectar servicios que ya no vienen y
        -- conviene dar de baja.
        (SELECT MAX(d.fecha_despacho) FROM despachos d
          WHERE d.id_transporte = t.id_transporte
        ) AS ultimo_despacho
    FROM transportes t
    LEFT JOIN lineas_fleteras    lf ON lf.id_linea_fletera    = t.id_linea_fletera
    LEFT JOIN operadores         op ON op.id_operador         = t.id_operador
    LEFT JOIN tractocamiones     tr ON tr.id_tractocamion     = t.id_tractocamion
    LEFT JOIN cajas_refrigeradas cr ON cr.id_caja_refrigerada = t.id_caja_refrigerada
`;

// FILTROS
//   estado            1 activos · 0 de baja
//   id_linea_fletera  servicios de una línea
//   completos         true → solo los que tienen los cuatro catálogos
//                     activos (dropdown del despacho)
//   buscar            línea, RFC, operador, placas o número económico
const getTransportes = async ({
    estado = null,
    id_linea_fletera = null,
    completos = false,
    buscar = null
} = {}) => {
    const result = await db.query(
        `
        SELECT * FROM (${SELECT_TRANSPORTE}) v
        WHERE ($1::INT IS NULL OR v.estado = $1)
          AND ($2::INT IS NULL OR v.id_linea_fletera = $2)
          AND ($3::BOOLEAN IS FALSE OR (v.catalogos_completos AND v.catalogos_activos))
          AND ($4::TEXT IS NULL
               OR v.razon_social ILIKE '%' || $4 || '%'
               OR v.rfc_linea_fletera ILIKE '%' || $4 || '%'
               OR v.nombre_operador ILIKE '%' || $4 || '%'
               OR v.placas_tracto ILIKE '%' || $4 || '%'
               OR v.placas_caja ILIKE '%' || $4 || '%'
               OR v.no_economico_tracto ILIKE '%' || $4 || '%'
               OR v.no_economico_caja ILIKE '%' || $4 || '%')
        ORDER BY v.razon_social, v.nombre_operador
        `,
        [estado, id_linea_fletera, completos, buscar]
    );
    return result.rows;
};

const getTransporteById = async (id_transporte) => {
    const result = await db.query(
        `${SELECT_TRANSPORTE} WHERE t.id_transporte = $1`,
        [id_transporte]
    );
    return result.rows[0];
};

// Las cuatro piezas que se quieren combinar, con su estado y su línea.
// El controller decide con esto si la combinación es válida: que existan,
// que estén activas y que no pertenezcan a otra línea fletera.
const getPiezas = async ({
    id_linea_fletera,
    id_operador,
    id_tractocamion,
    id_caja_refrigerada
}) => {
    const result = await db.query(
        `
        SELECT
            lf.id_linea_fletera,
            lf.razon_social,
            lf.estado              AS estado_linea,
            op.id_operador,
            op.nombre              AS nombre_operador,
            op.estado              AS estado_operador,
            op.id_linea_fletera    AS linea_operador,
            tr.id_tractocamion,
            tr.placas              AS placas_tracto,
            tr.estado              AS estado_tracto,
            tr.id_linea_fletera    AS linea_tracto,
            cr.id_caja_refrigerada,
            cr.placas              AS placas_caja,
            cr.estado              AS estado_caja,
            cr.id_linea_fletera    AS linea_caja
        FROM (SELECT 1) base
        LEFT JOIN lineas_fleteras    lf ON lf.id_linea_fletera    = $1
        LEFT JOIN operadores         op ON op.id_operador         = $2
        LEFT JOIN tractocamiones     tr ON tr.id_tractocamion     = $3
        LEFT JOIN cajas_refrigeradas cr ON cr.id_caja_refrigerada = $4
        `,
        [id_linea_fletera, id_operador, id_tractocamion, id_caja_refrigerada]
    );
    return result.rows[0];
};

// Duplicado por la COMBINACIÓN de los cuatro IDs.
// Antes se medía por placas de tracto + caja; ahora las placas viven en sus
// catálogos (con su propio control de duplicados) y lo que no debe
// repetirse es el mismo servicio completo.
const existeCombinacion = async (
    { id_linea_fletera, id_operador, id_tractocamion, id_caja_refrigerada },
    id_excluir = null
) => {
    const result = await db.query(
        `
        SELECT t.id_transporte, t.estado
        FROM transportes t
        WHERE t.id_linea_fletera    = $1
          AND t.id_operador         = $2
          AND t.id_tractocamion     = $3
          AND t.id_caja_refrigerada = $4
          AND ($5::INT IS NULL OR t.id_transporte <> $5)
        `,
        [id_linea_fletera, id_operador, id_tractocamion, id_caja_refrigerada, id_excluir]
    );
    return result.rows[0];
};

// Alta. Las columnas antiguas NOT NULL se copian de los catálogos en el
// mismo INSERT: nunca quedan desalineadas con los IDs que se guardan.
// inocuidad = 0 solo cumple el NOT NULL heredado (ver encabezado).
const createTransporte = async ({
    id_linea_fletera,
    id_operador,
    id_tractocamion,
    id_caja_refrigerada,
    estado
}) => {
    const result = await db.query(
        `
        INSERT INTO transportes (
            id_linea_fletera, id_operador, id_tractocamion, id_caja_refrigerada,
            razon_social, nombre_operador, celular,
            placas_tracto, placas_caja, no_economico_caja,
            inocuidad, estado
        )
        SELECT
            lf.id_linea_fletera, op.id_operador, tr.id_tractocamion, cr.id_caja_refrigerada,
            lf.razon_social, op.nombre, op.celular,
            tr.placas, cr.placas, cr.numero_economico,
            0, $5
        FROM lineas_fleteras lf
        JOIN operadores         op ON op.id_operador         = $2
        JOIN tractocamiones     tr ON tr.id_tractocamion     = $3
        JOIN cajas_refrigeradas cr ON cr.id_caja_refrigerada = $4
        WHERE lf.id_linea_fletera = $1
        RETURNING id_transporte
        `,
        [id_linea_fletera, id_operador, id_tractocamion, id_caja_refrigerada, estado]
    );
    if (!result.rows[0]) return undefined;
    return getTransporteById(result.rows[0].id_transporte);
};

// Edición. Mismo criterio que el alta: las columnas antiguas se reescriben
// desde los catálogos. NO toca transportes.inocuidad.
//
// Si el servicio ya tiene despachos y cambian los IDs, la BD lo rechaza
// (trg_proteger_transporte_asignado). El controller lo valida antes para
// responder un mensaje claro.
const updateTransporte = async (
    id_transporte,
    {
        id_linea_fletera,
        id_operador,
        id_tractocamion,
        id_caja_refrigerada,
        estado
    }
) => {
    const result = await db.query(
        `
        UPDATE transportes t
        SET
            id_linea_fletera    = lf.id_linea_fletera,
            id_operador         = op.id_operador,
            id_tractocamion     = tr.id_tractocamion,
            id_caja_refrigerada = cr.id_caja_refrigerada,
            razon_social        = lf.razon_social,
            nombre_operador     = op.nombre,
            celular             = op.celular,
            placas_tracto       = tr.placas,
            placas_caja         = cr.placas,
            no_economico_caja   = cr.numero_economico,
            estado              = $5
        FROM lineas_fleteras lf
        JOIN operadores         op ON op.id_operador         = $2
        JOIN tractocamiones     tr ON tr.id_tractocamion     = $3
        JOIN cajas_refrigeradas cr ON cr.id_caja_refrigerada = $4
        WHERE lf.id_linea_fletera = $1
          AND t.id_transporte = $6
        RETURNING t.id_transporte
        `,
        [
            id_linea_fletera,
            id_operador,
            id_tractocamion,
            id_caja_refrigerada,
            estado,
            id_transporte
        ]
    );
    if (!result.rows[0]) return undefined;
    return getTransporteById(id_transporte);
};

const bajaTransporte = async (id_transporte) => {
    const result = await db.query(
        `UPDATE transportes SET estado = 0 WHERE id_transporte = $1 RETURNING id_transporte`,
        [id_transporte]
    );
    if (!result.rows[0]) return undefined;
    return getTransporteById(id_transporte);
};

const reactivarTransporte = async (id_transporte) => {
    const result = await db.query(
        `UPDATE transportes SET estado = 1 WHERE id_transporte = $1 RETURNING id_transporte`,
        [id_transporte]
    );
    if (!result.rows[0]) return undefined;
    return getTransporteById(id_transporte);
};

const getDependencias = async (id_transporte) => {
    const result = await db.query(
        `
        SELECT (SELECT COUNT(*) FROM despachos
                 WHERE id_transporte = $1) AS despachos
        `,
        [id_transporte]
    );
    return result.rows[0];
};

const transportesModel = {
    getTransportes,
    getTransporteById,
    getPiezas,
    existeCombinacion,
    createTransporte,
    updateTransporte,
    bajaTransporte,
    reactivarTransporte,
    getDependencias
};

export default transportesModel;
