import { db } from "../database/connection.database.js";

// ============================================================================
// OCUPACIONES DE CÁMARA Y COLA DE ESPERA
// ============================================================================
// Este módulo es la cara visible del núcleo de inventario. No crea
// ocupaciones: las generan los triggers de recepción y movimiento. Lo que
// hace es CONSULTARLAS y disparar las dos funciones de la BD que el
// operador necesita:
//
//   fn_promover_de_cola     mueve fruta de la cola hacia la cámara
//   fn_set_prioridad_cola   adelanta un proceso urgente en la fila
//
// ⚠️ POR QUÉ SE LLAMAN FUNCIONES Y NO SE ESCRIBE UPDATE AQUÍ
//   Promover de la cola son cinco pasos encadenados: verificar espacio,
//   calcular cuántas tarimas caben, repartir las cajas en proporción, sumar
//   a la ocupación de la cámara (creándola si no existe) y descontar de la
//   cola cerrándola si se vació.
//
//   Hacerlo con cinco queries desde el backend significaría cinco viajes a
//   la BD sin transacción: si el proceso se corta a la mitad, la fruta
//   queda contada dos veces o desaparece. fn_promover_de_cola hace todo
//   dentro de una sola llamada atómica.
//
// LAS FUNCIONES DEVUELVEN TEXTO, NO EXCEPCIONES
//   Regresan 'OK: ...' o el motivo del rechazo ('La cámara no tiene espacio
//   disponible'). No lanzan error, así que el controller tiene que LEER la
//   respuesta para saber si funcionó. Es un detalle fácil de pasar por alto
//   y por eso este modelo lo deja explícito en el valor de retorno.
// ============================================================================

// ----------------------------------------------------------------------------
// Tablero de ocupación por cámara
// ----------------------------------------------------------------------------
// Lee vw_disponibilidad_camaras, que ya calcula ocupado, en espera, libre y
// estado de mantenimiento. Es la pantalla principal del módulo.
//
// La vista incluye cámaras dadas de baja a propósito: si quedó inventario
// dentro hay que poder verlo para vaciarlas. El filtro de operativas se
// aplica aquí, como parámetro opcional.
const getTablero = async (
    { tipo_camara = null, solo_operativas = false } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        SELECT
            v.*,
            -- Porcentaje de ocupación: lo que la pantalla pinta como barra.
            -- Se calcula aquí y no en el frontend para que el dashboard y
            -- este módulo no muestren números distintos.
            CASE
                WHEN v.capacidad_max_tarimas > 0
                THEN ROUND(
                    (v.tarimas_ocupadas::NUMERIC / v.capacidad_max_tarimas) * 100,
                    1
                )
                ELSE 0
            END AS porcentaje_ocupacion,
            CASE cam.tipo_camara
                WHEN 1 THEN 'Preenfrío'
                WHEN 2 THEN 'Conservación'
                ELSE 'Otra'
            END AS tipo_camara_texto
        FROM vw_disponibilidad_camaras v
        JOIN camaras cam ON cam.id_camara = v.id_camara
        WHERE ($1::INT IS NULL OR v.tipo_camara = $1)
          AND ($2::INT[] IS NULL OR v.id_camara = ANY($2))
          AND ($3::BOOLEAN IS FALSE OR v.estado = 1)
        ORDER BY v.tipo_camara, v.nombre_camara
        `,
        [tipo_camara, camaras, solo_operativas]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Cola de espera
// ----------------------------------------------------------------------------
// Lee vw_cola_espera, que ya trae la posición calculada con ROW_NUMBER y el
// orden que manda en el negocio:
//
//   1º prioridad DESC     → los urgentes al frente
//   2º fecha_empaque ASC  → la fruta más VIEJA entra primero
//   3º fecha/hora llegada → desempate
//
// 'posicion' es el turno dentro de cada cámara: 1 = el siguiente en entrar.
const getCola = async ({ id_camara = null } = {}, camaras = null) => {
    const result = await db.query(
        `
        SELECT * FROM vw_cola_espera
        WHERE ($1::INT IS NULL OR id_camara = $1)
          AND ($2::INT[] IS NULL OR id_camara = ANY($2))
        ORDER BY id_camara, posicion
        `,
        [id_camara, camaras]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Inventario físico dentro de las cámaras
// ----------------------------------------------------------------------------
// Lee vw_inventario_disponible: solo tipo_ocupacion = 1, es decir lo que
// está REALMENTE dentro. La cola no aparece porque no se puede despachar
// fruta que todavía está en el patio.
//
// Ordenado FEFO (la más vieja primero): es la fuente del picking de
// despachos y el orden en que debería salir.
const getInventario = async (
    { id_camara = null, id_cc = null, buscar = null } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        SELECT * FROM vw_inventario_disponible
        WHERE ($1::INT IS NULL OR id_camara = $1)
          AND ($2::INT IS NULL OR id_cc = $2)
          AND ($3::INT[] IS NULL OR id_camara = ANY($3))
          AND ($4::TEXT IS NULL
               OR codigo_lote ILIKE '%' || $4 || '%'
               OR nombre_finca ILIKE '%' || $4 || '%'
               OR cliente ILIKE '%' || $4 || '%')
        ORDER BY dias_desde_empaque DESC NULLS LAST, id_ocupacion
        `,
        [id_camara, id_cc, camaras, buscar]
    );
    return result.rows;
};

// Una ocupación concreta, con su trazabilidad.
// Sin filtro de alcance: el controller compara después para distinguir
// "no existe" (404) de "no es de tu planta" (403).
const getOcupacionById = async (id_ocupacion) => {
    const result = await db.query(
        `
        SELECT
            o.*,
            c.nombre_camara,
            c.tipo_camara,
            c.capacidad_max_tarimas,
            CASE o.tipo_ocupacion
                WHEN 1 THEN 'Dentro de cámara'
                WHEN 2 THEN 'Bloqueo por mantenimiento'
                WHEN 3 THEN 'En cola de espera'
                ELSE 'Otro'
            END AS tipo_texto,
            CASE o.estado
                WHEN 1 THEN 'Activa'
                WHEN 0 THEN 'Cerrada'
                ELSE 'Otro'
            END AS estado_texto,
            -- Trazabilidad vía la recepción que la originó
            r.id_recepcion,
            r.fecha_recepcion,
            p.id_produccion,
            p.codigo_lote,
            p.semana,
            p.fecha_empaque,
            (CURRENT_DATE - p.fecha_empaque) AS dias_desde_empaque,
            f.codigo_finca,
            f.nombre  AS nombre_finca,
            pr.nombre AS nombre_productor,
            s.codigo_sku,
            s.calidad AS calidad_sku,
            cc.cliente,
            cc.cedis
        FROM ocupaciones_camaras o
        JOIN camaras            c   ON c.id_camara     = o.id_camara
        LEFT JOIN recepciones   r   ON r.id_recepcion  = o.id_recepcion
        LEFT JOIN produccion    p   ON p.id_produccion = r.id_produccion
        LEFT JOIN fincas        f   ON f.id_finca      = p.id_finca
        LEFT JOIN productores   pr  ON pr.id_productor = p.id_productor
        LEFT JOIN sku_pt        s   ON s.id_sku        = p.id_sku
        LEFT JOIN cedis_cliente cc  ON cc.id_cc        = p.id_cc
        WHERE o.id_ocupacion = $1
        `,
        [id_ocupacion]
    );
    return result.rows[0];
};

// ----------------------------------------------------------------------------
// fn_promover_de_cola — mover fruta de la cola a la cámara
// ----------------------------------------------------------------------------
// NO es FIFO automático a propósito. El operador elige QUÉ proceso entra y
// CUÁNTAS tarimas, porque él ve el patio: sabe cuál camión está estorbando
// el andén y cuál fruta se ve peor.
//
// La función se encarga de no exceder ni lo que espera ni lo que cabe:
//     v_tar := LEAST(p_tarimas, v_tar_espera, v_disp)
//
// Devuelve TEXTO, no excepción. El controller lo interpreta.
const promoverDeCola = async (id_ocupacion, tarimas, fecha = null, hora = null) => {
    const result = await db.query(
        `
        SELECT fn_promover_de_cola(
            $1, $2,
            COALESCE($3::DATE, CURRENT_DATE),
            COALESCE($4::TIME, CURRENT_TIME)
        ) AS resultado
        `,
        [id_ocupacion, tarimas, fecha, hora]
    );
    return result.rows[0].resultado;
};

// ----------------------------------------------------------------------------
// fn_set_prioridad_cola — adelantar o regresar un proceso en la fila
// ----------------------------------------------------------------------------
//   prioridad = 0  → orden normal (por fecha de empaque)
//   prioridad > 0  → urgente; a mayor número, más al frente
//
// Solo aplica a filas tipo_ocupacion = 3. La función rechaza cualquier otra
// cosa con un mensaje, no con un error.
//
// El motivo solo se guarda si hay prioridad: la propia función lo pone en
// NULL cuando se regresa a 0, para que no quede un "URGENTE CLIENTE X"
// colgando de algo que ya no es urgente.
const setPrioridad = async (id_ocupacion, prioridad, motivo = null) => {
    const result = await db.query(
        `SELECT fn_set_prioridad_cola($1, $2, $3) AS resultado`,
        [id_ocupacion, prioridad, motivo]
    );
    return result.rows[0].resultado;
};

// ----------------------------------------------------------------------------
// Historial de ocupaciones cerradas
// ----------------------------------------------------------------------------
// Las que ya salieron de la cámara (estado = 0). Sirve para reconstruir qué
// pasó con un lote: cuándo entró, cuánto tiempo estuvo y cuándo se vació.
const getHistorial = async (
    { id_camara = null, fecha_desde = null, fecha_hasta = null } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        SELECT
            o.id_ocupacion,
            o.id_camara,
            c.nombre_camara,
            o.tipo_ocupacion,
            o.cantidad_tarimas,
            o.cantidad_cajas,
            o.fecha_inicio,
            o.hora_inicio,
            o.fecha_fin,
            o.hora_fin,
            -- Horas que la fruta estuvo dentro: el indicador operativo que
            -- importa en preenfrío (cuánto tardó en bajar temperatura).
            CASE
                WHEN o.fecha_fin IS NOT NULL THEN
                    ROUND(
                        EXTRACT(EPOCH FROM (
                            (o.fecha_fin + COALESCE(o.hora_fin, '00:00'::TIME))
                            - (o.fecha_inicio + o.hora_inicio)
                        )) / 3600,
                        1
                    )
                ELSE NULL
            END AS horas_en_camara,
            o.observaciones,
            p.codigo_lote,
            f.nombre  AS nombre_finca,
            cc.cliente
        FROM ocupaciones_camaras o
        JOIN camaras            c   ON c.id_camara     = o.id_camara
        LEFT JOIN recepciones   r   ON r.id_recepcion  = o.id_recepcion
        LEFT JOIN produccion    p   ON p.id_produccion = r.id_produccion
        LEFT JOIN fincas        f   ON f.id_finca      = p.id_finca
        LEFT JOIN cedis_cliente cc  ON cc.id_cc        = p.id_cc
        WHERE o.estado = 0
          AND ($1::INT IS NULL OR o.id_camara = $1)
          AND ($2::DATE IS NULL OR o.fecha_inicio >= $2)
          AND ($3::DATE IS NULL OR o.fecha_inicio <= $3)
          AND ($4::INT[] IS NULL OR o.id_camara = ANY($4))
        ORDER BY o.fecha_fin DESC NULLS LAST, o.id_ocupacion DESC
        LIMIT 500
        `,
        [id_camara, fecha_desde, fecha_hasta, camaras]
    );
    return result.rows;
};

const ocupacionesModel = {
    getTablero,
    getCola,
    getInventario,
    getOcupacionById,
    promoverDeCola,
    setPrioridad,
    getHistorial
};

export default ocupacionesModel;
