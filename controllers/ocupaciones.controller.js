import ocupacionesModel from "../models/ocupaciones.model.js";

// ============================================================================
// OCUPACIONES DE CÁMARA Y COLA
// ============================================================================
// req.camaras lo pone cargarAlcance:
//     null  -> Admin / Coordinador
//     [...] -> Supervisor / Operativo
//
// v2.3 · CRITICIDAD POR HOLGURA
//   La cola ya no ordena solo por antigüedad. Cada fila trae su nivel:
//       1 CRÍTICA · 2 URGENTE · 3 NORMAL · 4 HOLGADA
//   calculado con los días de margen que quedan antes de incumplir la cita.
//
//   El cálculo vive en las vistas, no aquí. Este controller solo lo expone
//   y lo usa para armar los avisos.
//
// ⚠️ LAS FUNCIONES DE LA BD DEVUELVEN TEXTO, NO EXCEPCIONES
//   fn_promover_de_cola y fn_set_prioridad_cola regresan 'OK: ...' o el
//   motivo del rechazo. NUNCA lanzan error.
//
//   Si este controller no leyera la respuesta, un intento fallido
//   devolvería HTTP 200 y el operador creería que su fruta entró a la
//   cámara cuando sigue en el patio. Por eso todas las llamadas revisan el
//   prefijo 'OK:' antes de responder.
// ============================================================================

/** Las funciones de la BD marcan el éxito con este prefijo. */
const esExito = (respuesta) => String(respuesta).startsWith("OK:");

// ----------------------------------------------------------------------------
// GET /api/preenfrio/ocupaciones/tablero
// ----------------------------------------------------------------------------
// Pantalla principal: capacidad, ocupado, en cola y mantenimiento por
// cámara.
//
// v2.3: incluye tarimas_criticas_en_cola. Sin ese dato, dos cámaras al 95%
// se ven igual; con él se distingue la que tiene tres lotes con la cita
// encima de la que solo tiene fruta holgada esperando. Las cámaras con
// fruta crítica salen ordenadas primero.
const getTablero = async (req, res) => {
    try {
        const { tipo_camara, solo_operativas } = req.query;

        const tablero = await ocupacionesModel.getTablero(
            {
                tipo_camara: tipo_camara ? Number(tipo_camara) : null,
                solo_operativas:
                    solo_operativas === "1" || solo_operativas === "true"
            },
            req.camaras
        );

        // Resumen de arriba: lo que el supervisor mira antes que nada
        const resumen = {
            camaras: tablero.length,
            con_fruta_critica: tablero.filter(
                (c) => Number(c.procesos_criticos_en_cola) > 0
            ).length,
            tarimas_criticas: tablero.reduce(
                (suma, c) => suma + Number(c.tarimas_criticas_en_cola || 0),
                0
            )
        };

        res.status(200).json({ resumen, camaras: tablero });
    } catch (error) {
        console.error("Error al obtener el tablero:", error);
        res.status(500).json({ error: "Error al obtener el tablero de cámaras" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/ocupaciones/cola
// ----------------------------------------------------------------------------
// Fruta esperando fuera de cada cámara, ya ordenada por la vista:
//
//   1º prioridad manual      override del supervisor
//   2º nivel de criticidad   holgura contra la cita
//   3º fecha de empaque      FEFO dentro del mismo nivel
//   4º llegada               desempate
//
// 'posicion' es el turno: 1 = el siguiente en entrar.
//
//   ?nivel_maximo=1  → solo lo crítico
//   ?nivel_maximo=2  → crítico y urgente
const getCola = async (req, res) => {
    try {
        const { id_camara, nivel_maximo } = req.query;

        const cola = await ocupacionesModel.getCola(
            {
                id_camara: id_camara ? Number(id_camara) : null,
                nivel_maximo: nivel_maximo ? Number(nivel_maximo) : null
            },
            req.camaras
        );

        res.status(200).json(cola);
    } catch (error) {
        console.error("Error al obtener la cola:", error);
        res.status(500).json({ error: "Error al obtener la cola de espera" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/ocupaciones/criticas
// ----------------------------------------------------------------------------
// Solo nivel 1, de todas las cámaras del alcance. Es el reporte de arranque
// de turno: responde "¿qué se me está incumpliendo ahora mismo?".
//
// Separa los dos motivos porque exigen acciones distintas:
//   CITA_VENCIDA  → ya no llega; hay que avisar al cliente
//   SALE_HOY      → todavía se salva si se despacha hoy
//   FRUTA_VIEJA   → revisar calidad, quizá ya no sirve para ninguna cita
const getCriticas = async (req, res) => {
    try {
        const criticas = await ocupacionesModel.getCriticas(req.camaras);

        const vencidas = criticas.filter((c) => c.tipo_criticidad === "CITA_VENCIDA");
        const hoy = criticas.filter((c) => c.tipo_criticidad === "SALE_HOY");
        const viejas = criticas.filter((c) => c.tipo_criticidad === "FRUTA_VIEJA");

        res.status(200).json({
            resumen: {
                total: criticas.length,
                cita_vencida: vencidas.length,
                sale_hoy: hoy.length,
                fruta_vieja: viejas.length,
                tarimas: criticas.reduce(
                    (suma, c) => suma + Number(c.tarimas_en_espera || 0),
                    0
                )
            },
            // Agrupadas por acción, no en una lista plana: cada grupo se
            // resuelve de forma distinta.
            cita_vencida: vencidas,
            sale_hoy: hoy,
            fruta_vieja: viejas
        });
    } catch (error) {
        console.error("Error al obtener las criticas:", error);
        res.status(500).json({ error: "Error al obtener la fruta crítica" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/ocupaciones/inventario
// ----------------------------------------------------------------------------
// Lo que está FÍSICAMENTE dentro de las cámaras.
//
// v2.3: ordenado por criticidad y luego FEFO. Antes era FEFO puro, lo que
// provocaba el error inverso al de la cola: sacar fruta vieja con cita
// lejana y dejar adentro la que vence mañana.
//
// Es la misma fuente que usará el picking de despachos.
const getInventario = async (req, res) => {
    try {
        const { id_camara, id_cc, nivel_maximo, buscar } = req.query;

        const inventario = await ocupacionesModel.getInventario(
            {
                id_camara: id_camara ? Number(id_camara) : null,
                id_cc: id_cc ? Number(id_cc) : null,
                nivel_maximo: nivel_maximo ? Number(nivel_maximo) : null,
                buscar: buscar || null
            },
            req.camaras
        );

        res.status(200).json(inventario);
    } catch (error) {
        console.error("Error al obtener el inventario:", error);
        res.status(500).json({ error: "Error al obtener el inventario" });
    }
};

// GET /api/preenfrio/ocupaciones/:id
const getOcupacionById = async (req, res) => {
    try {
        const { id } = req.params;
        const ocupacion = await ocupacionesModel.getOcupacionById(id);

        if (!ocupacion) {
            return res.status(404).json({ error: "Ocupación no encontrada" });
        }

        // Alcance después de traerla: distingue 404 de 403
        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(ocupacion.id_camara))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a esa ocupación"
            });
        }

        res.status(200).json(ocupacion);
    } catch (error) {
        console.error("Error al obtener la ocupacion:", error);
        res.status(500).json({ error: "Error al obtener la ocupación" });
    }
};

// ----------------------------------------------------------------------------
// POST /api/preenfrio/ocupaciones/:id/promover
// ----------------------------------------------------------------------------
// Mueve fruta de la COLA hacia la cámara. La acción más importante del
// módulo.
//
// No es FIFO automático: el operador elige qué proceso entra y cuántas
// tarimas, porque él ve el patio. El sistema solo impide que meta más de lo
// que espera o de lo que cabe.
//
// v2.3: si se promueve algo dejando atrás fruta más crítica, se avisa. No
// se bloquea — puede haber una razón válida (ese camión está estorbando el
// andén) — pero queda constancia de que se saltó el orden sugerido.
const promoverDeCola = async (req, res) => {
    try {
        const { id } = req.params;
        const { tarimas, fecha, hora } = req.body;

        const ocupacion = await ocupacionesModel.getOcupacionById(id);

        if (!ocupacion) {
            return res.status(404).json({ error: "Ocupación no encontrada" });
        }

        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(ocupacion.id_camara))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a esa cámara"
            });
        }

        // Se valida el tipo ANTES de llamar a la función: así el mensaje
        // explica qué es esa fila, en vez del genérico que devolvería la BD.
        if (ocupacion.tipo_ocupacion !== 3) {
            return res.status(409).json({
                error: `Esa ocupación no está en la cola: es "${ocupacion.tipo_texto}". Solo se puede promover fruta en espera.`
            });
        }

        if (ocupacion.estado !== 1) {
            return res.status(409).json({
                error: "Esa fila de la cola ya fue procesada"
            });
        }

        // ---- ¿Se está saltando algo más crítico? ----
        // Se consulta ANTES de promover, mientras la cola todavía tiene su
        // orden original.
        const colaAntes = await ocupacionesModel.getCola(
            { id_camara: Number(ocupacion.id_camara) },
            req.camaras
        );

        const estaFila = colaAntes.find(
            (c) => Number(c.id_ocupacion) === Number(id)
        );

        // Filas que van ANTES en el orden sugerido y son más críticas
        const saltadas = colaAntes.filter(
            (c) =>
                Number(c.posicion) < Number(estaFila?.posicion ?? 0) &&
                Number(c.nivel_criticidad) < Number(estaFila?.nivel_criticidad ?? 4)
        );

        // ---- Llamada a la función de la BD ----
        const resultado = await ocupacionesModel.promoverDeCola(
            id,
            tarimas,
            fecha,
            hora
        );

        // ⚠️ La función NO lanza excepción: devuelve el motivo del rechazo
        // como texto. Sin esta comprobación, un fallo respondería 200.
        if (!esExito(resultado)) {
            return res.status(409).json({
                error: resultado,
                // Contexto útil: casi siempre el rechazo es por falta de
                // espacio, y el operador quiere saber cuánto hay.
                tarimas_en_espera: ocupacion.cantidad_tarimas,
                camara: ocupacion.nombre_camara
            });
        }

        // Estado después del movimiento
        const colaRestante = await ocupacionesModel.getOcupacionById(id);
        const tablero = await ocupacionesModel.getTablero(
            {},
            [Number(ocupacion.id_camara)]
        );

        const avisos = [];

        if (saltadas.length > 0) {
            const peor = saltadas[0];
            avisos.push(
                `Ingresaste el lote ${ocupacion.codigo_lote} (${estaFila?.criticidad_texto ?? "sin clasificar"}) dejando en el patio ${saltadas.length} lote(s) más crítico(s). El más apremiante es ${peor.codigo_lote}: ${peor.motivo_criticidad}.`
            );
        }

        res.status(200).json({
            mensaje: resultado,
            lote: ocupacion.codigo_lote,
            camara: ocupacion.nombre_camara,
            criticidad: estaFila?.criticidad_texto ?? null,
            holgura_dias: ocupacion.holgura_dias,
            // Si la fila se cerró (estado 0), la cola se vació por completo
            cola_restante: colaRestante?.estado === 1
                ? colaRestante.cantidad_tarimas
                : 0,
            cola_cerrada: colaRestante?.estado === 0,
            camara_estado: tablero[0] ?? null,
            avisos
        });
    } catch (error) {
        console.error("Error al promover de la cola:", error);
        res.status(500).json({ error: "Error al ingresar la fruta a la cámara" });
    }
};

// ----------------------------------------------------------------------------
// PATCH /api/preenfrio/ocupaciones/:id/prioridad
// ----------------------------------------------------------------------------
// Adelanta (o regresa) un proceso en la cola de su cámara.
//   prioridad = 0  → orden normal (criticidad y luego antigüedad)
//   prioridad > 0  → urgente; a mayor número, más al frente
//
// v2.3: la prioridad manual sigue ganando sobre la criticidad automática.
// Es intencional — el supervisor a veces sabe algo que el sistema no puede
// calcular — pero con la criticidad funcionando debería necesitarse mucho
// menos que antes.
//
// Por eso, si se prioriza algo que ya era HOLGADA, se avisa: probablemente
// el dato que falta es la fecha de cita, no la prioridad.
const setPrioridad = async (req, res) => {
    try {
        const { id } = req.params;
        const { prioridad, motivo } = req.body;

        const ocupacion = await ocupacionesModel.getOcupacionById(id);

        if (!ocupacion) {
            return res.status(404).json({ error: "Ocupación no encontrada" });
        }

        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(ocupacion.id_camara))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a esa cámara"
            });
        }

        if (ocupacion.tipo_ocupacion !== 3) {
            return res.status(409).json({
                error: `Esa ocupación no está en la cola: es "${ocupacion.tipo_texto}". La prioridad solo aplica a fruta en espera.`
            });
        }

        const resultado = await ocupacionesModel.setPrioridad(id, prioridad, motivo);

        if (!esExito(resultado)) {
            return res.status(409).json({ error: resultado });
        }

        // Se devuelve la cola completa de esa cámara: el operador necesita
        // ver cómo quedó el orden, no solo que la operación funcionó.
        const cola = await ocupacionesModel.getCola(
            { id_camara: Number(ocupacion.id_camara) },
            req.camaras
        );

        const avisos = [];

        // Priorizar fruta sin cita suele significar que falta capturar la
        // fecha de entrega, no que realmente sea urgente.
        if (prioridad > 0 && ocupacion.fecha_entrega === null) {
            avisos.push(
                `El lote ${ocupacion.codigo_lote} no tiene fecha de cita capturada. Si ya se la asignaron, regístrala en la producción: el sistema la priorizaría solo.`
            );
        }

        res.status(200).json({
            mensaje: prioridad > 0
                ? `Lote ${ocupacion.codigo_lote} priorizado (nivel ${prioridad})`
                : `Lote ${ocupacion.codigo_lote} regresado al orden normal`,
            cola,
            avisos
        });
    } catch (error) {
        console.error("Error al cambiar la prioridad:", error);
        res.status(500).json({ error: "Error al cambiar la prioridad" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/ocupaciones/historial
// ----------------------------------------------------------------------------
// Ocupaciones ya cerradas, con las horas que la fruta estuvo dentro y si
// se cumplió la cita. Ese último dato cierra el ciclo: permite medir si la
// criticidad está sirviendo o si se sigue incumpliendo igual.
const getHistorial = async (req, res) => {
    try {
        const { id_camara, fecha_desde, fecha_hasta } = req.query;

        const historial = await ocupacionesModel.getHistorial(
            {
                id_camara: id_camara ? Number(id_camara) : null,
                fecha_desde: fecha_desde || null,
                fecha_hasta: fecha_hasta || null
            },
            req.camaras
        );

        // Indicador de cumplimiento sobre lo que sí tenía cita
        const conCita = historial.filter((h) => h.cumplio_cita !== null);
        const cumplidas = conCita.filter((h) => h.cumplio_cita === true);

        res.status(200).json({
            resumen: {
                total: historial.length,
                con_cita: conCita.length,
                cumplidas: cumplidas.length,
                incumplidas: conCita.length - cumplidas.length,
                porcentaje_cumplimiento: conCita.length > 0
                    ? Math.round((cumplidas.length / conCita.length) * 1000) / 10
                    : null
            },
            historial
        });
    } catch (error) {
        console.error("Error al obtener el historial:", error);
        res.status(500).json({ error: "Error al obtener el historial" });
    }
};

export const ocupacionesController = {
    getTablero,
    getCola,
    getCriticas,
    getInventario,
    getOcupacionById,
    promoverDeCola,
    setPrioridad,
    getHistorial
};
