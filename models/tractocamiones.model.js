import { db } from "../database/connection.database.js";

// ============================================================================
// TRACTOCAMIONES
// ============================================================================
// La unidad motriz que jala la caja. Puede pertenecer a una línea fletera
// (id_linea_fletera) o ser independiente (NULL).
//
// LA LLAVE DE NEGOCIO SON LAS PLACAS
//   Se comparan sin espacios ni guiones: en el andén se capturan de todas
//   las formas posibles ("15AN7H", "15-AN-7H", "15 AN 7H") y son la misma
//   unidad.
//
// LA BAJA ES LÓGICA
//   transportes.id_tractocamion apunta aquí, y vw_despachos lee las placas
//   en vivo: borrar la fila dejaría despachos sin tracto.
// ============================================================================

const getTractocamiones = async ({
    estado = null,
    id_linea_fletera = null,
    buscar = null
} = {}) => {
    const result = await db.query(
        `
        SELECT
            tc.*,
            lf.razon_social AS razon_social_linea,
            (SELECT COUNT(*) FROM transportes t
              WHERE t.id_tractocamion = tc.id_tractocamion AND t.estado = 1
            ) AS transportes_activos
        FROM tractocamiones tc
        LEFT JOIN lineas_fleteras lf ON lf.id_linea_fletera = tc.id_linea_fletera
        WHERE ($1::INT IS NULL OR tc.estado = $1)
          AND ($2::INT IS NULL OR tc.id_linea_fletera = $2)
          AND ($3::TEXT IS NULL
               OR tc.placas ILIKE '%' || $3 || '%'
               OR tc.numero_economico ILIKE '%' || $3 || '%'
               OR lf.razon_social ILIKE '%' || $3 || '%')
        ORDER BY tc.placas
        `,
        [estado, id_linea_fletera, buscar]
    );
    return result.rows;
};

const getTractocamionById = async (id_tractocamion) => {
    const result = await db.query(
        `
        SELECT tc.*, lf.razon_social AS razon_social_linea
        FROM tractocamiones tc
        LEFT JOIN lineas_fleteras lf ON lf.id_linea_fletera = tc.id_linea_fletera
        WHERE tc.id_tractocamion = $1
        `,
        [id_tractocamion]
    );
    return result.rows[0];
};

// Duplicado por placas, ignorando guiones y espacios.
const existePlacas = async (placas, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_tractocamion, placas, estado
        FROM tractocamiones
        WHERE REGEXP_REPLACE(UPPER(placas), '[^A-Z0-9]', '', 'g')
              = REGEXP_REPLACE(UPPER($1), '[^A-Z0-9]', '', 'g')
          AND ($2::INT IS NULL OR id_tractocamion <> $2)
        `,
        [placas, id_excluir]
    );
    return result.rows[0];
};

const createTractocamion = async ({
    id_linea_fletera,
    placas,
    numero_economico,
    estado
}) => {
    const result = await db.query(
        `
        INSERT INTO tractocamiones (id_linea_fletera, placas, numero_economico, estado)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [id_linea_fletera, placas, numero_economico, estado]
    );
    return result.rows[0];
};

const updateTractocamion = async (
    id_tractocamion,
    { id_linea_fletera, placas, numero_economico, estado }
) => {
    const result = await db.query(
        `
        UPDATE tractocamiones
        SET
            id_linea_fletera = $1,
            placas = $2,
            numero_economico = $3,
            estado = $4
        WHERE id_tractocamion = $5
        RETURNING *
        `,
        [id_linea_fletera, placas, numero_economico, estado, id_tractocamion]
    );
    return result.rows[0];
};

const bajaTractocamion = async (id_tractocamion) => {
    const result = await db.query(
        `UPDATE tractocamiones SET estado = 0 WHERE id_tractocamion = $1 RETURNING *`,
        [id_tractocamion]
    );
    return result.rows[0];
};

const reactivarTractocamion = async (id_tractocamion) => {
    const result = await db.query(
        `UPDATE tractocamiones SET estado = 1 WHERE id_tractocamion = $1 RETURNING *`,
        [id_tractocamion]
    );
    return result.rows[0];
};

const getDependencias = async (id_tractocamion) => {
    const result = await db.query(
        `
        SELECT
            (SELECT COUNT(*) FROM transportes
              WHERE id_tractocamion = $1) AS transportes,
            (SELECT COUNT(*) FROM transportes
              WHERE id_tractocamion = $1 AND estado = 1) AS transportes_activos,
            (SELECT COUNT(*) FROM despachos d
               JOIN transportes t ON t.id_transporte = d.id_transporte
              WHERE t.id_tractocamion = $1) AS despachos
        `,
        [id_tractocamion]
    );
    return result.rows[0];
};

const tractocamionesModel = {
    getTractocamiones,
    getTractocamionById,
    existePlacas,
    createTractocamion,
    updateTractocamion,
    bajaTractocamion,
    reactivarTractocamion,
    getDependencias
};

export default tractocamionesModel;
