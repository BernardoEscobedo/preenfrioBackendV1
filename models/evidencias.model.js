import { db } from "../database/connection.database.js";

// ============================================================================
// EVIDENCIAS (referencias a archivos en SharePoint)
// ============================================================================
// La BD no guarda archivos ni rutas en disco: guarda el par
// (sharepoint_drive_id, sharepoint_item_id) que identifica el archivo en la
// biblioteca de SharePoint. Todo lo demás (tamaño, tipo, quién, cuándo) es
// para listar sin tener que consultar a SharePoint.
//
// Dos tablas, misma forma:
//   despachos_evidencia   ligada al despacho
//   pulpeos_evidencia     ligada al pulpeo (el desglose por lote es opcional)
// ============================================================================

const TABLAS = {
    despachos: {
        tabla: "despachos_evidencia",
        llave: "id_despacho"
    },
    pulpeos: {
        tabla: "pulpeos_evidencia",
        llave: "id_pulpeo"
    }
};

// ----------------------------------------------------------------------------
// Documentos padre
// ----------------------------------------------------------------------------

// Lo mínimo del despacho para validar y armar la carpeta en SharePoint.
const getDespacho = async (id_despacho) => {
    const result = await db.query(
        `
        SELECT id_despacho, folio_despacho, fecha_despacho, estado
        FROM despachos WHERE id_despacho = $1
        `,
        [id_despacho]
    );
    return result.rows[0];
};

// Cámaras de las líneas del despacho, para validar el alcance.
const getCamarasDespacho = async (id_despacho) => {
    const result = await db.query(
        `
        SELECT DISTINCT id_camara_origen
        FROM despachos_detalle
        WHERE id_despacho = $1 AND id_camara_origen IS NOT NULL
        `,
        [id_despacho]
    );
    return result.rows.map((r) => Number(r.id_camara_origen));
};

// Lo mínimo del pulpeo, con su bloque.
const getPulpeo = async (id_pulpeo) => {
    const result = await db.query(
        `
        SELECT p.id_pulpeo, p.id_bloque, p.numero_pulpeo, p.fecha_hora,
               p.estado, b.codigo_bloque
        FROM pulpeos p
        JOIN bloques_fruta b ON b.id_bloque = p.id_bloque
        WHERE p.id_pulpeo = $1
        `,
        [id_pulpeo]
    );
    return result.rows[0];
};

// Verifica que el desglose pertenezca a ese pulpeo.
const detallePerteneceAPulpeo = async (id_pulpeo_detalle, id_pulpeo) => {
    const result = await db.query(
        `
        SELECT 1 FROM pulpeos_detalle
        WHERE id_pulpeo_detalle = $1 AND id_pulpeo = $2
        `,
        [id_pulpeo_detalle, id_pulpeo]
    );
    return result.rowCount > 0;
};

// ----------------------------------------------------------------------------
// Conteos para los límites por documento
// ----------------------------------------------------------------------------
const contar = async (origen, id_padre) => {
    const { tabla, llave } = TABLAS[origen];

    const result = await db.query(
        `
        SELECT
            COUNT(*) FILTER (WHERE tipo_archivo = 1)::INT AS fotos,
            COUNT(*) FILTER (WHERE tipo_archivo = 2)::INT AS videos
        FROM ${tabla}
        WHERE ${llave} = $1
        `,
        [id_padre]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Alta
// ----------------------------------------------------------------------------
const crear = async (origen, datos) => {
    const { tabla, llave } = TABLAS[origen];

    const columnas = [
        llave,
        "tipo_archivo",
        "nombre_archivo",
        "nombre_original",
        "mime_type",
        "tamano_bytes",
        "sharepoint_drive_id",
        "sharepoint_item_id",
        "web_url",
        "descripcion",
        "id_usuario"
    ];

    const valores = [
        datos.id_padre,
        datos.tipo_archivo,
        datos.nombre_archivo,
        datos.nombre_original,
        datos.mime_type,
        datos.tamano_bytes,
        datos.sharepoint_drive_id,
        datos.sharepoint_item_id,
        datos.web_url,
        datos.descripcion,
        datos.id_usuario
    ];

    // El desglose solo existe en pulpeos
    if (origen === "pulpeos") {
        columnas.push("id_pulpeo_detalle");
        valores.push(datos.id_pulpeo_detalle ?? null);
    }

    const marcadores = valores.map((_, i) => `$${i + 1}`).join(", ");

    const result = await db.query(
        `
        INSERT INTO ${tabla} (${columnas.join(", ")})
        VALUES (${marcadores})
        RETURNING *
        `,
        valores
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// Consultas
// ----------------------------------------------------------------------------
const listar = async (origen, id_padre) => {
    const { tabla, llave } = TABLAS[origen];

    const result = await db.query(
        `
        SELECT
            ev.*,
            CASE ev.tipo_archivo WHEN 1 THEN 'Foto' WHEN 2 THEN 'Video' END AS tipo_texto,
            u.usuario,
            e.nombre    AS nombre_empleado,
            e.apellidos AS apellidos_empleado
        FROM ${tabla} ev
        LEFT JOIN usuarios  u ON u.id_usuario  = ev.id_usuario
        LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
        WHERE ev.${llave} = $1
        ORDER BY ev.fecha_hora, ev.id_evidencia
        `,
        [id_padre]
    );
    return result.rows;
};

const getById = async (origen, id_evidencia) => {
    const { tabla } = TABLAS[origen];

    const result = await db.query(
        `SELECT * FROM ${tabla} WHERE id_evidencia = $1`,
        [id_evidencia]
    );
    return result.rows[0];
};

const eliminar = async (origen, id_evidencia) => {
    const { tabla } = TABLAS[origen];

    const result = await db.query(
        `DELETE FROM ${tabla} WHERE id_evidencia = $1 RETURNING *`,
        [id_evidencia]
    );
    return result.rows[0];
};

const evidenciasModel = {
    getDespacho,
    getCamarasDespacho,
    getPulpeo,
    detallePerteneceAPulpeo,
    contar,
    crear,
    listar,
    getById,
    eliminar
};

export default evidenciasModel;
