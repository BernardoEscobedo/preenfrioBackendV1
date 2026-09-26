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
// v2.3 · CRITICIDAD POR HOLGURA
//   La cola ya no ordena solo por antigüedad. Ahora cada fila trae:
//
//       holgura_dias       días de margen antes de incumplir la cita
//                          (días para la cita − tránsito − preenfrío)
//       nivel_criticidad   1 CRÍTICA · 2 URGENTE · 3 NORMAL · 4 HOLGADA
//       criticidad_texto   la etiqueta para la pantalla
//       motivo_criticidad  por qué quedó en ese nivel
//
//   El cálculo vive en las vistas (vw_cola_espera, vw_inventario_disponible)
//   y no aquí, para que el dashboard, el picking y este módulo no lleguen a
//   números distintos. Si cambia la regla, se cambia en un solo lugar.
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
//   respuesta para saber si funcionó.
//
// CORRECCIONES DE LA AUDITORÍA
//   · getOcupacionById no devolvía id_cc. despachos.controller lo usa para
//     avisar cuando se sube al camión fruta planeada para otro cliente:
//     llegaba undefined y el aviso nunca aparecía. (El cierre sí lo
//     atrapaba, pero el aviso temprano estaba muerto.)
//
//   · getOcupacionById calculaba la holgura con un "- 1" escrito aquí, que
//     es el mismo DIAS_PREENFRIO de la migración v2.3. Si se ajustaba en la
//     vista y no aquí, /promover mostraba una holgura distinta a la cola.
//     Ahora se lee de las vistas: el parámetro existe en un solo lugar.
//
//   · getInventario no tenía ORDER BY y confiaba en el orden de la vista.
//     En PostgreSQL, en cuanto se aplica un WHERE sobre una vista ese orden
//     deja de estar garantizado: el día que el planificador cambiara de
//     estrategia, el inventario dejaría de mostrar primero lo crítico sin
//     que nadie lo notara.
// ============================================================================

// ----------------------------------------------------------------------------
// Tablero de ocupación por cámara
// ----------------------------------------------------------------------------
// Lee vw_disponibilidad_camaras y le agrega el pendiente crítico: cuántas
// tarimas de nivel 1 están esperando en cada cámara.
//
// Ese dato es el que convierte el tablero en accionable. Sin él, una cámara
// al 95% y otra al 95% se ven igual; con él se distingue la que tiene tres
// lotes con la cita encima de la que solo tiene fruta holgada esperando.
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
            END AS tipo_camara_texto,
            -- v2.3 · Presión de la cola: lo que no puede esperar
            COALESCE(crit.tarimas_criticas, 0)  AS tarimas_criticas_en_cola,
            COALESCE(crit.procesos_criticos, 0) AS procesos_criticos_en_cola,
            crit.holgura_minima
        FROM vw_disponibilidad_camaras v
        JOIN camaras cam ON cam.id_camara = v.id_camara
        LEFT JOIN (
            SELECT
                id_camara,
                SUM(tarimas_en_espera) FILTER (WHERE nivel_criticidad = 1)
                    AS tarimas_criticas,
                COUNT(*) FILTER (WHERE nivel_criticidad = 1)
                    AS procesos_criticos,
                MIN(holgura_dias) AS holgura_minima
            FROM vw_cola_espera
            GROUP BY id_camara
        ) crit ON crit.id_camara = v.id_camara
        WHERE ($1::INT IS NULL OR v.tipo_camara = $1)
          AND ($2::INT[] IS NULL OR v.id_camara = ANY($2))
          AND ($3::BOOLEAN IS FALSE OR v.estado = 1)
        ORDER BY
            -- Las cámaras con fruta crítica esperando van arriba: es donde
            -- hay que actuar primero.
            COALESCE(crit.procesos_criticos, 0) DESC,
            v.tipo_camara,
            v.nombre_camara
        `,
        [tipo_camara, camaras, solo_operativas]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Cola de espera
// ----------------------------------------------------------------------------
// Lee vw_cola_espera, que ya trae 'posicion' calculada con el orden que
// manda en el negocio (v2.3):
//
//   1º prioridad DESC        override manual del supervisor
//   2º nivel_criticidad ASC  la holgura contra la cita
//   3º fecha_empaque ASC     FEFO dentro del mismo nivel
//   4º llegada               desempate
//
// El ORDER BY por 'posicion' es explícito a propósito: el orden de la vista
// no se garantiza en cuanto se filtra.
const getCola = async (
    { id_camara = null, nivel_maximo = null } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        SELECT * FROM vw_cola_espera
        WHERE ($1::INT IS NULL OR id_camara = $1)
          AND ($2::INT[] IS NULL OR id_camara = ANY($2))
          AND ($3::INT IS NULL OR nivel_criticidad <= $3)
        ORDER BY id_camara, posicion
        `,
        [id_camara, camaras, nivel_maximo]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Lo que no puede esperar — reporte de arranque de turno
// ----------------------------------------------------------------------------
// Solo nivel 1, de TODAS las cámaras del alcance, ordenado por lo peor
// primero. Es la consulta que responde "¿qué se me está incumpliendo?".
//
// Separa los dos motivos de criticidad, porque exigen acciones distintas:
//   · holgura ≤ 0        → hay que despachar YA
//   · fruta muy vieja    → hay que revisar calidad, quizá ya no sirve
const getCriticas = async (camaras = null) => {
    const result = await db.query(
        `
        SELECT
            id_ocupacion,
            id_camara,
            nombre_camara,
            posicion,
            codigo_lote,
            cliente,
            cedis,
            tarimas_en_espera,
            fecha_empaque,
            dias_desde_empaque,
            fecha_entrega,
            dias_para_cita,
            transito,
            holgura_dias,
            criticidad_texto,
            motivo_criticidad,
            prioridad,
            motivo_prioridad,
            -- Distingue el origen de la criticidad para saber qué hacer
            CASE
                WHEN holgura_dias IS NOT NULL AND holgura_dias < 0
                    THEN 'CITA_VENCIDA'
                WHEN holgura_dias = 0
                    THEN 'SALE_HOY'
                ELSE 'FRUTA_VIEJA'
            END AS tipo_criticidad
        FROM vw_cola_espera
        WHERE nivel_criticidad = 1
          AND ($1::INT[] IS NULL OR id_camara = ANY($1))
        ORDER BY holgura_dias ASC NULLS LAST, dias_desde_empaque DESC
        `,
        [camaras]
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
// El orden es criticidad y luego FEFO (v2.3). Ordenar solo por antigüedad
// provocaba el error inverso al de la cola: sacar fruta vieja con cita
// lejana y dejar adentro la que vence mañana.
//
// El ORDER BY va explícito: el de la vista deja de estar garantizado en
// cuanto se aplica el WHERE.
const getInventario = async (
    { id_camara = null, id_cc = null, nivel_maximo = null, buscar = null } = {},
    camaras = null
) => {
    const result = await db.query(
        `
        SELECT * FROM vw_inventario_disponible
        WHERE ($1::INT IS NULL OR id_camara = $1)
          AND ($2::INT IS NULL OR id_cc = $2)
          AND ($3::INT[] IS NULL OR id_camara = ANY($3))
          AND ($4::INT IS NULL OR nivel_criticidad <= $4)
          AND ($5::TEXT IS NULL
               OR codigo_lote ILIKE '%' || $5 || '%'
               OR nombre_finca ILIKE '%' || $5 || '%'
               OR cliente ILIKE '%' || $5 || '%')
        ORDER BY nivel_criticidad ASC,
                 fecha_empaque ASC NULLS LAST,
                 id_ocupacion ASC
        `,
        [id_camara, id_cc, camaras, nivel_maximo, buscar]
    );
    return result.rows;
};

// ----------------------------------------------------------------------------
// Una ocupación concreta, con su trazabilidad
// ----------------------------------------------------------------------------
// Sin filtro de alcance: el controller compara después para distinguir
// "no existe" (404) de "no es de tu planta" (403).
//
// La usan también movimientos (origen del traslado) y despachos (origen de
// la línea de picking), por eso trae id_cc: es lo que permite avisar cuando
// se sube al camión fruta planeada para otro cliente.
//
// La holgura y la criticidad se LEEN de las vistas en vez de calcularse
// aquí, para que el parámetro DIAS_PREENFRIO exista en un solo lugar. Una
// ocupación en cola la trae vw_cola_espera; una dentro de la cámara,
// vw_inventario_disponible. Las cerradas y los bloqueos no están en
// ninguna: para ellas la holgura viene NULL, que es lo correcto.
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
            p.fecha_entrega,
            (p.fecha_entrega - CURRENT_DATE) AS dias_para_cita,
            COALESCE(p.transito, 0) AS transito,
            -- Holgura y criticidad, tal como las calculan las vistas
            COALESCE(vc.holgura_dias, vi.holgura_dias)         AS holgura_dias,
            COALESCE(vc.nivel_criticidad, vi.nivel_criticidad) AS nivel_criticidad,
            COALESCE(vc.criticidad_texto, vi.criticidad_texto) AS criticidad_texto,
            f.codigo_finca,
            f.nombre  AS nombre_finca,
            pr.nombre AS nombre_productor,
            s.codigo_sku,
            s.calidad AS calidad_sku,
            -- id_cc: el dato que faltaba para el aviso de otro cliente
            p.id_cc,
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
        LEFT JOIN vw_cola_espera           vc ON vc.id_ocupacion = o.id_ocupacion
        LEFT JOIN vw_inventario_disponible vi ON vi.id_ocupacion = o.id_ocupacion
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
// La vista SUGIERE el orden con 'posicion' y ese orden ya considera la cita,
// no solo la antigüedad. El sistema recomienda; la persona decide.
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
//   prioridad = 0  → orden normal (por criticidad y luego antigüedad)
//   prioridad > 0  → urgente; a mayor número, más al frente
//
// La prioridad manual gana sobre TODO, incluida la criticidad. Es
// intencional: el supervisor a veces sabe algo que el sistema no puede
// calcular (un cliente llamando, un camión ya en el andén, un cambio de
// cita que aún no se captura).
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
            p.fecha_entrega,
            f.nombre  AS nombre_finca,
            cc.cliente,
            -- Cumplimiento: si salió después de la cita, se incumplió.
            -- Es el indicador que cierra el ciclo y permite medir si la
            -- criticidad está funcionando.
            CASE
                WHEN p.fecha_entrega IS NULL THEN NULL
                WHEN o.fecha_fin IS NULL THEN NULL
                WHEN o.fecha_fin <= p.fecha_entrega THEN TRUE
                ELSE FALSE
            END AS cumplio_cita
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
    getCriticas,
    getInventario,
    getOcupacionById,
    promoverDeCola,
    setPrioridad,
    getHistorial
};

export default ocupacionesModel;
