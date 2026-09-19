// ============================================================================
// MODELO · FINCAS
// ----------------------------------------------------------------------------
// Tabla: fincas (Bloque 3 del esquema)
//   id_finca       SERIAL PK
//   codigo_finca   VARCHAR(3) NOT NULL   -> 3 dígitos del código de lote
//   nombre         VARCHAR(70) NOT NULL
//   org_inv_nombre VARCHAR(70) NOT NULL  -> organización de inventario
//   zona           INT NOT NULL          -> 1=Chiapas(A) · 2=Colima(B) · 3=Tabasco(C)
//   id_productor   INT NOT NULL FK productores
//   estado         INT                   -> 1 activa · 0 dada de baja
//
// POR QUÉ IMPORTA LA ZONA
//   Es el PRIMER carácter del código de lote de 15 dígitos y la traduce
//   fn_generar_lote(): 1→A, 2→B, 3→C, cualquier otra→X. Si la zona está mal
//   capturada, todos los lotes de esa finca nacen con la letra equivocada.
//
// SOBRE codigo_finca
//   La tabla NO lo declara UNIQUE porque dos productores distintos pueden
//   reutilizar el mismo número interno. Lo que sí se valida aquí es que no
//   se repita DENTRO del mismo productor, que es donde genera confusión
//   al armar el lote.
// ============================================================================

import { db } from "../database/connection.database.js";

/** Traduce el entero de zona a la letra que usa el código de lote. */
export const LETRA_ZONA = { 1: "A", 2: "B", 3: "C" };

/** Nombre legible de la zona, para que el front no tenga que mapear. */
export const NOMBRE_ZONA = { 1: "CHIAPAS", 2: "COLIMA", 3: "TABASCO" };

// Se repiten en varias consultas: se centralizan para no desincronizarlos
const SQL_ZONA_NOMBRE = `
    CASE f.zona
        WHEN 1 THEN 'CHIAPAS'
        WHEN 2 THEN 'COLIMA'
        WHEN 3 THEN 'TABASCO'
        ELSE 'SIN ZONA'
    END AS zona_nombre`;

const SQL_ZONA_LETRA = `
    CASE f.zona
        WHEN 1 THEN 'A'
        WHEN 2 THEN 'B'
        WHEN 3 THEN 'C'
        ELSE 'X'
    END AS zona_letra`;

/**
 * Lista fincas con su productor resuelto (evita N+1 queries desde el front).
 * @param {Object}  filtros
 * @param {number} [filtros.id_productor]
 * @param {number} [filtros.zona]
 * @param {number} [filtros.estado]
 * @param {string} [filtros.buscar]
 */
const listar = async ({ id_productor, zona, estado, buscar } = {}) => {
    const condiciones = [];
    const valores = [];

    if (id_productor) {
        valores.push(Number(id_productor));
        condiciones.push(`f.id_productor = $${valores.length}`);
    }

    if (zona) {
        valores.push(Number(zona));
        condiciones.push(`f.zona = $${valores.length}`);
    }

    if (estado !== undefined && estado !== null && estado !== "") {
        valores.push(Number(estado));
        condiciones.push(`f.estado = $${valores.length}`);
    }

    if (buscar) {
        valores.push(`%${buscar}%`);
        condiciones.push(
            `(f.codigo_finca ILIKE $${valores.length}
              OR f.nombre ILIKE $${valores.length}
              OR f.org_inv_nombre ILIKE $${valores.length})`
        );
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";

    const { rows } = await db.query(
        `SELECT f.id_finca,
                f.codigo_finca,
                f.nombre,
                f.org_inv_nombre,
                f.zona,
                ${SQL_ZONA_NOMBRE},
                ${SQL_ZONA_LETRA},
                f.estado,
                f.id_productor,
                p.codigo_productor,
                p.nombre AS nombre_productor,
                p.activo AS productor_activo
           FROM fincas f
           JOIN productores p ON p.id_productor = f.id_productor
           ${where}
          ORDER BY p.codigo_productor ASC, f.codigo_finca ASC`,
        valores
    );

    return rows;
};

/** Una finca por id, con su productor resuelto. */
const obtenerPorId = async (id_finca) => {
    const { rows } = await db.query(
        `SELECT f.id_finca,
                f.codigo_finca,
                f.nombre,
                f.org_inv_nombre,
                f.zona,
                ${SQL_ZONA_NOMBRE},
                ${SQL_ZONA_LETRA},
                f.estado,
                f.id_productor,
                p.codigo_productor,
                p.nombre AS nombre_productor
           FROM fincas f
           JOIN productores p ON p.id_productor = f.id_productor
          WHERE f.id_finca = $1`,
        [id_finca]
    );
    return rows[0];
};

/**
 * Duplicado de código DENTRO del mismo productor.
 * @param {string} codigo_finca
 * @param {number} id_productor
 * @param {number} [excluirId]  id que no cuenta como duplicado (caso editar)
 */
const obtenerPorCodigoYProductor = async (codigo_finca, id_productor, excluirId = null) => {
    const valores = [codigo_finca, id_productor];
    let filtroExtra = "";

    if (excluirId) {
        valores.push(excluirId);
        filtroExtra = `AND id_finca <> $${valores.length}`;
    }

    const { rows } = await db.query(
        `SELECT id_finca, codigo_finca, nombre, id_productor
           FROM fincas
          WHERE UPPER(codigo_finca) = UPPER($1)
            AND id_productor = $2
            ${filtroExtra}`,
        valores
    );
    return rows[0];
};

/** Alta. El código se normaliza en mayúsculas. */
const crear = async ({
    codigo_finca, nombre, org_inv_nombre, zona, id_productor, estado = 1
}) => {
    const { rows } = await db.query(
        `INSERT INTO fincas
                (codigo_finca, nombre, org_inv_nombre, zona, id_productor, estado)
         VALUES (UPPER($1), $2, $3, $4, $5, $6)
         RETURNING id_finca, codigo_finca, nombre, org_inv_nombre,
                   zona, id_productor, estado`,
        [codigo_finca, nombre, org_inv_nombre, zona, id_productor, estado]
    );
    return rows[0];
};

/** Actualización parcial: COALESCE respeta lo que no venga en el body. */
const actualizar = async (id_finca, {
    codigo_finca, nombre, org_inv_nombre, zona, id_productor, estado
}) => {
    const { rows } = await db.query(
        `UPDATE fincas
            SET codigo_finca   = COALESCE(UPPER($2), codigo_finca),
                nombre         = COALESCE($3, nombre),
                org_inv_nombre = COALESCE($4, org_inv_nombre),
                zona           = COALESCE($5, zona),
                id_productor   = COALESCE($6, id_productor),
                estado         = COALESCE($7, estado)
          WHERE id_finca = $1
         RETURNING id_finca, codigo_finca, nombre, org_inv_nombre,
                   zona, id_productor, estado`,
        [
            id_finca,
            codigo_finca ?? null,
            nombre ?? null,
            org_inv_nombre ?? null,
            zona ?? null,
            id_productor ?? null,
            estado ?? null
        ]
    );
    return rows[0];
};

/** Baja lógica. produccion.id_finca referencia esta tabla. */
const darDeBaja = async (id_finca) => {
    const { rows } = await db.query(
        `UPDATE fincas SET estado = 0
          WHERE id_finca = $1
         RETURNING id_finca, codigo_finca, nombre, estado`,
        [id_finca]
    );
    return rows[0];
};

/** Reactivar una finca dada de baja. */
const reactivar = async (id_finca) => {
    const { rows } = await db.query(
        `UPDATE fincas SET estado = 1
          WHERE id_finca = $1
         RETURNING id_finca, codigo_finca, nombre, estado`,
        [id_finca]
    );
    return rows[0];
};

/** Producciones que cuelgan de esta finca (aviso antes de dar de baja). */
const contarDependencias = async (id_finca) => {
    const { rows } = await db.query(
        `SELECT (SELECT COUNT(*) FROM produccion
                  WHERE id_finca = $1)::INT AS producciones`,
        [id_finca]
    );
    return rows[0];
};

export const FincasModel = {
    listar,
    obtenerPorId,
    obtenerPorCodigoYProductor,
    crear,
    actualizar,
    darDeBaja,
    reactivar,
    contarDependencias
};
