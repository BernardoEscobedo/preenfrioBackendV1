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
//   El INSERT dispara los triggers que reparten la fruta entre la cámara y
//   la cola. Aquí solo se valida ANTES y se informa DESPUÉS.
//
// ────────────────────────────────────────────────────────────────────────
// v2.5 · CANCELAR AHORA SÍ LIBERA LA CÁMARA
// ────────────────────────────────────────────────────────────────────────
//   Hasta la v2.4, trg_sync_ocupacion_recepcion era AFTER INSERT: cancelar
//   una recepción cambiaba su estado pero dejaba la fruta contada dentro.
//   Este controller advertía de eso en la respuesta.
//
//   La v2.5 agregó trg_revertir_recepcion (AFTER UPDATE), que descuenta lo
//   que esa recepción metió y cierra su fila de cola. Los mensajes se
//   actualizaron: antes decían "la cancelación NO libera la cámara", que
//   ahora es falso.
//
//   Queda un caso que SÍ hay que seguir avisando: si parte de esa fruta ya
//   se movió a conservación o ya se despachó, la cámara solo puede
//   descontar lo que todavía tiene. El trigger corta con GREATEST(x, 0)
//   para no dejar el inventario en negativo, y aquí se detecta comparando
//   antes y después.
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
            cajas_recibidas
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
// Solo temperatura y observaciones.
//
// Las cantidades NO se editan, y esto sigue vigente en la v2.5: el trigger
// nuevo reacciona al cambio de ESTADO, no a un cambio de cantidades. Un
// UPDATE de tarimas_recibidas movería el número en la tabla sin tocar la
// ocupación.
//
// Para corregir un número hay que cancelar y volver a capturar — y ahora
// eso sí devuelve la capacidad.
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
// Cancelación (estado = 0). Dispara DOS triggers:
//
//   trg_actualizar_estado_produccion  recalcula el estado de la producción
//                                     (solo suma las recepciones activas)
//
//   trg_revertir_recepcion  ⭐ v2.5   descuenta de la cámara lo que esta
//                                     recepción metió y cierra su fila de
//                                     cola
//
// El segundo es nuevo. Antes la cámara se quedaba con la fruta contada y
// este controller lo advertía; ahora se libera sola.
//
// Lo que SÍ hay que seguir avisando: si parte de esa fruta ya se movió o se
// despachó, la cámara solo descuenta lo que todavía tiene. Se detecta
// comparando el inventario antes y después.
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

        // Foto ANTES de cancelar: es contra esto que se compara para saber
        // cuánto pudo devolver realmente el trigger.
        const antes = existente.id_camara
            ? await recepcionesModel.getDisponibilidad(existente.id_camara)
            : null;

        const recepcion = await recepcionesModel.cancelarRecepcion(id);

        // ---- Qué liberó el trigger ----
        const despues = existente.id_camara
            ? await recepcionesModel.getDisponibilidad(existente.id_camara)
            : null;

        const esperaba = Number(existente.tarimas_ingresadas ?? 0);
        const liberadas =
            antes && despues
                ? Number(despues.tarimas_disponibles) -
                  Number(antes.tarimas_disponibles)
                : 0;

        const avisos = [];

        // El caso que sigue necesitando advertencia: la fruta ya no estaba
        // toda en la cámara.
        if (existente.id_camara && liberadas < esperaba) {
            avisos.push(
                `⚠️ Esta recepción metió ${esperaba} tarima(s) pero solo se liberaron ${liberadas}: el resto ya se había movido a conservación o despachado. Revisa el inventario de "${existente.nombre_camara}".`
            );
        }

        let resultado;

        if (!existente.id_camara) {
            resultado = "Recepción cancelada. No ocupaba cámara (CEDA directo).";
        } else if (liberadas > 0) {
            resultado = `Se liberaron ${liberadas} tarima(s) en "${existente.nombre_camara}".`;
        } else if (esperaba === 0) {
            resultado = `Recepción cancelada. No había fruta dentro de la cámara que liberar.`;
        } else {
            resultado = `Recepción cancelada, pero la cámara no cambió: esa fruta ya no estaba ahí.`;
        }

        res.status(200).json({
            mensaje: "Recepción cancelada. El estado de la producción se recalculó.",
            resultado,
            recepcion,
            capacidad: despues
                ? {
                      camara: existente.nombre_camara,
                      antes: Number(antes.tarimas_disponibles),
                      despues: Number(despues.tarimas_disponibles),
                      liberadas
                  }
                : null,
            avisos
        });
    } catch (error) {
        console.error("Error al cancelar la recepcion:", error);
        res.status(500).json({ error: "Error al cancelar la recepción" });
    }
};

// ----------------------------------------------------------------------------
// PATCH /api/preenfrio/recepciones/:id/reactivar
// ----------------------------------------------------------------------------
// v2.5: trg_revertir_recepcion también cubre el camino de vuelta (0 → 1) y
// regenera la ocupación.
//
// ⚠️ Con una diferencia que SÍ hay que advertir: al reactivar, la fruta que
// originalmente quedó EN COLA se suma directo a la cámara. El trigger no
// puede reconstruir la fila de cola porque ya no se sabe si sigue habiendo
// espacio ni cuál era su lugar en el orden.
//
// En la práctica significa que una cámara puede quedar sobreocupada tras
// reactivar una recepción que había desbordado.
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

        const antes = existente.id_camara
            ? await recepcionesModel.getDisponibilidad(existente.id_camara)
            : null;

        const recepcion = await recepcionesModel.reactivarRecepcion(id);

        const despues = existente.id_camara
            ? await recepcionesModel.getDisponibilidad(existente.id_camara)
            : null;

        const avisos = [];

        // Había desbordado: lo que estaba en cola ahora entra a la cámara
        if (Number(existente.tarimas_en_cola) > 0) {
            avisos.push(
                `Esta recepción tenía ${existente.tarimas_en_cola} tarima(s) en cola. Al reactivar, todo se suma a la cámara: la fila de espera no se reconstruye porque ya no se conoce su lugar en el orden.`
            );
        }

        // La cámara quedó sobreocupada
        if (despues && Number(despues.tarimas_disponibles) < 0) {
            avisos.push(
                `⚠️ "${existente.nombre_camara}" quedó sobreocupada: ${despues.tarimas_ocupadas} tarimas contra una capacidad de ${despues.capacidad_max_tarimas}. Mueve fruta a conservación o despáchala.`
            );
        }

        res.status(200).json({
            mensaje: "Recepción reactivada. El estado de la producción se recalculó.",
            resultado: existente.id_camara
                ? `Se ocuparon de nuevo ${existente.tarimas_ingresadas ?? 0} tarima(s) en "${existente.nombre_camara}".`
                : "Recepción reactivada. No ocupaba cámara (CEDA directo).",
            recepcion,
            capacidad: despues
                ? {
                      camara: existente.nombre_camara,
                      antes: Number(antes.tarimas_disponibles),
                      despues: Number(despues.tarimas_disponibles)
                  }
                : null,
            avisos
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
