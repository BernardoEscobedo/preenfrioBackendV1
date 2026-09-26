import bloquesModel from "../models/bloques.model.js";
import produccionModel from "../models/produccion.model.js";

// ============================================================================
// BLOQUES FÍSICOS
// ============================================================================
// req.camaras lo pone cargarAlcance.
//
// ⚠️ ESTE CONTROLLER NO ESCRIBE LOS TOTALES
//   trg_recalcular_totales_bloque los deriva del detalle en cada
//   INSERT/UPDATE/DELETE de las líneas. Tocarlos aquí haría que el número
//   pudiera dejar de cuadrar con sus propias líneas.
//
// EL ALCANCE SE RESUELVE POR EL CONTENIDO
//   bloques_fruta no tiene id_camara: el bloque se define por la fruta que
//   agrupa. Un bloque armado pertenece a las cámaras de sus procesos; uno
//   vacío todavía no tiene planta, así que cualquiera puede continuarlo.
//
// CORRECCIONES DE LA AUDITORÍA
//   · Las cámaras son las REALES (donde se recibió o se trasladó la fruta),
//     no la planeada. Si el camión se desvió en el andén, el supervisor de
//     la cámara donde está la fruta es quien puede armar y pulpear el
//     bloque. Lo resuelve bloques.model con SQL_CAMARAS_REALES.
//
//   · No se puede agregar a un bloque una producción que no ha llegado
//     (estado 1, planeada). Un bloque es un montón físico: fruta que sigue
//     en la finca no puede estar apilada en la cámara.
// ============================================================================

/**
 * ¿El usuario tiene acceso a alguna de estas cámaras?
 * null en req.camaras = alcance total (admin y coordinador).
 */
const tocaAlguna = (camarasFruta, camarasUsuario) => {
    if (!Array.isArray(camarasUsuario)) return true;
    return camarasFruta.some((c) => camarasUsuario.includes(Number(c)));
};

/**
 * Valida acceso a un bloque ya armado.
 * Devuelve un objeto de error listo para responder, o null si todo cuadra.
 */
const validarAlcanceBloque = async (id_bloque, camaras) => {
    if (!Array.isArray(camaras)) return null;

    const camarasDelBloque = await bloquesModel.getCamarasDelBloque(id_bloque);

    // Bloque vacío: sin fruta todavía, no hay planta que proteger
    if (camarasDelBloque.length === 0) return null;

    if (!tocaAlguna(camarasDelBloque, camaras)) {
        return {
            status: 403,
            error: "No tienes acceso a ese bloque: su fruta está en otras cámaras"
        };
    }

    return null;
};

// GET /api/preenfrio/bloques?estado=1&buscar=B001
const getBloques = async (req, res) => {
    try {
        const { estado, fecha_desde, fecha_hasta, buscar } = req.query;

        const bloques = await bloquesModel.getBloques(
            {
                estado: estado !== undefined && estado !== "" ? Number(estado) : null,
                fecha_desde: fecha_desde || null,
                fecha_hasta: fecha_hasta || null,
                buscar: buscar || null
            },
            req.camaras
        );

        res.status(200).json(bloques);
    } catch (error) {
        console.error("Error al obtener bloques:", error);
        res.status(500).json({ error: "Error al obtener los bloques" });
    }
};

// GET /api/preenfrio/bloques/:id
// Devuelve el bloque con su composición completa.
const getBloqueById = async (req, res) => {
    try {
        const { id } = req.params;
        const bloque = await bloquesModel.getBloqueById(id);

        if (!bloque) {
            return res.status(404).json({ error: "Bloque no encontrado" });
        }

        const problema = await validarAlcanceBloque(id, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        const detalle = await bloquesModel.getDetalle(id);

        res.status(200).json({
            ...bloque,
            detalle,
            // Un bloque con varios procesos necesita que el pulpeo se
            // desglose: la fruta de cada finca puede venir a distinta
            // temperatura.
            mezcla_procesos: detalle.length > 1
        });
    } catch (error) {
        console.error("Error al obtener el bloque:", error);
        res.status(500).json({ error: "Error al obtener el bloque" });
    }
};

// POST /api/preenfrio/bloques
const createBloque = async (req, res) => {
    try {
        const { codigo_bloque } = req.body;

        const duplicado = await bloquesModel.existeCodigo(codigo_bloque);

        if (duplicado) {
            return res.status(409).json({
                error: `El código "${codigo_bloque}" ya está en uso por otro bloque (${
                    duplicado.estado === 1 ? "armado" : "desarmado"
                })`
            });
        }

        const nuevo = await bloquesModel.createBloque(req.body);
        const completo = await bloquesModel.getBloqueById(nuevo.id_bloque);

        res.status(201).json({
            mensaje: `Bloque ${completo.codigo_bloque} creado. Agrégale las tarimas que lo componen.`,
            bloque: completo
        });
    } catch (error) {
        console.error("Error al crear el bloque:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Ese código de bloque ya existe"
            });
        }

        res.status(500).json({
            error: "Error al crear el bloque" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/bloques/:id
const updateBloque = async (req, res) => {
    try {
        const { id } = req.params;
        const { codigo_bloque } = req.body;

        const existente = await bloquesModel.getBloqueById(id);

        if (!existente) {
            return res.status(404).json({ error: "Bloque no encontrado" });
        }

        const problema = await validarAlcanceBloque(id, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        const duplicado = await bloquesModel.existeCodigo(codigo_bloque, Number(id));

        if (duplicado) {
            return res.status(409).json({
                error: `El código "${codigo_bloque}" ya está en uso por otro bloque`
            });
        }

        await bloquesModel.updateBloque(id, req.body);
        const completo = await bloquesModel.getBloqueById(id);

        // Cambiar el código de un bloque que ya tiene pulpeos rompe el
        // enlace con las etiquetas físicas y con los reportes impresos.
        const avisos = [];

        if (
            Number(existente.pulpeos_registrados) > 0 &&
            existente.codigo_bloque !== completo.codigo_bloque
        ) {
            avisos.push(
                `Cambiaste el código de "${existente.codigo_bloque}" a "${completo.codigo_bloque}" y el bloque ya tiene ${existente.pulpeos_registrados} pulpeo(s). Actualiza la etiqueta física del montón.`
            );
        }

        res.status(200).json({ ...completo, avisos });
    } catch (error) {
        console.error("Error al actualizar el bloque:", error);
        res.status(500).json({ error: "Error al actualizar el bloque" });
    }
};

// ----------------------------------------------------------------------------
// POST /api/preenfrio/bloques/:id/lineas
// ----------------------------------------------------------------------------
// Agregar un proceso al bloque. El trigger recalcula los totales solo.
const agregarLinea = async (req, res) => {
    try {
        const { id } = req.params;
        const { id_produccion, cantidad_tarimas } = req.body;

        const bloque = await bloquesModel.getBloqueById(id);

        if (!bloque) {
            return res.status(404).json({ error: "Bloque no encontrado" });
        }

        if (Number(bloque.estado) === 0) {
            return res.status(409).json({
                error: `El bloque ${bloque.codigo_bloque} está desarmado: rearmalo antes de agregarle fruta.`
            });
        }

        // Si el bloque ya salió en un despacho, su composición es parte de
        // un documento de salida y no debe cambiar.
        const despachos = await bloquesModel.getLineasDespachoLigadas(id);

        if (despachos.length > 0) {
            return res.status(409).json({
                error: `El bloque ${bloque.codigo_bloque} ya forma parte del despacho ${despachos[0].folio_despacho}: su composición no puede cambiar.`
            });
        }

        // ---- La producción existe y ya llegó ----
        const produccion = await produccionModel.getProduccionById(id_produccion);

        if (!produccion) {
            return res.status(409).json({
                error: "La producción indicada no existe"
            });
        }

        if (produccion.estado === 0) {
            return res.status(409).json({
                error: `La producción ${produccion.codigo_lote} está cancelada`
            });
        }

        // Un bloque es un montón físico: fruta que no ha llegado no puede
        // estar apilada en la cámara.
        if (produccion.estado === 1) {
            return res.status(409).json({
                error: `La producción ${produccion.codigo_lote} todavía no tiene recepciones: no se puede armar en un bloque fruta que no ha llegado.`
            });
        }

        // ---- Alcance sobre las cámaras REALES de la producción ----
        // Donde se recibió o a donde se trasladó, no la planeada.
        const camarasFruta = await bloquesModel.getCamarasDeProduccion(id_produccion);

        if (camarasFruta.length > 0 && !tocaAlguna(camarasFruta, req.camaras)) {
            return res.status(403).json({
                error: "No tienes acceso a la cámara donde está esa fruta"
            });
        }

        // ---- Duplicado ----
        // La tabla tiene UNIQUE(id_bloque, id_produccion). Se verifica
        // antes para explicar qué hacer en vez de reventar con un 23505.
        const yaExiste = await bloquesModel.getLineaPorProduccion(id, id_produccion);

        if (yaExiste) {
            return res.status(409).json({
                error: `El lote ${produccion.codigo_lote} ya está en este bloque con ${yaExiste.cantidad_tarimas} tarima(s). Edita esa línea en vez de agregar otra.`,
                id_detalle: yaExiste.id_detalle
            });
        }

        const linea = await bloquesModel.agregarLinea({
            ...req.body,
            id_bloque: Number(id)
        });

        // Los totales ya los recalculó trg_recalcular_totales_bloque
        const completo = await bloquesModel.getBloqueById(id);
        const detalle = await bloquesModel.getDetalle(id);

        const avisos = [];

        // Mezclar fruta de distintas fechas de empaque en un bloque hace
        // que el pulpeo promedie lotes en estados distintos.
        const fechas = new Set(
            detalle.map((d) => String(d.fecha_empaque).slice(0, 10))
        );

        if (fechas.size > 1) {
            avisos.push(
                `Este bloque mezcla fruta de ${fechas.size} fechas de empaque distintas. Al pulpear, desglosa por proceso para no promediar lotes en estados diferentes.`
            );
        }

        res.status(201).json({
            mensaje: `Se agregaron ${cantidad_tarimas} tarimas del lote ${produccion.codigo_lote} al bloque ${bloque.codigo_bloque}`,
            linea,
            totales: {
                tarimas: completo.cantidad_tarimas,
                cajas: completo.cantidad_cajas,
                procesos: completo.procesos
            },
            avisos
        });
    } catch (error) {
        console.error("Error al agregar la linea:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Ese lote ya está en el bloque: edita la línea existente"
            });
        }

        if (error.code === "23503") {
            return res.status(409).json({
                error: "El bloque o la producción indicados no existen"
            });
        }

        res.status(500).json({ error: "Error al agregar la línea" });
    }
};

// Validaciones comunes para editar o quitar una línea.
// Devuelve { linea } si todo cuadra, o { status, error } para responder.
const validarLineaEditable = async (id, id_detalle, camaras) => {
    const bloque = await bloquesModel.getBloqueById(id);

    if (!bloque) {
        return { status: 404, error: "Bloque no encontrado" };
    }

    const linea = await bloquesModel.getLineaById(id_detalle);

    if (!linea) {
        return { status: 404, error: "Línea no encontrada" };
    }

    if (Number(linea.id_bloque) !== Number(id)) {
        return { status: 409, error: "Esa línea no pertenece a este bloque" };
    }

    const despachos = await bloquesModel.getLineasDespachoLigadas(id);

    if (despachos.length > 0) {
        return {
            status: 409,
            error: `El bloque ya forma parte del despacho ${despachos[0].folio_despacho}: su composición no puede cambiar.`
        };
    }

    // Alcance sobre las cámaras reales de esa producción
    const camarasFruta = (linea.camaras ?? []).map(Number);

    if (camarasFruta.length > 0 && !tocaAlguna(camarasFruta, camaras)) {
        return { status: 403, error: "No tienes acceso a la cámara donde está esa fruta" };
    }

    return { linea };
};

// PUT /api/preenfrio/bloques/:id/lineas/:id_detalle
const actualizarLinea = async (req, res) => {
    try {
        const { id, id_detalle } = req.params;
        const { cantidad_tarimas, cantidad_cajas } = req.body;

        const validacion = await validarLineaEditable(id, id_detalle, req.camaras);

        if (validacion.error) {
            return res.status(validacion.status).json({ error: validacion.error });
        }

        await bloquesModel.actualizarLinea(id_detalle, {
            cantidad_tarimas,
            cantidad_cajas
        });

        const completo = await bloquesModel.getBloqueById(id);

        res.status(200).json({
            mensaje: `Línea actualizada a ${cantidad_tarimas} tarimas`,
            totales: {
                tarimas: completo.cantidad_tarimas,
                cajas: completo.cantidad_cajas,
                procesos: completo.procesos
            }
        });
    } catch (error) {
        console.error("Error al actualizar la linea:", error);
        res.status(500).json({ error: "Error al actualizar la línea" });
    }
};

// DELETE /api/preenfrio/bloques/:id/lineas/:id_detalle
const quitarLinea = async (req, res) => {
    try {
        const { id, id_detalle } = req.params;

        const validacion = await validarLineaEditable(id, id_detalle, req.camaras);

        if (validacion.error) {
            return res.status(validacion.status).json({ error: validacion.error });
        }

        await bloquesModel.quitarLinea(id_detalle);
        const completo = await bloquesModel.getBloqueById(id);

        res.status(200).json({
            mensaje: `Lote ${validacion.linea.codigo_lote} retirado del bloque`,
            totales: {
                tarimas: completo.cantidad_tarimas,
                cajas: completo.cantidad_cajas,
                procesos: completo.procesos
            }
        });
    } catch (error) {
        console.error("Error al quitar la linea:", error);
        res.status(500).json({ error: "Error al quitar la línea" });
    }
};

// ----------------------------------------------------------------------------
// DELETE /api/preenfrio/bloques/:id  → desarmar (baja lógica)
// ----------------------------------------------------------------------------
// El montón se deshizo. No se borra porque sus pulpeos son evidencia de la
// cadena de frío y tienen que seguir resolviendo a qué bloque pertenecían.
const desarmarBloque = async (req, res) => {
    try {
        const { id } = req.params;

        const bloque = await bloquesModel.getBloqueById(id);

        if (!bloque) {
            return res.status(404).json({ error: "Bloque no encontrado" });
        }

        const problema = await validarAlcanceBloque(id, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        if (Number(bloque.estado) === 0) {
            return res.status(409).json({
                error: "El bloque ya está desarmado"
            });
        }

        const desarmado = await bloquesModel.desarmarBloque(id);

        res.status(200).json({
            mensaje: `Bloque ${desarmado.codigo_bloque} desarmado. Sus ${bloque.pulpeos_registrados} pulpeo(s) se conservan como evidencia.`,
            bloque: desarmado
        });
    } catch (error) {
        console.error("Error al desarmar el bloque:", error);
        res.status(500).json({ error: "Error al desarmar el bloque" });
    }
};

// PATCH /api/preenfrio/bloques/:id/rearmar
const rearmarBloque = async (req, res) => {
    try {
        const { id } = req.params;

        const bloque = await bloquesModel.getBloqueById(id);

        if (!bloque) {
            return res.status(404).json({ error: "Bloque no encontrado" });
        }

        const problema = await validarAlcanceBloque(id, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        if (Number(bloque.estado) !== 0) {
            return res.status(409).json({ error: "El bloque no está desarmado" });
        }

        const rearmado = await bloquesModel.rearmarBloque(id);

        res.status(200).json({
            mensaje: `Bloque ${rearmado.codigo_bloque} rearmado`,
            bloque: rearmado
        });
    } catch (error) {
        console.error("Error al rearmar el bloque:", error);
        res.status(500).json({ error: "Error al rearmar el bloque" });
    }
};

// DELETE /api/preenfrio/bloques/:id/eliminar
// Borrado físico. Solo para un alta mal capturada que nunca se usó.
const deleteBloque = async (req, res) => {
    try {
        const { id } = req.params;

        const bloque = await bloquesModel.getBloqueById(id);

        if (!bloque) {
            return res.status(404).json({ error: "Bloque no encontrado" });
        }

        if (Number(bloque.pulpeos_registrados) > 0) {
            return res.status(409).json({
                error: `No se puede eliminar: el bloque tiene ${bloque.pulpeos_registrados} pulpeo(s) que son evidencia de la cadena de frío. Desármalo en lugar de borrarlo.`
            });
        }

        const despachos = await bloquesModel.getLineasDespachoLigadas(id);

        if (despachos.length > 0) {
            return res.status(409).json({
                error: `No se puede eliminar: el bloque forma parte del despacho ${despachos[0].folio_despacho}`
            });
        }

        const eliminado = await bloquesModel.deleteBloque(id);

        res.status(200).json({
            mensaje: `Bloque ${eliminado.codigo_bloque} eliminado definitivamente`,
            bloque: eliminado
        });
    } catch (error) {
        console.error("Error al eliminar el bloque:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "No se puede eliminar: otros registros dependen de este bloque"
            });
        }

        res.status(500).json({ error: "Error al eliminar el bloque" });
    }
};

export const bloquesController = {
    getBloques,
    getBloqueById,
    createBloque,
    updateBloque,
    agregarLinea,
    actualizarLinea,
    quitarLinea,
    desarmarBloque,
    rearmarBloque,
    deleteBloque
};
