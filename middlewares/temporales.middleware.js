// ============================================================================
// VALIDACIONES · CAJAS TEMPORALES
// ============================================================================

const entero = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

// POST /temporales/reubicar
export const validarReubicar = (req, res, next) => {
    const { id_camara_origen, destino } = req.body ?? {};
    if (!entero(id_camara_origen)) return res.status(400).json({ error: "Indica la cámara de origen" });
    if (!destino || typeof destino !== "object") return res.status(400).json({ error: "Indica el destino" });

    if (destino.id_camara !== undefined && destino.id_camara !== null && destino.id_camara !== "") {
        if (!entero(destino.id_camara)) return res.status(400).json({ error: "Destino inválido" });
        req.body = { id_camara_origen: Number(id_camara_origen), destino: { id_camara: Number(destino.id_camara) } };
        return next();
    }

    const n = destino.nueva;
    if (!n || typeof n !== "object") return res.status(400).json({ error: "Elige una caja abierta, otra cámara o abre una caja nueva" });
    if (!entero(n.id_linea_fletera)) return res.status(400).json({ error: "Elige la línea fletera" });
    if (!entero(n.id_caja_refrigerada)) return res.status(400).json({ error: "Elige la caja refrigerada" });
    const cap = Number(n.capacidad);
    if (!Number.isInteger(cap) || cap < 1 || cap > 40) return res.status(400).json({ error: "La capacidad de la caja debe ser de 1 a 40 tarimas" });

    req.body = {
        id_camara_origen: Number(id_camara_origen),
        destino: {
            nueva: {
                id_linea_fletera: Number(n.id_linea_fletera),
                id_caja_refrigerada: Number(n.id_caja_refrigerada),
                capacidad: cap
            }
        }
    };
    next();
};

export const validarIdTemporal = (req, res, next) => {
    if (!entero(req.params.id)) return res.status(400).json({ error: "El id debe ser un número válido" });
    next();
};
