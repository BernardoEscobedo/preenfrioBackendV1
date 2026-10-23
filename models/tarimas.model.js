import { db } from "../database/connection.database.js";

// ============================================================================
// BLOQUES POR TARIMA Y PULPEO POR TARIMA
// ============================================================================
// Un bloque es un montón de 10 o 12 POSICIONES físicas. Cada posición es
// una tarima (bloques_tarimas) que puede llevar uno o más lotes/SKU
// (bloques_tarimas_detalle) y se pulpea por separado.
//
//   · Cada tarima sabe en qué cámara está. El bloque se traslada a
//     conservación desde el módulo de Movimientos (completo o parcial),
//     que también mueve el inventario.
//   · En preenfrío las horas cuentan desde fecha_hora_ingreso (alerta de
//     5 horas); en conservación, desde fecha_hora_traslado.
//   · El pulpeo de tarima SIEMPRE lleva foto: lo exige un trigger diferido.
//
// "AHORA" EN LA ZONA DE OPERACIÓN
//   Las horas se capturan en hora local. Para comparar contra ellas se usa
//   (now() AT TIME ZONE zona), no CURRENT_TIMESTAMP: si la BD está en UTC,
//   CURRENT_TIMESTAMP adelanta 6 horas y todas las tarimas saldrían con la
//   alerta de 5 horas.
//
//   La zona sale de ZONA_HORARIA en el .env. Se lee en cada consulta (no al
//   importar) para no depender del orden en que se carga dotenv.
// ============================================================================

export const zona = () => process.env.ZONA_HORARIA || "America/Mexico_City";

// Inicio del conteo de horas: traslado en conservación, ingreso en preenfrío
const INICIO_HORAS = `(CASE WHEN c.tipo_camara = 2 AND t.fecha_hora_traslado IS NOT NULL
                           THEN t.fecha_hora_traslado ELSE t.fecha_hora_ingreso END)`;

// ----------------------------------------------------------------------------
// Cámaras
// ----------------------------------------------------------------------------
const getCamara = async (ejecutor, id_camara) =>
    (await ejecutor.query(
        `SELECT id_camara, nombre_camara, tipo_camara, estado FROM camaras WHERE id_camara = $1`,
        [id_camara]
    )).rows[0];

// ----------------------------------------------------------------------------
// Tarimas de una cámara, con su último pulpeo y sus lotes
// ----------------------------------------------------------------------------
const getTarimas = async ({ id_camara = null } = {}, camaras = null) => {
    const result = await db.query(
        `
        SELECT
            t.id_tarima, t.id_bloque, t.posicion, t.id_camara,
            t.fecha_hora_ingreso, t.fecha_hora_traslado,
            b.codigo_bloque, b.posiciones, b.fecha_hora_armado,
            c.nombre_camara, c.tipo_camara,
            ROUND(EXTRACT(EPOCH FROM (a.ahora - ${INICIO_HORAS})) / 3600, 1) AS horas_en_camara,
            ROUND(EXTRACT(EPOCH FROM (a.ahora - ${INICIO_HORAS})) / 60)      AS minutos_en_camara,
            up.id_pulpeo            AS ultimo_pulpeo,
            up.fecha_hora           AS fecha_ultimo_pulpeo,
            up.temperatura_promedio AS ultima_temperatura,
            up.id_evidencia         AS ultima_evidencia,
            CASE WHEN up.id_pulpeo IS NULL THEN NULL
                 ELSE ROUND(EXTRACT(EPOCH FROM (a.ahora - up.fecha_hora)) / 60)
            END AS minutos_desde_pulpeo,
            (SELECT COUNT(*) FROM pulpeos p WHERE p.id_tarima = t.id_tarima AND p.estado = 1)::INT AS pulpeos,
            COALESCE(l.lotes, '[]'::json) AS lotes
        FROM bloques_tarimas t
        JOIN bloques_fruta b ON b.id_bloque = t.id_bloque
        JOIN camaras c       ON c.id_camara = t.id_camara
        CROSS JOIN (SELECT (now() AT TIME ZONE $3)::timestamp AS ahora) a
        LEFT JOIN LATERAL (
            SELECT p.id_pulpeo, p.fecha_hora, p.temperatura_promedio,
                   (SELECT MIN(ev.id_evidencia) FROM pulpeos_evidencia ev
                     WHERE ev.id_pulpeo = p.id_pulpeo) AS id_evidencia
            FROM pulpeos p
            WHERE p.id_tarima = t.id_tarima AND p.estado = 1
            ORDER BY p.fecha_hora DESC, p.id_pulpeo DESC
            LIMIT 1
        ) up ON TRUE
        LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object(
                       'id_produccion', d.id_produccion,
                       'cantidad_cajas', d.cantidad_cajas,
                       'codigo_lote', pr.codigo_lote,
                       'fecha_empaque', pr.fecha_empaque,
                       'codigo_sku', s.codigo_sku,
                       'calidad_sku', s.calidad,
                       'codigo_finca', f.codigo_finca,
                       'nombre_finca', f.nombre,
                       'codigo_productor', po.codigo_productor,
                       'acronimo_cc', cc.acronimo
                   ) ORDER BY d.id_detalle) AS lotes
            FROM bloques_tarimas_detalle d
            JOIN produccion pr          ON pr.id_produccion = d.id_produccion
            LEFT JOIN sku_pt s          ON s.id_sku         = pr.id_sku
            LEFT JOIN fincas f          ON f.id_finca       = pr.id_finca
            LEFT JOIN productores po    ON po.id_productor  = pr.id_productor
            LEFT JOIN cedis_cliente cc  ON cc.id_cc         = pr.id_cc
            WHERE d.id_tarima = t.id_tarima
        ) l ON TRUE
        WHERE b.estado = 1 AND t.estado = 1
          AND ($1::INT IS NULL OR t.id_camara = $1)
          AND ($2::INT[] IS NULL OR t.id_camara = ANY($2))
        ORDER BY b.fecha_hora_armado DESC, b.id_bloque DESC, t.posicion
        `,
        [id_camara, camaras, zona()]
    );
    return result.rows;
};

// Posiciones de esos bloques que están en OTRA cámara (traslado parcial):
// en la rejilla se muestran ocupadas, no libres.
const getTarimasFuera = async (ids_bloque, id_camara) =>
    (await db.query(
        `SELECT t.id_bloque, t.posicion, c.nombre_camara
         FROM bloques_tarimas t
         JOIN camaras c ON c.id_camara = t.id_camara
         WHERE t.id_bloque = ANY($1::INT[]) AND t.estado = 1
           AND ($2::INT IS NULL OR t.id_camara <> $2)`,
        [ids_bloque, id_camara]
    )).rows;

const getTarima = async (ejecutor, id_tarima, bloquear = false) =>
    (await ejecutor.query(
        `
        SELECT t.*, b.codigo_bloque, b.estado AS estado_bloque, b.posiciones,
               c.nombre_camara, c.tipo_camara
        FROM bloques_tarimas t
        JOIN bloques_fruta b ON b.id_bloque = t.id_bloque
        JOIN camaras c       ON c.id_camara = t.id_camara
        WHERE t.id_tarima = $1
        ${bloquear ? "FOR UPDATE OF t" : ""}
        `,
        [id_tarima]
    )).rows[0];

const getLotesDeTarima = async (ejecutor, id_tarima) =>
    (await ejecutor.query(
        `SELECT id_produccion, cantidad_cajas FROM bloques_tarimas_detalle WHERE id_tarima = $1`,
        [id_tarima]
    )).rows;

// ----------------------------------------------------------------------------
// Lotes disponibles en la cámara (para armar)
// ----------------------------------------------------------------------------
const getLotesCamara = async (id_camara) => {
    const result = await db.query(
        `
        SELECT v.id_produccion, v.codigo_lote, v.codigo_sku, v.calidad_sku,
               v.codigo_finca, v.nombre_finca, v.codigo_productor, v.acronimo_cc,
               v.fecha_empaque,
               SUM(v.tarimas_disponibles)::INT AS tarimas_disponibles,
               SUM(v.cajas_disponibles)::INT   AS cajas_disponibles,
               COALESCE((
                   SELECT SUM(d.cantidad_cajas)
                   FROM bloques_tarimas_detalle d
                   JOIN bloques_tarimas t ON t.id_tarima = d.id_tarima
                   JOIN bloques_fruta b   ON b.id_bloque = t.id_bloque
                   WHERE d.id_produccion = v.id_produccion
                     AND t.id_camara = $1 AND t.estado = 1 AND b.estado = 1
               ), 0)::INT AS cajas_en_bloques
        FROM vw_inventario_disponible v
        WHERE v.id_camara = $1 AND v.id_produccion IS NOT NULL
        GROUP BY v.id_produccion, v.codigo_lote, v.codigo_sku, v.calidad_sku,
                 v.codigo_finca, v.nombre_finca, v.codigo_productor, v.acronimo_cc,
                 v.fecha_empaque
        ORDER BY v.fecha_empaque NULLS LAST, v.codigo_lote
        `,
        [id_camara]
    );
    return result.rows;
};

const lotesEnCamara = async (ejecutor, id_camara, ids) =>
    (await ejecutor.query(
        `SELECT DISTINCT id_produccion FROM vw_inventario_disponible
         WHERE id_camara = $1 AND id_produccion = ANY($2::INT[])`,
        [id_camara, ids]
    )).rows.map((r) => Number(r.id_produccion));

// ----------------------------------------------------------------------------
// Armar
// ----------------------------------------------------------------------------
const ahoraLocal = async (ejecutor) =>
    (await ejecutor.query(`SELECT (now() AT TIME ZONE $1)::timestamp AS ahora`, [zona()])).rows[0].ahora;

const existeCodigo = async (ejecutor, codigo) =>
    (await ejecutor.query(`SELECT 1 FROM bloques_fruta WHERE UPPER(codigo_bloque) = UPPER($1)`, [codigo])).rowCount > 0;

// Código automático: B + AAMMDD + consecutivo del día
const siguienteCodigo = async (ejecutor) => {
    const r = await ejecutor.query(
        `
        SELECT 'B' || to_char((now() AT TIME ZONE $1)::date, 'YYMMDD') AS prefijo,
               COUNT(*) AS usados
        FROM bloques_fruta
        WHERE codigo_bloque LIKE 'B' || to_char((now() AT TIME ZONE $1)::date, 'YYMMDD') || '-%'
        `,
        [zona()]
    );
    const { prefijo, usados } = r.rows[0];
    for (let n = Number(usados) + 1; n < Number(usados) + 50; n++) {
        const codigo = `${prefijo}-${String(n).padStart(2, "0")}`;
        if (!(await existeCodigo(ejecutor, codigo))) return codigo;
    }
    return `${prefijo}-${Date.now() % 10000}`;
};

const crearBloque = async (ejecutor, { codigo_bloque, id_camara, posiciones, fecha_hora_armado }) =>
    (await ejecutor.query(
        `INSERT INTO bloques_fruta (codigo_bloque, fecha_hora_armado, estado, id_camara, posiciones)
         VALUES ($1, $2, 1, $3, $4)
         RETURNING id_bloque, codigo_bloque`,
        [codigo_bloque, fecha_hora_armado, id_camara, posiciones]
    )).rows[0];

const getBloque = async (ejecutor, id_bloque, bloquear = false) =>
    (await ejecutor.query(
        `SELECT * FROM bloques_fruta WHERE id_bloque = $1 ${bloquear ? "FOR UPDATE" : ""}`,
        [id_bloque]
    )).rows[0];

// Cualquier cámara: una posición trasladada sigue ocupada
const posicionOcupada = async (ejecutor, id_bloque, posicion) =>
    (await ejecutor.query(
        `SELECT 1 FROM bloques_tarimas WHERE id_bloque = $1 AND posicion = $2 AND estado = 1`,
        [id_bloque, posicion]
    )).rowCount > 0;

const crearTarima = async (ejecutor, { id_bloque, posicion, id_camara, fecha_hora_ingreso, id_usuario, lotes }) => {
    const t = (await ejecutor.query(
        `INSERT INTO bloques_tarimas (id_bloque, posicion, id_camara, fecha_hora_ingreso, id_usuario)
         VALUES ($1, $2, $3, $4, $5) RETURNING id_tarima`,
        [id_bloque, posicion, id_camara, fecha_hora_ingreso, id_usuario]
    )).rows[0];
    for (const l of lotes) {
        await ejecutor.query(
            `INSERT INTO bloques_tarimas_detalle (id_tarima, id_produccion, cantidad_cajas) VALUES ($1, $2, $3)`,
            [t.id_tarima, l.id_produccion, l.cantidad_cajas]
        );
    }
    return t.id_tarima;
};

const retirarTarima = async (ejecutor, id_tarima) => {
    await ejecutor.query(
        `UPDATE bloques_tarimas SET estado = 0, fecha_hora_retiro = (now() AT TIME ZONE $2)::timestamp
         WHERE id_tarima = $1`,
        [id_tarima, zona()]
    );
};

// ----------------------------------------------------------------------------
// Pulpeo con evidencia (una transacción)
// ----------------------------------------------------------------------------
const evidenciaPorItem = async (ejecutor, item_id) =>
    (await ejecutor.query(
        `SELECT id_pulpeo FROM pulpeos_evidencia WHERE sharepoint_item_id = $1 LIMIT 1`,
        [item_id]
    )).rows[0];

const siguienteNumero = async (ejecutor, id_tarima) =>
    Number((await ejecutor.query(
        `SELECT COALESCE(MAX(numero_pulpeo), 0) + 1 AS n FROM pulpeos WHERE id_tarima = $1`,
        [id_tarima]
    )).rows[0].n);

const crearPulpeo = async (ejecutor, d) =>
    (await ejecutor.query(
        `INSERT INTO pulpeos (
            id_bloque, id_tarima, id_camara, fecha_hora, numero_pulpeo,
            temperatura_objetivo, temperatura_promedio, id_usuario, observaciones, estado
         ) VALUES ($1, $2, $3, COALESCE($4::timestamp, (now() AT TIME ZONE $9)::timestamp), $5,
                   NULL, $6, $7, $8, 1)
         RETURNING id_pulpeo, fecha_hora, numero_pulpeo`,
        [d.id_bloque, d.id_tarima, d.id_camara, d.fecha_hora, d.numero_pulpeo,
         d.temperatura, d.id_usuario, d.observaciones, zona()]
    )).rows[0];

// Desglose por lote: traza la lectura a cada lote de la tarima
const crearDetallePulpeo = async (ejecutor, id_pulpeo, fecha_hora, temperatura, lotes) => {
    for (const l of lotes) {
        await ejecutor.query(
            `INSERT INTO pulpeos_detalle (id_pulpeo, id_produccion, cantidad_tarimas, temperatura, fecha_hora)
             VALUES ($1, $2, 1, $3, $4)`,
            [id_pulpeo, l.id_produccion, temperatura, fecha_hora]
        );
    }
};

const crearEvidencia = async (ejecutor, d) =>
    (await ejecutor.query(
        `INSERT INTO pulpeos_evidencia (
            id_pulpeo, tipo_archivo, nombre_archivo, nombre_original, mime_type,
            tamano_bytes, sharepoint_drive_id, sharepoint_item_id, web_url,
            descripcion, id_usuario
         ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id_evidencia`,
        [d.id_pulpeo, d.nombre_archivo, d.nombre_original, d.mime_type, d.tamano_bytes,
         d.sharepoint_drive_id, d.sharepoint_item_id, d.web_url, d.descripcion, d.id_usuario]
    )).rows[0];

// ----------------------------------------------------------------------------
// Historial de una tarima
// ----------------------------------------------------------------------------
const getHistorial = async (id_tarima) =>
    (await db.query(
        `
        SELECT p.id_pulpeo, p.numero_pulpeo, p.fecha_hora, p.temperatura_promedio,
               p.observaciones, c.nombre_camara,
               e.nombre AS nombre_empleado, e.apellidos AS apellidos_empleado, u.usuario,
               COALESCE((SELECT json_agg(ev.id_evidencia ORDER BY ev.id_evidencia)
                         FROM pulpeos_evidencia ev WHERE ev.id_pulpeo = p.id_pulpeo), '[]'::json) AS evidencias
        FROM pulpeos p
        LEFT JOIN camaras c   ON c.id_camara   = p.id_camara
        LEFT JOIN usuarios u  ON u.id_usuario  = p.id_usuario
        LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
        WHERE p.id_tarima = $1 AND p.estado = 1
        ORDER BY p.fecha_hora DESC, p.id_pulpeo DESC
        `,
        [id_tarima]
    )).rows;

const tarimasModel = {
    getCamara,
    getTarimas,
    getTarimasFuera,
    getTarima,
    getLotesDeTarima,
    getLotesCamara,
    lotesEnCamara,
    ahoraLocal,
    siguienteCodigo,
    existeCodigo,
    crearBloque,
    getBloque,
    posicionOcupada,
    crearTarima,
    retirarTarima,
    evidenciaPorItem,
    siguienteNumero,
    crearPulpeo,
    crearDetallePulpeo,
    crearEvidencia,
    getHistorial
};

export default tarimasModel;
