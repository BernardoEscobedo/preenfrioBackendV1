import { db } from "../database/connection.database.js";

// ============================================================================
// CAJAS TEMPORALES (resguardo en caja de línea fletera)
// ============================================================================
// Una caja temporal es una cámara tipo 3. La lógica de inventario vive en la
// BD (fn_abrir_camara_temporal, fn_reubicar_camara y los triggers de
// siempre); aquí solo se consulta y se llama a esas funciones.
// ============================================================================

export const zona = () => process.env.ZONA_HORARIA || "America/Mexico_City";

// Cajas abiertas con lo que tienen dentro y en cola
const getAbiertas = async (camaras = null) =>
    (await db.query(
        `
        SELECT
            c.id_camara, c.nombre_camara, c.capacidad_max_tarimas,
            c.id_camara_origen, co.nombre_camara AS camara_origen,
            c.fecha_hora_apertura,
            lf.razon_social, cr.placas AS placas_caja, cr.numero_economico,
            COALESCE(inv.tarimas, 0)::INT AS tarimas_dentro,
            COALESCE(inv.cajas, 0)::INT   AS cajas_dentro,
            COALESCE(inv.procesos, 0)::INT AS procesos,
            COALESCE(cola.tarimas, 0)::INT AS tarimas_en_cola,
            public.fn_tarimas_disponibles(c.id_camara) AS espacio
        FROM camaras c
        LEFT JOIN camaras co            ON co.id_camara = c.id_camara_origen
        LEFT JOIN lineas_fleteras lf    ON lf.id_linea_fletera = c.id_linea_fletera
        LEFT JOIN cajas_refrigeradas cr ON cr.id_caja_refrigerada = c.id_caja_refrigerada
        LEFT JOIN LATERAL (
            SELECT SUM(cantidad_tarimas) AS tarimas, SUM(cantidad_cajas) AS cajas, COUNT(*) AS procesos
            FROM ocupaciones_camaras
            WHERE id_camara = c.id_camara AND tipo_ocupacion = 1 AND estado = 1
              AND (cantidad_tarimas > 0 OR cantidad_cajas > 0)
        ) inv ON TRUE
        LEFT JOIN LATERAL (
            SELECT SUM(cantidad_tarimas) AS tarimas
            FROM ocupaciones_camaras
            WHERE id_camara = c.id_camara AND tipo_ocupacion = 3 AND estado = 1
        ) cola ON TRUE
        WHERE c.es_temporal AND c.estado = 1
          AND ($1::INT[] IS NULL OR c.id_camara = ANY($1) OR c.id_camara_origen = ANY($1))
        ORDER BY c.fecha_hora_apertura DESC
        `,
        [camaras]
    )).rows;

// Lotes dentro de una caja
const getFruta = async (id_camara) =>
    (await db.query(
        `SELECT id_ocupacion, codigo_lote, codigo_sku, calidad_sku, codigo_productor,
                codigo_finca, nombre_finca, acronimo_cc, fecha_empaque, fecha_entrega,
                tarimas_disponibles, cajas_disponibles, nivel_criticidad, criticidad_texto
         FROM vw_inventario_disponible
         WHERE id_camara = $1
         ORDER BY nivel_criticidad, fecha_empaque NULLS LAST`,
        [id_camara]
    )).rows;

// Cámaras operando (destino de reingreso o de reubicación)
const getDestinos = async (excluir, camaras = null) =>
    (await db.query(
        `
        SELECT c.id_camara, c.nombre_camara, c.tipo_camara, c.capacidad_max_tarimas,
               public.fn_tarimas_disponibles(c.id_camara) AS espacio
        FROM camaras c
        WHERE c.estado = 1 AND c.tipo_camara IN (1, 2, 3)
          AND c.id_camara <> $1
          AND NOT public.fn_camara_bloqueada(c.id_camara)
          AND ($2::INT[] IS NULL OR c.id_camara = ANY($2))
        ORDER BY c.tipo_camara, c.nombre_camara
        `,
        [excluir, camaras]
    )).rows;

// Para recibir: ¿la cámara planeada está fuera de servicio? ¿qué cajas hay?
const getDestinosRecepcion = async (id_camara, camaras = null) =>
    (await db.query(
        `
        SELECT c.id_camara, c.nombre_camara, c.tipo_camara, c.es_temporal,
               c.id_camara_origen,
               public.fn_camara_bloqueada(c.id_camara) AS bloqueada,
               public.fn_tarimas_disponibles(c.id_camara) AS espacio
        FROM camaras c
        WHERE c.estado = 1
          AND (c.id_camara = $1 OR (c.es_temporal AND c.id_camara_origen = $1)
               OR (c.tipo_camara = 1 AND NOT public.fn_camara_bloqueada(c.id_camara)))
          AND ($2::INT[] IS NULL OR c.id_camara = ANY($2))
        ORDER BY (c.id_camara = $1) DESC, c.es_temporal DESC, c.nombre_camara
        `,
        [id_camara, camaras]
    )).rows;

const getCamara = async (ejecutor, id) =>
    (await ejecutor.query(
        `SELECT id_camara, nombre_camara, tipo_camara, estado, es_temporal, id_camara_origen,
                public.fn_camara_bloqueada(id_camara) AS bloqueada
         FROM camaras WHERE id_camara = $1`,
        [id]
    )).rows[0];

const abrir = async (ejecutor, { id_camara_origen, id_linea_fletera, id_caja_refrigerada, capacidad }) =>
    Number((await ejecutor.query(
        `SELECT public.fn_abrir_camara_temporal($1, $2, $3, $4, $5) AS id`,
        [id_camara_origen, id_linea_fletera, id_caja_refrigerada, capacidad, zona()]
    )).rows[0].id);

const reubicar = async (ejecutor, origen, destino, id_usuario) =>
    (await ejecutor.query(
        `SELECT public.fn_reubicar_camara($1, $2, $3, $4) AS r`,
        [origen, destino, id_usuario, zona()]
    )).rows[0].r;

const estaVacia = async (ejecutor, id) =>
    (await ejecutor.query(
        `SELECT NOT EXISTS (
             SELECT 1 FROM ocupaciones_camaras
             WHERE id_camara = $1 AND estado = 1 AND tipo_ocupacion IN (1, 3)
               AND (cantidad_tarimas > 0 OR cantidad_cajas > 0)
         ) AS vacia`,
        [id]
    )).rows[0].vacia;

const cerrar = async (ejecutor, id) =>
    (await ejecutor.query(
        `UPDATE camaras SET estado = 0, fecha_hora_cierre = (now() AT TIME ZONE $2)
         WHERE id_camara = $1 AND es_temporal AND estado = 1
         RETURNING nombre_camara`,
        [id, zona()]
    )).rows[0];

const temporalesModel = {
    getAbiertas,
    getFruta,
    getDestinos,
    getDestinosRecepcion,
    getCamara,
    abrir,
    reubicar,
    estaVacia,
    cerrar
};

export default temporalesModel;
