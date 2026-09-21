import { db } from "../database/connection.database.js";

// ============================================================================
// SKU DE PRODUCTO TERMINADO
// ============================================================================
// Catálogo de empaques y calidades. Aporta el ÚLTIMO dígito del código de
// lote a través de 'turno'.
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
        -- que ya no se pueden borrar, antes de que el usuario lo intente.
        (SELECT COUNT(*) FROM produccion pr
          WHERE pr.id_sku = s.id_sku
        ) AS total_producciones
    FROM sku_pt s
`;

const getSkus = async ({ turno = null, calidad = null, buscar = null } = {}) => {
    const result = await db.query(
        `
        ${SELECT_SKU}
        WHERE ($1::INT IS NULL OR s.turno = $1)
          AND ($2::TEXT IS NULL OR s.calidad ILIKE '%' || $2 || '%')
          AND ($3::TEXT IS NULL
               OR s.codigo_sku ILIKE '%' || $3 || '%'
               OR s.calidad ILIKE '%' || $3 || '%')
        ORDER BY s.codigo_sku, s.calidad
        `,
        [turno, calidad, buscar]
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

const createSku = async ({ codigo_sku, calidad, turno }) => {
    const result = await db.query(
        `
        INSERT INTO sku_pt (codigo_sku, calidad, turno)
        VALUES ($1, $2, $3)
        RETURNING *
        `,
        [codigo_sku, calidad, turno]
    );
    return result.rows[0];
};

const updateSku = async (id_sku, { codigo_sku, calidad, turno }) => {
    const result = await db.query(
        `
        UPDATE sku_pt
        SET codigo_sku = $1, calidad = $2, turno = $3
        WHERE id_sku = $4
        RETURNING *
        `,
        [codigo_sku, calidad, turno, id_sku]
    );
    return result.rows[0];
};

// sku_pt no tiene columna de estado, así que la única baja posible es el
// borrado físico. Si alguna producción lo referencia, la FK lo impide
// (error 23503) y el controller lo traduce a un mensaje entendible.
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
    deleteSku,
    getDependencias
};

export default skuModel;
