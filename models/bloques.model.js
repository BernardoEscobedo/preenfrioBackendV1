import { db } from "../database/connection.database.js";
import { SQL_CAMARAS_REALES } from "../utils/camarasReales.sql.js";

// ============================================================================
// BLOQUES FÍSICOS DE FRUTA
// ============================================================================
// Un bloque es una AGRUPACIÓN FÍSICA de tarimas dentro de la cámara: el
// montón que el montacarguista arma junto y que se pulpea como unidad.
//
// POR QUÉ EXISTE ESTA TABLA SI YA ESTÁ ocupaciones_camaras
//   La ocupación dice CUÁNTO hay en la cámara; el bloque dice CÓMO está
//   acomodado. Son cosas distintas:
//
//     · Un bloque puede mezclar varios procesos (fruta de distintas fincas
//       apilada junta porque llegó el mismo día).
//     · El pulpeo se hace POR BLOQUE, no por proceso: el termómetro entra
//       al montón físico.
//
//   Por eso bloques_produccion_detalle es N:M contra producción.
//
// ⚠️ LOS TOTALES NO SE CAPTURAN
//   bloques_fruta.cantidad_tarimas y cantidad_cajas los mantiene
//   trg_recalcular_totales_bloque sumando el detalle. Este modelo NUNCA los
//   escribe: si lo hiciera, el número podría dejar de cuadrar con sus
//   propias líneas.
//
// ALCANCE POR CÁMARA
//   bloques_fruta no tiene id_camara: el bloque se define por su contenido.
//
//   CORRECCIÓN DE LA AUDITORÍA · SE USA LA CÁMARA REAL, NO LA PLANEADA
//   Antes el alcance salía de produccion.id_camara, que es el plan. Si en
//   el andén desviaban el camión a otra cámara, el supervisor de donde
//   realmente estaba la fruta no podía ver su bloque. Ahora se usa
//   SQL_CAMARAS_REALES: donde se recibió, a donde se trasladó, y la
//   planeada solo mientras no haya llegado nada.
// ============================================================================

const SELECT_BLOQUE = `
    SELECT
        b.*,
        CASE b.estado
            WHEN 1 THEN 'Armado'
            WHEN 0 THEN 'Desarmado'
            ELSE 'Otro'
        END AS estado_texto,
        -- Cuántos procesos distintos lo componen. Si es más de uno, el
        -- bloque mezcla fruta y el pulpeo necesita desglose por proceso.
        (SELECT COUNT(*) FROM bloques_produccion_detalle d
          WHERE d.id_bloque = b.id_bloque) AS procesos,
        (SELECT COUNT(*) FROM pulpeos p
          WHERE p.id_bloque = b.id_bloque AND p.estado = 1) AS pulpeos_registrados,
        -- Último pulpeo válido: es el dato que dice si la fruta ya llegó a
        -- su temperatura objetivo y puede salir del preenfrío.
        (SELECT p.temperatura_promedio FROM pulpeos p
          WHERE p.id_bloque = b.id_bloque AND p.estado = 1
          ORDER BY p.fecha_hora DESC LIMIT 1) AS ultima_temperatura,
        (SELECT p.fecha_hora FROM pulpeos p
          WHERE p.id_bloque = b.id_bloque AND p.estado = 1
          ORDER BY p.fecha_hora DESC LIMIT 1) AS ultimo_pulpeo,
        -- Horas desde que se armó: junto con la temperatura, define si el
        -- ciclo de preenfrío terminó.
        ROUND(
            EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - b.fecha_hora_armado)) / 3600,
            1
        ) AS horas_desde_armado
    FROM bloques_fruta b
`;

// ----------------------------------------------------------------------------
// Listado
// ----------------------------------------------------------------------------
// El alcance filtra por las cámaras donde REALMENTE está la fruta que
// compone el bloque. Un bloque sin detalle todavía no tiene planta
// asignada, así que pasa siempre: es el borrador que se está armando.
const getBloques = async (
    { estado = null, fecha_desde = null, fecha_hasta = null, buscar = null } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        ${SELECT_BLOQUE}
        WHERE ($1::INT IS NULL OR b.estado = $1)
          AND ($2::DATE IS NULL OR b.fecha_hora_armado::DATE >= $2)
          AND ($3::DATE IS NULL OR b.fecha_hora_armado::DATE <= $3)
          AND ($4::TEXT IS NULL OR b.codigo_bloque ILIKE '%' || $4 || '%')
          AND (
              $5::INT[] IS NULL
              OR EXISTS (
                  SELECT 1
                  FROM bloques_produccion_detalle d
                  JOIN produccion p ON p.id_produccion = d.id_produccion
                  CROSS JOIN LATERAL (${SQL_CAMARAS_REALES("p")}) AS cr(id_camara)
                  WHERE d.id_bloque = b.id_bloque
                    AND cr.id_camara = ANY($5)
              )
              OR NOT EXISTS (
                  SELECT 1 FROM bloques_produccion_detalle d
                  WHERE d.id_bloque = b.id_bloque
              )
          )
        ORDER BY b.fecha_hora_armado DESC, b.id_bloque DESC
        LIMIT 500
        `,
        [estado, fecha_desde, fecha_hasta, buscar, camaras]
    );
    return result.rows;
};

const getBloqueById = async (id_bloque) => {
    const result = await db.query(
        `${SELECT_BLOQUE} WHERE b.id_bloque = $1`,
        [id_bloque]
    );
    return result.rows[0];
};

// Duplicado de código. Se valida antes de insertar para dar un mensaje
// claro en vez de dejar que reviente el UNIQUE de la tabla.
const existeCodigo = async (codigo_bloque, id_excluir = null) => {
    const result = await db.query(
        `
        SELECT id_bloque, codigo_bloque, estado FROM bloques_fruta
        WHERE UPPER(codigo_bloque) = UPPER($1)
          AND ($2::INT IS NULL OR id_bloque <> $2)
        `,
        [codigo_bloque, id_excluir]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Composición del bloque
// ----------------------------------------------------------------------------
// Qué procesos lo forman y con cuántas tarimas cada uno. Es lo que permite
// que un pulpeo sobre el montón se desglose por lote.
//
// Trae la cámara planeada (nombre_camara) y las cámaras reales
// (camaras_reales): si no coinciden, el camión se desvió en el andén.
const getDetalle = async (id_bloque) => {
    const result = await db.query(
        `
        SELECT
            d.id_detalle,
            d.id_bloque,
            d.id_produccion,
            d.cantidad_tarimas,
            d.cantidad_cajas,
            p.codigo_lote,
            p.semana,
            p.fecha_empaque,
            (CURRENT_DATE - p.fecha_empaque) AS dias_desde_empaque,
            p.id_camara,
            cam.nombre_camara,
            ARRAY(
                SELECT c2.nombre_camara
                FROM camaras c2
                WHERE c2.id_camara IN (
                    SELECT cr.id_camara
                    FROM (${SQL_CAMARAS_REALES("p")}) AS cr(id_camara)
                )
                ORDER BY c2.nombre_camara
            ) AS camaras_reales,
            f.codigo_finca,
            f.nombre  AS nombre_finca,
            pr.nombre AS nombre_productor,
            s.codigo_sku,
            s.calidad AS calidad_sku,
            cc.cliente,
            cc.cedis
        FROM bloques_produccion_detalle d
        JOIN produccion         p   ON p.id_produccion = d.id_produccion
        LEFT JOIN camaras       cam ON cam.id_camara   = p.id_camara
        LEFT JOIN fincas        f   ON f.id_finca      = p.id_finca
        LEFT JOIN productores   pr  ON pr.id_productor = p.id_productor
        LEFT JOIN sku_pt        s   ON s.id_sku        = p.id_sku
        LEFT JOIN cedis_cliente cc  ON cc.id_cc        = p.id_cc
        WHERE d.id_bloque = $1
        ORDER BY d.id_detalle
        `,
        [id_bloque]
    );
    return result.rows;
};

// Cámaras donde está la fruta de este bloque. La usan bloques.controller
// y pulpeos.controller para validar el alcance.
const getCamarasDelBloque = async (id_bloque) => {
    const result = await db.query(
        `
        SELECT DISTINCT cr.id_camara
        FROM bloques_produccion_detalle d
        JOIN produccion p ON p.id_produccion = d.id_produccion
        CROSS JOIN LATERAL (${SQL_CAMARAS_REALES("p")}) AS cr(id_camara)
        WHERE d.id_bloque = $1
        `,
        [id_bloque]
    );
    return result.rows.map((r) => Number(r.id_camara));
};

// Cámaras donde está la fruta de UNA producción. La usa el controller al
// agregar una línea, antes de que la producción forme parte del bloque.
const getCamarasDeProduccion = async (id_produccion) => {
    const result = await db.query(
        `
        SELECT DISTINCT cr.id_camara
        FROM produccion p
        CROSS JOIN LATERAL (${SQL_CAMARAS_REALES("p")}) AS cr(id_camara)
        WHERE p.id_produccion = $1
        `,
        [id_produccion]
    );
    return result.rows.map((r) => Number(r.id_camara));
};

// ----------------------------------------------------------------------------
// Alta
// ----------------------------------------------------------------------------
// Nace vacío y en estado 1 (armado). Los totales quedan en 0 hasta que el
// trigger los recalcule con la primera línea del detalle.
const createBloque = async ({
    codigo_bloque,
    fecha_hora_armado,
    temperatura_ingreso
}) => {
    const result = await db.query(
        `
        INSERT INTO bloques_fruta (
            codigo_bloque, fecha_hora_armado, temperatura_ingreso, estado
        )
        VALUES ($1, COALESCE($2, CURRENT_TIMESTAMP), $3, 1)
        RETURNING *
        `,
        [codigo_bloque, fecha_hora_armado, temperatura_ingreso]
    );
    return result.rows[0];
};

// NO toca cantidad_tarimas ni cantidad_cajas: los deriva el trigger.
const updateBloque = async (
    id_bloque,
    { codigo_bloque, fecha_hora_armado, temperatura_ingreso }
) => {
    const result = await db.query(
        `
        UPDATE bloques_fruta
        SET codigo_bloque = $2,
            fecha_hora_armado = COALESCE($3, fecha_hora_armado),
            temperatura_ingreso = $4
        WHERE id_bloque = $1
        RETURNING *
        `,
        [id_bloque, codigo_bloque, fecha_hora_armado, temperatura_ingreso]
    );
    return result.rows[0];
};

// Desarmar: el montón se deshizo. No se borra porque sus pulpeos son
// evidencia de la cadena de frío y tienen que seguir resolviendo a qué
// bloque pertenecían.
const desarmarBloque = async (id_bloque) => {
    const result = await db.query(
        `UPDATE bloques_fruta SET estado = 0 WHERE id_bloque = $1 RETURNING *`,
        [id_bloque]
    );
    return result.rows[0];
};

const rearmarBloque = async (id_bloque) => {
    const result = await db.query(
        `UPDATE bloques_fruta SET estado = 1 WHERE id_bloque = $1 RETURNING *`,
        [id_bloque]
    );
    return result.rows[0];
};

// Borrado físico. Solo para un alta mal capturada que nunca se usó: si
// tiene pulpeos o líneas de despacho, la FK lo impide.
const deleteBloque = async (id_bloque) => {
    const result = await db.query(
        `DELETE FROM bloques_fruta WHERE id_bloque = $1 RETURNING *`,
        [id_bloque]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Líneas del bloque
// ----------------------------------------------------------------------------
// ⚠️ Cada INSERT/UPDATE/DELETE aquí dispara trg_recalcular_totales_bloque,
// que recalcula los totales del encabezado desde cero. Por eso el modelo
// nunca los escribe a mano.
//
// La tabla tiene UNIQUE(id_bloque, id_produccion): un proceso aparece una
// sola vez por bloque. Si llegan más tarimas del mismo lote, se actualiza
// la línea en vez de agregar otra.
const agregarLinea = async ({
    id_bloque,
    id_produccion,
    cantidad_tarimas,
    cantidad_cajas
}) => {
    const result = await db.query(
        `
        INSERT INTO bloques_produccion_detalle (
            id_bloque, id_produccion, cantidad_tarimas, cantidad_cajas
        )
        VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [id_bloque, id_produccion, cantidad_tarimas, cantidad_cajas]
    );
    return result.rows[0];
};

const actualizarLinea = async (id_detalle, { cantidad_tarimas, cantidad_cajas }) => {
    const result = await db.query(
        `
        UPDATE bloques_produccion_detalle
        SET cantidad_tarimas = $2, cantidad_cajas = $3
        WHERE id_detalle = $1
        RETURNING *
        `,
        [id_detalle, cantidad_tarimas, cantidad_cajas]
    );
    return result.rows[0];
};

const quitarLinea = async (id_detalle) => {
    const result = await db.query(
        `DELETE FROM bloques_produccion_detalle WHERE id_detalle = $1 RETURNING *`,
        [id_detalle]
    );
    return result.rows[0];
};

// Una línea con las cámaras reales de su producción, para validar el
// alcance al editarla o quitarla.
const getLineaById = async (id_detalle) => {
    const result = await db.query(
        `
        SELECT
            d.*,
            p.codigo_lote,
            ARRAY(
                SELECT cr.id_camara
                FROM (${SQL_CAMARAS_REALES("p")}) AS cr(id_camara)
            ) AS camaras
        FROM bloques_produccion_detalle d
        JOIN produccion p ON p.id_produccion = d.id_produccion
        WHERE d.id_detalle = $1
        `,
        [id_detalle]
    );
    return result.rows[0];
};

// Si ese proceso ya está en el bloque, se devuelve la línea existente: el
// controller decide entre actualizar o rechazar, en vez de dejar que
// reviente el UNIQUE.
const getLineaPorProduccion = async (id_bloque, id_produccion) => {
    const result = await db.query(
        `
        SELECT * FROM bloques_produccion_detalle
        WHERE id_bloque = $1 AND id_produccion = $2
        `,
        [id_bloque, id_produccion]
    );
    return result.rows[0];
};

// Si el bloque ya salió en un despacho, no se puede modificar: el documento
// de salida referencia ese montón.
const getLineasDespachoLigadas = async (id_bloque) => {
    const result = await db.query(
        `
        SELECT dd.id_detalle, dd.id_despacho, d.folio_despacho, d.estado
        FROM despachos_detalle dd
        JOIN despachos d ON d.id_despacho = dd.id_despacho
        WHERE dd.id_bloque = $1
        `,
        [id_bloque]
    );
    return result.rows;
};

const bloquesModel = {
    getBloques,
    getBloqueById,
    existeCodigo,
    getDetalle,
    getCamarasDelBloque,
    getCamarasDeProduccion,
    createBloque,
    updateBloque,
    desarmarBloque,
    rearmarBloque,
    deleteBloque,
    agregarLinea,
    actualizarLinea,
    quitarLinea,
    getLineaById,
    getLineaPorProduccion,
    getLineasDespachoLigadas
};

export default bloquesModel;
