import { db } from "../database/connection.database.js";

// ============================================================================
// OPERADORES
// ============================================================================
// Quien maneja la unidad. Puede pertenecer a una línea fletera
// (id_linea_fletera) o ser independiente (NULL).
//
// LA LLAVE DE NEGOCIO ES EL CELULAR
//   Los nombres se capturan con y sin acentos, con y sin segundo apellido.
//   El celular identifica a la persona y es lo que se usa para localizarla
//   cuando el camión no llega a la cita.
//
// LA BAJA ES LÓGICA
//   transportes.id_operador apunta aquí, y vw_despachos lee el nombre y el
//   celular en vivo: borrar la fila dejaría despachos sin operador.
// ============================================================================

const getOperadores = async ({
    estado = null,
    id_linea_fletera = null,
    buscar = null
} = {}) => {
    const result = await db.query(
        `
        SELECT
            o.*,
            lf.razon_social AS razon_social_linea,
            (SELECT COUNT(*) FROM transportes t
              WHERE t.id_operador = o.id_operador AND t.estado = 1
            ) AS transportes_activos
        FROM operadores o
        LEFT JOIN lineas_fleteras lf ON lf.id_linea_fletera = o.id_linea_fletera
        WHERE ($1::INT IS NULL OR o.estado = $1)
          AND ($2::INT IS NULL OR o.id_linea_fletera = $2)
          AND ($3::TEXT IS NULL
               OR o.nombre ILIKE '%' || $3 || '%'
               OR o.celular ILIKE '%' || $3 || '%'
               OR lf.razon_social ILIKE '%' || $3 || '%')
        ORDER BY o.nombre
        `,
        [estado, id_linea_fletera, buscar]
    );
    return result.rows;
};

const getOperadorById = async (id_operador) => {
    const result = await db.query(
        `
        SELECT o.*, lf.razon_social AS razon_social_linea
        FROM operadores o
        LEFT JOIN lineas_fleteras lf ON lf.id_linea_fletera = o.id_linea_fletera
        WHERE o.id_operador = $1
        `,
        [id_operador]
    );
    return result.rows[0];
};

const existeCelular = async (celular, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_operador, nombre, estado
        FROM operadores
        WHERE celular = $1
          AND ($2::INT IS NULL OR id_operador <> $2)
        `,
        [celular, id_excluir]
    );
    return result.rows[0];
};

const createOperador = async ({ id_linea_fletera, nombre, celular, estado }) => {
    const result = await db.query(
        `
        INSERT INTO operadores (id_linea_fletera, nombre, celular, estado)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [id_linea_fletera, nombre, celular, estado]
    );
    return result.rows[0];
};

const updateOperador = async (
    id_operador,
    { id_linea_fletera, nombre, celular, estado }
) => {
    const result = await db.query(
        `
        UPDATE operadores
        SET
            id_linea_fletera = $1,
            nombre = $2,
            celular = $3,
            estado = $4
        WHERE id_operador = $5
        RETURNING *
        `,
        [id_linea_fletera, nombre, celular, estado, id_operador]
    );
    return result.rows[0];
};

const bajaOperador = async (id_operador) => {
    const result = await db.query(
        `UPDATE operadores SET estado = 0 WHERE id_operador = $1 RETURNING *`,
        [id_operador]
    );
    return result.rows[0];
};

const reactivarOperador = async (id_operador) => {
    const result = await db.query(
        `UPDATE operadores SET estado = 1 WHERE id_operador = $1 RETURNING *`,
        [id_operador]
    );
    return result.rows[0];
};

const getDependencias = async (id_operador) => {
    const result = await db.query(
        `
        SELECT
            (SELECT COUNT(*) FROM transportes
              WHERE id_operador = $1) AS transportes,
            (SELECT COUNT(*) FROM transportes
              WHERE id_operador = $1 AND estado = 1) AS transportes_activos,
            (SELECT COUNT(*) FROM despachos d
               JOIN transportes t ON t.id_transporte = d.id_transporte
              WHERE t.id_operador = $1) AS despachos
        `,
        [id_operador]
    );
    return result.rows[0];
};

const operadoresModel = {
    getOperadores,
    getOperadorById,
    existeCelular,
    createOperador,
    updateOperador,
    bajaOperador,
    reactivarOperador,
    getDependencias
};

export default operadoresModel;
