import { db } from "../database/connection.database.js";

// ============================================================================
// PRODUCTORES
// ============================================================================
// Catálogo de origen. Es la base de 'fincas': una finca siempre pertenece a
// un productor, y de ahí salen 2 de los 15 dígitos del código de lote.
//
// SIN ALCANCE POR CÁMARA
//   Un productor no pertenece a un preenfrío, así que este modelo no recibe
//   el arreglo req.camaras. El recorte por cámara empieza en producción y
//   recepciones, donde la fruta ya está físicamente en una planta.
//
// LA BAJA ES LÓGICA
//   Nunca DELETE: fincas.id_productor y produccion.id_productor apuntan
//   aquí. Borrar la fila dejaría lotes históricos sin su origen. Se marca
//   activo = 0 y deja de ofrecerse en los selectores.
// ============================================================================

// Lista con el conteo de fincas, para que la pantalla muestre de un vistazo
// qué productores tienen operación y cuáles quedaron vacíos.
//
// Los filtros son opcionales. El patrón ($1::INT IS NULL OR ...) evita
// armar SQL dinámico: si el parámetro llega NULL la condición se cumple
// siempre y la misma query sirve para todos los casos.
const getProductores = async ({ activo = null, buscar = null } = {}) => {
    const result = await db.query(
        `
        SELECT
            p.*,
            (SELECT COUNT(*) FROM fincas f
              WHERE f.id_productor = p.id_productor
            ) AS total_fincas
        FROM productores p
        WHERE ($1::INT IS NULL OR p.activo = $1)
          AND ($2::TEXT IS NULL
               OR p.codigo_productor ILIKE '%' || $2 || '%'
               OR p.nombre ILIKE '%' || $2 || '%')
        ORDER BY p.codigo_productor
        `,
        [activo, buscar]
    );
    return result.rows;
};

const getProductorById = async (id_productor) => {
    const result = await db.query(
        `SELECT * FROM productores WHERE id_productor = $1`,
        [id_productor]
    );
    return result.rows[0];
};

// Verifica si un código ya está en uso.
// Se consulta antes de insertar para dar un mensaje claro en vez de dejar
// que reviente el índice UNIQUE.
//
// Al editar se excluye el propio id: guardar sin cambiar el código no debe
// marcar conflicto consigo mismo.
const existeCodigo = async (codigo_productor, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_productor, nombre FROM productores
        WHERE UPPER(codigo_productor) = UPPER($1)
          AND ($2::INT IS NULL OR id_productor <> $2)
        `,
        [codigo_productor, id_excluir]
    );
    return result.rows[0];
};

const createProductor = async ({ codigo_productor, nombre, activo }) => {
    const result = await db.query(
        `
        INSERT INTO productores (codigo_productor, nombre, activo)
        VALUES ($1, $2, $3)
        RETURNING *
        `,
        [codigo_productor, nombre, activo]
    );
    return result.rows[0];
};

// Actualiza las tres columnas siempre: el middleware ya garantizó que
// vengan completas y normalizadas. Un UPDATE parcial con COALESCE haría
// imposible distinguir "no lo mandes" de "ponlo en cero".
const updateProductor = async (
    id_productor,
    { codigo_productor, nombre, activo }
) => {
    const result = await db.query(
        `
        UPDATE productores
        SET codigo_productor = $1, nombre = $2, activo = $3
        WHERE id_productor = $4
        RETURNING *
        `,
        [codigo_productor, nombre, activo, id_productor]
    );
    return result.rows[0];
};

// Baja lógica. El histórico de fincas y producción se conserva intacto.
const bajaProductor = async (id_productor) => {
    const result = await db.query(
        `
        UPDATE productores SET activo = 0
        WHERE id_productor = $1
        RETURNING *
        `,
        [id_productor]
    );
    return result.rows[0];
};

const reactivarProductor = async (id_productor) => {
    const result = await db.query(
        `
        UPDATE productores SET activo = 1
        WHERE id_productor = $1
        RETURNING *
        `,
        [id_productor]
    );
    return result.rows[0];
};

// Qué queda colgando si se da de baja.
// El controller lo devuelve como aviso: el usuario merece saber que sus
// fincas siguen ahí y que las producciones viejas no se tocan.
const getDependencias = async (id_productor) => {
    const result = await db.query(
        `
        SELECT
            (SELECT COUNT(*) FROM fincas
              WHERE id_productor = $1) AS fincas,
            (SELECT COUNT(*) FROM produccion
              WHERE id_productor = $1) AS producciones
        `,
        [id_productor]
    );
    return result.rows[0];
};

const productoresModel = {
    getProductores,
    getProductorById,
    existeCodigo,
    createProductor,
    updateProductor,
    bajaProductor,
    reactivarProductor,
    getDependencias
};

export default productoresModel;
