import { db } from "../database/connection.database.js";

// ============================================================================
// CÁMARAS
// ============================================================================
// Catálogo de las cámaras físicas. La capacidad que se define aquí es el
// tope que respetan los triggers de recepción y de cola: si se captura mal,
// el sistema mandará fruta a la cola de más o de menos.
//
// ALCANCE POR CÁMARA
//   getCamaras recibe `camaras` desde el middleware cargarAlcance:
//       null   -> sin restricción (Admin / Coordinador)
//       [1,2]  -> solo esas cámaras (Supervisor / Operativo)
//
//   Filtrar este catálogo tiene un efecto colateral valioso: TODOS los
//   dropdowns del sistema se acotan solos. Un supervisor de Doña Nelly ya
//   no podrá siquiera elegir Fortaleza al mover inventario, porque su lista
//   no la trae. Previene errores de captura, no solo fugas de información.
//
// CORRECCIÓN DE LA AUDITORÍA
//   Desde la v2.2 la tabla tiene 'estado' (1 operativa · 0 fuera de
//   servicio), pero getCamarasByTipo —que alimenta dropdowns como el
//   destino al mover a conserva— seguía ofreciendo cámaras dadas de baja.
//   Ahora filtra estado = 1.
//
//   getCamaras NO filtra por estado a propósito: es también la pantalla del
//   catálogo, y el admin tiene que poder ver las cámaras fuera de servicio
//   (sobre todo si les quedó inventario dentro). Para supervisores ya viene
//   filtrado: fn_camaras_usuario excluye las cámaras dadas de baja.
// ============================================================================

// Lista filtrada por alcance.
// El patrón ($1::INT[] IS NULL OR ...) sirve para los dos casos con la
// misma query: si el parámetro llega NULL la condición se cumple siempre.
// Las fuera de servicio salen al final.
const getCamaras = async (camaras = null) => {
    const result = await db.query(
        `
        SELECT *
        FROM camaras
        WHERE ($1::INT[] IS NULL OR id_camara = ANY($1))
        ORDER BY estado DESC, tipo_camara, nombre_camara
        `,
        [camaras]
    );
    return result.rows;
};

// Una cámara por ID.
// No filtra por alcance: el controller compara el resultado para poder
// distinguir entre "no existe" (404) y "no es tuya" (403).
const getCamaraById = async (id_camara) => {
    const result = await db.query(
        `SELECT * FROM camaras WHERE id_camara = $1`,
        [id_camara]
    );
    return result.rows[0];
};

// Cámaras OPERATIVAS por tipo: 1=preenfrío · 2=conservación.
// Útil para los dropdowns que solo aceptan uno de los dos (ej. el destino
// al mover a conserva). Una cámara fuera de servicio no debe ofrecerse como
// destino: el controller la rechazaría después con un 409.
const getCamarasByTipo = async (tipo_camara, camaras = null) => {
    const result = await db.query(
        `
        SELECT *
        FROM camaras
        WHERE tipo_camara = $1
          AND estado = 1
          AND ($2::INT[] IS NULL OR id_camara = ANY($2))
        ORDER BY nombre_camara
        `,
        [tipo_camara, camaras]
    );
    return result.rows;
};

const createCamara = async ({
    nombre_camara,
    tipo_camara,
    ubicacion,
    capacidad_max_tarimas,
    capacidad_max_cajas,
    capacidad_max_bloques
}) => {
    const result = await db.query(
        `
        INSERT INTO camaras (
            nombre_camara,
            tipo_camara,
            ubicacion,
            capacidad_max_tarimas,
            capacidad_max_cajas,
            capacidad_max_bloques
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        `,
        [
            nombre_camara,
            tipo_camara,
            ubicacion,
            capacidad_max_tarimas,
            capacidad_max_cajas,
            capacidad_max_bloques
        ]
    );
    return result.rows[0];
};

const updateCamara = async (
    id_camara,
    {
        nombre_camara,
        tipo_camara,
        ubicacion,
        capacidad_max_tarimas,
        capacidad_max_cajas,
        capacidad_max_bloques
    }
) => {
    const result = await db.query(
        `
        UPDATE camaras
        SET
            nombre_camara = $1,
            tipo_camara = $2,
            ubicacion = $3,
            capacidad_max_tarimas = $4,
            capacidad_max_cajas = $5,
            capacidad_max_bloques = $6
        WHERE id_camara = $7
        RETURNING *
        `,
        [
            nombre_camara,
            tipo_camara,
            ubicacion,
            capacidad_max_tarimas,
            capacidad_max_cajas,
            capacidad_max_bloques,
            id_camara
        ]
    );
    return result.rows[0];
};

const deleteCamara = async (id_camara) => {
    const result = await db.query(
        `DELETE FROM camaras WHERE id_camara = $1 RETURNING *`,
        [id_camara]
    );
    return result.rows[0];
};

// Cuánto se está usando la cámara ahora mismo.
// Se consulta antes de reducir su capacidad: bajarla por debajo de lo que
// ya tiene dentro dejaría el inventario sobreocupado.
const getOcupacionActual = async (id_camara) => {
    const result = await db.query(
        `
        SELECT
            COALESCE(SUM(cantidad_tarimas), 0) AS tarimas_ocupadas,
            COALESCE(SUM(cantidad_cajas), 0)   AS cajas_ocupadas
        FROM ocupaciones_camaras
        WHERE id_camara = $1 AND tipo_ocupacion = 1 AND estado = 1
        `,
        [id_camara]
    );
    return result.rows[0];
};

const camarasModel = {
    getCamaras,
    getCamaraById,
    getCamarasByTipo,
    createCamara,
    updateCamara,
    deleteCamara,
    getOcupacionActual
};

export default camarasModel;
