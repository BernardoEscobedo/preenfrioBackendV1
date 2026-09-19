// ============================================================================
// MODELO · SKU DE PRODUCTO TERMINADO
// ----------------------------------------------------------------------------
// Tabla: sku_pt (Bloque 3 del esquema)
//   id_sku     SERIAL PK
//   codigo_sku VARCHAR(10) NOT NULL
//   calidad    VARCHAR(70) NOT NULL
//   turno      INT NOT NULL DEFAULT 1
//
// POR QUÉ EL TURNO VIVE AQUÍ
//   El turno es una propiedad FIJA del SKU (depende de la calidad), no del
//   día de trabajo. Es el ÚLTIMO dígito del código de lote de 15 dígitos y
//   fn_generar_lote() lo recibe desde este catálogo.
//
// POR QUÉ produccion NO TIENE COLUMNA 'calidad'
//   Se resuelve por JOIN contra sku_pt. Duplicarla habría permitido que una
//   producción dijera "PRIMERA" mientras su SKU dice otra cosa.
//
// CAJAS POR TARIMA
//   Regla operativa: 48 cajas = 1 tarima, salvo los SKU de la familia
//   CPL0813, donde son 42. No se guarda en la tabla: se expone como campo
//   calculado para que el front, el dashboard y la importación del Excel
//   usen el mismo criterio sin replicar el if.
// ============================================================================

import { db } from "../database/connection.database.js";

/** Regla de estiba: 42 cajas por tarima en la familia CPL0813, 48 en el resto. */
export const CAJAS_POR_TARIMA_DEFAULT = 48;
export const CAJAS_POR_TARIMA_CPL0813 = 42;

/** Expresión SQL reutilizable para no repetir el CASE en cada consulta. */
const SQL_CAJAS_POR_TARIMA = `
    CASE WHEN UPPER(codigo_sku) LIKE 'CPL0813%'
         THEN ${CAJAS_POR_TARIMA_CPL0813}
         ELSE ${CAJAS_POR_TARIMA_DEFAULT}
    END AS cajas_por_tarima`;

/**
 * Lista los SKU.
 * @param {Object}  filtros
 * @param {number} [filtros.turno]   1 o 2
 * @param {string} [filtros.calidad] coincidencia parcial
 * @param {string} [filtros.buscar]  texto libre contra código o calidad
 */
const listar = async ({ turno, calidad, buscar } = {}) => {
    const condiciones = [];
    const valores = [];

    if (turno) {
        valores.push(Number(turno));
        condiciones.push(`turno = $${valores.length}`);
    }

    if (calidad) {
        valores.push(`%${calidad}%`);
        condiciones.push(`calidad ILIKE $${valores.length}`);
    }

    if (buscar) {
        valores.push(`%${buscar}%`);
        condiciones.push(
            `(codigo_sku ILIKE $${valores.length} OR calidad ILIKE $${valores.length})`
        );
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";

    const { rows } = await db.query(
        `SELECT id_sku,
                codigo_sku,
                calidad,
                turno,
                ${SQL_CAJAS_POR_TARIMA}
           FROM sku_pt
           ${where}
          ORDER BY codigo_sku ASC`,
        valores
    );

    return rows;
};

/** Un SKU por id. */
const obtenerPorId = async (id_sku) => {
    const { rows } = await db.query(
        `SELECT id_sku, codigo_sku, calidad, turno, ${SQL_CAJAS_POR_TARIMA}
           FROM sku_pt
          WHERE id_sku = $1`,
        [id_sku]
    );
    return rows[0];
};

/**
 * Duplicado por código + calidad.
 * No se valida solo por código: el mismo empaque puede existir en varias
 * calidades y son SKU distintos para efectos del lote.
 */
const obtenerPorCodigoYCalidad = async (codigo_sku, calidad, excluirId = null) => {
    const valores = [codigo_sku, calidad];
    let filtroExtra = "";

    if (excluirId) {
        valores.push(excluirId);
        filtroExtra = `AND id_sku <> $${valores.length}`;
    }

    const { rows } = await db.query(
        `SELECT id_sku, codigo_sku, calidad, turno
           FROM sku_pt
          WHERE UPPER(codigo_sku) = UPPER($1)
            AND UPPER(calidad)    = UPPER($2)
            ${filtroExtra}`,
        valores
    );
    return rows[0];
};

/** Alta. Turno por defecto 1, igual que el DEFAULT de la tabla. */
const crear = async ({ codigo_sku, calidad, turno = 1 }) => {
    const { rows } = await db.query(
        `INSERT INTO sku_pt (codigo_sku, calidad, turno)
         VALUES (UPPER($1), UPPER($2), $3)
         RETURNING id_sku, codigo_sku, calidad, turno`,
        [codigo_sku, calidad, turno]
    );
    return rows[0];
};

/** Actualización parcial. */
const actualizar = async (id_sku, { codigo_sku, calidad, turno }) => {
    const { rows } = await db.query(
        `UPDATE sku_pt
            SET codigo_sku = COALESCE(UPPER($2), codigo_sku),
                calidad    = COALESCE(UPPER($3), calidad),
                turno      = COALESCE($4, turno)
          WHERE id_sku = $1
         RETURNING id_sku, codigo_sku, calidad, turno`,
        [id_sku, codigo_sku ?? null, calidad ?? null, turno ?? null]
    );
    return rows[0];
};

/**
 * Producciones que usan este SKU.
 * sku_pt NO tiene columna de estado, así que la única baja posible es el
 * DELETE físico. El controlador solo lo permite si no hay dependencias.
 */
const contarDependencias = async (id_sku) => {
    const { rows } = await db.query(
        `SELECT (SELECT COUNT(*) FROM produccion
                  WHERE id_sku = $1)::INT AS producciones`,
        [id_sku]
    );
    return rows[0];
};

/** DELETE físico. Solo se invoca tras verificar que no hay producciones. */
const eliminar = async (id_sku) => {
    const { rows } = await db.query(
        `DELETE FROM sku_pt
          WHERE id_sku = $1
         RETURNING id_sku, codigo_sku, calidad, turno`,
        [id_sku]
    );
    return rows[0];
};

export const SkuModel = {
    listar,
    obtenerPorId,
    obtenerPorCodigoYCalidad,
    crear,
    actualizar,
    contarDependencias,
    eliminar
};
