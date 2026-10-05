import { db } from "../database/connection.database.js";

// ============================================================================
// CAJAS REFRIGERADAS
// ============================================================================
// El remolque donde viaja la fruta: es la pieza que se INSPECCIONA en cada
// despacho (limpieza, olores, plagas, estado). Puede pertenecer a una línea
// fletera (id_linea_fletera) o ser independiente (NULL).
//
// largo_pies es la longitud nominal (48, 53...), no la capacidad de carga.
//
// LA LLAVE DE NEGOCIO SON LAS PLACAS
//   Se comparan sin espacios ni guiones, igual que en tractocamiones.
//
// LA BAJA ES LÓGICA
//   transportes.id_caja_refrigerada apunta aquí, y vw_despachos lee placas
//   y número económico en vivo: borrar la fila dejaría despachos sin caja.
// ============================================================================

const getCajas = async ({
    estado = null,
    id_linea_fletera = null,
    buscar = null
} = {}) => {
    const result = await db.query(
        `
        SELECT
            c.*,
            lf.razon_social AS razon_social_linea,
            (SELECT COUNT(*) FROM transportes t
              WHERE t.id_caja_refrigerada = c.id_caja_refrigerada AND t.estado = 1
            ) AS transportes_activos
        FROM cajas_refrigeradas c
        LEFT JOIN lineas_fleteras lf ON lf.id_linea_fletera = c.id_linea_fletera
        WHERE ($1::INT IS NULL OR c.estado = $1)
          AND ($2::INT IS NULL OR c.id_linea_fletera = $2)
          AND ($3::TEXT IS NULL
               OR c.placas ILIKE '%' || $3 || '%'
               OR c.numero_economico ILIKE '%' || $3 || '%'
               OR lf.razon_social ILIKE '%' || $3 || '%')
        ORDER BY c.placas
        `,
        [estado, id_linea_fletera, buscar]
    );
    return result.rows;
};

const getCajaById = async (id_caja_refrigerada) => {
    const result = await db.query(
        `
        SELECT c.*, lf.razon_social AS razon_social_linea
        FROM cajas_refrigeradas c
        LEFT JOIN lineas_fleteras lf ON lf.id_linea_fletera = c.id_linea_fletera
        WHERE c.id_caja_refrigerada = $1
        `,
        [id_caja_refrigerada]
    );
    return result.rows[0];
};

// Duplicado por placas, ignorando guiones y espacios.
const existePlacas = async (placas, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_caja_refrigerada, placas, estado
        FROM cajas_refrigeradas
        WHERE REGEXP_REPLACE(UPPER(placas), '[^A-Z0-9]', '', 'g')
              = REGEXP_REPLACE(UPPER($1), '[^A-Z0-9]', '', 'g')
          AND ($2::INT IS NULL OR id_caja_refrigerada <> $2)
        `,
        [placas, id_excluir]
    );
    return result.rows[0];
};

const createCaja = async ({
    id_linea_fletera,
    placas,
    numero_economico,
    largo_pies,
    estado
}) => {
    const result = await db.query(
        `
        INSERT INTO cajas_refrigeradas (
            id_linea_fletera, placas, numero_economico, largo_pies, estado
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [id_linea_fletera, placas, numero_economico, largo_pies, estado]
    );
    return result.rows[0];
};

const updateCaja = async (
    id_caja_refrigerada,
    { id_linea_fletera, placas, numero_economico, largo_pies, estado }
) => {
    const result = await db.query(
        `
        UPDATE cajas_refrigeradas
        SET
            id_linea_fletera = $1,
            placas = $2,
            numero_economico = $3,
            largo_pies = $4,
            estado = $5
        WHERE id_caja_refrigerada = $6
        RETURNING *
        `,
        [
            id_linea_fletera,
            placas,
            numero_economico,
            largo_pies,
            estado,
            id_caja_refrigerada
        ]
    );
    return result.rows[0];
};

const bajaCaja = async (id_caja_refrigerada) => {
    const result = await db.query(
        `UPDATE cajas_refrigeradas SET estado = 0 WHERE id_caja_refrigerada = $1 RETURNING *`,
        [id_caja_refrigerada]
    );
    return result.rows[0];
};

const reactivarCaja = async (id_caja_refrigerada) => {
    const result = await db.query(
        `UPDATE cajas_refrigeradas SET estado = 1 WHERE id_caja_refrigerada = $1 RETURNING *`,
        [id_caja_refrigerada]
    );
    return result.rows[0];
};

const getDependencias = async (id_caja_refrigerada) => {
    const result = await db.query(
        `
        SELECT
            (SELECT COUNT(*) FROM transportes
              WHERE id_caja_refrigerada = $1) AS transportes,
            (SELECT COUNT(*) FROM transportes
              WHERE id_caja_refrigerada = $1 AND estado = 1) AS transportes_activos,
            (SELECT COUNT(*) FROM despachos d
               JOIN transportes t ON t.id_transporte = d.id_transporte
              WHERE t.id_caja_refrigerada = $1) AS despachos
        `,
        [id_caja_refrigerada]
    );
    return result.rows[0];
};

const cajasRefrigeradasModel = {
    getCajas,
    getCajaById,
    existePlacas,
    createCaja,
    updateCaja,
    bajaCaja,
    reactivarCaja,
    getDependencias
};

export default cajasRefrigeradasModel;
