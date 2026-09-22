import { db } from "../database/connection.database.js";

// ============================================================================
// CEDIS / CLIENTE
// ============================================================================
// Destino de la fruta. Cada fila es la combinación CLIENTE + CEDIS: un mismo
// cliente puede tener varios centros de distribución y cada uno se planea,
// se despacha y se cita por separado.
//
// SOBRE 'acronimo'
//   Es la LLAVE DE NEGOCIO que usa logística en sus hojas y la que cruza con
//   el Excel de planeación semanal. Por eso la BD la declara única
//   (uq_cedis_cliente_acronimo, sobre UPPER): dos destinos con el mismo
//   acrónimo harían que la importación asignara fruta al CEDIS equivocado
//   sin lanzar ningún error.
//
// SIN ALCANCE POR CÁMARA
//   Un cliente no pertenece a un preenfrío. El recorte por cámara empieza en
//   producción y recepciones.
//
// LA BAJA ES LÓGICA
//   produccion.id_cc y despachos.id_cc apuntan aquí. Un despacho de hace
//   tres meses tiene que seguir resolviendo a qué cliente se entregó.
// ============================================================================

// Lista con el conteo de producciones, para que la pantalla distinga los
// destinos que realmente operan de los que quedaron en el catálogo.
const getCedis = async ({ estado = null, buscar = null } = {}) => {
    const result = await db.query(
        `
        SELECT
            cc.*,
            (SELECT COUNT(*) FROM produccion p
              WHERE p.id_cc = cc.id_cc
            ) AS total_producciones,
            (SELECT COUNT(*) FROM despachos d
              WHERE d.id_cc = cc.id_cc
            ) AS total_despachos
        FROM cedis_cliente cc
        WHERE ($1::INT IS NULL OR cc.estado = $1)
          AND ($2::TEXT IS NULL
               OR cc.cliente ILIKE '%' || $2 || '%'
               OR cc.cedis ILIKE '%' || $2 || '%'
               OR cc.acronimo ILIKE '%' || $2 || '%')
        ORDER BY cc.cliente, cc.cedis
        `,
        [estado, buscar]
    );
    return result.rows;
};

const getCedisById = async (id_cc) => {
    const result = await db.query(
        `SELECT * FROM cedis_cliente WHERE id_cc = $1`,
        [id_cc]
    );
    return result.rows[0];
};

// Duplicado de acrónimo. Se consulta antes de insertar para dar un mensaje
// claro en vez de dejar que reviente el índice único.
// Al editar se excluye el propio id.
const existeAcronimo = async (acronimo, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_cc, cliente, cedis FROM cedis_cliente
        WHERE UPPER(acronimo) = UPPER($1)
          AND ($2::INT IS NULL OR id_cc <> $2)
        `,
        [acronimo, id_excluir]
    );
    return result.rows[0];
};

// La pareja cliente + cedis tampoco debería repetirse: sería el mismo
// destino capturado dos veces con acrónimos distintos, y la planeación no
// sabría a cuál de los dos mandar la fruta.
//
// La BD no lo impide (solo el acrónimo es único), así que se valida aquí.
const existeClienteCedis = async (cliente, cedis, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_cc, acronimo FROM cedis_cliente
        WHERE UPPER(cliente) = UPPER($1)
          AND UPPER(cedis) = UPPER($2)
          AND ($3::INT IS NULL OR id_cc <> $3)
        `,
        [cliente, cedis, id_excluir]
    );
    return result.rows[0];
};

const createCedis = async ({ cliente, cedis, acronimo, estado }) => {
    const result = await db.query(
        `
        INSERT INTO cedis_cliente (cliente, cedis, acronimo, estado)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [cliente, cedis, acronimo, estado]
    );
    return result.rows[0];
};

// Actualiza todas las columnas: el middleware ya garantizó que vengan
// completas y normalizadas.
const updateCedis = async (id_cc, { cliente, cedis, acronimo, estado }) => {
    const result = await db.query(
        `
        UPDATE cedis_cliente
        SET cliente = $1, cedis = $2, acronimo = $3, estado = $4
        WHERE id_cc = $5
        RETURNING *
        `,
        [cliente, cedis, acronimo, estado, id_cc]
    );
    return result.rows[0];
};

const bajaCedis = async (id_cc) => {
    const result = await db.query(
        `UPDATE cedis_cliente SET estado = 0 WHERE id_cc = $1 RETURNING *`,
        [id_cc]
    );
    return result.rows[0];
};

const reactivarCedis = async (id_cc) => {
    const result = await db.query(
        `UPDATE cedis_cliente SET estado = 1 WHERE id_cc = $1 RETURNING *`,
        [id_cc]
    );
    return result.rows[0];
};

const getDependencias = async (id_cc) => {
    const result = await db.query(
        `
        SELECT
            (SELECT COUNT(*) FROM produccion
              WHERE id_cc = $1) AS producciones,
            (SELECT COUNT(*) FROM despachos
              WHERE id_cc = $1) AS despachos
        `,
        [id_cc]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Búsqueda por acrónimo — la usa la importación del Excel semanal
// ----------------------------------------------------------------------------
// El Excel trae el acrónimo, no el id. Este método lo resuelve para poder
// armar el INSERT de producción.
//
// NO filtra por estado: si la hoja trae un destino dado de baja, conviene
// que el importador lo encuentre y avise "este CEDIS está inactivo", en vez
// de reportar "no existe" y mandar a crear un duplicado.
const getByAcronimo = async (acronimo) => {
    const result = await db.query(
        `SELECT * FROM cedis_cliente WHERE UPPER(acronimo) = UPPER($1)`,
        [acronimo]
    );
    return result.rows[0];
};

const cedisModel = {
    getCedis,
    getCedisById,
    existeAcronimo,
    existeClienteCedis,
    createCedis,
    updateCedis,
    bajaCedis,
    reactivarCedis,
    getDependencias,
    getByAcronimo
};

export default cedisModel;
