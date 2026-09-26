import { db } from "../database/connection.database.js";
import { SQL_CAMARAS_REALES } from "../utils/camarasReales.sql.js";

// ============================================================================
// PULPEOS — CONTROL DE TEMPERATURA
// ============================================================================
// Un pulpeo es la medición de temperatura DENTRO de la fruta: el termómetro
// de aguja entra a la pulpa, no mide el aire de la cámara. Es el dato que
// respalda la cadena de frío ante el cliente.
//
// ESTRUCTURA EN TRES NIVELES
//   pulpeos            la medición sobre el BLOQUE físico completo
//   pulpeos_detalle    el desglose por proceso, porque un bloque puede
//                      mezclar fruta de varias fincas y cada una puede
//                      venir a distinta temperatura
//   pulpeos_evidencia  la foto del termómetro
//
// EL DATO QUE DECIDE LA SALIDA
//   temperatura_promedio contra temperatura_objetivo. Mientras no llegue al
//   objetivo, la fruta sigue en preenfrío.
//
// LA BAJA ES LÓGICA (v2.2)
//   estado = 0 para una lectura errónea. No se borra: dejaría un hueco
//   inexplicable en la secuencia de pulpeos del bloque, y esa secuencia es
//   evidencia.
//
// CORRECCIÓN DE LA AUDITORÍA · ALCANCE POR CÁMARA REAL
//   El listado y los pendientes filtraban por produccion.id_camara, la
//   cámara del plan. Si el camión se desvió en el andén, el supervisor de
//   la cámara donde estaba la fruta no veía sus pulpeos pendientes. Ahora
//   se usa SQL_CAMARAS_REALES, el mismo criterio que bloques.model.
// ============================================================================

// Condición de alcance reutilizable: el bloque tiene fruta en alguna de las
// cámaras del usuario. Recibe el alias del bloque y el número de parámetro.
const ALCANCE_BLOQUE = (aliasBloque, param) => `
    (
        ${param}::INT[] IS NULL
        OR EXISTS (
            SELECT 1
            FROM bloques_produccion_detalle d
            JOIN produccion pr ON pr.id_produccion = d.id_produccion
            CROSS JOIN LATERAL (${SQL_CAMARAS_REALES("pr")}) AS cr(id_camara)
            WHERE d.id_bloque = ${aliasBloque}.id_bloque
              AND cr.id_camara = ANY(${param})
        )
    )
`;

const SELECT_PULPEO = `
    SELECT
        p.*,
        b.codigo_bloque,
        b.estado            AS estado_bloque,
        b.cantidad_tarimas  AS tarimas_bloque,
        CASE p.estado
            WHEN 1 THEN 'Válido'
            WHEN 0 THEN 'Cancelado'
            ELSE 'Otro'
        END AS estado_texto,
        -- Diferencia contra el objetivo: positiva significa que la fruta
        -- todavía está más caliente de lo que debería.
        ROUND(p.temperatura_promedio - p.temperatura_objetivo, 2) AS desviacion,
        CASE
            WHEN p.temperatura_promedio <= p.temperatura_objetivo
                THEN TRUE ELSE FALSE
        END AS alcanzo_objetivo,
        -- Quién lo tomó: ante un reclamo, es el dato que se busca
        e.nombre    AS nombre_usuario,
        e.apellidos AS apellidos_usuario,
        u.usuario,
        (SELECT COUNT(*) FROM pulpeos_detalle d
          WHERE d.id_pulpeo = p.id_pulpeo) AS procesos_medidos,
        (SELECT COUNT(*) FROM pulpeos_evidencia ev
          JOIN pulpeos_detalle d2 ON d2.id_pulpeo_detalle = ev.id_pulpeo_detalle
          WHERE d2.id_pulpeo = p.id_pulpeo) AS fotos
    FROM pulpeos p
    JOIN bloques_fruta  b ON b.id_bloque   = p.id_bloque
    LEFT JOIN usuarios  u ON u.id_usuario  = p.id_usuario
    LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
`;

// ----------------------------------------------------------------------------
// Listado
// ----------------------------------------------------------------------------
const getPulpeos = async (
    {
        id_bloque = null,
        estado = null,
        solo_fuera_de_objetivo = false,
        fecha_desde = null,
        fecha_hasta = null
    } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        ${SELECT_PULPEO}
        WHERE ($1::INT IS NULL OR p.id_bloque = $1)
          AND ($2::INT IS NULL OR p.estado = $2)
          AND ($3::DATE IS NULL OR p.fecha_hora::DATE >= $3)
          AND ($4::DATE IS NULL OR p.fecha_hora::DATE <= $4)
          AND ($5::BOOLEAN IS FALSE
               OR p.temperatura_promedio > p.temperatura_objetivo)
          AND ${ALCANCE_BLOQUE("p", "$6")}
        ORDER BY p.fecha_hora DESC, p.id_pulpeo DESC
        LIMIT 500
        `,
        [
            id_bloque,
            estado,
            fecha_desde,
            fecha_hasta,
            solo_fuera_de_objetivo,
            camaras
        ]
    );
    return result.rows;
};

const getPulpeoById = async (id_pulpeo) => {
    const result = await db.query(
        `${SELECT_PULPEO} WHERE p.id_pulpeo = $1`,
        [id_pulpeo]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Desglose por proceso
// ----------------------------------------------------------------------------
// Cuando el bloque mezcla lotes, permite saber cuál venía más caliente.
const getDetalle = async (id_pulpeo) => {
    const result = await db.query(
        `
        SELECT
            d.id_pulpeo_detalle,
            d.id_pulpeo,
            d.id_produccion,
            d.cantidad_tarimas,
            d.temperatura,
            d.fecha_hora,
            p.codigo_lote,
            p.fecha_empaque,
            f.nombre  AS nombre_finca,
            pr.nombre AS nombre_productor,
            s.codigo_sku,
            s.calidad AS calidad_sku,
            cc.cliente,
            (SELECT COUNT(*) FROM pulpeos_evidencia ev
              WHERE ev.id_pulpeo_detalle = d.id_pulpeo_detalle) AS fotos
        FROM pulpeos_detalle d
        JOIN produccion         p   ON p.id_produccion = d.id_produccion
        LEFT JOIN fincas        f   ON f.id_finca      = p.id_finca
        LEFT JOIN productores   pr  ON pr.id_productor = p.id_productor
        LEFT JOIN sku_pt        s   ON s.id_sku        = p.id_sku
        LEFT JOIN cedis_cliente cc  ON cc.id_cc        = p.id_cc
        WHERE d.id_pulpeo = $1
        ORDER BY d.id_pulpeo_detalle
        `,
        [id_pulpeo]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Alta con su detalle — EN TRANSACCIÓN
// ----------------------------------------------------------------------------
// El pulpeo y su desglose se guardan juntos o no se guardan: un pulpeo sin
// detalle cuando el bloque mezcla lotes es una medición que no se puede
// atribuir, y un detalle huérfano no significa nada.
const createPulpeo = async ({
    id_bloque,
    fecha_hora,
    numero_pulpeo,
    temperatura_objetivo,
    temperatura_promedio,
    id_usuario,
    observaciones,
    detalle = []
}) => {
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        const resultPulpeo = await client.query(
            `
            INSERT INTO pulpeos (
                id_bloque, fecha_hora, numero_pulpeo,
                temperatura_objetivo, temperatura_promedio,
                id_usuario, observaciones, estado
            )
            VALUES ($1, COALESCE($2, CURRENT_TIMESTAMP), $3, $4, $5, $6, $7, 1)
            RETURNING *
            `,
            [
                id_bloque,
                fecha_hora,
                numero_pulpeo,
                temperatura_objetivo,
                temperatura_promedio,
                id_usuario,
                observaciones
            ]
        );

        const pulpeo = resultPulpeo.rows[0];

        // El detalle es opcional: si el bloque tiene un solo proceso, la
        // medición del encabezado ya lo dice todo.
        for (const linea of detalle) {
            await client.query(
                `
                INSERT INTO pulpeos_detalle (
                    id_pulpeo, id_produccion, cantidad_tarimas,
                    temperatura, fecha_hora
                )
                VALUES ($1, $2, $3, $4, COALESCE($5, $6))
                `,
                [
                    pulpeo.id_pulpeo,
                    linea.id_produccion,
                    linea.cantidad_tarimas,
                    linea.temperatura,
                    linea.fecha_hora,
                    pulpeo.fecha_hora
                ]
            );
        }

        await client.query("COMMIT");
        return pulpeo;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

// Edición limitada a lo administrativo. Las temperaturas NO se editan: una
// lectura es un hecho puntual, no un dato corregible. Si estuvo mal, se
// cancela y se toma otra — así queda rastro de que hubo una corrección.
const updatePulpeo = async (id_pulpeo, { numero_pulpeo, observaciones }) => {
    const result = await db.query(
        `
        UPDATE pulpeos
        SET numero_pulpeo = COALESCE($2, numero_pulpeo),
            observaciones = $3
        WHERE id_pulpeo = $1
        RETURNING *
        `,
        [id_pulpeo, numero_pulpeo, observaciones]
    );
    return result.rows[0];
};

// Cancelar una lectura errónea. Se conserva la fila: borrarla dejaría un
// hueco inexplicable en la secuencia de pulpeos del bloque.
const cancelarPulpeo = async (id_pulpeo) => {
    const result = await db.query(
        `UPDATE pulpeos SET estado = 0 WHERE id_pulpeo = $1 RETURNING *`,
        [id_pulpeo]
    );
    return result.rows[0];
};

const reactivarPulpeo = async (id_pulpeo) => {
    const result = await db.query(
        `UPDATE pulpeos SET estado = 1 WHERE id_pulpeo = $1 RETURNING *`,
        [id_pulpeo]
    );
    return result.rows[0];
};

// Siguiente número de pulpeo del bloque. Los pulpeos se numeran en
// secuencia (1º, 2º, 3º...) para seguir la curva de enfriamiento.
const getSiguienteNumero = async (id_bloque) => {
    const result = await db.query(
        `
        SELECT COALESCE(MAX(numero_pulpeo), 0) + 1 AS siguiente
        FROM pulpeos WHERE id_bloque = $1
        `,
        [id_bloque]
    );
    return Number(result.rows[0].siguiente);
};

// ----------------------------------------------------------------------------
// Curva de enfriamiento de un bloque
// ----------------------------------------------------------------------------
// Todos los pulpeos en orden cronológico, con las horas transcurridas desde
// el armado. Es el gráfico que demuestra la cadena de frío ante el cliente.
const getCurva = async (id_bloque) => {
    const result = await db.query(
        `
        SELECT
            p.id_pulpeo,
            p.numero_pulpeo,
            p.fecha_hora,
            p.temperatura_objetivo,
            p.temperatura_promedio,
            ROUND(p.temperatura_promedio - p.temperatura_objetivo, 2) AS desviacion,
            p.estado,
            -- Horas desde que se armó el bloque: el eje X de la curva
            ROUND(
                EXTRACT(EPOCH FROM (p.fecha_hora - b.fecha_hora_armado)) / 3600,
                1
            ) AS horas_desde_armado,
            -- Cuánto bajó respecto a la medición anterior. LAG mira la fila
            -- previa sin necesidad de un self-join.
            ROUND(
                p.temperatura_promedio - LAG(p.temperatura_promedio)
                    OVER (ORDER BY p.fecha_hora),
                2
            ) AS variacion
        FROM pulpeos p
        JOIN bloques_fruta b ON b.id_bloque = p.id_bloque
        WHERE p.id_bloque = $1 AND p.estado = 1
        ORDER BY p.fecha_hora
        `,
        [id_bloque]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Bloques que necesitan pulpeo
// ----------------------------------------------------------------------------
// Los que llevan horas sin medición, o cuya última lectura no alcanzó el
// objetivo. Es el reporte de pendientes del turno.
const getPendientes = async (horas_sin_pulpeo = 4, camaras = null) => {
    const result = await db.query(
        `
        SELECT
            b.id_bloque,
            b.codigo_bloque,
            b.fecha_hora_armado,
            b.cantidad_tarimas,
            ROUND(
                EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - b.fecha_hora_armado)) / 3600,
                1
            ) AS horas_desde_armado,
            ult.id_pulpeo         AS ultimo_pulpeo,
            ult.fecha_hora        AS fecha_ultimo_pulpeo,
            ult.temperatura_promedio,
            ult.temperatura_objetivo,
            CASE
                WHEN ult.id_pulpeo IS NULL THEN NULL
                ELSE ROUND(
                    EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ult.fecha_hora)) / 3600,
                    1
                )
            END AS horas_sin_medicion,
            CASE
                WHEN ult.id_pulpeo IS NULL THEN 'SIN_PULPEO'
                WHEN ult.temperatura_promedio > ult.temperatura_objetivo
                    THEN 'FUERA_DE_OBJETIVO'
                ELSE 'AL_DIA'
            END AS situacion
        FROM bloques_fruta b
        LEFT JOIN LATERAL (
            -- LATERAL trae la última fila por bloque sin una subconsulta
            -- correlacionada por cada columna
            SELECT p.id_pulpeo, p.fecha_hora,
                   p.temperatura_promedio, p.temperatura_objetivo
            FROM pulpeos p
            WHERE p.id_bloque = b.id_bloque AND p.estado = 1
            ORDER BY p.fecha_hora DESC
            LIMIT 1
        ) ult ON TRUE
        WHERE b.estado = 1
          AND (
              ult.id_pulpeo IS NULL
              OR ult.temperatura_promedio > ult.temperatura_objetivo
              OR EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ult.fecha_hora)) / 3600
                 >= $1
          )
          AND ${ALCANCE_BLOQUE("b", "$2")}
        ORDER BY horas_desde_armado DESC
        `,
        [horas_sin_pulpeo, camaras]
    );
    return result.rows;
};

// Evidencias fotográficas de una línea del detalle.
// ⚠️ La SUBIDA de fotos necesita multer + sharp, que todavía no están
// instalados. Este método solo lista lo que ya exista.
const getEvidencias = async (id_pulpeo_detalle) => {
    const result = await db.query(
        `
        SELECT * FROM pulpeos_evidencia
        WHERE id_pulpeo_detalle = $1
        ORDER BY fecha_hora
        `,
        [id_pulpeo_detalle]
    );
    return result.rows;
};

const pulpeosModel = {
    getPulpeos,
    getPulpeoById,
    getDetalle,
    createPulpeo,
    updatePulpeo,
    cancelarPulpeo,
    reactivarPulpeo,
    getSiguienteNumero,
    getCurva,
    getPendientes,
    getEvidencias
};

export default pulpeosModel;
