import movimientosModel from "../models/movimientos.model.js";
import ocupacionesModel from "../models/ocupaciones.model.js";
import camarasModel from "../models/camaras.model.js";

// ============================================================================
// MOVIMIENTOS DE INVENTARIO
// ============================================================================
// req.camaras lo pone cargarAlcance:
//     null  -> Admin / Coordinador
//     [...] -> Supervisor / Operativo
//
// ⚠️ ESTE CONTROLLER NO TOCA ocupaciones_camaras
//   El INSERT dispara trg_sync_ocupacion_movimiento, que descuenta del
//   origen y suma al destino. Aquí solo se valida ANTES y se informa
//   DESPUÉS de lo que hizo el trigger.
//
// ⚠️ EL ALCANCE SE VALIDA SOBRE DOS CÁMARAS
//   Es el primer módulo con este caso. validarCamaraEnAlcance solo revisa
//   UN campo del body, así que no alcanza: hay que validar la cámara
//   ORIGEN (que sale de la ocupación, no del body) y la DESTINO.
//
//   Sin las dos, un supervisor podría sacar fruta de una planta ajena
//   mandando un id_ocupacion_origen que no le corresponde.
// ============================================================================

// GET /api/preenfrio/movimientos?tipo_movimiento=2&fecha_desde=...
const getMovimientos = async (req, res) => {
    try {
        const {
            tipo_movimiento,
            id_produccion,
            id_camara,
            id_despacho,
            fecha_desde,
            fecha_hasta,
            buscar
        } = req.query;

        const movimientos = await movimientosModel.getMovimientos(
            {
                tipo_movimiento: tipo_movimiento ? Number(tipo_movimiento) : null,
                id_produccion: id_produccion ? Number(id_produccion) : null,
                id_camara: id_camara ? Number(id_camara) : null,
                id_despacho: id_despacho ? Number(id_despacho) : null,
                fecha_desde: fecha_desde || null,
                fecha_hasta: fecha_hasta || null,
                buscar: buscar || null
            },
            req.camaras
        );

        res.status(200).json(movimientos);
    } catch (error) {
        console.error("Error al obtener movimientos:", error);
        res.status(500).json({ error: "Error al obtener los movimientos" });
    }
};

// GET /api/preenfrio/movimientos/:id
const getMovimientoById = async (req, res) => {
    try {
        const { id } = req.params;
        const movimiento = await movimientosModel.getMovimientoById(id);

        if (!movimiento) {
            return res.status(404).json({ error: "Movimiento no encontrado" });
        }

        // Alcance sobre CUALQUIERA de las dos cámaras: si el supervisor
        // tiene la de destino, el traslado que llegó ahí sí es asunto suyo
        // aunque el origen no lo sea.
        if (Array.isArray(req.camaras)) {
            const tocaOrigen =
                movimiento.id_camara_origen !== null &&
                req.camaras.includes(Number(movimiento.id_camara_origen));

            const tocaDestino =
                movimiento.id_camara_destino !== null &&
                req.camaras.includes(Number(movimiento.id_camara_destino));

            if (!tocaOrigen && !tocaDestino) {
                return res.status(403).json({
                    error: "No tienes acceso a ese movimiento"
                });
            }
        }

        res.status(200).json(movimiento);
    } catch (error) {
        console.error("Error al obtener el movimiento:", error);
        res.status(500).json({ error: "Error al obtener el movimiento" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/movimientos/trasladables
// ----------------------------------------------------------------------------
// Fruta dentro de cámaras de PREENFRÍO, candidata a pasar a conservación.
// Es el origen del formulario de traslado.
//
// Viene ordenada por criticidad (v2.3) y trae horas_en_preenfrio: los dos
// datos que decide el supervisor al elegir qué sacar.
const getTrasladables = async (req, res) => {
    try {
        const { id_camara } = req.query;

        const trasladables = await movimientosModel.getTrasladables(
            { id_camara: id_camara ? Number(id_camara) : null },
            req.camaras
        );

        res.status(200).json(trasladables);
    } catch (error) {
        console.error("Error al obtener los trasladables:", error);
        res.status(500).json({ error: "Error al obtener la fruta trasladable" });
    }
};

// GET /api/preenfrio/movimientos/trazabilidad/:id_produccion
// Todos los movimientos de un lote, en orden cronológico. Es la respuesta
// a "¿por dónde pasó esta fruta?" cuando hay un reclamo.
const getTrazabilidad = async (req, res) => {
    try {
        const { id_produccion } = req.params;

        if (!id_produccion || isNaN(Number(id_produccion))) {
            return res.status(400).json({
                error: "El id de producción debe ser un número válido"
            });
        }

        const movimientos = await movimientosModel.getTrazabilidad(id_produccion);

        res.status(200).json({
            id_produccion: Number(id_produccion),
            codigo_lote: movimientos[0]?.codigo_lote ?? null,
            total_movimientos: movimientos.length,
            movimientos
        });
    } catch (error) {
        console.error("Error al obtener la trazabilidad:", error);
        res.status(500).json({ error: "Error al obtener la trazabilidad" });
    }
};

// GET /api/preenfrio/movimientos/resumen?fecha_desde=...&fecha_hasta=...
const getResumen = async (req, res) => {
    try {
        const { fecha_desde, fecha_hasta } = req.query;

        const resumen = await movimientosModel.getResumen(
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
// POST /api/preenfrio/movimientos
// ----------------------------------------------------------------------------
// Traslado de preenfrío a conservación. El INSERT dispara el trigger que
// mueve el inventario; aquí se valida antes y se informa después.
const createMovimiento = async (req, res) => {
    try {
        const {
            id_ocupacion_origen,
            id_camara_destino,
            cantidad_tarimas,
            cantidad_cajas
        } = req.body;

        // ---- La ocupación de origen existe y tiene fruta ----
        const origen = await ocupacionesModel.getOcupacionById(id_ocupacion_origen);

        if (!origen) {
            return res.status(409).json({
                error: "La ocupación de origen no existe"
            });
        }

        if (origen.estado !== 1) {
            return res.status(409).json({
                error: "Esa ocupación ya está cerrada: no queda fruta que mover"
            });
        }

        // Solo se traslada lo que está DENTRO de la cámara. La cola (tipo 3)
        // todavía está en el patio: primero tiene que ingresar.
        if (origen.tipo_ocupacion !== 1) {
            return res.status(409).json({
                error: `Esa ocupación es "${origen.tipo_texto}". Solo se puede trasladar fruta que ya está dentro de la cámara: si está en cola, ingrésala primero.`
            });
        }

        // ---- Alcance sobre la cámara ORIGEN ----
        // No lo cubre validarCamaraEnAlcance: la cámara origen no viene en
        // el body, se deduce de la ocupación.
        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(origen.id_camara))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a la cámara de origen"
            });
        }

        // ---- No se puede mover más de lo que hay ----
        // El trigger usa GREATEST(cantidad - movida, 0), así que un exceso
        // NO reventaría: dejaría el origen en cero y sumaría de más al
        // destino, inventando fruta. Por eso se valida aquí.
        if (Number(cantidad_tarimas) > Number(origen.cantidad_tarimas)) {
            return res.status(409).json({
                error: `No puedes mover ${cantidad_tarimas} tarimas: en "${origen.nombre_camara}" solo hay ${origen.cantidad_tarimas} de este lote.`
            });
        }

        if (Number(cantidad_cajas) > Number(origen.cantidad_cajas)) {
            return res.status(409).json({
                error: `No puedes mover ${cantidad_cajas} cajas: en "${origen.nombre_camara}" solo hay ${origen.cantidad_cajas} de este lote.`
            });
        }

        // ---- La cámara destino ----
        const destino = await camarasModel.getCamaraById(id_camara_destino);

        if (!destino) {
            return res.status(409).json({
                error: "La cámara destino no existe"
            });
        }

        if (destino.estado === 0) {
            return res.status(409).json({
                error: `La cámara "${destino.nombre_camara}" está fuera de servicio`
            });
        }

        // Este módulo solo hace preenfrío → conservación. Mover a otro
        // preenfrío no es un traslado de proceso, es una reubicación, y
        // tendría que resolverse de otra forma.
        if (Number(destino.tipo_camara) !== 2) {
            return res.status(409).json({
                error: `"${destino.nombre_camara}" no es de conservación. Este módulo solo traslada de preenfrío a conservación.`
            });
        }

        if (Number(origen.id_camara) === Number(id_camara_destino)) {
            return res.status(409).json({
                error: "El origen y el destino son la misma cámara"
            });
        }

        // ---- Capacidad del destino ----
        // Se avisa pero no se bloquea: a diferencia de la recepción, aquí
        // no hay cola a donde mandar el excedente, y dejar la fruta en el
        // preenfrío ocupando espacio suele ser peor que sobrecargar un
        // poco la conserva.
        const disponibleDestino = await ocupacionesModel.getTablero(
            {},
            [Number(id_camara_destino)]
        );

        const libres = Number(
            disponibleDestino[0]?.tarimas_disponibles_operativas ?? 0
        );

        let avisoCapacidad = null;

        if (Number(cantidad_tarimas) > libres) {
            avisoCapacidad = `"${destino.nombre_camara}" solo tiene ${libres} espacios libres y estás moviendo ${cantidad_tarimas} tarimas: quedará sobreocupada.`;
        }

        // ---- Temperatura: ¿ya terminó el preenfrío? ----
        // No se bloquea porque a veces hay que sacar fruta caliente para
        // liberar la cámara, pero se deja constancia.
        let avisoTemperatura = null;

        if (
            req.body.temperatura !== null &&
            Number(req.body.temperatura) > 15
        ) {
            avisoTemperatura = `La fruta sale a ${req.body.temperatura} °C: verifica que haya terminado su ciclo de preenfrío.`;
        }

        // ---- INSERT ----
        // id_produccion y id_camara_origen se toman de la ocupación, no del
        // body: son datos derivados y dejarlos al cliente invitaría a
        // inconsistencias.
        //
        // id_usuario sale del token: es quien firma el movimiento.
        const nuevo = await movimientosModel.createMovimiento({
            ...req.body,
            id_produccion: origen.id_produccion,
            id_camara_origen: origen.id_camara,
            id_usuario: req.id_usuario
        });

        // ---- Qué hizo el trigger ----
        const completo = await movimientosModel.getMovimientoById(
            nuevo.id_movimiento
        );
        const origenDespues = await ocupacionesModel.getOcupacionById(
            id_ocupacion_origen
        );

        res.status(201).json({
            mensaje: "Traslado registrado correctamente",
            resultado: `Se movieron ${cantidad_tarimas} tarimas de "${origen.nombre_camara}" a "${destino.nombre_camara}".`,
            movimiento: completo,
            origen: {
                id_ocupacion: origen.id_ocupacion,
                camara: origen.nombre_camara,
                // El trigger cierra la ocupación si quedó en cero
                tarimas_restantes: origenDespues?.cantidad_tarimas ?? 0,
                cerrada: origenDespues?.estado === 0
            },
            avisos: [avisoCapacidad, avisoTemperatura].filter(Boolean)
        });
    } catch (error) {
        console.error("Error al crear el movimiento:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "La ocupación, la producción o la cámara indicadas no existen"
            });
        }

        res.status(500).json({
            error: "Error al registrar el movimiento" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// ----------------------------------------------------------------------------
// DELETE /api/preenfrio/movimientos/:id
// ----------------------------------------------------------------------------
// La tabla es inmutable: no hay UPDATE. Si un movimiento se capturó mal, se
// borra y se vuelve a registrar.
//
// ⚠️ EL DELETE NO REVIERTE LA OCUPACIÓN
//   trg_sync_ocupacion_movimiento es AFTER INSERT. Al borrar no se dispara
//   nada: la fruta sigue contada en el destino y descontada del origen.
//   La respuesta lo advierte de forma explícita.
//
//   La corrección limpia es registrar el movimiento INVERSO, que sí pasa
//   por el trigger y además deja rastro de que hubo una corrección.
const deleteMovimiento = async (req, res) => {
    try {
        const { id } = req.params;

        const movimiento = await movimientosModel.getMovimientoById(id);

        if (!movimiento) {
            return res.status(404).json({ error: "Movimiento no encontrado" });
        }

        if (Array.isArray(req.camaras)) {
            const tocaOrigen =
                movimiento.id_camara_origen !== null &&
                req.camaras.includes(Number(movimiento.id_camara_origen));

            const tocaDestino =
                movimiento.id_camara_destino !== null &&
                req.camaras.includes(Number(movimiento.id_camara_destino));

            if (!tocaOrigen && !tocaDestino) {
                return res.status(403).json({
                    error: "No tienes acceso a ese movimiento"
                });
            }
        }

        // Los movimientos de salida por despacho tienen su propia reversa:
        // fn_quitar_linea_despacho devuelve la fruta a la cámara y borra el
        // movimiento en una sola operación. Borrarlo suelto dejaría la
        // línea de despacho apuntando a un movimiento inexistente.
        const linea = await movimientosModel.getLineaDespachoLigada(id);

        if (linea) {
            return res.status(409).json({
                error: `Este movimiento pertenece al despacho ${linea.folio_despacho}. Para revertirlo, quita la línea desde el módulo de despachos: así la fruta regresa a la cámara.`
            });
        }

        if (Number(movimiento.tipo_movimiento) === 1) {
            return res.status(409).json({
                error: "Este movimiento lo generó una recepción. Para revertirlo, cancela la recepción correspondiente."
            });
        }

        const eliminado = await movimientosModel.deleteMovimiento(id);

        res.status(200).json({
            mensaje: "Movimiento eliminado de la bitácora",
            movimiento: eliminado,
            avisos: [
                `El borrado NO devolvió la fruta: siguen ${movimiento.cantidad_tarimas} tarima(s) contadas en "${movimiento.camara_destino}" y descontadas de "${movimiento.camara_origen}". Para corregir el inventario, registra el movimiento inverso.`
            ]
        });
    } catch (error) {
        console.error("Error al eliminar el movimiento:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "No se puede eliminar: otro registro depende de este movimiento"
            });
        }

        res.status(500).json({ error: "Error al eliminar el movimiento" });
    }
};

export const movimientosController = {
    getMovimientos,
    getMovimientoById,
    getTrasladables,
    getTrazabilidad,
    getResumen,
    createMovimiento,
    deleteMovimiento
};
