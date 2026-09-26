import movimientosModel from "../models/movimientos.model.js";
import ocupacionesModel from "../models/ocupaciones.model.js";
import camarasModel from "../models/camaras.model.js";

// ============================================================================
// MOVIMIENTOS DE INVENTARIO
// ============================================================================
// req.camaras lo pone cargarAlcance.
//
// ⚠️ ESTE CONTROLLER NO TOCA ocupaciones_camaras
//   El INSERT dispara trg_sync_ocupacion_movimiento; el DELETE dispara
//   trg_revertir_movimiento (v2.5). Aquí solo se valida antes y se informa
//   después.
//
// ⚠️ EL ALCANCE SE VALIDA SOBRE DOS CÁMARAS
//   validarCamaraEnAlcance solo revisa un campo del body, así que cubre la
//   cámara DESTINO. La de ORIGEN sale de la ocupación, no del body, y la
//   valida este controller.
//
// v2.5 · LA CORRECCIÓN ES POR MOVIMIENTO INVERSO
//   Borrar un movimiento sí devuelve la fruta, pero la vía recomendada
//   sigue siendo el INVERSO, por auditoría:
//
//     DELETE    la fila desaparece y con ella la evidencia del error
//     INVERSO   quedan las dos filas, con fecha, usuario y motivo
//
//   POST /:id/revertir es la operación normal (supervisor) y DELETE queda
//   reservado a admin, para filas que nunca debieron existir.
//
// CORRECCIÓN DE LA AUDITORÍA · REVERTIR EXIGE LAS DOS CÁMARAS
//   Para LEER basta con tener una de las dos cámaras: si el traslado llegó
//   a la tuya, es asunto tuyo. Pero revertirlo mete fruta en la cámara de
//   origen. Con el criterio de lectura, un supervisor que solo tenía la
//   conserva podía meter fruta a un preenfrío de otra planta. Ahora
//   revertir exige acceso a ambas, igual que crear el traslado.
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

/**
 * Acceso para LEER un movimiento.
 * Basta con tener UNA de las dos cámaras: si el traslado llegó a la tuya,
 * es asunto tuyo aunque haya salido de otra planta.
 */
const tieneAcceso = (movimiento, camaras) => {
    if (!Array.isArray(camaras)) return true;

    const origen =
        movimiento.id_camara_origen !== null &&
        camaras.includes(Number(movimiento.id_camara_origen));

    const destino =
        movimiento.id_camara_destino !== null &&
        camaras.includes(Number(movimiento.id_camara_destino));

    return origen || destino;
};

/**
 * Acceso para MODIFICAR el inventario a partir de un movimiento.
 * Exige las DOS cámaras: revertir saca fruta de una y la mete en la otra.
 * Devuelve la lista de cámaras que faltan (vacía si todo cuadra).
 */
const camarasSinAcceso = (movimiento, camaras) => {
    if (!Array.isArray(camaras)) return [];

    return [movimiento.id_camara_origen, movimiento.id_camara_destino]
        .filter((c) => c !== null && c !== undefined)
        .filter((c) => !camaras.includes(Number(c)));
};

// GET /api/preenfrio/movimientos/:id
const getMovimientoById = async (req, res) => {
    try {
        const { id } = req.params;
        const movimiento = await movimientosModel.getMovimientoById(id);

        if (!movimiento) {
            return res.status(404).json({ error: "Movimiento no encontrado" });
        }

        if (!tieneAcceso(movimiento, req.camaras)) {
            return res.status(403).json({
                error: "No tienes acceso a ese movimiento"
            });
        }

        // Si ya fue corregido, se adjunta la reversa: el usuario necesita
        // verlo antes de intentar revertirlo otra vez.
        const reversa = await movimientosModel.getReversaDe(id);

        res.status(200).json({
            ...movimiento,
            revertido: Boolean(reversa),
            reversa: reversa ?? null,
            // La pantalla lo usa para habilitar o no el botón de revertir
            puede_revertir: camarasSinAcceso(movimiento, req.camaras).length === 0
        });
    } catch (error) {
        console.error("Error al obtener el movimiento:", error);
        res.status(500).json({ error: "Error al obtener el movimiento" });
    }
};

// GET /api/preenfrio/movimientos/trasladables
// Fruta dentro de cámaras de PREENFRÍO, candidata a pasar a conservación.
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
// Todos los movimientos de un lote, con las reversas marcadas.
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
            // Cuántos fueron correcciones: si son muchos, algo está fallando
            // en la captura y conviene revisarlo.
            correcciones: movimientos.filter((m) => m.es_reversa).length,
            movimientos
        });
    } catch (error) {
        console.error("Error al obtener la trazabilidad:", error);
        res.status(500).json({ error: "Error al obtener la trazabilidad" });
    }
};

// GET /api/preenfrio/movimientos/resumen
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
// Traslado de preenfrío a conservación.
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

        // Solo se traslada lo que está DENTRO. La cola sigue en el patio.
        if (origen.tipo_ocupacion !== 1) {
            return res.status(409).json({
                error: `Esa ocupación es "${origen.tipo_texto}". Solo se puede trasladar fruta que ya está dentro de la cámara: si está en cola, ingrésala primero.`
            });
        }

        // ---- Alcance sobre la cámara ORIGEN ----
        // No lo cubre validarCamaraEnAlcance: la cámara origen se deduce de
        // la ocupación, no viene en el body.
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
        // destino, inventando fruta.
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
            return res.status(409).json({ error: "La cámara destino no existe" });
        }

        if (destino.estado === 0) {
            return res.status(409).json({
                error: `La cámara "${destino.nombre_camara}" está fuera de servicio`
            });
        }

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
        // Se avisa pero no se bloquea: aquí no hay cola a donde mandar el
        // excedente, y dejar la fruta ocupando preenfrío suele ser peor.
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
        let avisoTemperatura = null;

        if (req.body.temperatura !== null && Number(req.body.temperatura) > 15) {
            avisoTemperatura = `La fruta sale a ${req.body.temperatura} °C: verifica que haya terminado su ciclo de preenfrío.`;
        }

        // ---- INSERT ----
        // id_produccion e id_camara_origen se toman de la ocupación: son
        // datos derivados y dejarlos al cliente invitaría a
        // inconsistencias. id_usuario sale del token.
        const nuevo = await movimientosModel.createMovimiento({
            ...req.body,
            id_produccion: origen.id_produccion,
            id_camara_origen: origen.id_camara,
            id_usuario: req.id_usuario
        });

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
// ⭐ POST /api/preenfrio/movimientos/:id/revertir
// ----------------------------------------------------------------------------
// LA VÍA OFICIAL DE CORRECCIÓN.
//
// Crea un movimiento inverso: mismas cantidades, cámaras intercambiadas. El
// inventario queda igual que si se hubiera borrado el original, pero la
// bitácora conserva las dos filas.
//
// Exige motivo. Sin él la reversa es tan opaca como un borrado: se sabría
// que la fruta volvió, pero no por qué.
const revertirMovimiento = async (req, res) => {
    try {
        const { id } = req.params;
        const { motivo, fecha, hora, temperatura } = req.body;

        const original = await movimientosModel.getMovimientoById(id);

        if (!original) {
            return res.status(404).json({ error: "Movimiento no encontrado" });
        }

        // Primero el criterio de lectura: si no ve ninguna de las dos
        // cámaras, para él el movimiento no existe.
        if (!tieneAcceso(original, req.camaras)) {
            return res.status(403).json({
                error: "No tienes acceso a ese movimiento"
            });
        }

        // ---- Revertir exige las DOS cámaras ----
        // Revertir saca fruta de la conserva y la mete al preenfrío de
        // origen. Con solo una de las dos, podría meter fruta a una planta
        // ajena.
        const faltantes = camarasSinAcceso(original, req.camaras);

        if (faltantes.length > 0) {
            return res.status(403).json({
                error: `Para revertir este traslado necesitas acceso a "${original.camara_origen}" y a "${original.camara_destino}": la fruta sale de una y entra a la otra. Pídele a coordinación que lo revierta.`
            });
        }

        // ---- Solo los traslados de este módulo ----
        // Los tipo 1 y 3 tienen su propia reversa en sus módulos.
        if (Number(original.tipo_movimiento) === 1) {
            return res.status(409).json({
                error: "Este movimiento lo generó una recepción. Para revertirlo, cancela la recepción: desde la v2.5 eso libera la cámara automáticamente."
            });
        }

        if (Number(original.tipo_movimiento) === 3) {
            const linea = await movimientosModel.getLineaDespachoLigada(id);

            return res.status(409).json({
                error: linea
                    ? `Este movimiento pertenece al despacho ${linea.folio_despacho}. Para revertirlo, quita la línea desde el módulo de despachos.`
                    : "Este movimiento es una salida por despacho: revierte desde ese módulo."
            });
        }

        // ---- No revertir dos veces ----
        // La segunda reversa devolvería la fruta al destino equivocado y
        // dejaría tres filas contradictorias en la bitácora.
        const yaRevertido = await movimientosModel.getReversaDe(id);

        if (yaRevertido) {
            return res.status(409).json({
                error: `Este movimiento ya fue revertido el ${yaRevertido.fecha_movimiento} por el movimiento #${yaRevertido.id_movimiento}.`,
                reversa: yaRevertido
            });
        }

        // ---- La fruta sigue en el destino ----
        // Si ya se despachó o se movió otra vez, no hay qué devolver: la
        // reversa dejaría el destino en negativo (el trigger lo corta con
        // GREATEST, pero el resultado sería inventario inventado en el
        // origen).
        const tableroDestino = await ocupacionesModel.getTablero(
            {},
            [Number(original.id_camara_destino)]
        );

        const enDestino = Number(tableroDestino[0]?.tarimas_ocupadas ?? 0);

        if (enDestino < Number(original.cantidad_tarimas)) {
            return res.status(409).json({
                error: `No se puede revertir: el movimiento trasladó ${original.cantidad_tarimas} tarimas a "${original.camara_destino}", pero ahí solo quedan ${enDestino}. Esa fruta ya se movió o se despachó.`
            });
        }

        // ---- Espacio en el preenfrío al que regresa ----
        // Se avisa pero no se bloquea: la fruta ya está físicamente de
        // vuelta en el andén, el sistema tiene que reflejarlo.
        const tableroOrigen = await ocupacionesModel.getTablero(
            {},
            [Number(original.id_camara_origen)]
        );

        const libresOrigen = Number(
            tableroOrigen[0]?.tarimas_disponibles_operativas ?? 0
        );

        const avisos = [
            "Ambos movimientos quedan en la bitácora. La trazabilidad del lote mostrará el traslado y su corrección."
        ];

        if (Number(original.cantidad_tarimas) > libresOrigen) {
            avisos.push(
                `⚠️ "${original.camara_origen}" solo tiene ${libresOrigen} espacios libres y regresan ${original.cantidad_tarimas} tarimas: quedará sobreocupada.`
            );
        }

        // ---- Crear el inverso ----
        const inverso = await movimientosModel.crearInverso({
            original,
            fecha_movimiento: fecha ?? new Date().toISOString().slice(0, 10),
            hora_movimiento: hora ?? new Date().toTimeString().slice(0, 8),
            temperatura: temperatura ?? null,
            id_usuario: req.id_usuario,
            motivo
        });

        const completo = await movimientosModel.getMovimientoById(
            inverso.id_movimiento
        );

        res.status(201).json({
            mensaje: `Movimiento #${original.id_movimiento} revertido: ${original.cantidad_tarimas} tarimas regresaron de "${original.camara_destino}" a "${original.camara_origen}".`,
            // Las dos filas quedan en la bitácora: eso es lo que hace
            // auditable la corrección.
            original: {
                id_movimiento: original.id_movimiento,
                fecha: original.fecha_movimiento,
                de: original.camara_origen,
                a: original.camara_destino
            },
            reversa: completo,
            avisos
        });
    } catch (error) {
        console.error("Error al revertir el movimiento:", error);
        res.status(500).json({ error: "Error al revertir el movimiento" });
    }
};

// ----------------------------------------------------------------------------
// DELETE /api/preenfrio/movimientos/:id
// ----------------------------------------------------------------------------
// VÍA EXCEPCIONAL, solo admin.
//
// v2.5: trg_revertir_movimiento ya devuelve la fruta, así que borrar es
// seguro para el inventario. Pero borra también la evidencia de que hubo un
// error, y eso rara vez conviene.
//
// Se reserva para filas que NUNCA debieron existir: una captura duplicada,
// una prueba que se coló a producción. Para corregir un traslado real está
// POST /:id/revertir.
const deleteMovimiento = async (req, res) => {
    try {
        const { id } = req.params;
        const { motivo } = req.body;

        const movimiento = await movimientosModel.getMovimientoById(id);

        if (!movimiento) {
            return res.status(404).json({ error: "Movimiento no encontrado" });
        }

        if (!tieneAcceso(movimiento, req.camaras)) {
            return res.status(403).json({
                error: "No tienes acceso a ese movimiento"
            });
        }

        // Se exige motivo aunque la fila vaya a desaparecer: queda en el
        // log del servidor, que es el único rastro que quedará.
        if (!motivo || String(motivo).trim().length < 10) {
            return res.status(400).json({
                error: 'El campo "motivo" es obligatorio (mínimo 10 caracteres). Si lo que buscas es corregir un traslado, usa POST /:id/revertir: deja constancia en la bitácora.'
            });
        }

        // Los movimientos de despacho tienen su propia reversa: borrarlo
        // suelto dejaría la línea apuntando a un movimiento inexistente.
        const linea = await movimientosModel.getLineaDespachoLigada(id);

        if (linea) {
            return res.status(409).json({
                error: `Este movimiento pertenece al despacho ${linea.folio_despacho}. Quita la línea desde el módulo de despachos.`
            });
        }

        if (Number(movimiento.tipo_movimiento) === 1) {
            return res.status(409).json({
                error: "Este movimiento lo generó una recepción. Cancela la recepción para revertirlo."
            });
        }

        // El rastro que queda cuando la fila desaparece
        console.warn(
            `[movimientos.delete] Usuario ${req.id_usuario} eliminó el movimiento ${id} ` +
            `(${movimiento.cantidad_tarimas} tarimas, ${movimiento.camara_origen} → ${movimiento.camara_destino}). ` +
            `Motivo: ${motivo}`
        );

        const eliminado = await movimientosModel.deleteMovimiento(id);

        res.status(200).json({
            mensaje: "Movimiento eliminado de la bitácora",
            movimiento: eliminado,
            resultado: `El inventario se revirtió automáticamente: ${movimiento.cantidad_tarimas} tarima(s) regresaron a "${movimiento.camara_origen}".`,
            avisos: [
                "⚠️ La fila se eliminó de la bitácora: no queda registro de que este traslado ocurrió. Para correcciones que deban ser auditables, usa POST /:id/revertir."
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
    revertirMovimiento,
    deleteMovimiento
};
