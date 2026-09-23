import recepcionesModel from "../models/recepciones.model.js";
import produccionModel from "../models/produccion.model.js";
import camarasModel from "../models/camaras.model.js";

// ============================================================================
// RECEPCIONES
// ============================================================================
// req.camaras lo pone cargarAlcance:
//     null  -> Admin / Coordinador
//     [...] -> Supervisor / Operativo
//
// ⚠️ ESTE CONTROLLER NO TOCA ocupaciones_camaras
//   El INSERT en recepciones dispara los triggers que reparten la fruta
//   entre la cámara y la cola. Aquí solo se valida ANTES y se informa
//   DESPUÉS de lo que hicieron.
//
//   Por eso createRecepcion relee las ocupaciones generadas al final: es la
//   única forma honesta de decirle al operador "entraron 15 tarimas y 5
//   quedaron en cola", sin duplicar en JavaScript el cálculo que ya hizo la
//   BD (y arriesgarse a que un día dejen de coincidir).
// ============================================================================

// GET /api/preenfrio/recepciones?id_produccion=5&estado=1
const getRecepciones = async (req, res) => {
    try {
        const {
            id_produccion,
            id_camara,
            estado,
            fecha_desde,
            fecha_hasta,
            buscar
        } = req.query;

        const recepciones = await recepcionesModel.getRecepciones(
            {
                id_produccion: id_produccion ? Number(id_produccion) : null,
                id_camara: id_camara ? Number(id_camara) : null,
                estado: estado !== undefined && estado !== "" ? Number(estado) : null,
                fecha_desde: fecha_desde || null,
                fecha_hasta: fecha_hasta || null,
                buscar: buscar || null
            },
            req.camaras
        );

        res.status(200).json(recepciones);
    } catch (error) {
        console.error("Error al obtener recepciones:", error);
        res.status(500).json({ error: "Error al obtener las recepciones" });
    }
};

// GET /api/preenfrio/recepciones/:id
const getRecepcionById = async (req, res) => {
    try {
        const { id } = req.params;
        const recepcion = await recepcionesModel.getRecepcionById(id);

        if (!recepcion) {
            return res.status(404).json({ error: "Recepción no encontrada" });
        }

        // Alcance después de traerla: distingue "no existe" de "no es tuya"
        if (Array.isArray(req.camaras)) {
            if (
                recepcion.id_camara === null ||
                !req.camaras.includes(Number(recepcion.id_camara))
            ) {
                return res.status(403).json({
                    error: "No tienes acceso a esa recepción"
                });
            }
        }

        // Se adjunta lo que generaron los triggers: cuánto entró y cuánto
        // quedó esperando. Es la respuesta a "¿por qué mi fruta no está
        // dentro de la cámara?".
        const ocupaciones = await recepcionesModel.getOcupacionesGeneradas(id);

        res.status(200).json({ ...recepcion, ocupaciones });
    } catch (error) {
        console.error("Error al obtener recepcion:", error);
        res.status(500).json({ error: "Error al obtener la recepción" });
    }
};

// GET /api/preenfrio/recepciones/esperadas?semana=39
// Lo que el preenfrío espera recibir. Es la pantalla principal del andén.
const getEsperadas = async (req, res) => {
    try {
        const { semana, id_camara, todas } = req.query;

        const esperadas = await recepcionesModel.getEsperadas(
            {
                semana: semana ? Number(semana) : null,
                id_camara: id_camara ? Number(id_camara) : null,
                // Por defecto solo lo pendiente: es lo que necesita el
                // andén. ?todas=1 muestra también lo ya completado.
                solo_pendientes: todas !== "1" && todas !== "true"
            },
            req.camaras
        );

        res.status(200).json(esperadas);
    } catch (error) {
        console.error("Error al obtener las esperadas:", error);
        res.status(500).json({ error: "Error al obtener lo esperado" });
    }
};

// GET /api/preenfrio/recepciones/disponibilidad/:id_camara
// Cuánto cabe ahora mismo. El frontend la consulta al abrir el modal de
// recepción, para avisar de antemano si algo va a quedar en cola.
const getDisponibilidad = async (req, res) => {
    try {
        const { id_camara } = req.params;

        if (!id_camara || isNaN(Number(id_camara))) {
            return res.status(400).json({
                error: "El id de cámara debe ser un número válido"
            });
        }

        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(id_camara))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a esa cámara"
            });
        }

        const disponibilidad = await recepcionesModel.getDisponibilidad(id_camara);

        if (!disponibilidad) {
            return res.status(404).json({ error: "Cámara no encontrada" });
        }

        res.status(200).json(disponibilidad);
    } catch (error) {
        console.error("Error al consultar la disponibilidad:", error);
        res.status(500).json({ error: "Error al consultar la disponibilidad" });
    }
};

// ----------------------------------------------------------------------------
// POST /api/preenfrio/recepciones
// ----------------------------------------------------------------------------
// El INSERT dispara dos triggers. Aquí se valida antes y se informa después.
const createRecepcion = async (req, res) => {
    try {
        const {
            id_produccion,
            id_camara,
            tarimas_recibidas,
            cajas_recibidas,
            tarimas_ingresadas
        } = req.body;

        // ---- La producción existe y se puede recibir ----
        const produccion = await produccionModel.getProduccionById(id_produccion);

        if (!produccion) {
            return res.status(409).json({
                error: "La producción indicada no existe"
            });
        }

        if (produccion.estado === 0) {
            return res.status(409).json({
                error: `La producción ${produccion.codigo_lote} está cancelada: no se puede recibir fruta contra ella`
            });
        }

        // ---- Cámara destino ----
        // Si no se indicó, se hereda la planeada. Es lo normal: el andén
        // solo manda cámara cuando desvía el camión a otra.
        const camaraDestino = id_camara !== null ? id_camara : produccion.id_camara;

        // Alcance sobre la cámara DESTINO.
        // validarCamaraEnAlcance solo revisa el body; si la cámara se
        // heredó de la producción hay que validarla aquí.
        if (Array.isArray(req.camaras) && camaraDestino !== null) {
            if (!req.camaras.includes(Number(camaraDestino))) {
                return res.status(403).json({
                    error: "No tienes acceso a la cámara destino de esa producción"
                });
            }
        }

        // Producción sin cámara y sin cámara en el body: es CEDA directo.
        // Se permite registrar la recepción (queda el dato de que llegó),
        // pero no generará ocupación alguna.
        let avisoCamara = null;
        let disponibilidad = null;

        if (camaraDestino !== null) {
            const camara = await camarasModel.getCamaraById(camaraDestino);

            if (!camara) {
                return res.status(409).json({ error: "La cámara indicada no existe" });
            }

            if (camara.estado === 0) {
                return res.status(409).json({
                    error: `La cámara "${camara.nombre_camara}" está fuera de servicio`
                });
            }

            disponibilidad = await recepcionesModel.getDisponibilidad(camaraDestino);

            // Mantenimiento activo: fn_tarimas_disponibles devuelve 0, así
            // que TODO se iría a la cola. Se bloquea porque casi siempre es
            // un error: el operador no sabía que la cámara estaba parada.
            if (disponibilidad.en_mantenimiento) {
                return res.status(409).json({
                    error: `La cámara "${camara.nombre_camara}" está en mantenimiento: toda la fruta quedaría en cola. Libérala o elige otra cámara.`
                });
            }

            // Desvío respecto al plan: se permite (el supervisor ve el
            // patio) pero se deja constancia en la respuesta.
            if (
                produccion.id_camara !== null &&
                Number(produccion.id_camara) !== Number(camaraDestino)
            ) {
                avisoCamara = `La producción estaba planeada para "${produccion.nombre_camara}" y se recibió en "${camara.nombre_camara}".`;
            }
        }

        // ---- Sobre-recepción ----
        // No se bloquea: en campo a veces llega más de lo planeado y hay
        // que registrarlo. Pero se avisa, porque suele ser error de captura
        // o fruta de otro proceso mezclada.
        const yaRecibidas = Number(produccion.tarimas_recibidas) || 0;
        const planeadas = Number(produccion.tarimas_planeadas) || 0;
        const totalTrasEsta = yaRecibidas + Number(tarimas_recibidas);

        let avisoExceso = null;

        if (planeadas > 0 && totalTrasEsta > planeadas) {
            avisoExceso = `Con esta recepción se acumulan ${totalTrasEsta} tarimas contra ${planeadas} planeadas. Verifica que no se haya mezclado fruta de otro proceso.`;
        }

        // ---- INSERT ----
        // El id_usuario sale del token, nunca del body: es quien firma la
        // recepción y no debe poder suplantarse.
        const nueva = await recepcionesModel.createRecepcion({
            ...req.body,
            id_camara: camaraDestino,
            id_usuario: req.id_usuario
        });

        // ---- Qué hicieron los triggers ----
        const completa = await recepcionesModel.getRecepcionById(nueva.id_recepcion);
        const ocupaciones = await recepcionesModel.getOcupacionesGeneradas(
            nueva.id_recepcion
        );

        const dentro = ocupaciones.find((o) => o.tipo_ocupacion === 1);
        const enCola = ocupaciones.find((o) => o.tipo_ocupacion === 3);

        // Resumen legible de lo que pasó realmente, leído de la BD y no
        // recalculado aquí.
        let resultado;

        if (camaraDestino === null) {
            resultado = "Recepción registrada. Esta producción no pasa por preenfrío (CEDA directo): no ocupa cámara.";
        } else if (enCola) {
            resultado = `Entraron ${dentro?.cantidad_tarimas ?? 0} tarimas a "${completa.nombre_camara}" y ${enCola.cantidad_tarimas} quedaron EN COLA esperando espacio.`;
        } else {
            resultado = `Entraron ${dentro?.cantidad_tarimas ?? 0} tarimas completas a "${completa.nombre_camara}".`;
        }

        res.status(201).json({
            mensaje: "Recepción registrada correctamente",
            resultado,
            recepcion: completa,
            ocupaciones,
            avisos: [avisoCamara, avisoExceso].filter(Boolean)
        });
    } catch (error) {
        console.error("Error al crear recepcion:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "La producción o la cámara indicadas no existen"
            });
        }

        res.status(500).json({
            error: "Error al registrar la recepción" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// ----------------------------------------------------------------------------
// PUT /api/preenfrio/recepciones/:id
// ----------------------------------------------------------------------------
// Solo temperatura y observaciones. Las cantidades NO se editan: el trigger
// que reparte la fruta es AFTER INSERT y no revertiría la ocupación ya
// creada, así que un UPDATE dejaría el inventario descuadrado en silencio.
const updateRecepcion = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await recepcionesModel.getRecepcionById(id);
        if (!existente) {
            return res.status(404).json({ error: "Recepción no encontrada" });
        }

        if (Array.isArray(req.camaras)) {
            if (
                existente.id_camara === null ||
                !req.camaras.includes(Number(existente.id_camara))
            ) {
                return res.status(403).json({
                    error: "No tienes acceso a esa recepción"
                });
            }
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "La recepción está cancelada"
            });
        }

        await recepcionesModel.updateRecepcion(id, req.body);
        const completa = await recepcionesModel.getRecepcionById(id);

        res.status(200).json({
            mensaje: "Recepción actualizada. Solo se modifican temperatura y observaciones: para corregir cantidades, cancela y vuelve a capturar.",
            recepcion: completa
        });
    } catch (error) {
        console.error("Error al actualizar recepcion:", error);
        res.status(500).json({ error: "Error al actualizar la recepción" });
    }
};

// ----------------------------------------------------------------------------
// DELETE /api/preenfrio/recepciones/:id
// ----------------------------------------------------------------------------
// Cancelación (estado = 0). Dispara trg_actualizar_estado_produccion, que
// solo suma las activas, así que la producción recalcula su estado sola.
//
// ⚠️ NO devuelve las tarimas de la cámara: trg_sync_ocupacion_recepcion es
// AFTER INSERT y no se dispara al cancelar. Se avisa explícitamente para
// que el supervisor ajuste el inventario.
const cancelarRecepcion = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await recepcionesModel.getRecepcionById(id);
        if (!existente) {
            return res.status(404).json({ error: "Recepción no encontrada" });
        }

        if (Array.isArray(req.camaras)) {
            if (
                existente.id_camara === null ||
                !req.camaras.includes(Number(existente.id_camara))
            ) {
                return res.status(403).json({
                    error: "No tienes acceso a esa recepción"
                });
            }
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "La recepción ya está cancelada"
            });
        }

        const ocupaciones = await recepcionesModel.getOcupacionesGeneradas(id);
        const activas = ocupaciones.filter((o) => o.estado === 1);

        const recepcion = await recepcionesModel.cancelarRecepcion(id);

        // El aviso es la parte importante de esta respuesta: sin él, alguien
        // podría creer que cancelar vació la cámara.
        const avisos = [];

        if (activas.length > 0) {
            const tarimas = activas.reduce(
                (suma, o) => suma + Number(o.cantidad_tarimas), 0
            );
            avisos.push(
                `La cancelación NO libera la cámara automáticamente: siguen ${tarimas} tarima(s) registradas en "${existente.nombre_camara}" por esta recepción. Ajústalas con un movimiento de inventario.`
            );
        }

        res.status(200).json({
            mensaje: "Recepción cancelada. El estado de la producción se recalculó.",
            recepcion,
            ocupaciones_pendientes: activas,
            avisos
        });
    } catch (error) {
        console.error("Error al cancelar la recepcion:", error);
        res.status(500).json({ error: "Error al cancelar la recepción" });
    }
};

// PATCH /api/preenfrio/recepciones/:id/reactivar
const reactivarRecepcion = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await recepcionesModel.getRecepcionById(id);
        if (!existente) {
            return res.status(404).json({ error: "Recepción no encontrada" });
        }

        if (Array.isArray(req.camaras)) {
            if (
                existente.id_camara === null ||
                !req.camaras.includes(Number(existente.id_camara))
            ) {
                return res.status(403).json({
                    error: "No tienes acceso a esa recepción"
                });
            }
        }

        if (existente.estado !== 0) {
            return res.status(409).json({
                error: "La recepción no está cancelada"
            });
        }

        const recepcion = await recepcionesModel.reactivarRecepcion(id);

        res.status(200).json({
            mensaje: "Recepción reactivada. El estado de la producción se recalculó.",
            recepcion,
            avisos: [
                "Reactivar NO regenera las ocupaciones de cámara. Verifica el inventario si se habían ajustado a mano."
            ]
        });
    } catch (error) {
        console.error("Error al reactivar la recepcion:", error);
        res.status(500).json({ error: "Error al reactivar la recepción" });
    }
};

export const recepcionesController = {
    getRecepciones,
    getRecepcionById,
    getEsperadas,
    getDisponibilidad,
    createRecepcion,
    updateRecepcion,
    cancelarRecepcion,
    reactivarRecepcion
};
