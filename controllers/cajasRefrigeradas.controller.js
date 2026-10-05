import cajasRefrigeradasModel from "../models/cajasRefrigeradas.model.js";
import lineasFleterasModel from "../models/lineasFleteras.model.js";

// ============================================================================
// CAJAS REFRIGERADAS
// ============================================================================
// Catálogo sin alcance por cámara. El acceso lo limita el rol.
//
// La caja es la pieza que se inspecciona en cada despacho, pero su
// inspección NO vive aquí: un resultado de ayer no vale para hoy. Se
// registra en PATCH /despachos/:id/inocuidad.
//
// ⚠️ CAMBIAR DE LÍNEA
//   Si la caja ya forma parte de algún transporte, no se le cambia la
//   línea fletera: ese servicio quedaría con una caja de otra empresa.
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

// GET /api/preenfrio/cajas-refrigeradas?estado=1&id_linea_fletera=3&buscar=texto
const getCajas = async (req, res) => {
    try {
        const { estado, id_linea_fletera, buscar } = req.query;

        const cajas = await cajasRefrigeradasModel.getCajas({
            estado: estado !== undefined && estado !== "" ? Number(estado) : null,
            id_linea_fletera: id_linea_fletera ? Number(id_linea_fletera) : null,
            buscar: buscar || null
        });

        res.status(200).json(cajas);
    } catch (error) {
        console.error("Error al obtener cajas refrigeradas:", error);
        res.status(500).json({ error: "Error al obtener las cajas refrigeradas" });
    }
};

// GET /api/preenfrio/cajas-refrigeradas/:id
const getCajaById = async (req, res) => {
    try {
        const { id } = req.params;

        const caja = await cajasRefrigeradasModel.getCajaById(id);

        if (!caja) {
            return res.status(404).json({ error: "Caja refrigerada no encontrada" });
        }

        res.status(200).json(caja);
    } catch (error) {
        console.error("Error al obtener la caja refrigerada:", error);
        res.status(500).json({ error: "Error al obtener la caja refrigerada" });
    }
};

// POST /api/preenfrio/cajas-refrigeradas
const createCaja = async (req, res) => {
    try {
        const { id_linea_fletera, placas } = req.body;

        const errorLinea = await validarLinea(id_linea_fletera);
        if (errorLinea) {
            return res.status(409).json({ error: errorLinea });
        }

        const duplicado = await cajasRefrigeradasModel.existePlacas(placas);
        if (duplicado) {
            return res.status(409).json({
                error: Number(duplicado.estado) === 1
                    ? `Las placas ${duplicado.placas} ya están registradas`
                    : `Las placas ${duplicado.placas} ya existen pero están dadas de baja. Reactiva la caja en vez de crear otra.`
            });
        }

        const nueva = await cajasRefrigeradasModel.createCaja(req.body);

        res.status(201).json(nueva);
    } catch (error) {
        console.error("Error al crear la caja refrigerada:", error);

        if (error.code === "23503") {
            return res.status(409).json({ error: "La línea fletera indicada no existe" });
        }

        res.status(500).json({
            error: "Error al crear la caja refrigerada" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/cajas-refrigeradas/:id
const updateCaja = async (req, res) => {
    try {
        const { id } = req.params;
        const { id_linea_fletera, placas, numero_economico } = req.body;

        const existente = await cajasRefrigeradasModel.getCajaById(id);

        if (!existente) {
            return res.status(404).json({ error: "Caja refrigerada no encontrada" });
        }

        const dependencias = await cajasRefrigeradasModel.getDependencias(id);

        const cambiaLinea =
            (existente.id_linea_fletera ?? null) !== (id_linea_fletera ?? null);

        if (cambiaLinea && Number(dependencias.transportes) > 0) {
            return res.status(409).json({
                error: `Esta caja ya forma parte de ${dependencias.transportes} transporte(s): no se le puede cambiar la línea fletera.`
            });
        }

        if (cambiaLinea) {
            const errorLinea = await validarLinea(id_linea_fletera);
            if (errorLinea) {
                return res.status(409).json({ error: errorLinea });
            }
        }

        const duplicado = await cajasRefrigeradasModel.existePlacas(placas, Number(id));
        if (duplicado) {
            return res.status(409).json({
                error: `Las placas ${duplicado.placas} ya pertenecen a otra caja`
            });
        }

        const actualizada = await cajasRefrigeradasModel.updateCaja(id, req.body);

        // vw_despachos lee placas y número económico en vivo: la
        // corrección también se ve en los despachos ya registrados.
        const cambioVisible =
            existente.placas !== placas ||
            existente.numero_economico !== numero_economico;

        res.status(200).json({
            ...actualizada,
            aviso: cambioVisible && Number(dependencias.despachos) > 0
                ? `La corrección también se verá en ${dependencias.despachos} despacho(s) ya registrados con esta caja.`
                : null
        });
    } catch (error) {
        console.error("Error al actualizar la caja refrigerada:", error);

        if (error.code === "23514") {
            return res.status(400).json({ error: "El largo de la caja debe ser mayor a 0" });
        }

        res.status(500).json({ error: "Error al actualizar la caja refrigerada" });
    }
};

// DELETE /api/preenfrio/cajas-refrigeradas/:id
const bajaCaja = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await cajasRefrigeradasModel.getCajaById(id);

        if (!existente) {
            return res.status(404).json({ error: "Caja refrigerada no encontrada" });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "La caja refrigerada ya está dada de baja"
            });
        }

        const dependencias = await cajasRefrigeradasModel.getDependencias(id);
        const caja = await cajasRefrigeradasModel.bajaCaja(id);

        res.status(200).json({
            mensaje: "Caja refrigerada dada de baja. Sus transportes ya no podrán usarse en despachos nuevos; el histórico se conserva.",
            caja,
            dependencias
        });
    } catch (error) {
        console.error("Error al dar de baja la caja refrigerada:", error);
        res.status(500).json({ error: "Error al dar de baja la caja refrigerada" });
    }
};

// PATCH /api/preenfrio/cajas-refrigeradas/:id/reactivar
const reactivarCaja = async (req, res) => {
    try {
        const { id } = req.params;

        const caja = await cajasRefrigeradasModel.reactivarCaja(id);

        if (!caja) {
            return res.status(404).json({ error: "Caja refrigerada no encontrada" });
        }

        res.status(200).json({
            mensaje: "Caja refrigerada reactivada correctamente",
            caja
        });
    } catch (error) {
        console.error("Error al reactivar la caja refrigerada:", error);
        res.status(500).json({ error: "Error al reactivar la caja refrigerada" });
    }
};

export const cajasRefrigeradasController = {
    getCajas,
    getCajaById,
    createCaja,
    updateCaja,
    bajaCaja,
    reactivarCaja
};
