import m from "../models/packing.model.js";

// ============================================================================
// GET /api/preenfrio/packing/:id_despacho · operativo+
// ============================================================================
// Datos del packing list. El PDF se arma en el navegador (imprimir →
// guardar como PDF), así no depende de ninguna librería en el servidor.
// ============================================================================

export const getPacking = async (req, res) => {
    try {
        const id = Number(req.params.id_despacho);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Despacho inválido" });

        const despacho = await m.getEncabezado(id);
        if (!despacho) return res.status(404).json({ error: "Despacho no encontrado" });

        if (Array.isArray(req.camaras)) {
            const camaras = await m.getCamaras(id);
            if (camaras.length && !camaras.some((c) => req.camaras.includes(c))) {
                return res.status(403).json({ error: "No tienes acceso a ese despacho" });
            }
        }

        const [tarimas, lotes, caja2] = await Promise.all([
            m.getTarimas(id),
            m.getLotes(id),
            m.getCaja2(despacho.id_caja_refrigerada_2)
        ]);

        res.status(200).json({
            despacho: {
                ...despacho,
                placas_caja_2: despacho.placas_caja_2 ?? caja2?.placas ?? null,
                no_economico_caja_2: despacho.no_economico_caja_2 ?? caja2?.numero_economico ?? null
            },
            tarimas,
            lotes
        });
    } catch (error) {
        console.error("Error al armar el packing list:", error);
        res.status(500).json({ error: "Error al obtener el packing list" });
    }
};
