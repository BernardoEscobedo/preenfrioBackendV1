import produccionModel from "../models/produccion.model.js";
import fincasModel from "../models/fincas.model.js";
import camarasModel from "../models/camaras.model.js";

// ============================================================================
// PRODUCCIÓN
// ============================================================================
// req.camaras lo pone el middleware cargarAlcance:
//     null  -> Admin / Coordinador (ven todas las plantas)
//     [...] -> Supervisor / Operativo (solo las suyas)
//
// DOS CAPAS DE ALCANCE, Y LAS DOS HACEN FALTA
//   1. LECTURA: el modelo recibe req.camaras y filtra en el SQL.
//   2. ESCRITURA: validarCamaraEnAlcance("body") revisa el id_camara que
//      llega en el cuerpo de la petición.
//
//   Sin la segunda, un operativo de Doña Nelly podría planear fruta en
//   Fortaleza mandando ese id a mano con Postman. Filtrar solo la lectura
//   esconde los datos pero no impide escribirlos.
//
// LA COHERENCIA FINCA ↔ PRODUCTOR SE VALIDA AQUÍ
//   produccion guarda ambas FK por separado, y nada en la BD obliga a que
//   el productor sea el dueño de esa finca. Si se desalinean, el código de
//   lote mezcla el código de un productor con la finca de otro y la
//   trazabilidad se rompe en silencio.
// ============================================================================

// GET /api/preenfrio/produccion?semana=38&estado=1&buscar=texto
const getProduccion = async (req, res) => {
    try {
        const {
            semana,
            estado,
            id_camara,
            id_finca,
            id_cc,
            fecha_desde,
            fecha_hasta,
            buscar
        } = req.query;

        const produccion = await produccionModel.getProduccion(
            {
                semana: semana ? Number(semana) : null,
                estado: estado !== undefined && estado !== "" ? Number(estado) : null,
                id_camara: id_camara ? Number(id_camara) : null,
                id_finca: id_finca ? Number(id_finca) : null,
                id_cc: id_cc ? Number(id_cc) : null,
                fecha_desde: fecha_desde || null,
                fecha_hasta: fecha_hasta || null,
                buscar: buscar || null
            },
            req.camaras
        );

        res.status(200).json(produccion);
    } catch (error) {
        console.error("Error al obtener produccion:", error);
        res.status(500).json({ error: "Error al obtener la producción" });
    }
};

// GET /api/preenfrio/produccion/:id
const getProduccionById = async (req, res) => {
    try {
        const { id } = req.params;
        const produccion = await produccionModel.getProduccionById(id);

        if (!produccion) {
            return res.status(404).json({ error: "Producción no encontrada" });
        }

        // El alcance se valida DESPUÉS de traerla, para distinguir entre
        // "no existe" (404) y "existe pero no es de tu planta" (403).
        // Mismo criterio que camaras.controller.js.
        //
        // Las producciones sin cámara (CEDA directo) quedan fuera del
        // alcance limitado: esa fruta nunca toca un preenfrío.
        if (Array.isArray(req.camaras)) {
            if (
                produccion.id_camara === null ||
                !req.camaras.includes(Number(produccion.id_camara))
            ) {
                return res.status(403).json({
                    error: "No tienes acceso a esa producción"
                });
            }
        }

        res.status(200).json(produccion);
    } catch (error) {
        console.error("Error al obtener produccion:", error);
        res.status(500).json({ error: "Error al obtener la producción" });
    }
};

// GET /api/preenfrio/produccion/resumen?semana=38
// Encabezado del dashboard de planeación. Respeta el alcance.
const getResumenSemana = async (req, res) => {
    try {
        const { semana } = req.query;

        const resumen = await produccionModel.getResumenSemana(
            semana ? Number(semana) : null,
            req.camaras
        );

        res.status(200).json(resumen);
    } catch (error) {
        console.error("Error al obtener el resumen:", error);
        res.status(500).json({ error: "Error al obtener el resumen" });
    }
};

// ----------------------------------------------------------------------------
// Validación compartida entre alta y edición
// ----------------------------------------------------------------------------
// Devuelve un objeto de error listo para responder, o null si todo cuadra.
// Se extrae aquí porque las mismas tres reglas aplican en POST y en PUT.
const validarCoherencia = async ({ id_finca, id_productor, id_camara }) => {
    // 1) La finca existe y está activa
    const finca = await fincasModel.getFincaById(id_finca);

    if (!finca) {
        return { status: 409, error: "La finca indicada no existe" };
    }

    if (finca.estado === 0) {
        return {
            status: 409,
            error: `La finca "${finca.nombre}" está dada de baja. Reactívala antes de planear fruta suya.`
        };
    }

    // 2) El productor corresponde a esa finca
    // Es la validación clave del módulo: si no cuadran, el código de lote
    // mezcla el código de un productor con la finca de otro.
    if (Number(finca.id_productor) !== Number(id_productor)) {
        return {
            status: 409,
            error: `La finca "${finca.nombre}" pertenece a ${finca.nombre_productor} (id ${finca.id_productor}), no al productor ${id_productor}. El código de lote quedaría inconsistente.`
        };
    }

    // 3) La cámara existe, está operativa y es de preenfrío
    // NULL es válido: significa CEDA directo.
    if (id_camara !== null && id_camara !== undefined) {
        const camara = await camarasModel.getCamaraById(id_camara);

        if (!camara) {
            return { status: 409, error: "La cámara indicada no existe" };
        }

        if (camara.estado === 0) {
            return {
                status: 409,
                error: `La cámara "${camara.nombre_camara}" está fuera de servicio`
            };
        }

        // La planeación solo asigna PREENFRÍO (tipo 1). La conservación es
        // un destino posterior, al que la fruta llega por movimiento, no
        // por plan.
        if (Number(camara.tipo_camara) !== 1) {
            return {
                status: 409,
                error: `"${camara.nombre_camara}" es una cámara de conservación. La planeación solo asigna cámaras de preenfrío.`
            };
        }
    }

    return null;
};

// POST /api/preenfrio/produccion
const createProduccion = async (req, res) => {
    try {
        const problema = await validarCoherencia(req.body);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        const nueva = await produccionModel.createProduccion(req.body);

        // Si el INSERT no devolvió fila, algún catálogo no existe: el
        // SELECT interno no encontró la combinación finca/productor/SKU.
        if (!nueva) {
            return res.status(409).json({
                error: "No se pudo generar el código de lote: revisa que la finca, el productor y el SKU existan"
            });
        }

        const completa = await produccionModel.getProduccionById(nueva.id_produccion);

        res.status(201).json(completa);
    } catch (error) {
        console.error("Error al crear produccion:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "Alguno de los catálogos indicados no existe (finca, productor, SKU, cliente o cámara)"
            });
        }

        res.status(500).json({
            error: "Error al crear la producción" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/produccion/:id
const updateProduccion = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await produccionModel.getProduccionById(id);
        if (!existente) {
            return res.status(404).json({ error: "Producción no encontrada" });
        }

        // Alcance sobre la fila ACTUAL: no basta validar la cámara nueva,
        // porque si no, alguien podría "jalarse" una producción ajena
        // reasignándola a su propia cámara.
        if (Array.isArray(req.camaras)) {
            if (
                existente.id_camara === null ||
                !req.camaras.includes(Number(existente.id_camara))
            ) {
                return res.status(403).json({
                    error: "No tienes acceso a esa producción"
                });
            }
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "La producción está cancelada. Reactívala antes de editarla."
            });
        }

        const problema = await validarCoherencia(req.body);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        // Editar los datos de origen de una producción que YA recibió fruta
        // descuadra la trazabilidad: las ocupaciones y movimientos que ya
        // existen apuntan al lote viejo. Se permite, pero se avisa.
        const dependencias = await produccionModel.getDependencias(id);
        const yaRecibio = Number(dependencias.recepciones) > 0;

        const actualizada = await produccionModel.updateProduccion(id, req.body);

        if (!actualizada) {
            return res.status(409).json({
                error: "No se pudo recalcular el código de lote: revisa la finca, el productor y el SKU"
            });
        }

        const completa = await produccionModel.getProduccionById(id);

        let aviso = null;

        if (yaRecibio && existente.codigo_lote !== completa.codigo_lote) {
            aviso = `Esta producción ya tiene ${dependencias.recepciones} recepción(es) registrada(s) y el código de lote cambió de "${existente.codigo_lote}" a "${completa.codigo_lote}". Verifica las etiquetas físicas de la fruta que ya está en cámara.`;
        }

        res.status(200).json({ ...completa, aviso });
    } catch (error) {
        console.error("Error al actualizar produccion:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "Alguno de los catálogos indicados no existe"
            });
        }

        res.status(500).json({ error: "Error al actualizar la producción" });
    }
};

// PATCH /api/preenfrio/produccion/:id/camara
// Reasignación de cámara: la operación más frecuente del planeador cuando
// un preenfrío se satura. Va aparte del PUT para no obligar a reenviar las
// quince columnas por cambiar una.
const reasignarCamara = async (req, res) => {
    try {
        const { id } = req.params;
        const { id_camara } = req.body;

        const existente = await produccionModel.getProduccionById(id);
        if (!existente) {
            return res.status(404).json({ error: "Producción no encontrada" });
        }

        // Alcance sobre la cámara ACTUAL. La de destino ya la validó
        // validarCamaraEnAlcance("body") en la cadena de la ruta.
        if (Array.isArray(req.camaras)) {
            if (
                existente.id_camara === null ||
                !req.camaras.includes(Number(existente.id_camara))
            ) {
                return res.status(403).json({
                    error: "No tienes acceso a esa producción"
                });
            }
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "La producción está cancelada"
            });
        }

        // Mover de cámara fruta que YA entró no reubica nada físicamente:
        // las ocupaciones siguen en la cámara original. Se bloquea porque
        // el resultado sería un plan que miente sobre dónde está la fruta.
        const dependencias = await produccionModel.getDependencias(id);

        if (Number(dependencias.recepciones) > 0) {
            return res.status(409).json({
                error: `No se puede reasignar: la producción ya tiene ${dependencias.recepciones} recepción(es) y su fruta está físicamente en "${existente.nombre_camara}". Para moverla usa un movimiento de inventario.`
            });
        }

        // Validaciones de la cámara destino (existe, operativa, preenfrío)
        if (id_camara !== null) {
            const camara = await camarasModel.getCamaraById(id_camara);

            if (!camara) {
                return res.status(409).json({ error: "La cámara indicada no existe" });
            }

            if (camara.estado === 0) {
                return res.status(409).json({
                    error: `La cámara "${camara.nombre_camara}" está fuera de servicio`
                });
            }

            if (Number(camara.tipo_camara) !== 1) {
                return res.status(409).json({
                    error: `"${camara.nombre_camara}" es de conservación. La planeación solo asigna preenfrío.`
                });
            }
        }

        await produccionModel.reasignarCamara(id, id_camara);
        const completa = await produccionModel.getProduccionById(id);

        res.status(200).json({
            mensaje: id_camara === null
                ? "Producción marcada como CEDA directo: no pasará por preenfrío"
                : `Producción reasignada a "${completa.nombre_camara}"`,
            produccion: completa
        });
    } catch (error) {
        console.error("Error al reasignar la camara:", error);
        res.status(500).json({ error: "Error al reasignar la cámara" });
    }
};

// DELETE /api/preenfrio/produccion/:id
// Cancelación (estado = 0). No se borra la fila: si ya hubo recepciones,
// sus ocupaciones y movimientos siguen apuntando aquí.
const cancelarProduccion = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await produccionModel.getProduccionById(id);
        if (!existente) {
            return res.status(404).json({ error: "Producción no encontrada" });
        }

        if (Array.isArray(req.camaras)) {
            if (
                existente.id_camara === null ||
                !req.camaras.includes(Number(existente.id_camara))
            ) {
                return res.status(403).json({
                    error: "No tienes acceso a esa producción"
                });
            }
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "La producción ya está cancelada"
            });
        }

        const dependencias = await produccionModel.getDependencias(id);

        // Cancelar algo que ya se despachó dejaría un documento de salida
        // apuntando a una línea de plan que dice "no existió".
        if (Number(dependencias.lineas_despacho) > 0) {
            return res.status(409).json({
                error: `No se puede cancelar: la producción ya tiene ${dependencias.lineas_despacho} línea(s) de despacho. Esa fruta ya salió.`
            });
        }

        const produccion = await produccionModel.cancelarProduccion(id);

        res.status(200).json({
            mensaje: Number(dependencias.recepciones) > 0
                ? `Producción cancelada. OJO: tiene ${dependencias.recepciones} recepción(es) y su fruta sigue ocupando cámara. Revisa el inventario.`
                : "Producción cancelada correctamente",
            produccion,
            dependencias
        });
    } catch (error) {
        console.error("Error al cancelar la produccion:", error);
        res.status(500).json({ error: "Error al cancelar la producción" });
    }
};

// PATCH /api/preenfrio/produccion/:id/reactivar
// El estado no vuelve a 1 por defecto: se recalcula según lo que se haya
// recibido mientras estuvo cancelada.
const reactivarProduccion = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await produccionModel.getProduccionById(id);
        if (!existente) {
            return res.status(404).json({ error: "Producción no encontrada" });
        }

        if (Array.isArray(req.camaras)) {
            if (
                existente.id_camara === null ||
                !req.camaras.includes(Number(existente.id_camara))
            ) {
                return res.status(403).json({
                    error: "No tienes acceso a esa producción"
                });
            }
        }

        if (existente.estado !== 0) {
            return res.status(409).json({
                error: "La producción no está cancelada"
            });
        }

        await produccionModel.reactivarProduccion(id);
        const completa = await produccionModel.getProduccionById(id);

        res.status(200).json({
            mensaje: `Producción reactivada con estado "${completa.estado_texto}"`,
            produccion: completa
        });
    } catch (error) {
        console.error("Error al reactivar la produccion:", error);
        res.status(500).json({ error: "Error al reactivar la producción" });
    }
};

export const produccionController = {
    getProduccion,
    getProduccionById,
    getResumenSemana,
    createProduccion,
    updateProduccion,
    reasignarCamara,
    cancelarProduccion,
    reactivarProduccion
};
