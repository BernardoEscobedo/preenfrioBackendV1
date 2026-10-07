import { db } from "../database/connection.database.js";

// ============================================================================
// PRODUCCIÓN · IMPORTACIÓN DESDE EXCEL Y ASIGNACIÓN DE PREENFRÍO
// ============================================================================
// Las funciones que escriben reciben el EJECUTOR (db o un cliente de
// transacción): la confirmación evalúa, cuenta duplicados e inserta dentro
// de la misma transacción.
//
// La producción se importa con id_camara NULL. El coordinador la asigna
// después; lo que no se asigna no pasa por preenfrío.
// ============================================================================

// ----------------------------------------------------------------------------
// Catálogos para evaluar filas
// ----------------------------------------------------------------------------
// Se cargan completos una vez por petición: así evaluar 2,000 renglones no
// dispara 2,000 consultas.
const getCatalogos = async (ejecutor = db) => {
    const [productores, fincas, skus, cedis, equivalencias] = await Promise.all([
        ejecutor.query(
            `SELECT id_productor, UPPER(TRIM(codigo_productor)) AS codigo_productor, nombre, estado
             FROM productores`
        ),
        ejecutor.query(
            `SELECT id_finca, UPPER(TRIM(codigo_finca)) AS codigo_finca, nombre, zona, id_productor
             FROM fincas
             WHERE estado = 1`
        ),
        ejecutor.query(
            `SELECT id_sku, UPPER(TRIM(codigo_sku)) AS codigo_sku, calidad, turno, estado
             FROM sku_pt`
        ),
        ejecutor.query(`SELECT id_cc, cliente, cedis, acronimo, estado FROM cedis_cliente`),
        ejecutor.query(`SELECT clave, id_cc FROM cedis_equivalencias`)
    ]);

    const fincasPorClave = new Map();
    for (const f of fincas.rows) {
        const k = `${f.id_productor}|${f.codigo_finca}`;
        fincasPorClave.set(k, [...(fincasPorClave.get(k) ?? []), f]);
    }

    // Si un SKU estuviera repetido, gana el activo
    const skusPorCodigo = new Map();
    for (const s of skus.rows) {
        const actual = skusPorCodigo.get(s.codigo_sku);
        if (!actual || (Number(actual.estado) !== 1 && Number(s.estado) === 1)) skusPorCodigo.set(s.codigo_sku, s);
    }

    return {
        productores: new Map(productores.rows.map((p) => [p.codigo_productor, p])),
        fincas: fincasPorClave,
        skus: skusPorCodigo,
        cedis: new Map(cedis.rows.map((c) => [Number(c.id_cc), c])),
        equivalencias: new Map(equivalencias.rows.map((e) => [e.clave, Number(e.id_cc)]))
    };
};

// Listas compactas para los combos del modal de corrección
const getListasCorreccion = async () => {
    const [fincas, skus, cedis] = await Promise.all([
        db.query(
            `SELECT f.id_finca, TRIM(f.codigo_finca) AS codigo_finca, f.nombre, f.zona,
                    p.id_productor, TRIM(p.codigo_productor) AS codigo_productor,
                    p.nombre AS nombre_productor
             FROM fincas f
             JOIN productores p ON p.id_productor = f.id_productor
             WHERE f.estado = 1 AND p.estado = 1
             ORDER BY p.codigo_productor, f.codigo_finca`
        ),
        db.query(
            `SELECT id_sku, TRIM(codigo_sku) AS codigo_sku, calidad, turno
             FROM sku_pt WHERE estado = 1 ORDER BY codigo_sku`
        ),
        db.query(
            `SELECT id_cc, cliente, cedis, acronimo
             FROM cedis_cliente WHERE estado = 1 ORDER BY cliente, cedis`
        )
    ]);
    return { fincas: fincas.rows, skus: skus.rows, cedis: cedis.rows };
};

// Cuántas filas ya existen con cada huella. Incluye canceladas: una línea
// cancelada a propósito no debe regresar al volver a subir el archivo.
const contarHuellas = async (ejecutor, huellas) => {
    if (huellas.length === 0) return new Map();
    const result = await ejecutor.query(
        `SELECT huella_importacion AS huella, COUNT(*)::INT AS total
         FROM produccion
         WHERE huella_importacion = ANY($1::VARCHAR[])
         GROUP BY huella_importacion`,
        [huellas]
    );
    return new Map(result.rows.map((r) => [r.huella, r.total]));
};

const crearImportacion = async (ejecutor, datos) => {
    const result = await ejecutor.query(
        `INSERT INTO produccion_importaciones (
            nombre_archivo, filas_archivo, filas_insertadas,
            filas_omitidas, filas_con_error, id_usuario
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id_importacion`,
        [
            datos.nombre_archivo,
            datos.filas_archivo,
            datos.filas_insertadas,
            datos.filas_omitidas,
            datos.filas_con_error,
            datos.id_usuario
        ]
    );
    return result.rows[0].id_importacion;
};

// Guarda (o corrige) la equivalencia de cada destino elegido a mano
const guardarEquivalencias = async (ejecutor, lista, id_usuario) => {
    for (const e of lista) {
        await ejecutor.query(
            `INSERT INTO cedis_equivalencias (cedis_excel, cliente_excel, id_cc, id_usuario)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (clave) DO UPDATE
                SET id_cc = EXCLUDED.id_cc, id_usuario = EXCLUDED.id_usuario`,
            [e.cedis_excel.slice(0, 60), e.cliente_excel.slice(0, 60), e.id_cc, id_usuario]
        );
    }
};

// Inserta todas las filas en una sola sentencia. id_camara queda NULL.
const insertarFilas = async (ejecutor, filas, id_importacion) => {
    const result = await ejecutor.query(
        `INSERT INTO produccion (
            semana, region, id_finca, id_productor, fecha_empaque, transito,
            fecha_entrega, id_cc, id_sku, cajas_procesadas, estiba_pallets,
            comentarios, codigo_lote, huella_importacion, id_importacion
         )
         SELECT x.semana, x.region, x.id_finca, x.id_productor, x.fecha_empaque,
                x.transito, x.fecha_entrega, x.id_cc, x.id_sku, x.cajas,
                x.tarimas, x.comentarios, x.codigo_lote, x.huella, $2
         FROM jsonb_to_recordset($1::jsonb) AS x(
            semana INT, region VARCHAR, id_finca INT, id_productor INT,
            fecha_empaque DATE, transito INT, fecha_entrega DATE, id_cc INT,
            id_sku INT, cajas INT, tarimas INT, comentarios VARCHAR,
            codigo_lote VARCHAR, huella VARCHAR
         )
         RETURNING id_produccion`,
        [JSON.stringify(filas), id_importacion]
    );
    return result.rows.map((r) => r.id_produccion);
};

// ----------------------------------------------------------------------------
// Producción sin preenfrío asignado
// ----------------------------------------------------------------------------
// Filtros opcionales: semana y fecha de empaque (el coordinador trabaja
// por día). Se excluye lo que ya tiene recepciones: esa fruta ya llegó.
const getSinCamara = async ({ semana = null, fecha_empaque = null } = {}) => {
    const result = await db.query(
        `SELECT p.id_produccion, p.semana, p.codigo_lote, p.fecha_empaque,
                p.fecha_entrega, p.transito, p.cajas_procesadas, p.estiba_pallets,
                p.comentarios, p.id_importacion,
                f.codigo_finca, f.nombre AS nombre_finca, f.zona,
                pr.codigo_productor, pr.nombre AS nombre_productor,
                s.codigo_sku, s.calidad AS calidad_sku,
                cc.cliente, cc.cedis, cc.acronimo AS acronimo_cc
         FROM produccion p
         JOIN fincas        f  ON f.id_finca      = p.id_finca
         JOIN productores   pr ON pr.id_productor = p.id_productor
         JOIN sku_pt        s  ON s.id_sku        = p.id_sku
         JOIN cedis_cliente cc ON cc.id_cc        = p.id_cc
         WHERE p.id_camara IS NULL AND p.estado <> 0
           AND ($1::INT  IS NULL OR p.semana = $1)
           AND ($2::DATE IS NULL OR p.fecha_empaque = $2)
           AND NOT EXISTS (
               SELECT 1 FROM recepciones r
               WHERE r.id_produccion = p.id_produccion AND r.estado = 1
           )
         ORDER BY p.fecha_empaque, p.fecha_entrega NULLS LAST, p.id_produccion`,
        [semana, fecha_empaque]
    );
    return result.rows;
};

// Cámaras de preenfrío operativas con su ocupación actual
const getCamarasPreenfrio = async () => {
    const result = await db.query(
        `SELECT id_camara, nombre_camara, ubicacion, capacidad_max_tarimas,
                tarimas_ocupadas, tarimas_en_espera, en_mantenimiento,
                tarimas_disponibles_operativas
         FROM vw_disponibilidad_camaras
         WHERE tipo_camara = 1 AND estado = 1
         ORDER BY nombre_camara`
    );
    return result.rows;
};

const getCamaraById = async (ejecutor, id_camara) => {
    const result = await ejecutor.query(
        `SELECT id_camara, nombre_camara, tipo_camara, estado, capacidad_max_tarimas
         FROM camaras WHERE id_camara = $1`,
        [id_camara]
    );
    return result.rows[0];
};

// Filas a asignar, bloqueadas para que nadie las cambie a la vez
const getParaAsignar = async (ejecutor, ids) => {
    const result = await ejecutor.query(
        `SELECT p.id_produccion, p.codigo_lote, p.estado, p.id_camara, p.estiba_pallets,
                (SELECT COUNT(*) FROM recepciones r
                  WHERE r.id_produccion = p.id_produccion AND r.estado = 1)::INT AS recepciones
         FROM produccion p
         WHERE p.id_produccion = ANY($1::INT[])
         FOR UPDATE`,
        [ids]
    );
    return result.rows;
};

const asignarCamara = async (ejecutor, ids, id_camara) => {
    const result = await ejecutor.query(
        `UPDATE produccion SET id_camara = $2
         WHERE id_produccion = ANY($1::INT[])`,
        [ids, id_camara]
    );
    return result.rowCount;
};

const produccionImportacionModel = {
    getCatalogos,
    getListasCorreccion,
    contarHuellas,
    crearImportacion,
    guardarEquivalencias,
    insertarFilas,
    getSinCamara,
    getCamarasPreenfrio,
    getCamaraById,
    getParaAsignar,
    asignarCamara
};

export default produccionImportacionModel;
