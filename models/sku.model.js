import { db } from "../database/connection.database.js";

// ============================================================================
// SKU DE PRODUCTO TERMINADO
// ============================================================================
// Catálogo de empaques y calidades. Aporta el ÚLTIMO dígito del código de
// lote a través de 'turno'.
//
// v2.2 · CAMBIO IMPORTANTE
//   sku_pt ya tiene columna 'estado', así que la baja pasó de FÍSICA a
//   LÓGICA. Antes, un SKU descontinuado solo se podía borrar (y el borrado
//   quedaba bloqueado en cuanto alguna producción lo usara, que es
//   prácticamente siempre). Ahora se marca estado = 0 y desaparece de los
//   dropdowns sin tocar el histórico.
//
//   Se conserva deleteSku para el caso legítimo de un alta mal capturada
//   que nunca llegó a usarse.
//
// POR QUÉ EL TURNO VIVE AQUÍ Y NO EN PRODUCCIÓN
//   Es una propiedad fija del SKU: depende de la calidad, no del día ni del
//   horario en que se trabajó. Si estuviera en produccion habría que
//   recordarlo en cada captura y tarde o temprano saldría mal.
//
// POR QUÉ produccion NO GUARDA 'calidad'
//   Se resuelve por JOIN contra esta tabla. Duplicarla habría permitido que
//   una producción dijera PRIMERA mientras su SKU dice otra cosa, y ningún
//   trigger podría detectarlo.
//
// CAJAS POR TARIMA
//   48 cajas = 1 tarima, salvo la familia CPL0813 donde son 42. No se
//   guarda como columna: se calcula aquí para que el dashboard, el frontend
//   y la importación del Excel usen el mismo criterio. Si mañana cambia la
//   regla, se cambia en un solo lugar.
// ============================================================================

const CAJAS_TARIMA_DEFAULT = 48;
const CAJAS_TARIMA_CPL0813 = 42;

const SELECT_SKU = `
    SELECT
        s.*,
        CASE WHEN UPPER(s.codigo_sku) LIKE 'CPL0813%'
             THEN ${CAJAS_TARIMA_CPL0813}
             ELSE ${CAJAS_TARIMA_DEFAULT}
        END AS cajas_por_tarima,
        -- Cuántas producciones lo usan: la pantalla marca con esto los SKU
        -- que solo admiten baja lógica, antes de que el usuario lo intente.
        (SELECT COUNT(*) FROM produccion pr
          WHERE pr.id_sku = s.id_sku
        ) AS total_producciones
    FROM sku_pt s
`;

const getSkus = async ({
    estado = null,
    turno = null,
    calidad = null,
    buscar = null
} = {}) => {
    const result = await db.query(
        `
        ${SELECT_SKU}
        WHERE ($1::INT IS NULL OR s.estado = $1)
          AND ($2::INT IS NULL OR s.turno = $2)
          AND ($3::TEXT IS NULL OR s.calidad ILIKE '%' || $3 || '%')
          AND ($4::TEXT IS NULL
               OR s.codigo_sku ILIKE '%' || $4 || '%'
               OR s.calidad ILIKE '%' || $4 || '%')
        ORDER BY s.codigo_sku, s.calidad
        `,
        [estado, turno, calidad, buscar]
    );
    return result.rows;
};

const getSkuById = async (id_sku) => {
    const result = await db.query(
        `${SELECT_SKU} WHERE s.id_sku = $1`,
        [id_sku]
    );
    return result.rows[0];
};

// Duplicado por código + calidad, no solo por código.
// El mismo empaque puede existir en PRIMERA y en SEGUNDA: son SKU distintos
// y cada uno lleva su propio turno, así que generan lotes diferentes.
//
// v2.2: la BD ya tiene el índice único uq_sku_codigo_calidad. Esta consulta
// se conserva para dar un mensaje claro antes de que reviente.
const existeSku = async (codigo_sku, calidad, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_sku, codigo_sku, calidad FROM sku_pt
        WHERE UPPER(codigo_sku) = UPPER($1)
          AND UPPER(calidad) = UPPER($2)
          AND ($3::INT IS NULL OR id_sku <> $3)
        `,
        [codigo_sku, calidad, id_excluir]
    );
    return result.rows[0];
};

const createSku = async ({ codigo_sku, calidad, turno, estado }) => {
    const result = await db.query(
        `
        INSERT INTO sku_pt (codigo_sku, calidad, turno, estado)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [codigo_sku, calidad, turno, estado]
    );
    return result.rows[0];
};

const updateSku = async (id_sku, { codigo_sku, calidad, turno, estado }) => {
    const result = await db.query(
        `
        UPDATE sku_pt
        SET codigo_sku = $1, calidad = $2, turno = $3, estado = $4
        WHERE id_sku = $5
        RETURNING *
        `,
        [codigo_sku, calidad, turno, estado, id_sku]
    );
    return result.rows[0];
};

// Baja LÓGICA (v2.2). Es la vía normal: el SKU deja de ofrecerse en los
// dropdowns pero las producciones históricas siguen resolviendo su calidad.
const bajaSku = async (id_sku) => {
    const result = await db.query(
        `UPDATE sku_pt SET estado = 0 WHERE id_sku = $1 RETURNING *`,
        [id_sku]
    );
    return result.rows[0];
};

const reactivarSku = async (id_sku) => {
    const result = await db.query(
        `UPDATE sku_pt SET estado = 1 WHERE id_sku = $1 RETURNING *`,
        [id_sku]
    );
    return result.rows[0];
};

// Borrado FÍSICO. Solo para corregir un alta mal capturada que nunca se
// usó. Si alguna producción lo referencia, la FK lo impide (error 23503)
// y el controller lo traduce a un mensaje entendible.
const deleteSku = async (id_sku) => {
    const result = await db.query(
        `DELETE FROM sku_pt WHERE id_sku = $1 RETURNING *`,
        [id_sku]
    );
    return result.rows[0];
};

const getDependencias = async (id_sku) => {
    const result = await db.query(
        `
        SELECT (SELECT COUNT(*) FROM produccion
                 WHERE id_sku = $1) AS producciones
        `,
        [id_sku]
    );
    return result.rows[0];
};

const skuModel = {
    getSkus,
    getSkuById,
    existeSku,
    createSku,
    updateSku,
    bajaSku,
    reactivarSku,
    deleteSku,
    getDependencias
};

export default skuModel;
