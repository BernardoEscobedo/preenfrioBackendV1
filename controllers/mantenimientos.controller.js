import mantenimientosModel from "../models/mantenimientos.model.js";
import camarasModel from "../models/camaras.model.js";

// ============================================================================
// MANTENIMIENTOS DE CÁMARA
// ============================================================================
// req.camaras lo pone cargarAlcance.
//
// ⚠️ ESTE MÓDULO BLOQUEA CAPACIDAD
//   Pasar un mantenimiento a estado 2 dispara
//   trg_sync_ocupacion_mantenimiento, que crea una ocupación tipo 2
//   consumiendo TODA la capacidad de la cámara. A partir de ahí
//   fn_tarimas_disponibles devuelve 0 y toda la fruta que llegue se va a la
//   cola.
//
//   Por eso iniciar es una acción aparte, con su propio endpoint y sus
//   propias advertencias: no debería poder dispararse por accidente al
//   guardar un formulario.
//
// ⚠️ EL HUECO DEL TRIGGER: EL ESTADO 4
//   trg_sync_ocupacion_mantenimiento solo tiene dos ramas:
//     · estado → 2  crea la ocupación de bloqueo
//     · estado → 3  la cierra
//
//   No hay rama para el 4 (cancelado). Si un mantenimiento pasa de 2 a 4,
//   la ocupación tipo 2 queda ACTIVA para siempre y la cámara nunca vuelve
//   a recibir fruta.
//
//   Este controller lo impide: desde 'en proceso' solo se puede finalizar.
//   Y para los casos que ya quedaron trabados —por una cancelación hecha
//   directo en la BD, por ejemplo— están getBloqueosHuerfanos y
//   cerrarBloqueo.
// ============================================================================

// GET /api/preenfrio/mantenimientos?estado=2&id_camara=1
const getMantenimientos = async (req, res) => {
    try {
        const { id_camara, estado, tipo, fecha_desde, fecha_hasta } = req.query;

        const mantenimientos = await mantenimientosModel.getMantenimientos(
            {
                id_camara: id_camara ? Number(id_camara) : null,
                estado: estado !== undefined && estado !== "" ? Number(estado) : null,
                tipo: tipo ? Number(tipo) : null,
                fecha_desde: fecha_desde || null,
                fecha_hasta: fecha_hasta || null
            },
            req.camaras
        );

        res.status(200).json(mantenimientos);
    } catch (error) {
        console.error("Error al obtener mantenimientos:", error);
        res.status(500).json({ error: "Error al obtener los mantenimientos" });
    }
};

// GET /api/preenfrio/mantenimientos/:id
const getMantenimientoById = async (req, res) => {
    try {
        const { id } = req.params;
        const mantenimiento = await mantenimientosModel.getMantenimientoById(id);

        if (!mantenimiento) {
            return res.status(404).json({ error: "Mantenimiento no encontrado" });
        }

        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(mantenimiento.id_camara))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a ese mantenimiento"
            });
        }

        res.status(200).json(mantenimiento);
    } catch (error) {
        console.error("Error al obtener el mantenimiento:", error);
        res.status(500).json({ error: "Error al obtener el mantenimiento" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/mantenimientos/activos
// ----------------------------------------------------------------------------
// Los que están bloqueando cámaras ahora mismo. Es la respuesta a "¿por qué
// esta cámara no recibe fruta si está vacía?".
const getActivos = async (req, res) => {
    try {
        const activos = await mantenimientosModel.getActivos(req.camaras);

        res.status(200).json({
            resumen: {
                camaras_bloqueadas: activos.length,
                // El paro más largo: si lleva días, alguien debería saberlo
                horas_paro_maximo: activos.length
                    ? Math.max(...activos.map((a) => Number(a.horas_paro) || 0))
                    : 0
            },
            mantenimientos: activos
        });
    } catch (error) {
        console.error("Error al obtener los activos:", error);
        res.status(500).json({ error: "Error al obtener los mantenimientos activos" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/mantenimientos/bloqueos-huerfanos
// ----------------------------------------------------------------------------
// Ocupaciones tipo 2 activas cuyo mantenimiento ya no está en proceso.
// No deberían existir, pero el trigger no cubre el estado 4 y una
// cancelación hecha directo en la BD las dejaría así.
//
// Es la herramienta de diagnóstico para una cámara trabada.
const getBloqueosHuerfanos = async (req, res) => {
    try {
        const huerfanos = await mantenimientosModel.getBloqueosHuerfanos(
            req.camaras
        );

        res.status(200).json({
            resumen: {
                total: huerfanos.length,
                mensaje: huerfanos.length > 0
                    ? "Estas cámaras están bloqueadas sin un mantenimiento en proceso que lo justifique. Libéralas con POST /bloqueos/:id_ocupacion/liberar."
                    : "No hay bloqueos huérfanos: todas las cámaras bloqueadas tienen su mantenimiento activo."
            },
            bloqueos: huerfanos
        });
    } catch (error) {
        console.error("Error al obtener los bloqueos huerfanos:", error);
        res.status(500).json({ error: "Error al obtener los bloqueos" });
    }
};

// GET /api/preenfrio/mantenimientos/resumen?fecha_desde=...
// Horas de paro por cámara. Insumo para decidir si un equipo ya necesita
// reemplazo.
const getResumen = async (req, res) => {
    try {
        const { fecha_desde, fecha_hasta } = req.query;

        const resumen = await mantenimientosModel.getResumenPorCamara(
            {
                fecha_desde: fecha_desde || null,
                fecha_hasta: fecha_hasta || null
            },
            req.camaras
        );

        res.status(200).json(resumen);
    } catch (error) {
        console.error("Error al obtener el resumen:", error);
        res.status(500).json({ error: "Error al obtener el resumen" });
    }
};

// ----------------------------------------------------------------------------
// POST /api/preenfrio/mantenimientos
// ----------------------------------------------------------------------------
// Si nace con estado 2, la cámara se bloquea de inmediato.
const createMantenimiento = async (req, res) => {
    try {
        const { id_camara, estado } = req.body;

        // ---- La cámara existe y opera ----
        const camara = await camarasModel.getCamaraById(id_camara);

        if (!camara) {
            return res.status(409).json({ error: "La cámara indicada no existe" });
        }

        if (camara.estado === 0) {
            return res.status(409).json({
                error: `La cámara "${camara.nombre_camara}" está dada de baja: no tiene sentido programarle mantenimiento.`
            });
        }

        // ---- No puede haber dos bloqueos activos ----
        // Dos ocupaciones tipo 2 sobre la misma cámara dejarían una
        // huérfana al finalizar la primera, y la cámara seguiría trabada.
        if (Number(estado) === 2) {
            const activo = await mantenimientosModel.getActivoPorCamara(id_camara);

            if (activo) {
                return res.status(409).json({
                    error: `La cámara "${camara.nombre_camara}" ya tiene un mantenimiento en proceso desde el ${activo.fecha_inicio}: "${activo.motivo}". Finalízalo antes de iniciar otro.`
                });
            }
        }

        const nuevo = await mantenimientosModel.createMantenimiento(req.body);
        const completo = await mantenimientosModel.getMantenimientoById(
            nuevo.id_mantenimiento
        );

        const avisos = [];

        // Si nació bloqueando, hay que decir qué pasó con la fruta que
        // estaba adentro.
        if (Number(estado) === 2) {
            const contenido = await mantenimientosModel.getContenidoCamara(id_camara);

            avisos.push(
                `La cámara "${camara.nombre_camara}" quedó BLOQUEADA: no recibirá fruta hasta que finalices el mantenimiento.`
            );

            if (Number(contenido.tarimas_dentro) > 0) {
                avisos.push(
                    `⚠️ Hay ${contenido.tarimas_dentro} tarima(s) DENTRO de la cámara. El bloqueo no las saca: impide que entren más. Si el mantenimiento requiere vaciarla, muévelas antes.`
                );
            }

            if (Number(contenido.procesos_en_cola) > 0) {
                avisos.push(
                    `Hay ${contenido.procesos_en_cola} proceso(s) en cola esperando esta cámara: no podrán ingresar mientras dure el paro.`
                );
            }
        }

        res.status(201).json({
            mensaje: Number(estado) === 2
                ? `Mantenimiento iniciado en "${camara.nombre_camara}"`
                : `Mantenimiento programado para "${camara.nombre_camara}"`,
            mantenimiento: completo,
            avisos
        });
    } catch (error) {
        console.error("Error al crear el mantenimiento:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "La cámara indicada no existe"
            });
        }

        res.status(500).json({
            error: "Error al crear el mantenimiento" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/mantenimientos/:id
// Solo datos administrativos. El estado va por sus propios endpoints.
const updateMantenimiento = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await mantenimientosModel.getMantenimientoById(id);

        if (!existente) {
            return res.status(404).json({ error: "Mantenimiento no encontrado" });
        }

        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(existente.id_camara))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a ese mantenimiento"
            });
        }

        // Un mantenimiento cerrado es histórico: editarlo cambiaría las
        // horas de paro que ya se reportaron.
        if ([3, 4].includes(Number(existente.estado))) {
            return res.status(409).json({
                error: `El mantenimiento está ${existente.estado_texto.toLowerCase()}: ya no se puede editar.`
            });
        }

        await mantenimientosModel.updateMantenimiento(id, req.body);
        const completo = await mantenimientosModel.getMantenimientoById(id);

        res.status(200).json({
            mensaje: "Mantenimiento actualizado",
            mantenimiento: completo
        });
    } catch (error) {
        console.error("Error al actualizar el mantenimiento:", error);
        res.status(500).json({ error: "Error al actualizar el mantenimiento" });
    }
};

// ----------------------------------------------------------------------------
// PATCH /api/preenfrio/mantenimientos/:id/iniciar
// ----------------------------------------------------------------------------
// estado 1 → 2. El trigger crea la ocupación tipo 2 que bloquea TODA la
// capacidad de la cámara.
const iniciarMantenimiento = async (req, res) => {
    try {
        const { id } = req.params;
        const { fecha, hora } = req.body;

        const existente = await mantenimientosModel.getMantenimientoById(id);

        if (!existente) {
            return res.status(404).json({ error: "Mantenimiento no encontrado" });
        }

        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(existente.id_camara))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a ese mantenimiento"
            });
        }

        if (Number(existente.estado) === 2) {
            return res.status(409).json({
                error: "El mantenimiento ya está en proceso"
            });
        }

        if ([3, 4].includes(Number(existente.estado))) {
            return res.status(409).json({
                error: `El mantenimiento está ${existente.estado_texto.toLowerCase()}: crea uno nuevo si hace falta parar la cámara otra vez.`
            });
        }

        // Dos bloqueos activos sobre la misma cámara dejarían uno huérfano
        const activo = await mantenimientosModel.getActivoPorCamara(
            existente.id_camara,
            Number(id)
        );

        if (activo) {
            return res.status(409).json({
                error: `La cámara "${existente.nombre_camara}" ya tiene otro mantenimiento en proceso: "${activo.motivo}". Finalízalo primero.`
            });
        }

        // Se consulta ANTES de bloquear: después la ocupación tipo 2 se
        // mezclaría con el conteo.
        const contenido = await mantenimientosModel.getContenidoCamara(
            existente.id_camara
        );

        await mantenimientosModel.iniciarMantenimiento(id, { fecha, hora });
        const completo = await mantenimientosModel.getMantenimientoById(id);

        const avisos = [
            `La cámara "${completo.nombre_camara}" quedó BLOQUEADA: fn_tarimas_disponibles devolverá 0 y toda la fruta que llegue se irá a la cola.`
        ];

        if (Number(contenido.tarimas_dentro) > 0) {
            avisos.push(
                `⚠️ Hay ${contenido.tarimas_dentro} tarima(s) DENTRO. El bloqueo no las saca: impide que entren más. Si el trabajo requiere vaciar la cámara, muévelas con un movimiento de inventario.`
            );
        }

        if (Number(contenido.procesos_en_cola) > 0) {
            avisos.push(
                `Hay ${contenido.procesos_en_cola} proceso(s) en cola que no podrán ingresar durante el paro.`
            );
        }

        res.status(200).json({
            mensaje: `Mantenimiento iniciado en "${completo.nombre_camara}"`,
            mantenimiento: completo,
            contenido_al_bloquear: contenido,
            avisos
        });
    } catch (error) {
        console.error("Error al iniciar el mantenimiento:", error);
        res.status(500).json({ error: "Error al iniciar el mantenimiento" });
    }
};

// ----------------------------------------------------------------------------
// PATCH /api/preenfrio/mantenimientos/:id/finalizar
// ----------------------------------------------------------------------------
// estado 2 → 3. El trigger cierra la ocupación tipo 2 y la cámara vuelve a
// recibir fruta.
const finalizarMantenimiento = async (req, res) => {
    try {
        const { id } = req.params;
        const { fecha, hora } = req.body;

        const existente = await mantenimientosModel.getMantenimientoById(id);

        if (!existente) {
            return res.status(404).json({ error: "Mantenimiento no encontrado" });
        }

        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(existente.id_camara))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a ese mantenimiento"
            });
        }

        if (Number(existente.estado) !== 2) {
            return res.status(409).json({
                error: `Solo se puede finalizar un mantenimiento en proceso. Este está ${existente.estado_texto.toLowerCase()}.`
            });
        }

        await mantenimientosModel.finalizarMantenimiento(id, { fecha, hora });
        const completo = await mantenimientosModel.getMantenimientoById(id);

        // Verificación: el trigger debió cerrar la ocupación de bloqueo.
        // Si sigue activa, algo falló y hay que avisarlo en vez de dar por
        // hecho que la cámara se liberó.
        const avisos = [];

        if (completo.estado_bloqueo === 1) {
            avisos.push(
                "⚠️ La ocupación de bloqueo sigue activa. Revisa /mantenimientos/bloqueos-huerfanos y libérala manualmente."
            );
        }

        res.status(200).json({
            mensaje: `Mantenimiento finalizado: "${completo.nombre_camara}" vuelve a estar disponible tras ${completo.horas_paro} horas de paro.`,
            mantenimiento: completo,
            avisos
        });
    } catch (error) {
        console.error("Error al finalizar el mantenimiento:", error);
        res.status(500).json({ error: "Error al finalizar el mantenimiento" });
    }
};

// ----------------------------------------------------------------------------
// DELETE /api/preenfrio/mantenimientos/:id  → cancelar
// ----------------------------------------------------------------------------
// estado 1 → 4. SOLO desde 'programado'.
//
// ⚠️ Cancelar uno EN PROCESO dejaría su ocupación tipo 2 activa para
// siempre: el trigger no tiene rama para el estado 4. Por eso se bloquea y
// se obliga a finalizar, que sí libera la cámara.
const cancelarMantenimiento = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await mantenimientosModel.getMantenimientoById(id);

        if (!existente) {
            return res.status(404).json({ error: "Mantenimiento no encontrado" });
        }

        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(existente.id_camara))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a ese mantenimiento"
            });
        }

        // El bloqueo clave de este módulo
        if (Number(existente.estado) === 2) {
            return res.status(409).json({
                error: `No se puede cancelar un mantenimiento EN PROCESO: la cámara "${existente.nombre_camara}" quedaría bloqueada permanentemente. Usa "finalizar" para liberarla.`
            });
        }

        if (Number(existente.estado) === 3) {
            return res.status(409).json({
                error: "El mantenimiento ya está finalizado"
            });
        }

        if (Number(existente.estado) === 4) {
            return res.status(409).json({
                error: "El mantenimiento ya está cancelado"
            });
        }

        const cancelado = await mantenimientosModel.cancelarMantenimiento(id);

        res.status(200).json({
            mensaje: `Mantenimiento cancelado. La cámara "${existente.nombre_camara}" nunca se bloqueó.`,
            mantenimiento: cancelado
        });
    } catch (error) {
        console.error("Error al cancelar el mantenimiento:", error);
        res.status(500).json({ error: "Error al cancelar el mantenimiento" });
    }
};

// ----------------------------------------------------------------------------
// POST /api/preenfrio/mantenimientos/bloqueos/:id_ocupacion/liberar
// ----------------------------------------------------------------------------
// Salida de emergencia: cierra a mano una ocupación tipo 2 que quedó
// trabada. Solo admin.
//
// Existe porque el trigger no cubre el estado 4: si alguien canceló un
// mantenimiento en proceso directo en la BD, la cámara se queda bloqueada
// sin forma de liberarla desde la aplicación.
const liberarBloqueo = async (req, res) => {
    try {
        const { id_ocupacion } = req.params;

        if (!id_ocupacion || isNaN(Number(id_ocupacion))) {
            return res.status(400).json({
                error: "El id de ocupación debe ser un número válido"
            });
        }

        // Se valida que sea realmente huérfana: liberar el bloqueo de un
        // mantenimiento EN PROCESO dejaría la cámara recibiendo fruta
        // mientras el técnico sigue trabajando adentro.
        const huerfanos = await mantenimientosModel.getBloqueosHuerfanos(
            req.camaras
        );

        const esHuerfano = huerfanos.some(
            (h) => Number(h.id_ocupacion) === Number(id_ocupacion)
        );

        if (!esHuerfano) {
            return res.status(409).json({
                error: "Esa ocupación no es un bloqueo huérfano: o no existe, o su mantenimiento sigue en proceso, o no tienes acceso a esa cámara. Para liberar una cámara en mantenimiento activo, finaliza el mantenimiento."
            });
        }

        const liberado = await mantenimientosModel.cerrarBloqueo(id_ocupacion);

        if (!liberado) {
            return res.status(409).json({
                error: "No se pudo liberar: la ocupación ya estaba cerrada"
            });
        }

        res.status(200).json({
            mensaje: "Bloqueo liberado manualmente. La cámara vuelve a tener capacidad disponible.",
            ocupacion: liberado
        });
    } catch (error) {
        console.error("Error al liberar el bloqueo:", error);
        res.status(500).json({ error: "Error al liberar el bloqueo" });
    }
};

// DELETE /api/preenfrio/mantenimientos/:id/eliminar
// Borrado físico. Solo para un alta mal capturada que nunca bloqueó nada.
const deleteMantenimiento = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await mantenimientosModel.getMantenimientoById(id);

        if (!existente) {
            return res.status(404).json({ error: "Mantenimiento no encontrado" });
        }

        if (Number(existente.estado) === 2) {
            return res.status(409).json({
                error: "No se puede eliminar un mantenimiento en proceso: finalízalo primero para liberar la cámara."
            });
        }

        // Si generó una ocupación, borrarlo rompería la FK y además
        // perdería el registro del paro.
        if (existente.id_ocupacion_bloqueo) {
            return res.status(409).json({
                error: "No se puede eliminar: este mantenimiento llegó a bloquear la cámara y su registro es parte del histórico de paros."
            });
        }

        const eliminado = await mantenimientosModel.deleteMantenimiento(id);

        res.status(200).json({
            mensaje: "Mantenimiento eliminado",
            mantenimiento: eliminado
        });
    } catch (error) {
        console.error("Error al eliminar el mantenimiento:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "No se puede eliminar: tiene ocupaciones asociadas"
            });
        }

        res.status(500).json({ error: "Error al eliminar el mantenimiento" });
    }
};

export const mantenimientosController = {
    getMantenimientos,
    getMantenimientoById,
    getActivos,
    getBloqueosHuerfanos,
    getResumen,
    createMantenimiento,
    updateMantenimiento,
    iniciarMantenimiento,
    finalizarMantenimiento,
    cancelarMantenimiento,
    liberarBloqueo,
    deleteMantenimiento
};
