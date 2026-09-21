import { db } from "../database/connection.database.js";

// ============================================================================
// FINCAS
// ============================================================================
// Origen físico de la fruta. Aporta 3 de los 15 dígitos del código de lote
// y, sobre todo, la ZONA: es el primer carácter del lote y fn_generar_lote()
// la traduce a letra (1→A Chiapas · 2→B Colima · 3→C Tabasco · otra→X).
//
// Una zona mal capturada no rompe nada visible: simplemente todos los lotes
// de esa finca nacen con la letra equivocada y el error se descubre semanas
// después, cuando ya hay fruta despachada. Por eso se valida con dureza.
//
// SOBRE codigo_finca
//   La tabla no lo declara UNIQUE porque dos productores distintos pueden
//   usar el mismo número interno. Lo que sí se impide es repetirlo DENTRO
//   del mismo productor: ahí sí generaría dos lotes idénticos.
// ============================================================================

// Los CASE se repiten en varias consultas: centralizarlos evita que una
// query traduzca las zonas distinto que otra.
const ZONA_NOMBRE = `
    CASE f.zona
        WHEN 1 THEN 'CHIAPAS'
        WHEN 2 THEN 'COLIMA'
        WHEN 3 THEN 'TABASCO'
        ELSE 'SIN ZONA'
    END AS zona_nombre`;

// La letra que terminará al inicio del código de lote. Se expone para que
// la pantalla de fincas muestre el prefijo real y el error salte a la vista.
const ZONA_LETRA = `
    CASE f.zona
        WHEN 1 THEN 'A'
        WHEN 2 THEN 'B'
        WHEN 3 THEN 'C'
        ELSE 'X'
    END AS zona_letra`;

// El productor va resuelto en el SELECT para que el frontend no tenga que
// hacer una consulta por cada renglón de la tabla.
const SELECT_FINCA = `
    SELECT
        f.*,
        ${ZONA_NOMBRE},
        ${ZONA_LETRA},
        p.codigo_productor,
        p.nombre   AS nombre_productor,
        p.activo   AS productor_activo
    FROM fincas f
    JOIN productores p ON p.id_productor = f.id_productor
`;

// Lista con filtros opcionales.
//   id_productor -> para los selects encadenados (elige productor, carga fincas)
//   zona         -> 1 Chiapas · 2 Colima · 3 Tabasco
//   estado       -> 1 activas · 0 dadas de baja
const getFincas = async ({
    id_productor = null,
    zona = null,
    estado = null,
    buscar = null
} = {}) => {
    const result = await db.query(
        `
        ${SELECT_FINCA}
        WHERE ($1::INT IS NULL OR f.id_productor = $1)
          AND ($2::INT IS NULL OR f.zona = $2)
          AND ($3::INT IS NULL OR f.estado = $3)
          AND ($4::TEXT IS NULL
               OR f.codigo_finca ILIKE '%' || $4 || '%'
               OR f.nombre ILIKE '%' || $4 || '%'
               OR f.org_inv_nombre ILIKE '%' || $4 || '%')
        ORDER BY p.codigo_productor, f.codigo_finca
        `,
        [id_productor, zona, estado, buscar]
    );
    return result.rows;
};

const getFincaById = async (id_finca) => {
    const result = await db.query(
        `${SELECT_FINCA} WHERE f.id_finca = $1`,
        [id_finca]
    );
    return result.rows[0];
};

// Duplicado de código DENTRO del mismo productor.
// Al editar se excluye el propio id para que guardar sin cambios no marque
// conflicto consigo mismo.
const existeCodigo = async (codigo_finca, id_productor, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_finca, nombre FROM fincas
        WHERE UPPER(codigo_finca) = UPPER($1)
          AND id_productor = $2
          AND ($3::INT IS NULL OR id_finca <> $3)
        `,
        [codigo_finca, id_productor, id_excluir]
    );
    return result.rows[0];
};

const createFinca = async ({
    codigo_finca,
    nombre,
    org_inv_nombre,
    zona,
    id_productor,
    estado
}) => {
    const result = await db.query(
        `
        INSERT INTO fincas (
            codigo_finca, nombre, org_inv_nombre, zona, id_productor, estado
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        `,
        [codigo_finca, nombre, org_inv_nombre, zona, id_productor, estado]
    );
    return result.rows[0];
};

// Actualiza todas las columnas: el middleware ya validó y normalizó el body.
const updateFinca = async (
    id_finca,
    { codigo_finca, nombre, org_inv_nombre, zona, id_productor, estado }
) => {
    const result = await db.query(
        `
        UPDATE fincas
        SET
            codigo_finca = $1,
            nombre = $2,
            org_inv_nombre = $3,
            zona = $4,
            id_productor = $5,
            estado = $6
        WHERE id_finca = $7
        RETURNING *
        `,
        [
            codigo_finca,
            nombre,
            org_inv_nombre,
            zona,
            id_productor,
            estado,
            id_finca
        ]
    );
    return result.rows[0];
};

// Baja lógica: produccion.id_finca sigue apuntando aquí y el histórico
// tiene que poder resolverse.
const bajaFinca = async (id_finca) => {
    const result = await db.query(
        `UPDATE fincas SET estado = 0 WHERE id_finca = $1 RETURNING *`,
        [id_finca]
    );
    return result.rows[0];
};

const reactivarFinca = async (id_finca) => {
    const result = await db.query(
        `UPDATE fincas SET estado = 1 WHERE id_finca = $1 RETURNING *`,
        [id_finca]
    );
    return result.rows[0];
};

const getDependencias = async (id_finca) => {
    const result = await db.query(
        `
        SELECT (SELECT COUNT(*) FROM produccion
                 WHERE id_finca = $1) AS producciones
        `,
        [id_finca]
    );
    return result.rows[0];
};

const fincasModel = {
    getFincas,
    getFincaById,
    existeCodigo,
    createFinca,
    updateFinca,
    bajaFinca,
    reactivarFinca,
    getDependencias
};

export default fincasModel;
