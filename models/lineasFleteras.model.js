import { db } from "../database/connection.database.js";

// ============================================================================
// LÍNEAS FLETERAS
// ============================================================================
// La empresa transportista. Es la primera pieza de un servicio de
// transporte: operadores, tractocamiones y cajas pueden pertenecer a una
// línea (id_linea_fletera) o ser independientes (NULL).
//
// LA LLAVE DE NEGOCIO ES EL RFC
//   La razón social se escribe de mil formas ("TRANSPORTES PEREZ SA DE CV",
//   "Transp. Pérez"); el RFC no. Se compara sin espacios ni guiones y en
//   mayúsculas para que la misma empresa no se dé de alta dos veces.
//
// LA BAJA ES LÓGICA
//   transportes.id_linea_fletera apunta aquí, y a través de él los
//   despachos históricos. vw_despachos lee la razón social de esta tabla:
//   borrar la fila dejaría el histórico sin decir quién se llevó la fruta.
//
// ⚠️ EDITAR CAMBIA EL HISTÓRICO
//   vw_despachos lee la razón social EN VIVO de este catálogo. Corregir un
//   dato aquí se refleja también en los despachos ya cerrados. El controller
//   avisa cuántos despachos se ven afectados.
// ============================================================================

const getLineas = async ({ estado = null, buscar = null } = {}) => {
    const result = await db.query(
        `
        SELECT
            lf.*,
            (SELECT COUNT(*) FROM operadores o
              WHERE o.id_linea_fletera = lf.id_linea_fletera AND o.estado = 1
            ) AS operadores_activos,
            (SELECT COUNT(*) FROM tractocamiones t
              WHERE t.id_linea_fletera = lf.id_linea_fletera AND t.estado = 1
            ) AS tractocamiones_activos,
            (SELECT COUNT(*) FROM cajas_refrigeradas c
              WHERE c.id_linea_fletera = lf.id_linea_fletera AND c.estado = 1
            ) AS cajas_activas
        FROM lineas_fleteras lf
        WHERE ($1::INT IS NULL OR lf.estado = $1)
          AND ($2::TEXT IS NULL
               OR lf.razon_social ILIKE '%' || $2 || '%'
               OR lf.rfc ILIKE '%' || $2 || '%'
               OR lf.telefono_contacto ILIKE '%' || $2 || '%')
        ORDER BY lf.razon_social
        `,
        [estado, buscar]
    );
    return result.rows;
};

const getLineaById = async (id_linea_fletera) => {
    const result = await db.query(
        `SELECT * FROM lineas_fleteras WHERE id_linea_fletera = $1`,
        [id_linea_fletera]
    );
    return result.rows[0];
};

// Duplicado por RFC, ignorando espacios, guiones y mayúsculas.
const existeRfc = async (rfc, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_linea_fletera, razon_social, estado
        FROM lineas_fleteras
        WHERE REGEXP_REPLACE(UPPER(rfc), '[^A-ZÑ&0-9]', '', 'g')
              = REGEXP_REPLACE(UPPER($1), '[^A-ZÑ&0-9]', '', 'g')
          AND ($2::INT IS NULL OR id_linea_fletera <> $2)
        `,
        [rfc, id_excluir]
    );
    return result.rows[0];
};

const createLinea = async ({ razon_social, rfc, telefono_contacto, estado }) => {
    const result = await db.query(
        `
        INSERT INTO lineas_fleteras (razon_social, rfc, telefono_contacto, estado)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [razon_social, rfc, telefono_contacto, estado]
    );
    return result.rows[0];
};

const updateLinea = async (
    id_linea_fletera,
    { razon_social, rfc, telefono_contacto, estado }
) => {
    const result = await db.query(
        `
        UPDATE lineas_fleteras
        SET
            razon_social = $1,
            rfc = $2,
            telefono_contacto = $3,
            estado = $4
        WHERE id_linea_fletera = $5
        RETURNING *
        `,
        [razon_social, rfc, telefono_contacto, estado, id_linea_fletera]
    );
    return result.rows[0];
};

const bajaLinea = async (id_linea_fletera) => {
    const result = await db.query(
        `UPDATE lineas_fleteras SET estado = 0 WHERE id_linea_fletera = $1 RETURNING *`,
        [id_linea_fletera]
    );
    return result.rows[0];
};

const reactivarLinea = async (id_linea_fletera) => {
    const result = await db.query(
        `UPDATE lineas_fleteras SET estado = 1 WHERE id_linea_fletera = $1 RETURNING *`,
        [id_linea_fletera]
    );
    return result.rows[0];
};

// Qué depende de la línea. Se informa al dar de baja y al editar.
const getDependencias = async (id_linea_fletera) => {
    const result = await db.query(
        `
        SELECT
            (SELECT COUNT(*) FROM operadores
              WHERE id_linea_fletera = $1 AND estado = 1) AS operadores_activos,
            (SELECT COUNT(*) FROM tractocamiones
              WHERE id_linea_fletera = $1 AND estado = 1) AS tractocamiones_activos,
            (SELECT COUNT(*) FROM cajas_refrigeradas
              WHERE id_linea_fletera = $1 AND estado = 1) AS cajas_activas,
            (SELECT COUNT(*) FROM transportes
              WHERE id_linea_fletera = $1 AND estado = 1) AS transportes_activos,
            (SELECT COUNT(*) FROM despachos d
               JOIN transportes t ON t.id_transporte = d.id_transporte
              WHERE t.id_linea_fletera = $1) AS despachos
        `,
        [id_linea_fletera]
    );
    return result.rows[0];
};

const lineasFleterasModel = {
    getLineas,
    getLineaById,
    existeRfc,
    createLinea,
    updateLinea,
    bajaLinea,
    reactivarLinea,
    getDependencias
};

export default lineasFleterasModel;
