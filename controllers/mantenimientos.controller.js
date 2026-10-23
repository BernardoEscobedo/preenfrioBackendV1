import mantenimientosModel from "../models/mantenimientos.model.js";
import camarasModel from "../models/camaras.model.js";
import { aFechaISO } from "../utils/fechas.js";
import { activarMantenimientosProgramados } from "../utils/mantenimientosProgramados.js";

// ============================================================================
// MANTENIMIENTOS DE CÁMARA
// ============================================================================
// req.camaras lo pone cargarAlcance.
//
// ⚠️ ESTE MÓDULO BLOQUEA CAPACIDAD
//   Pasar un mantenimiento a estado 2 dispara
//   trg_sync_ocupacion_mantenimiento, que crea una ocupación tipo 2
//   consumiendo TODA la capacidad de la cámara. Con ese bloqueo la cámara
//   NO RECIBE FRUTA: la BD rechaza recepciones y traslados hacia ella, y la
//   cola no puede ingresar (0 espacios).
//
// TIPOS
//   1 Preventivo   se programa; bloquea A LA HORA PROGRAMADA
//   2 Correctivo   la cámara dejó de funcionar bien: bloquea al registrarlo
//   3 Emergencia   igual que correctivo, prioridad máxima
//
// OBLIGA A SACAR LA FRUTA
//   Al quedar fuera de servicio, la respuesta trae requiere_reubicar si hay
//   fruta dentro, y la pantalla abre el paso para sacarla (caja temporal,
//   otra cámara o despacho). El mantenimiento NO se puede finalizar con
//   fruta dentro: lo valida este controller y lo respalda
//   trg_mantenimiento_sin_fruta en la BD.
//
// POR QUÉ SE SIGUE IMPIDIENDO CANCELAR UNO EN PROCESO
//   Por el DATO: si la cámara estuvo parada, ese paro ocurrió y tiene que
//   quedar en el histórico de horas de paro.
//
// HORA LOCAL: sale de ZONA_HORARIA del .env, no de la zona del servidor.
// ============================================================================

const zona = () => process.env.ZONA_HORARIA || "America/Mexico_City";

/** Fecha actual en la zona de operación, como 'AAAA-MM-DD'. */
const hoyLocal = () => new Date().toLocaleDateString("sv-SE", { timeZone: zona() });

/** Hora actual en la zona de operación, como 'HH:MM:SS'. */
const horaActualISO = () =>
    new Intl.DateTimeFormat("en-GB", {
        timeZone: zona(),
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
    }).format(new Date());

/** Lleva una hora 'HH:MM' o 'HH:MM:SS' a 'HH:MM:SS' para compararla. */
const normalizarHora = (hora) => {
    const texto = String(hora ?? "00:00:00").slice(0, 8);
    return texto.length === 5 ? `${texto}:00` : texto;
};

const sinAlcance = (req, id_camara) =>
    Array.isArray(req.camaras) && !req.camaras.includes(Number(id_camara));

/** Rechazos de los triggers (P0001) con su mensaje. Devuelve true si respondió. */
const responderErrorBD = (res, error) => {
    if (error.code === "P0001") {
        res.status(409).json({ error: error.message });
        return true;
    }
    return false;
};

/** Avisos de lo que quedó dentro / en cola al bloquear. */
const avisosDeContenido = (nombre, contenido) => {
    const avisos = [
        `La cámara "${nombre}" quedó FUERA DE SERVICIO: no recibirá fruta hasta que finalices el mantenimiento.`
    ];
    if (Number(contenido.tarimas_dentro) > 0) {
        avisos.push(
            `⚠️ Hay ${contenido.tarimas_dentro} tarima(s) y ${contenido.cajas_dentro} cajas DENTRO: hay que sacarlas (caja temporal, otra cámara o despacho). El mantenimiento no se podrá finalizar con fruta dentro.`
        );
    }
    if (Number(contenido.procesos_en_cola) > 0) {
        avisos.push(
            `Hay ${contenido.procesos_en_cola} proceso(s) en cola esperando esta cámara: pásalos a una caja temporal o esperarán al fin del paro.`
        );
    }
    return avisos;
};

const requiereReubicar = (contenido) =>
    Number(contenido.tarimas_dentro) > 0 || Number(contenido.procesos_en_cola) > 0;

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
        if (sinAlcance(req, mantenimiento.id_camara)) {
            return res.status(403).json({ error: "No tienes acceso a ese mantenimiento" });
        }

        res.status(200).json(mantenimiento);
    } catch (error) {
        console.error("Error al obtener el mantenimiento:", error);
        res.status(500).json({ error: "Error al obtener el mantenimiento" });
    }
};

// GET /api/preenfrio/mantenimientos/tablero
// Cada cámara (preenfrío y conservación) con su situación. Las cajas
// temporales se consultan aparte en /temporales.
const getTablero = async (req, res) => {
    try {
        await activarMantenimientosProgramados(true);
        const camaras = (await mantenimientosModel.getTablero(req.camaras)).filter(
            (c) => Number(c.tipo_camara) !== 3
        );
        res.status(200).json({
            resumen: {
                camaras: camaras.length,
                fuera_de_servicio: camaras.filter((c) => c.bloqueada).length,
                programados: camaras.filter((c) => c.id_programado).length,
                con_fruta_por_reubicar: camaras.filter((c) => c.bloqueada && c.tarimas_dentro > 0).length
            },
            camaras
        });
    } catch (error) {
        console.error("Error al obtener el tablero:", error);
        res.status(500).json({ error: "Error al obtener el estado de las cámaras" });
    }
};

// GET /api/preenfrio/mantenimientos/camara/:id_camara/fruta
const getFrutaDentro = async (req, res) => {
    try {
        const idCamara = Number(req.params.id_camara);
        if (!Number.isInteger(idCamara) || idCamara <= 0) {
            return res.status(400).json({ error: "El id de cámara debe ser un número válido" });
        }
        if (sinAlcance(req, idCamara)) {
            return res.status(403).json({ error: "No tienes acceso a esa cámara" });
        }
        res.status(200).json(await mantenimientosModel.getFrutaDentro(idCamara));
    } catch (error) {
        console.error("Error al obtener la fruta de la cámara:", error);
        res.status(500).json({ error: "Error al obtener la fruta de la cámara" });
    }
};

// GET /api/preenfrio/mantenimientos/activos
const getActivos = async (req, res) => {
    try {
        const activos = await mantenimientosModel.getActivos(req.camaras);

        res.status(200).json({
            resumen: {
                camaras_bloqueadas: activos.length,
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

// GET /api/preenfrio/mantenimientos/bloqueos-huerfanos
const getBloqueosHuerfanos = async (req, res) => {
    try {
        const huerfanos = await mantenimientosModel.getBloqueosHuerfanos(req.camaras);

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
const getResumen = async (req, res) => {
    try {
        const { fecha_desde, fecha_hasta } = req.query;

        const resumen = await mantenimientosModel.getResumenPorCamara(
            { fecha_desde: fecha_desde || null, fecha_hasta: fecha_hasta || null },
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
// Correctivo / emergencia: nace en estado 2 y bloquea al instante.
// Preventivo: nace en estado 1 y bloquea a su hora (si ya pasó, al guardar).
const createMantenimiento = async (req, res) => {
    try {
        const { id_camara, estado } = req.body;

        const camara = await camarasModel.getCamaraById(id_camara);
        if (!camara) {
            return res.status(409).json({ error: "La cámara indicada no existe" });
        }
        if (Number(camara.estado) === 0) {
            return res.status(409).json({
                error: `La cámara "${camara.nombre_camara}" está dada de baja: no tiene sentido programarle mantenimiento.`
            });
        }
        if (Number(camara.tipo_camara) === 3) {
            return res.status(409).json({
                error: "Es una caja temporal: no se le registran mantenimientos. Si falla, pasa su fruta a otra caja."
            });
        }

        const activo = await mantenimientosModel.getActivoPorCamara(id_camara);
        if (Number(estado) === 2 && activo) {
            return res.status(409).json({
                error: `La cámara "${camara.nombre_camara}" ya está fuera de servicio desde el ${aFechaISO(activo.fecha_inicio)}: "${activo.motivo}". Finaliza ese mantenimiento o agrega el detalle en sus observaciones.`
            });
        }

        // Se consulta ANTES de bloquear
        const contenido = await mantenimientosModel.getContenidoCamara(id_camara);

        const nuevo = await mantenimientosModel.createMantenimiento({
            ...req.body,
            id_usuario: req.id_usuario ?? null
        });

        if (Number(estado) === 1) await activarMantenimientosProgramados(true);

        const completo = await mantenimientosModel.getMantenimientoById(nuevo.id_mantenimiento);
        const bloqueo = Number(completo.estado) === 2;

        const avisos = [];
        if (bloqueo) avisos.push(...avisosDeContenido(camara.nombre_camara, contenido));
        else if (activo) {
            avisos.push(
                "La cámara ya tiene otro mantenimiento en proceso: este preventivo se iniciará cuando aquel se finalice y llegue su hora."
            );
        } else {
            avisos.push(
                `La cámara sigue operando. Se pondrá fuera de servicio el ${aFechaISO(completo.fecha_inicio)} a las ${String(completo.hora_inicio).slice(0, 5)}.`
            );
        }

        res.status(201).json({
            mensaje: bloqueo
                ? `"${camara.nombre_camara}" fuera de servicio: ${completo.tipo_texto.toLowerCase()} registrado`
                : `Preventivo programado para "${camara.nombre_camara}"`,
            mantenimiento: completo,
            requiere_reubicar: bloqueo && requiereReubicar(contenido),
            id_camara: Number(id_camara),
            avisos
        });
    } catch (error) {
        console.error("Error al crear el mantenimiento:", error);
        if (responderErrorBD(res, error)) return;
        if (error.code === "23503") {
            return res.status(409).json({ error: "La cámara indicada no existe" });
        }
        res.status(500).json({
            error: "Error al crear el mantenimiento" + (error.message ? `: ${error.message}` : "")
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
        if (sinAlcance(req, existente.id_camara)) {
            return res.status(403).json({ error: "No tienes acceso a ese mantenimiento" });
        }
        if ([3, 4].includes(Number(existente.estado))) {
            return res.status(409).json({
                error: `El mantenimiento está ${existente.estado_texto.toLowerCase()}: ya no se puede editar.`
            });
        }

        await mantenimientosModel.updateMantenimiento(id, req.body);
        if (Number(existente.estado) === 1) await activarMantenimientosProgramados(true);
        const completo = await mantenimientosModel.getMantenimientoById(id);

        res.status(200).json({ mensaje: "Mantenimiento actualizado", mantenimiento: completo });
    } catch (error) {
        console.error("Error al actualizar el mantenimiento:", error);
        if (responderErrorBD(res, error)) return;
        res.status(500).json({ error: "Error al actualizar el mantenimiento" });
    }
};

// ----------------------------------------------------------------------------
// PATCH /api/preenfrio/mantenimientos/:id/iniciar
// ----------------------------------------------------------------------------
// Iniciar YA un preventivo programado (por ejemplo, el técnico llegó antes).
const iniciarMantenimiento = async (req, res) => {
    try {
        const { id } = req.params;
        const fecha = req.body.fecha ?? hoyLocal();
        const hora = normalizarHora(req.body.hora ?? horaActualISO());

        const existente = await mantenimientosModel.getMantenimientoById(id);
        if (!existente) {
            return res.status(404).json({ error: "Mantenimiento no encontrado" });
        }
        if (sinAlcance(req, existente.id_camara)) {
            return res.status(403).json({ error: "No tienes acceso a ese mantenimiento" });
        }
        if (Number(existente.estado) === 2) {
            return res.status(409).json({ error: "El mantenimiento ya está en proceso" });
        }
        if ([3, 4].includes(Number(existente.estado))) {
            return res.status(409).json({
                error: `El mantenimiento está ${existente.estado_texto.toLowerCase()}: crea uno nuevo si hace falta parar la cámara otra vez.`
            });
        }

        const activo = await mantenimientosModel.getActivoPorCamara(existente.id_camara, Number(id));
        if (activo) {
            return res.status(409).json({
                error: `La cámara "${existente.nombre_camara}" ya tiene otro mantenimiento en proceso: "${activo.motivo}". Finalízalo primero.`
            });
        }

        const contenido = await mantenimientosModel.getContenidoCamara(existente.id_camara);

        await mantenimientosModel.iniciarMantenimiento(id, { fecha, hora });
        const completo = await mantenimientosModel.getMantenimientoById(id);

        res.status(200).json({
            mensaje: `Mantenimiento iniciado en "${completo.nombre_camara}"`,
            mantenimiento: completo,
            contenido_al_bloquear: contenido,
            requiere_reubicar: requiereReubicar(contenido),
            id_camara: Number(existente.id_camara),
            avisos: avisosDeContenido(completo.nombre_camara, contenido)
        });
    } catch (error) {
        console.error("Error al iniciar el mantenimiento:", error);
        if (responderErrorBD(res, error)) return;
        res.status(500).json({ error: "Error al iniciar el mantenimiento" });
    }
};

// ----------------------------------------------------------------------------
// PATCH /api/preenfrio/mantenimientos/:id/finalizar
// ----------------------------------------------------------------------------
// estado 2 → 3. La cámara vuelve a recibir fruta. No se permite con fruta
// dentro: el paro obliga a sacarla.
const finalizarMantenimiento = async (req, res) => {
    try {
        const { id } = req.params;
        const existente = await mantenimientosModel.getMantenimientoById(id);

        if (!existente) {
            return res.status(404).json({ error: "Mantenimiento no encontrado" });
        }
        if (sinAlcance(req, existente.id_camara)) {
            return res.status(403).json({ error: "No tienes acceso a ese mantenimiento" });
        }
        if (Number(existente.estado) !== 2) {
            return res.status(409).json({
                error: `Solo se puede finalizar un mantenimiento en proceso. Este está ${existente.estado_texto.toLowerCase()}.`
            });
        }

        // ---- La fruta tuvo que salir ----
        const contenido = await mantenimientosModel.getContenidoCamara(existente.id_camara);
        if (Number(contenido.tarimas_dentro) > 0) {
            return res.status(409).json({
                error: `"${existente.nombre_camara}" todavía tiene ${contenido.tarimas_dentro} tarima(s) dentro. Sácala (caja temporal, otra cámara o despacho) antes de finalizar.`
            });
        }

        const fechaFin = req.body.fecha ?? hoyLocal();
        const horaFin = normalizarHora(req.body.hora ?? horaActualISO());

        // El fin no puede ser antes del inicio
        const inicio = `${aFechaISO(existente.fecha_inicio)}T${normalizarHora(existente.hora_inicio)}`;
        const fin = `${fechaFin}T${horaFin}`;
        if (fin < inicio) {
            return res.status(400).json({
                error: `El cierre (${fechaFin} ${horaFin.slice(0, 5)}) no puede ser anterior al inicio del mantenimiento (${inicio.replace("T", " ").slice(0, 16)}).`
            });
        }

        await mantenimientosModel.finalizarMantenimiento(id, {
            fecha: fechaFin,
            hora: horaFin,
            comentario: req.body.comentario,
            id_usuario: req.id_usuario ?? null
        });
        const completo = await mantenimientosModel.getMantenimientoById(id);

        const avisos = [];
        if (completo.estado_bloqueo === 1) {
            avisos.push(
                "⚠️ La ocupación de bloqueo sigue activa. Revisa /mantenimientos/bloqueos-huerfanos y libérala manualmente."
            );
        }
        avisos.push("Si hay fruta en una caja temporal de esta cámara, reingrésala desde Mantenimientos › Cajas temporales.");

        await activarMantenimientosProgramados(true);

        res.status(200).json({
            mensaje: `"${completo.nombre_camara}" vuelve a operar tras ${completo.horas_paro} horas fuera de servicio.`,
            mantenimiento: completo,
            avisos
        });
    } catch (error) {
        console.error("Error al finalizar el mantenimiento:", error);
        if (responderErrorBD(res, error)) return;
        res.status(500).json({ error: "Error al finalizar el mantenimiento" });
    }
};

// ----------------------------------------------------------------------------
// DELETE /api/preenfrio/mantenimientos/:id  → cancelar
// ----------------------------------------------------------------------------
// estado 1 → 4. Solo desde 'programado'.
const cancelarMantenimiento = async (req, res) => {
    try {
        const { id } = req.params;
        const existente = await mantenimientosModel.getMantenimientoById(id);

        if (!existente) {
            return res.status(404).json({ error: "Mantenimiento no encontrado" });
        }
        if (sinAlcance(req, existente.id_camara)) {
            return res.status(403).json({ error: "No tienes acceso a ese mantenimiento" });
        }
        if (Number(existente.estado) === 2) {
            return res.status(409).json({
                error: `No se puede cancelar un mantenimiento que ya está en proceso: la cámara "${existente.nombre_camara}" sí estuvo parada y ese paro debe quedar en el histórico. Usa "finalizar".`
            });
        }
        if ([3, 4].includes(Number(existente.estado))) {
            return res.status(409).json({ error: `El mantenimiento ya está ${existente.estado_texto.toLowerCase()}` });
        }

        const comentario = req.body?.comentario ? String(req.body.comentario).trim().slice(0, 500) : null;
        const cancelado = await mantenimientosModel.cancelarMantenimiento(id, {
            comentario,
            id_usuario: req.id_usuario ?? null
        });

        res.status(200).json({
            mensaje: `Preventivo cancelado. La cámara "${existente.nombre_camara}" sigue operando.`,
            mantenimiento: cancelado
        });
    } catch (error) {
        console.error("Error al cancelar el mantenimiento:", error);
        if (responderErrorBD(res, error)) return;
        res.status(500).json({ error: "Error al cancelar el mantenimiento" });
    }
};

// ----------------------------------------------------------------------------
// POST /api/preenfrio/mantenimientos/bloqueos/:id_ocupacion/liberar
// ----------------------------------------------------------------------------
const liberarBloqueo = async (req, res) => {
    try {
        const { id_ocupacion } = req.params;

        if (!id_ocupacion || isNaN(Number(id_ocupacion))) {
            return res.status(400).json({ error: "El id de ocupación debe ser un número válido" });
        }

        const huerfanos = await mantenimientosModel.getBloqueosHuerfanos(req.camaras);
        const esHuerfano = huerfanos.some((h) => Number(h.id_ocupacion) === Number(id_ocupacion));

        if (!esHuerfano) {
            return res.status(409).json({
                error: "Esa ocupación no es un bloqueo huérfano: o no existe, o su mantenimiento sigue en proceso, o no tienes acceso a esa cámara. Para liberar una cámara en mantenimiento activo, finaliza el mantenimiento."
            });
        }

        const liberado = await mantenimientosModel.cerrarBloqueo(id_ocupacion);
        if (!liberado) {
            return res.status(409).json({ error: "No se pudo liberar: la ocupación ya estaba cerrada" });
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
        if (existente.id_ocupacion_bloqueo) {
            return res.status(409).json({
                error: "No se puede eliminar: este mantenimiento llegó a bloquear la cámara y su registro es parte del histórico de paros."
            });
        }

        const eliminado = await mantenimientosModel.deleteMantenimiento(id);
        res.status(200).json({ mensaje: "Mantenimiento eliminado", mantenimiento: eliminado });
    } catch (error) {
        console.error("Error al eliminar el mantenimiento:", error);
        if (error.code === "23503") {
            return res.status(409).json({ error: "No se puede eliminar: tiene ocupaciones asociadas" });
        }
        res.status(500).json({ error: "Error al eliminar el mantenimiento" });
    }
};

export const mantenimientosController = {
    getMantenimientos,
    getMantenimientoById,
    getTablero,
    getFrutaDentro,
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
