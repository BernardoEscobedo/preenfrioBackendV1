import ocupacionesModel from "../models/ocupaciones.model.js";

// ============================================================================
// OCUPACIONES DE CÁMARA Y COLA
// ============================================================================
// req.camaras lo pone cargarAlcance:
//     null  -> Admin / Coordinador
//     [...] -> Supervisor / Operativo
//
// ⚠️ LAS FUNCIONES DE LA BD DEVUELVEN TEXTO, NO EXCEPCIONES
//   fn_promover_de_cola y fn_set_prioridad_cola regresan 'OK: ...' o el
//   motivo del rechazo ('La cámara no tiene espacio disponible', 'No existe
//   esa fila en la cola o ya fue procesada'...). NUNCA lanzan error.
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
// cámara. Alimenta las barras de ocupación del dashboard.
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

        res.status(200).json(tablero);
    } catch (error) {
        console.error("Error al obtener el tablero:", error);
        res.status(500).json({ error: "Error al obtener el tablero de cámaras" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/ocupaciones/cola
// ----------------------------------------------------------------------------
// Fruta esperando fuera de cada cámara, ya ordenada por la vista:
//   prioridad DESC → fecha_empaque ASC → llegada
// 'posicion' es el turno: 1 = el siguiente en entrar.
const getCola = async (req, res) => {
    try {
        const { id_camara } = req.query;

        const cola = await ocupacionesModel.getCola(
            { id_camara: id_camara ? Number(id_camara) : null },
            req.camaras
        );

        res.status(200).json(cola);
    } catch (error) {
        console.error("Error al obtener la cola:", error);
        res.status(500).json({ error: "Error al obtener la cola de espera" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/ocupaciones/inventario
// ----------------------------------------------------------------------------
// Lo que está FÍSICAMENTE dentro de las cámaras. Ordenado FEFO: la fruta
// más vieja primero, que es la que debería salir antes.
//
// Es la misma fuente que usará el picking de despachos.
const getInventario = async (req, res) => {
    try {
        const { id_camara, id_cc, buscar } = req.query;

        const inventario = await ocupacionesModel.getInventario(
            {
                id_camara: id_camara ? Number(id_camara) : null,
                id_cc: id_cc ? Number(id_cc) : null,
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

        // Estado después del movimiento: cuánto quedó en la cola y cómo
        // está la cámara ahora.
        const colaRestante = await ocupacionesModel.getOcupacionById(id);
        const tablero = await ocupacionesModel.getTablero(
            {},
            [Number(ocupacion.id_camara)]
        );

        res.status(200).json({
            mensaje: resultado,
            lote: ocupacion.codigo_lote,
            camara: ocupacion.nombre_camara,
            // Si la fila se cerró (estado 0), la cola se vació por completo
            cola_restante: colaRestante?.estado === 1
                ? colaRestante.cantidad_tarimas
                : 0,
            cola_cerrada: colaRestante?.estado === 0,
            camara_estado: tablero[0] ?? null
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
//   prioridad = 0  → orden normal, por fecha de empaque
//   prioridad > 0  → urgente; a mayor número, más al frente
//
// El motivo es obligatorio al priorizar: saltarse el orden de antigüedad
// tiene que quedar justificado.
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

        res.status(200).json({
            mensaje: prioridad > 0
                ? `Lote ${ocupacion.codigo_lote} priorizado (nivel ${prioridad})`
                : `Lote ${ocupacion.codigo_lote} regresado al orden normal`,
            cola
        });
    } catch (error) {
        console.error("Error al cambiar la prioridad:", error);
        res.status(500).json({ error: "Error al cambiar la prioridad" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/ocupaciones/historial
// ----------------------------------------------------------------------------
// Ocupaciones ya cerradas, con las horas que la fruta estuvo dentro. Sirve
// para reconstruir qué pasó con un lote y para medir tiempos de preenfrío.
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

        res.status(200).json(historial);
    } catch (error) {
        console.error("Error al obtener el historial:", error);
        res.status(500).json({ error: "Error al obtener el historial" });
    }
};

export const ocupacionesController = {
    getTablero,
    getCola,
    getInventario,
    getOcupacionById,
    promoverDeCola,
    setPrioridad,
    getHistorial
};
