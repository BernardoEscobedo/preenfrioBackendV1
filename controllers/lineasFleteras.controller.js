import lineasFleterasModel from "../models/lineasFleteras.model.js";

// ============================================================================
// LÍNEAS FLETERAS
// ============================================================================
// Catálogo sin alcance por cámara: una línea trabaja para todas las plantas.
// El acceso lo limita el rol.
//
// LA BAJA NO ARRASTRA
//   Dar de baja una línea no da de baja a sus operadores, tractos ni cajas:
//   pueden cambiarse a otra línea o quedar independientes. Se informa
//   cuántos dependen de ella para que coordinación decida.
// ============================================================================

// GET /api/preenfrio/lineas-fleteras?estado=1&buscar=texto
const getLineas = async (req, res) => {
    try {
        const { estado, buscar } = req.query;

        const lineas = await lineasFleterasModel.getLineas({
            estado: estado !== undefined && estado !== "" ? Number(estado) : null,
            buscar: buscar || null
        });

        res.status(200).json(lineas);
    } catch (error) {
        console.error("Error al obtener líneas fleteras:", error);
        res.status(500).json({ error: "Error al obtener las líneas fleteras" });
    }
};

// GET /api/preenfrio/lineas-fleteras/:id
const getLineaById = async (req, res) => {
    try {
        const { id } = req.params;

        const linea = await lineasFleterasModel.getLineaById(id);

        if (!linea) {
            return res.status(404).json({ error: "Línea fletera no encontrada" });
        }

        res.status(200).json(linea);
    } catch (error) {
        console.error("Error al obtener la línea fletera:", error);
        res.status(500).json({ error: "Error al obtener la línea fletera" });
    }
};

// POST /api/preenfrio/lineas-fleteras
const createLinea = async (req, res) => {
    try {
        const { rfc } = req.body;

        const duplicado = await lineasFleterasModel.existeRfc(rfc);
        if (duplicado) {
            return res.status(409).json({
                error: Number(duplicado.estado) === 1
                    ? `Ese RFC ya está registrado (${duplicado.razon_social})`
                    : `Ese RFC ya existe pero está dado de baja (${duplicado.razon_social}). Reactívala en vez de crear otra.`
            });
        }

        const nueva = await lineasFleterasModel.createLinea(req.body);

        res.status(201).json(nueva);
    } catch (error) {
        console.error("Error al crear la línea fletera:", error);
        res.status(500).json({
            error: "Error al crear la línea fletera" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/lineas-fleteras/:id
const updateLinea = async (req, res) => {
    try {
        const { id } = req.params;
        const { rfc, razon_social } = req.body;

        const existente = await lineasFleterasModel.getLineaById(id);

        if (!existente) {
            return res.status(404).json({ error: "Línea fletera no encontrada" });
        }

        const duplicado = await lineasFleterasModel.existeRfc(rfc, Number(id));
        if (duplicado) {
            return res.status(409).json({
                error: `Ese RFC ya pertenece a otra línea (${duplicado.razon_social})`
            });
        }

        const dependencias = await lineasFleterasModel.getDependencias(id);
        const actualizada = await lineasFleterasModel.updateLinea(id, req.body);

        // vw_despachos lee la razón social en vivo: corregirla aquí cambia
        // también lo que muestran los despachos históricos.
        const cambioVisible =
            existente.razon_social !== razon_social || existente.rfc !== rfc;

        res.status(200).json({
            ...actualizada,
            aviso: cambioVisible && Number(dependencias.despachos) > 0
                ? `La corrección también se verá en ${dependencias.despachos} despacho(s) ya registrados con esta línea.`
                : null
        });
    } catch (error) {
        console.error("Error al actualizar la línea fletera:", error);
        res.status(500).json({ error: "Error al actualizar la línea fletera" });
    }
};

// DELETE /api/preenfrio/lineas-fleteras/:id
// Baja LÓGICA: los transportes y despachos históricos siguen apuntando aquí.
const bajaLinea = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await lineasFleterasModel.getLineaById(id);

        if (!existente) {
            return res.status(404).json({ error: "Línea fletera no encontrada" });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "La línea fletera ya está dada de baja"
            });
        }

        const dependencias = await lineasFleterasModel.getDependencias(id);
        const linea = await lineasFleterasModel.bajaLinea(id);

        res.status(200).json({
            mensaje: "Línea fletera dada de baja. Sus transportes ya no podrán usarse en despachos nuevos; el histórico se conserva.",
            linea,
            dependencias
        });
    } catch (error) {
        console.error("Error al dar de baja la línea fletera:", error);
        res.status(500).json({ error: "Error al dar de baja la línea fletera" });
    }
};

// PATCH /api/preenfrio/lineas-fleteras/:id/reactivar
const reactivarLinea = async (req, res) => {
    try {
        const { id } = req.params;

        const linea = await lineasFleterasModel.reactivarLinea(id);

        if (!linea) {
            return res.status(404).json({ error: "Línea fletera no encontrada" });
        }

        res.status(200).json({
            mensaje: "Línea fletera reactivada correctamente",
            linea
        });
    } catch (error) {
        console.error("Error al reactivar la línea fletera:", error);
        res.status(500).json({ error: "Error al reactivar la línea fletera" });
    }
};

export const lineasFleterasController = {
    getLineas,
    getLineaById,
    createLinea,
    updateLinea,
    bajaLinea,
    reactivarLinea
};
