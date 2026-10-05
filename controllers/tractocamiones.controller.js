import tractocamionesModel from "../models/tractocamiones.model.js";
import lineasFleterasModel from "../models/lineasFleteras.model.js";

// ============================================================================
// TRACTOCAMIONES
// ============================================================================
// Catálogo sin alcance por cámara. El acceso lo limita el rol.
//
// ⚠️ CAMBIAR DE LÍNEA
//   Si el tracto ya forma parte de algún transporte, no se le cambia la
//   línea fletera: ese servicio quedaría con una unidad de otra empresa.
// ============================================================================

/**
 * Revisa que la línea indicada exista y esté activa.
 * Devuelve el texto del error, o null si no hay línea o todo cuadra.
 */
const validarLinea = async (id_linea_fletera) => {
    if (id_linea_fletera === null) return null;

    const linea = await lineasFleterasModel.getLineaById(id_linea_fletera);

    if (!linea) return "La línea fletera indicada no existe";
    if (linea.estado === 0) {
        return `La línea fletera "${linea.razon_social}" está dada de baja`;
    }
    return null;
};

// GET /api/preenfrio/tractocamiones?estado=1&id_linea_fletera=3&buscar=texto
const getTractocamiones = async (req, res) => {
    try {
        const { estado, id_linea_fletera, buscar } = req.query;

        const tractos = await tractocamionesModel.getTractocamiones({
            estado: estado !== undefined && estado !== "" ? Number(estado) : null,
            id_linea_fletera: id_linea_fletera ? Number(id_linea_fletera) : null,
            buscar: buscar || null
        });

        res.status(200).json(tractos);
    } catch (error) {
        console.error("Error al obtener tractocamiones:", error);
        res.status(500).json({ error: "Error al obtener los tractocamiones" });
    }
};

// GET /api/preenfrio/tractocamiones/:id
const getTractocamionById = async (req, res) => {
    try {
        const { id } = req.params;

        const tracto = await tractocamionesModel.getTractocamionById(id);

        if (!tracto) {
            return res.status(404).json({ error: "Tractocamión no encontrado" });
        }

        res.status(200).json(tracto);
    } catch (error) {
        console.error("Error al obtener el tractocamión:", error);
        res.status(500).json({ error: "Error al obtener el tractocamión" });
    }
};

// POST /api/preenfrio/tractocamiones
const createTractocamion = async (req, res) => {
    try {
        const { id_linea_fletera, placas } = req.body;

        const errorLinea = await validarLinea(id_linea_fletera);
        if (errorLinea) {
            return res.status(409).json({ error: errorLinea });
        }

        const duplicado = await tractocamionesModel.existePlacas(placas);
        if (duplicado) {
            return res.status(409).json({
                error: Number(duplicado.estado) === 1
                    ? `Las placas ${duplicado.placas} ya están registradas`
                    : `Las placas ${duplicado.placas} ya existen pero están dadas de baja. Reactiva el tractocamión en vez de crear otro.`
            });
        }

        const nuevo = await tractocamionesModel.createTractocamion(req.body);

        res.status(201).json(nuevo);
    } catch (error) {
        console.error("Error al crear el tractocamión:", error);

        if (error.code === "23503") {
            return res.status(409).json({ error: "La línea fletera indicada no existe" });
        }

        res.status(500).json({
            error: "Error al crear el tractocamión" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/tractocamiones/:id
const updateTractocamion = async (req, res) => {
    try {
        const { id } = req.params;
        const { id_linea_fletera, placas, numero_economico } = req.body;

        const existente = await tractocamionesModel.getTractocamionById(id);

        if (!existente) {
            return res.status(404).json({ error: "Tractocamión no encontrado" });
        }

        const dependencias = await tractocamionesModel.getDependencias(id);

        const cambiaLinea =
            (existente.id_linea_fletera ?? null) !== (id_linea_fletera ?? null);

        if (cambiaLinea && Number(dependencias.transportes) > 0) {
            return res.status(409).json({
                error: `Este tractocamión ya forma parte de ${dependencias.transportes} transporte(s): no se le puede cambiar la línea fletera.`
            });
        }

        if (cambiaLinea) {
            const errorLinea = await validarLinea(id_linea_fletera);
            if (errorLinea) {
                return res.status(409).json({ error: errorLinea });
            }
        }

        const duplicado = await tractocamionesModel.existePlacas(placas, Number(id));
        if (duplicado) {
            return res.status(409).json({
                error: `Las placas ${duplicado.placas} ya pertenecen a otro tractocamión`
            });
        }

        const actualizado = await tractocamionesModel.updateTractocamion(id, req.body);

        // vw_despachos lee las placas en vivo: la corrección también se ve
        // en los despachos ya registrados.
        const cambioVisible =
            existente.placas !== placas ||
            existente.numero_economico !== numero_economico;

        res.status(200).json({
            ...actualizado,
            aviso: cambioVisible && Number(dependencias.despachos) > 0
                ? `La corrección también se verá en ${dependencias.despachos} despacho(s) ya registrados con este tractocamión.`
                : null
        });
    } catch (error) {
        console.error("Error al actualizar el tractocamión:", error);
        res.status(500).json({ error: "Error al actualizar el tractocamión" });
    }
};

// DELETE /api/preenfrio/tractocamiones/:id
const bajaTractocamion = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await tractocamionesModel.getTractocamionById(id);

        if (!existente) {
            return res.status(404).json({ error: "Tractocamión no encontrado" });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "El tractocamión ya está dado de baja"
            });
        }

        const dependencias = await tractocamionesModel.getDependencias(id);
        const tracto = await tractocamionesModel.bajaTractocamion(id);

        res.status(200).json({
            mensaje: "Tractocamión dado de baja. Sus transportes ya no podrán usarse en despachos nuevos; el histórico se conserva.",
            tractocamion: tracto,
            dependencias
        });
    } catch (error) {
        console.error("Error al dar de baja el tractocamión:", error);
        res.status(500).json({ error: "Error al dar de baja el tractocamión" });
    }
};

// PATCH /api/preenfrio/tractocamiones/:id/reactivar
const reactivarTractocamion = async (req, res) => {
    try {
        const { id } = req.params;

        const tracto = await tractocamionesModel.reactivarTractocamion(id);

        if (!tracto) {
            return res.status(404).json({ error: "Tractocamión no encontrado" });
        }

        res.status(200).json({
            mensaje: "Tractocamión reactivado correctamente",
            tractocamion: tracto
        });
    } catch (error) {
        console.error("Error al reactivar el tractocamión:", error);
        res.status(500).json({ error: "Error al reactivar el tractocamión" });
    }
};

export const tractocamionesController = {
    getTractocamiones,
    getTractocamionById,
    createTractocamion,
    updateTractocamion,
    bajaTractocamion,
    reactivarTractocamion
};
