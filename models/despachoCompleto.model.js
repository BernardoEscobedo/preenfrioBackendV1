import { db } from "../database/connection.database.js";

// ============================================================================
// DESPACHO EN UN PASO · consultas del asistente
// ============================================================================
// Todas reciben el CLIENTE de la transacción: el despacho completo (altas
// rápidas, transporte, documento, picking, inspección y cierre) se guarda
// junto o no se guarda nada.
//
// Este modelo NUNCA escribe en ocupaciones_camaras: las líneas se insertan
// en despachos_detalle y la cadena de triggers de siempre descuenta.
//
// TRANSPORTES · COLUMNAS SEGÚN TU ESQUEMA
//   El servicio se crea solo con las columnas que existen en tu tabla
//   transportes. Las columnas heredadas (razon_social, nombre_operador,
//   placas_caja, inocuidad…) se llenan SOLO si todavía existen; si ya se
//   eliminaron, se omiten. Se consulta information_schema una vez y se
//   guarda en memoria.
// ============================================================================

const placaNormal = (t) => String(t ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ---- Catálogos ----
const getLinea = async (c, id) =>
    (await c.query(`SELECT id_linea_fletera, razon_social, estado FROM lineas_fleteras WHERE id_linea_fletera = $1`, [id])).rows[0];

const getCedis = async (c, id) =>
    (await c.query(`SELECT id_cc, cliente, cedis, acronimo, estado FROM cedis_cliente WHERE id_cc = $1`, [id])).rows[0];

const getOperador = async (c, id) =>
    (await c.query(`SELECT id_operador, id_linea_fletera, nombre, celular, estado FROM operadores WHERE id_operador = $1`, [id])).rows[0];

const getTracto = async (c, id) =>
    (await c.query(`SELECT id_tractocamion, id_linea_fletera, placas, numero_economico, estado FROM tractocamiones WHERE id_tractocamion = $1`, [id])).rows[0];

const getCaja = async (c, id) =>
    (await c.query(`SELECT id_caja_refrigerada, id_linea_fletera, placas, numero_economico, estado FROM cajas_refrigeradas WHERE id_caja_refrigerada = $1`, [id])).rows[0];

// ---- Duplicados (mismo criterio que los catálogos) ----
const operadorPorCelular = async (c, celular) =>
    (await c.query(`SELECT id_operador, nombre, estado FROM operadores WHERE celular = $1 LIMIT 1`, [celular])).rows[0];

const tractoPorPlacas = async (c, placas) =>
    (await c.query(
        `SELECT id_tractocamion, placas, estado FROM tractocamiones
         WHERE REGEXP_REPLACE(UPPER(placas), '[^A-Z0-9]', '', 'g') = $1 LIMIT 1`,
        [placaNormal(placas)]
    )).rows[0];

const cajaPorPlacas = async (c, placas) =>
    (await c.query(
        `SELECT id_caja_refrigerada, placas, estado FROM cajas_refrigeradas
         WHERE REGEXP_REPLACE(UPPER(placas), '[^A-Z0-9]', '', 'g') = $1 LIMIT 1`,
        [placaNormal(placas)]
    )).rows[0];

// ---- Altas rápidas ----
const crearOperador = async (c, { id_linea_fletera, nombre, celular }) =>
    (await c.query(
        `INSERT INTO operadores (id_linea_fletera, nombre, celular, estado)
         VALUES ($1, $2, $3, 1) RETURNING id_operador, id_linea_fletera, nombre, celular, estado`,
        [id_linea_fletera, nombre, celular]
    )).rows[0];

const crearTracto = async (c, { id_linea_fletera, placas, numero_economico }) =>
    (await c.query(
        `INSERT INTO tractocamiones (id_linea_fletera, placas, numero_economico, estado)
         VALUES ($1, $2, $3, 1) RETURNING id_tractocamion, id_linea_fletera, placas, numero_economico, estado`,
        [id_linea_fletera, placas, numero_economico]
    )).rows[0];

const crearCaja = async (c, { id_linea_fletera, placas, numero_economico, largo_pies }) =>
    (await c.query(
        `INSERT INTO cajas_refrigeradas (id_linea_fletera, placas, numero_economico, largo_pies, estado)
         VALUES ($1, $2, $3, $4, 1) RETURNING id_caja_refrigerada, id_linea_fletera, placas, numero_economico, estado`,
        [id_linea_fletera, placas, numero_economico, largo_pies]
    )).rows[0];

// ---- Transporte (servicio) ----
// Se reutiliza el servicio si ya existe la misma combinación; si estaba de
// baja se reactiva.
const buscarTransporte = async (c, t) =>
    (await c.query(
        `SELECT id_transporte, estado FROM transportes
         WHERE id_linea_fletera = $1 AND id_operador = $2 AND id_tractocamion = $3
           AND id_caja_refrigerada = $4
           AND id_caja_refrigerada_2 IS NOT DISTINCT FROM $5::INT
           AND tipo_unidad = $6
         ORDER BY estado DESC, id_transporte
         LIMIT 1`,
        [t.id_linea_fletera, t.id_operador, t.id_tractocamion, t.id_caja_1, t.id_caja_2, t.tipo_unidad]
    )).rows[0];

const reactivarTransporte = async (c, id) => {
    await c.query(`UPDATE transportes SET estado = 1 WHERE id_transporte = $1`, [id]);
};

// Columnas heredadas que se copian de los catálogos SI existen en la tabla
const HEREDADAS = {
    razon_social:      "lf.razon_social",
    nombre_operador:   "op.nombre",
    celular:           "op.celular",
    placas_tracto:     "tr.placas",
    placas_caja:       "cr.placas",
    no_economico_caja: "cr.numero_economico",
    inocuidad:         "0"
};

let columnasTransportes = null;
const getColumnasTransportes = async (c) => {
    if (!columnasTransportes) {
        const r = await c.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'transportes'`
        );
        columnasTransportes = new Set(r.rows.map((x) => x.column_name));
    }
    return columnasTransportes;
};

const crearTransporte = async (c, t) => {
    const existentes = await getColumnasTransportes(c);

    const columnas = [
        "id_linea_fletera", "id_operador", "id_tractocamion", "id_caja_refrigerada",
        "id_caja_refrigerada_2", "tipo_unidad", "estado"
    ];
    const valores = ["lf.id_linea_fletera", "op.id_operador", "tr.id_tractocamion", "cr.id_caja_refrigerada", "$5::INT", "$6", "1"];

    for (const [col, expr] of Object.entries(HEREDADAS)) {
        if (existentes.has(col)) {
            columnas.push(col);
            valores.push(expr);
        }
    }

    return (await c.query(
        `INSERT INTO transportes (${columnas.join(", ")})
         SELECT ${valores.join(", ")}
         FROM lineas_fleteras lf
         JOIN operadores         op ON op.id_operador         = $2
         JOIN tractocamiones     tr ON tr.id_tractocamion     = $3
         JOIN cajas_refrigeradas cr ON cr.id_caja_refrigerada = $4
         WHERE lf.id_linea_fletera = $1
         RETURNING id_transporte`,
        [t.id_linea_fletera, t.id_operador, t.id_tractocamion, t.id_caja_1, t.id_caja_2, t.tipo_unidad]
    )).rows[0];
};

// ---- Fruta (flujo anterior por montón; se conserva) ----
const bloquearOcupaciones = async (c, ids) =>
    (await c.query(
        `SELECT o.id_ocupacion, o.id_camara, o.tipo_ocupacion, o.estado,
                o.cantidad_tarimas, o.cantidad_cajas,
                cam.nombre_camara,
                r.id_produccion, p.id_cc, p.codigo_lote,
                cc.cliente, cc.cedis
         FROM ocupaciones_camaras o
         JOIN camaras cam ON cam.id_camara = o.id_camara
         LEFT JOIN recepciones r    ON r.id_recepcion  = o.id_recepcion
         LEFT JOIN produccion p     ON p.id_produccion = r.id_produccion
         LEFT JOIN cedis_cliente cc ON cc.id_cc        = p.id_cc
         WHERE o.id_ocupacion = ANY($1::INT[])
         FOR UPDATE OF o`,
        [ids]
    )).rows;

// ---- Documento ----
const crearDespacho = async (c, d) =>
    (await c.query(
        `INSERT INTO despachos (
            folio_despacho, id_transporte, fecha_despacho, hora_salida,
            id_cc, orden_venta, cita, fecha_cita,
            temperatura_salida, observaciones, estado
         ) VALUES (
            fn_generar_folio_despacho(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 1
         ) RETURNING id_despacho, folio_despacho`,
        [d.id_transporte, d.fecha_despacho, d.hora_salida, d.id_cc, d.orden_venta,
         d.cita, d.fecha_cita, d.temperatura_salida, d.observaciones]
    )).rows[0];

// Inspección de las cajas. La fecha la pone trg_validar_cierre.
//
// Solo se escriben las columnas que EXISTEN en tu tabla despachos: el
// resultado (inocuidad) siempre; quién inspeccionó y las observaciones, si
// la tabla tiene dónde guardarlas. Se consulta information_schema una vez.
let columnasDespachos = null;
const getColumnasDespachos = async (c) => {
    if (!columnasDespachos) {
        const r = await c.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'despachos'`
        );
        columnasDespachos = new Set(r.rows.map((x) => x.column_name));
    }
    return columnasDespachos;
};

const registrarInspeccion = async (c, id_despacho, { caja1, caja2, id_usuario }) => {
    const existentes = await getColumnasDespachos(c);
    const posibles = [
        ["inocuidad", caja1.inocuidad],
        ["inocuidad_id_usuario", id_usuario],
        ["inocuidad_observaciones", caja1.observaciones],
        ["inocuidad_caja_2", caja2 ? caja2.inocuidad : null],
        ["inocuidad_caja_2_observaciones", caja2 ? caja2.observaciones : null]
    ].filter(([col]) => existentes.has(col));

    if (caja2 && !existentes.has("inocuidad_caja_2")) {
        throw Object.assign(new Error("La tabla despachos no tiene la inspección de la segunda caja: corre Preenfrio_despacho_full_asistente.sql"), { code: "P0001" });
    }

    const sets = posibles.map(([col], i) => `${col} = $${i + 2}`).join(", ");
    await c.query(
        `UPDATE despachos SET ${sets} WHERE id_despacho = $1`,
        [id_despacho, ...posibles.map(([, v]) => v)]
    );
};

// Línea de picking: dispara trg_despacho_detalle_movimiento → descuento
const agregarLinea = async (c, l) =>
    (await c.query(
        `INSERT INTO despachos_detalle (
            id_despacho, id_produccion, id_ocupacion_origen, id_camara_origen,
            cantidad_tarimas, cantidad_cajas
         ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id_detalle`,
        [l.id_despacho, l.id_produccion, l.id_ocupacion_origen, l.id_camara_origen,
         l.cantidad_tarimas, l.cantidad_cajas]
    )).rows[0];

const insertarAuditoria = async (c, { id_despacho, motivo, cambios, id_usuario }) => {
    await c.query(
        `INSERT INTO despachos_auditoria (id_despacho, estado_al_editar, motivo, cambios, id_usuario)
         VALUES ($1, 1, $2, $3, $4)`,
        [id_despacho, motivo, cambios, id_usuario]
    );
};

// Cierre. La confirmación de reasignación viaja en la MISMA transacción.
const cerrar = async (c, id_despacho, confirmarReasignacion) => {
    await c.query(`SELECT set_config('app.confirmar_reasignacion', $1, true)`, [confirmarReasignacion ? "1" : ""]);
    await c.query(`UPDATE despachos SET estado = 2 WHERE id_despacho = $1`, [id_despacho]);
};

const getDespacho = async (id_despacho) =>
    (await db.query(`SELECT * FROM vw_despachos WHERE id_despacho = $1`, [id_despacho])).rows[0];

const despachoCompletoModel = {
    placaNormal,
    getLinea,
    getCedis,
    getOperador,
    getTracto,
    getCaja,
    operadorPorCelular,
    tractoPorPlacas,
    cajaPorPlacas,
    crearOperador,
    crearTracto,
    crearCaja,
    buscarTransporte,
    reactivarTransporte,
    crearTransporte,
    bloquearOcupaciones,
    crearDespacho,
    registrarInspeccion,
    agregarLinea,
    insertarAuditoria,
    cerrar,
    getDespacho
};

export default despachoCompletoModel;