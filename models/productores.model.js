// ============================================================================
// MODELO · PRODUCTORES
// ----------------------------------------------------------------------------
// Tabla: productores (Bloque 3 del esquema)
//   id_productor      SERIAL PK
//   codigo_productor  VARCHAR(4) UNIQUE NOT NULL  -> alimenta el codigo_lote
//   nombre            VARCHAR(100) NOT NULL
//   activo            INT DEFAULT 1               -> 1 activo · 0 dado de baja
//
// NOTA DE ALCANCE
//   Los catálogos de origen NO se filtran por cámara: un productor no
//   pertenece a un preenfrío. Por eso aquí no entra el arreglo req.camaras.
//   El recorte por cámara aplica de produccion/recepciones en adelante.
//
// NOTA SOBRE LA BAJA
//   No se hace DELETE físico. fincas.id_productor y produccion.id_productor
//   apuntan aquí; borrar la fila rompería el histórico y la trazabilidad del
//   lote. Se marca activo = 0 y deja de aparecer en los selectores.
// ============================================================================

import { db } from "../database/connection.database.js";

/**
 * Lista productores con filtros opcionales.
 * @param {Object}  filtros
 * @param {number} [filtros.activo]  1 = solo activos · 0 = solo bajas · undefined = todos
 * @param {string} [filtros.buscar]  texto libre contra código o nombre
 */
const listar = async ({ activo, buscar } = {}) => {
    const condiciones = [];
    const valores = [];

    if (activo !== undefined && activo !== null && activo !== "") {
        valores.push(Number(activo));
        condiciones.push(`activo = $${valores.length}`);
    }

    if (buscar) {
        // ILIKE: búsqueda sin distinguir mayúsculas (en piso capturan de todo)
        valores.push(`%${buscar}%`);
        condiciones.push(
            `(codigo_productor ILIKE $${valores.length} OR nombre ILIKE $${valores.length})`
        );
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";

    const { rows } = await db.query(
        `SELECT id_productor,
                codigo_productor,
                nombre,
                activo
           FROM productores
           ${where}
          ORDER BY codigo_productor ASC`,
        valores
    );

    return rows;
};

/** Un productor por id. Devuelve undefined si no existe. */
const obtenerPorId = async (id_productor) => {
    const { rows } = await db.query(
        `SELECT id_productor, codigo_productor, nombre, activo
           FROM productores
          WHERE id_productor = $1`,
        [id_productor]
    );
    return rows[0];
};

/**
 * Busca por código de negocio. Se usa para validar duplicados antes de
 * insertar y para importaciones desde el Excel de planeación.
 * @param {string} codigo
 * @param {number} [excluirId]  id que NO cuenta como duplicado (caso editar)
 */
const obtenerPorCodigo = async (codigo, excluirId = null) => {
    const valores = [codigo];
    let filtroExtra = "";

    if (excluirId) {
        valores.push(excluirId);
        filtroExtra = `AND id_productor <> $${valores.length}`;
    }

    const { rows } = await db.query(
        `SELECT id_productor, codigo_productor, nombre, activo
           FROM productores
          WHERE UPPER(codigo_productor) = UPPER($1)
            ${filtroExtra}`,
        valores
    );
    return rows[0];
};

/** Alta. El código se guarda siempre en mayúsculas. */
const crear = async ({ codigo_productor, nombre, activo = 1 }) => {
    const { rows } = await db.query(
        `INSERT INTO productores (codigo_productor, nombre, activo)
         VALUES (UPPER($1), $2, $3)
         RETURNING id_productor, codigo_productor, nombre, activo`,
        [codigo_productor, nombre, activo]
    );
    return rows[0];
};

/**
 * Actualización parcial: solo se pisan los campos que vienen en el body.
 * COALESCE deja intacto lo que llegue como NULL.
 */
const actualizar = async (id_productor, { codigo_productor, nombre, activo }) => {
    const { rows } = await db.query(
        `UPDATE productores
            SET codigo_productor = COALESCE(UPPER($2), codigo_productor),
                nombre           = COALESCE($3, nombre),
                activo           = COALESCE($4, activo)
          WHERE id_productor = $1
         RETURNING id_productor, codigo_productor, nombre, activo`,
        [
            id_productor,
            codigo_productor ?? null,
            nombre ?? null,
            activo ?? null
        ]
    );
    return rows[0];
};

/** Baja lógica. Nunca DELETE: hay FK desde fincas y produccion. */
const darDeBaja = async (id_productor) => {
    const { rows } = await db.query(
        `UPDATE productores
            SET activo = 0
          WHERE id_productor = $1
         RETURNING id_productor, codigo_productor, nombre, activo`,
        [id_productor]
    );
    return rows[0];
};

/** Reactivar un productor dado de baja. */
const reactivar = async (id_productor) => {
    const { rows } = await db.query(
        `UPDATE productores
            SET activo = 1
          WHERE id_productor = $1
         RETURNING id_productor, codigo_productor, nombre, activo`,
        [id_productor]
    );
    return rows[0];
};

/**
 * Cuenta las dependencias antes de permitir una baja.
 * El controlador lo usa para avisar al usuario qué queda afectado.
 */
const contarDependencias = async (id_productor) => {
    const { rows } = await db.query(
        `SELECT
            (SELECT COUNT(*) FROM fincas
              WHERE id_productor = $1)::INT AS fincas,
            (SELECT COUNT(*) FROM produccion
              WHERE id_productor = $1)::INT AS producciones`,
        [id_productor]
    );
    return rows[0];
};

export const ProductoresModel = {
    listar,
    obtenerPorId,
    obtenerPorCodigo,
    crear,
    actualizar,
    darDeBaja,
    reactivar,
    contarDependencias
};
