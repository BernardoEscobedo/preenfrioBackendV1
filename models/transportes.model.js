import { db } from "../database/connection.database.js";

// ============================================================================
// TRANSPORTES
// ============================================================================
// Unidades y operadores que sacan la fruta. Cada fila es la combinación
// LÍNEA + OPERADOR + TRACTO + CAJA tal como se presenta en el andén, porque
// así es como se captura en el despacho: el checador ve llegar un camión
// completo, no una línea transportista abstracta.
//
// SOBRE 'inocuidad'
//   Es el resultado de la inspección sanitaria de la caja (limpieza, olores,
//   plagas, estado de la unidad). 1 = aprobada · 0 = rechazada.
//   Una unidad con inocuidad 0 NO debería cargar fruta: el controller lo
//   marca en la respuesta para que la pantalla de despachos lo advierta.
//
// LA BAJA ES LÓGICA
//   Los operadores y las unidades rotan constantemente. despachos.id_transporte
//   apunta aquí, así que borrar una fila dejaría despachos históricos sin
//   poder decir quién se llevó la fruta — justo el dato que se necesita
//   cuando hay un reclamo.
// ============================================================================

// Las placas se comparan sin espacios ni guiones: en el andén se capturan
// de todas las formas posibles ("15AN7H", "15-AN-7H", "15 AN 7H") y son
// la misma unidad.
const NORMALIZAR_PLACA = `REGEXP_REPLACE(UPPER($1), '[^A-Z0-9]', '', 'g')`;

const getTransportes = async ({
    estado = null,
    inocuidad = null,
    buscar = null
} = {}) => {
    const result = await db.query(
        `
        SELECT
            t.*,
            (SELECT COUNT(*) FROM despachos d
              WHERE d.id_transporte = t.id_transporte
            ) AS total_despachos,
            -- Último viaje: sirve para detectar unidades que ya no vienen y
            -- conviene dar de baja.
            (SELECT MAX(d.fecha_despacho) FROM despachos d
              WHERE d.id_transporte = t.id_transporte
            ) AS ultimo_despacho
        FROM transportes t
        WHERE ($1::INT IS NULL OR t.estado = $1)
          AND ($2::INT IS NULL OR t.inocuidad = $2)
          AND ($3::TEXT IS NULL
               OR t.razon_social ILIKE '%' || $3 || '%'
               OR t.nombre_operador ILIKE '%' || $3 || '%'
               OR t.placas_tracto ILIKE '%' || $3 || '%'
               OR t.placas_caja ILIKE '%' || $3 || '%'
               OR t.no_economico_caja ILIKE '%' || $3 || '%')
        ORDER BY t.razon_social, t.nombre_operador
        `,
        [estado, inocuidad, buscar]
    );
    return result.rows;
};

const getTransporteById = async (id_transporte) => {
    const result = await db.query(
        `SELECT * FROM transportes WHERE id_transporte = $1`,
        [id_transporte]
    );
    return result.rows[0];
};

// Duplicado por placas de TRACTO + CAJA.
// No se valida solo por tracto: un mismo tracto jala cajas distintas y cada
// combinación es un registro legítimo. Tampoco solo por operador: los
// operadores cambian de unidad.
//
// La comparación ignora guiones y espacios para que "15AN7H" y "15-AN-7H"
// cuenten como la misma placa.
const existeUnidad = async (placas_tracto, placas_caja, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_transporte, razon_social, nombre_operador
        FROM transportes
        WHERE REGEXP_REPLACE(UPPER(placas_tracto), '[^A-Z0-9]', '', 'g')
              = REGEXP_REPLACE(UPPER($1), '[^A-Z0-9]', '', 'g')
          AND REGEXP_REPLACE(UPPER(placas_caja), '[^A-Z0-9]', '', 'g')
              = REGEXP_REPLACE(UPPER($2), '[^A-Z0-9]', '', 'g')
          AND ($3::INT IS NULL OR id_transporte <> $3)
        `,
        [placas_tracto, placas_caja, id_excluir]
    );
    return result.rows[0];
};

const createTransporte = async ({
    razon_social,
    nombre_operador,
    celular,
    placas_tracto,
    placas_caja,
    no_economico_caja,
    inocuidad,
    estado
}) => {
    const result = await db.query(
        `
        INSERT INTO transportes (
            razon_social, nombre_operador, celular,
            placas_tracto, placas_caja, no_economico_caja,
            inocuidad, estado
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
        `,
        [
            razon_social,
            nombre_operador,
            celular,
            placas_tracto,
            placas_caja,
            no_economico_caja,
            inocuidad,
            estado
        ]
    );
    return result.rows[0];
};

const updateTransporte = async (
    id_transporte,
    {
        razon_social,
        nombre_operador,
        celular,
        placas_tracto,
        placas_caja,
        no_economico_caja,
        inocuidad,
        estado
    }
) => {
    const result = await db.query(
        `
        UPDATE transportes
        SET
            razon_social = $1,
            nombre_operador = $2,
            celular = $3,
            placas_tracto = $4,
            placas_caja = $5,
            no_economico_caja = $6,
            inocuidad = $7,
            estado = $8
        WHERE id_transporte = $9
        RETURNING *
        `,
        [
            razon_social,
            nombre_operador,
            celular,
            placas_tracto,
            placas_caja,
            no_economico_caja,
            inocuidad,
            estado,
            id_transporte
        ]
    );
    return result.rows[0];
};

const bajaTransporte = async (id_transporte) => {
    const result = await db.query(
        `UPDATE transportes SET estado = 0 WHERE id_transporte = $1 RETURNING *`,
        [id_transporte]
    );
    return result.rows[0];
};

const reactivarTransporte = async (id_transporte) => {
    const result = await db.query(
        `UPDATE transportes SET estado = 1 WHERE id_transporte = $1 RETURNING *`,
        [id_transporte]
    );
    return result.rows[0];
};

// Actualizar SOLO el resultado de inocuidad.
// Va aparte del update completo porque es una decisión operativa que se
// toma en el andén, con la unidad enfrente: obligar a reenviar placas y
// datos del operador para marcar un rechazo invitaba a errores de captura.
const setInocuidad = async (id_transporte, inocuidad) => {
    const result = await db.query(
        `
        UPDATE transportes SET inocuidad = $1
        WHERE id_transporte = $2
        RETURNING *
        `,
        [inocuidad, id_transporte]
    );
    return result.rows[0];
};

const getDependencias = async (id_transporte) => {
    const result = await db.query(
        `
        SELECT (SELECT COUNT(*) FROM despachos
                 WHERE id_transporte = $1) AS despachos
        `,
        [id_transporte]
    );
    return result.rows[0];
};

const transportesModel = {
    getTransportes,
    getTransporteById,
    existeUnidad,
    createTransporte,
    updateTransporte,
    bajaTransporte,
    reactivarTransporte,
    setInocuidad,
    getDependencias
};

export default transportesModel;
