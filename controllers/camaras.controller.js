import camarasModel from "../models/camaras.model.js";

// ============================================================================
// CÁMARAS
// ============================================================================
// req.camaras lo pone el middleware cargarAlcance:
//     null  -> Admin / Coordinador (ven todas)
//     [...] -> Supervisor / Operativo (solo las suyas)
// ============================================================================

// GET /api/preenfrio/camaras/camaras
const getCamaras = async (req, res) => {
    try {
        const camaras = await camarasModel.getCamaras(req.camaras);
        res.status(200).json(camaras);
    } catch (error) {
        console.error("Error al obtener camaras:", error);
        res.status(500).json({ error: "Error al obtener las cámaras" });
    }
};

// GET /api/preenfrio/camaras/camara/:id_camara
const getCamaraById = async (req, res) => {
    try {
        const { id_camara } = req.params;
        const camara = await camarasModel.getCamaraById(id_camara);

        if (!camara) {
            return res.status(404).json({ error: "Cámara no encontrada" });
        }

        // El alcance se valida DESPUÉS de traerla, para poder distinguir
        // entre "no existe" (404) y "existe pero no es tuya" (403).
        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(camara.id_camara))
        ) {
            return res.status(403).json({ error: "No tienes acceso a esa cámara" });
        }

        res.status(200).json(camara);
    } catch (error) {
        console.error("Error al obtener camara:", error);
        res.status(500).json({ error: "Error al obtener la cámara" });
    }
};

// GET /api/preenfrio/camaras/tipo/:tipo
// 1 = preenfrío · 2 = conservación
const getCamarasByTipo = async (req, res) => {
    try {
        const { tipo } = req.params;
        if (!tipo || ![1, 2].includes(Number(tipo))) {
            return res.status(400).json({
                error: "El tipo debe ser 1 (preenfrío) o 2 (conservación)"
            });
        }
        const camaras = await camarasModel.getCamarasByTipo(
            Number(tipo),
            req.camaras
        );
        res.status(200).json(camaras);
    } catch (error) {
        console.error("Error al obtener camaras por tipo:", error);
        res.status(500).json({ error: "Error al obtener las cámaras" });
    }
};

// POST /api/preenfrio/camaras/registrarcamara
// Dar de alta cámaras es decisión de coordinación (ver la ruta): quien
// llega aquí ya tiene alcance total, así que no hay nada que validar.
const createCamara = async (req, res) => {
    try {
        const nueva = await camarasModel.createCamara(req.body);
        res.status(201).json(nueva);
    } catch (error) {
        console.error("Error al crear camara:", error);
        res.status(500).json({
            error: "Error al crear la cámara" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/camaras/actualizarcamara/:id_camara
const updateCamara = async (req, res) => {
    try {
        const { id_camara } = req.params;
        const { capacidad_max_tarimas, capacidad_max_cajas } = req.body;

        const actual = await camarasModel.getCamaraById(id_camara);
        if (!actual) {
            return res.status(404).json({ error: "Cámara no encontrada" });
        }

        // No se permite bajar la capacidad por debajo de lo que la cámara
        // ya tiene dentro: dejaría el inventario en sobreocupación y los
        // cálculos de espacio libre darían números negativos.
        const ocupacion = await camarasModel.getOcupacionActual(id_camara);
        const tarimasDentro = Number(ocupacion.tarimas_ocupadas) || 0;
        const cajasDentro = Number(ocupacion.cajas_ocupadas) || 0;

        if (Number(capacidad_max_tarimas) < tarimasDentro) {
            return res.status(409).json({
                error: `No puedes bajar la capacidad a ${capacidad_max_tarimas} tarimas: la cámara tiene ${tarimasDentro} dentro. Mueve producto primero.`
            });
        }
        if (Number(capacidad_max_cajas) < cajasDentro) {
            return res.status(409).json({
                error: `No puedes bajar la capacidad a ${capacidad_max_cajas} cajas: la cámara tiene ${cajasDentro} dentro.`
            });
        }

        const actualizada = await camarasModel.updateCamara(id_camara, req.body);
        res.status(200).json(actualizada);
    } catch (error) {
        console.error("Error al actualizar camara:", error);
        res.status(500).json({ error: "Error al actualizar la cámara" });
    }
};

// DELETE /api/preenfrio/camaras/eliminarcamara/:id_camara
const deleteCamara = async (req, res) => {
    try {
        const { id_camara } = req.params;
        const eliminada = await camarasModel.deleteCamara(id_camara);

        if (!eliminada) {
            return res.status(404).json({ error: "Cámara no encontrada" });
        }

        res.status(200).json({
            mensaje: "Cámara eliminada correctamente",
            camara: eliminada
        });
    } catch (error) {
        console.error("Error al eliminar camara:", error);
        // La cámara puede estar referenciada por ocupaciones, producción,
        // recepciones, movimientos o asignaciones de usuarios.
        if (error.code === "23503") {
            return res.status(409).json({
                error: "No se puede eliminar: la cámara tiene ocupaciones, producción o movimientos asociados"
            });
        }
        res.status(500).json({ error: "Error al eliminar la cámara" });
    }
};

export const camarasController = {
    getCamaras,
    getCamaraById,
    getCamarasByTipo,
    createCamara,
    updateCamara,
    deleteCamara
};
