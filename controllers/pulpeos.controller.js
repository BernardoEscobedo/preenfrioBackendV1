import pulpeosModel from "../models/pulpeos.model.js";
import bloquesModel from "../models/bloques.model.js";

// ============================================================================
// PULPEOS — CONTROL DE TEMPERATURA
// ============================================================================
// req.camaras lo pone cargarAlcance. El alcance se resuelve por las cámaras
// donde está la fruta del bloque, igual que en el módulo de bloques.
//
// EL PULPEO ES EVIDENCIA
//   Estos números son lo que se presenta ante un reclamo por cadena de
//   frío. Por eso:
//     · las temperaturas NO se editan (una lectura es un hecho puntual)
//     · cancelar no borra (dejaría un hueco en la secuencia)
//     · siempre se registra quién la tomó, desde el token
// ============================================================================

/** Valida acceso a los pulpeos de un bloque. */
const validarAlcanceBloque = async (id_bloque, camaras) => {
    if (!Array.isArray(camaras)) return null;

    const camarasDelBloque = await bloquesModel.getCamarasDelBloque(id_bloque);

    if (camarasDelBloque.length === 0) return null;

    const tieneAcceso = camarasDelBloque.some((c) => camaras.includes(c));

    if (!tieneAcceso) {
        return {
            status: 403,
            error: "No tienes acceso a ese bloque: su fruta está en otras cámaras"
        };
    }

    return null;
};

// GET /api/preenfrio/pulpeos?id_bloque=3&fuera_de_objetivo=1
const getPulpeos = async (req, res) => {
    try {
        const {
            id_bloque,
            estado,
            fuera_de_objetivo,
            fecha_desde,
            fecha_hasta
        } = req.query;

        const pulpeos = await pulpeosModel.getPulpeos(
            {
                id_bloque: id_bloque ? Number(id_bloque) : null,
                estado: estado !== undefined && estado !== "" ? Number(estado) : null,
                solo_fuera_de_objetivo:
                    fuera_de_objetivo === "1" || fuera_de_objetivo === "true",
                fecha_desde: fecha_desde || null,
                fecha_hasta: fecha_hasta || null
            },
            req.camaras
        );

        res.status(200).json(pulpeos);
    } catch (error) {
        console.error("Error al obtener pulpeos:", error);
        res.status(500).json({ error: "Error al obtener los pulpeos" });
    }
};

// GET /api/preenfrio/pulpeos/:id
const getPulpeoById = async (req, res) => {
    try {
        const { id } = req.params;
        const pulpeo = await pulpeosModel.getPulpeoById(id);

        if (!pulpeo) {
            return res.status(404).json({ error: "Pulpeo no encontrado" });
        }

        const problema = await validarAlcanceBloque(pulpeo.id_bloque, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        const detalle = await pulpeosModel.getDetalle(id);

        res.status(200).json({ ...pulpeo, detalle });
    } catch (error) {
        console.error("Error al obtener el pulpeo:", error);
        res.status(500).json({ error: "Error al obtener el pulpeo" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/pulpeos/pendientes
// ----------------------------------------------------------------------------
// Bloques que necesitan medición: los que nunca se pulpearon, los que llevan
// horas sin lectura y los que no alcanzaron su objetivo.
//
// Es el reporte de pendientes del turno.
const getPendientes = async (req, res) => {
    try {
        const { horas } = req.query;

        // 4 horas por defecto: el intervalo típico entre mediciones durante
        // el ciclo de preenfrío.
        const umbral = horas ? Number(horas) : 4;

        const pendientes = await pulpeosModel.getPendientes(umbral, req.camaras);

        const sinPulpeo = pendientes.filter((p) => p.situacion === "SIN_PULPEO");
        const fueraObjetivo = pendientes.filter(
            (p) => p.situacion === "FUERA_DE_OBJETIVO"
        );
        const sinMedir = pendientes.filter((p) => p.situacion === "AL_DIA");

        res.status(200).json({
            resumen: {
                total: pendientes.length,
                sin_pulpeo: sinPulpeo.length,
                fuera_de_objetivo: fueraObjetivo.length,
                sin_medicion_reciente: sinMedir.length,
                umbral_horas: umbral
            },
            // Agrupados por acción: cada grupo se atiende distinto
            sin_pulpeo: sinPulpeo,
            fuera_de_objetivo: fueraObjetivo,
            sin_medicion_reciente: sinMedir
        });
    } catch (error) {
        console.error("Error al obtener los pendientes:", error);
        res.status(500).json({ error: "Error al obtener los pendientes" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/pulpeos/curva/:id_bloque
// ----------------------------------------------------------------------------
// La curva de enfriamiento: todas las mediciones en orden, con las horas
// transcurridas y cuánto bajó entre una y otra.
//
// Es el gráfico que demuestra la cadena de frío ante el cliente.
const getCurva = async (req, res) => {
    try {
        const { id_bloque } = req.params;

        if (!id_bloque || isNaN(Number(id_bloque))) {
            return res.status(400).json({
                error: "El id de bloque debe ser un número válido"
            });
        }

        const bloque = await bloquesModel.getBloqueById(id_bloque);

        if (!bloque) {
            return res.status(404).json({ error: "Bloque no encontrado" });
        }

        const problema = await validarAlcanceBloque(id_bloque, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        const curva = await pulpeosModel.getCurva(id_bloque);

        const ultima = curva[curva.length - 1] ?? null;

        res.status(200).json({
            bloque: {
                id_bloque: bloque.id_bloque,
                codigo_bloque: bloque.codigo_bloque,
                fecha_hora_armado: bloque.fecha_hora_armado,
                temperatura_ingreso: bloque.temperatura_ingreso,
                horas_desde_armado: bloque.horas_desde_armado
            },
            resumen: {
                mediciones: curva.length,
                temperatura_actual: ultima?.temperatura_promedio ?? null,
                objetivo: ultima?.temperatura_objetivo ?? null,
                // El dato que decide si la fruta puede salir del preenfrío
                alcanzo_objetivo: ultima
                    ? Number(ultima.temperatura_promedio) <=
                      Number(ultima.temperatura_objetivo)
                    : null,
                // Cuánto bajó desde que se armó: mide la eficiencia del
                // ciclo de enfriamiento
                descenso_total:
                    bloque.temperatura_ingreso !== null && ultima
                        ? Math.round(
                              (Number(bloque.temperatura_ingreso) -
                                  Number(ultima.temperatura_promedio)) * 100
                          ) / 100
                        : null
            },
            curva
        });
    } catch (error) {
        console.error("Error al obtener la curva:", error);
        res.status(500).json({ error: "Error al obtener la curva de enfriamiento" });
    }
};

// ----------------------------------------------------------------------------
// POST /api/preenfrio/pulpeos
// ----------------------------------------------------------------------------
// Registra la medición con su desglose por proceso, en transacción.
const createPulpeo = async (req, res) => {
    try {
        const {
            id_bloque,
            numero_pulpeo,
            temperatura_objetivo,
            temperatura_promedio,
            detalle
        } = req.body;

        // ---- El bloque existe y está armado ----
        const bloque = await bloquesModel.getBloqueById(id_bloque);

        if (!bloque) {
            return res.status(409).json({ error: "El bloque indicado no existe" });
        }

        if (Number(bloque.estado) === 0) {
            return res.status(409).json({
                error: `El bloque ${bloque.codigo_bloque} está desarmado: ya no se puede pulpear.`
            });
        }

        const problema = await validarAlcanceBloque(id_bloque, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        // ---- El detalle debe corresponder al bloque ----
        // Medir un lote que no está en el montón sería un error de captura
        // que contaminaría la evidencia.
        if (detalle.length > 0) {
            const composicion = await bloquesModel.getDetalle(id_bloque);
            const idsEnBloque = composicion.map((c) => Number(c.id_produccion));

            for (const linea of detalle) {
                if (!idsEnBloque.includes(linea.id_produccion)) {
                    return res.status(409).json({
                        error: `El proceso ${linea.id_produccion} no forma parte del bloque ${bloque.codigo_bloque}: no se puede pulpear fruta que no está en el montón.`
                    });
                }
            }
        }

        // ---- Número de pulpeo ----
        // Si no viene, se calcula el siguiente de la secuencia del bloque.
        const numero =
            numero_pulpeo ?? (await pulpeosModel.getSiguienteNumero(id_bloque));

        // ---- INSERT en transacción ----
        // id_usuario sale del token: es quien firma la medición.
        const nuevo = await pulpeosModel.createPulpeo({
            ...req.body,
            numero_pulpeo: numero,
            id_usuario: req.id_usuario
        });

        const completo = await pulpeosModel.getPulpeoById(nuevo.id_pulpeo);
        const detalleGuardado = await pulpeosModel.getDetalle(nuevo.id_pulpeo);

        // ---- Avisos operativos ----
        const avisos = [];
        const alcanzo =
            Number(temperatura_promedio) <= Number(temperatura_objetivo);

        if (!alcanzo) {
            const faltan =
                Math.round(
                    (Number(temperatura_promedio) - Number(temperatura_objetivo)) * 100
                ) / 100;
            avisos.push(
                `La fruta está ${faltan} °C por encima del objetivo: todavía no puede salir del preenfrío.`
            );
        }

        // Un bloque que mezcla lotes y se pulpea sin desglose deja un
        // promedio que no se puede atribuir a ninguno en particular.
        if (Number(bloque.procesos) > 1 && detalle.length === 0) {
            avisos.push(
                `El bloque mezcla ${bloque.procesos} procesos y esta medición no trae desglose. Sin él, el promedio no se puede atribuir a un lote concreto ante un reclamo.`
            );
        }

        res.status(201).json({
            mensaje: alcanzo
                ? `Pulpeo #${numero} registrado: la fruta alcanzó el objetivo (${temperatura_promedio} °C).`
                : `Pulpeo #${numero} registrado: ${temperatura_promedio} °C contra un objetivo de ${temperatura_objetivo} °C.`,
            pulpeo: completo,
            detalle: detalleGuardado,
            alcanzo_objetivo: alcanzo,
            avisos
        });
    } catch (error) {
        console.error("Error al crear el pulpeo:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Ese proceso ya tiene una medición en este pulpeo"
            });
        }

        if (error.code === "23503") {
            return res.status(409).json({
                error: "El bloque o alguno de los procesos indicados no existen"
            });
        }

        res.status(500).json({
            error: "Error al registrar el pulpeo" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// ----------------------------------------------------------------------------
// PUT /api/preenfrio/pulpeos/:id
// ----------------------------------------------------------------------------
// Solo número y observaciones. Las temperaturas NO se editan: una lectura
// es un hecho puntual, no un dato corregible. Si estuvo mal, se cancela y
// se toma otra — así queda rastro de la corrección.
const updatePulpeo = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await pulpeosModel.getPulpeoById(id);

        if (!existente) {
            return res.status(404).json({ error: "Pulpeo no encontrado" });
        }

        const problema = await validarAlcanceBloque(existente.id_bloque, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "El pulpeo está cancelado"
            });
        }

        await pulpeosModel.updatePulpeo(id, req.body);
        const completo = await pulpeosModel.getPulpeoById(id);

        res.status(200).json({
            mensaje: "Pulpeo actualizado. Las temperaturas no se editan: si la lectura estuvo mal, cancélala y toma otra.",
            pulpeo: completo
        });
    } catch (error) {
        console.error("Error al actualizar el pulpeo:", error);
        res.status(500).json({ error: "Error al actualizar el pulpeo" });
    }
};

// ----------------------------------------------------------------------------
// DELETE /api/preenfrio/pulpeos/:id  → cancelar (baja lógica)
// ----------------------------------------------------------------------------
// Para una lectura errónea: termómetro descalibrado, tarima equivocada.
// No se borra porque dejaría un hueco inexplicable en la secuencia.
const cancelarPulpeo = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await pulpeosModel.getPulpeoById(id);

        if (!existente) {
            return res.status(404).json({ error: "Pulpeo no encontrado" });
        }

        const problema = await validarAlcanceBloque(existente.id_bloque, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "El pulpeo ya está cancelado"
            });
        }

        const cancelado = await pulpeosModel.cancelarPulpeo(id);

        res.status(200).json({
            mensaje: `Pulpeo #${existente.numero_pulpeo} cancelado. La fila se conserva: borrarla dejaría un hueco en la secuencia de mediciones del bloque.`,
            pulpeo: cancelado
        });
    } catch (error) {
        console.error("Error al cancelar el pulpeo:", error);
        res.status(500).json({ error: "Error al cancelar el pulpeo" });
    }
};

// PATCH /api/preenfrio/pulpeos/:id/reactivar
const reactivarPulpeo = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await pulpeosModel.getPulpeoById(id);

        if (!existente) {
            return res.status(404).json({ error: "Pulpeo no encontrado" });
        }

        if (existente.estado !== 0) {
            return res.status(409).json({ error: "El pulpeo no está cancelado" });
        }

        const reactivado = await pulpeosModel.reactivarPulpeo(id);

        res.status(200).json({
            mensaje: `Pulpeo #${existente.numero_pulpeo} reactivado`,
            pulpeo: reactivado
        });
    } catch (error) {
        console.error("Error al reactivar el pulpeo:", error);
        res.status(500).json({ error: "Error al reactivar el pulpeo" });
    }
};

export const pulpeosController = {
    getPulpeos,
    getPulpeoById,
    getPendientes,
    getCurva,
    createPulpeo,
    updatePulpeo,
    cancelarPulpeo,
    reactivarPulpeo
};
