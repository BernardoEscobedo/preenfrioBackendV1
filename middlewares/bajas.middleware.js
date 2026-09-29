// ============================================================================
// VALIDACIÓN DEL MOTIVO DE UNA BAJA O REACTIVACIÓN
// ============================================================================
// El motivo es lo que va a leer el administrador en el historial meses
// después. "error" o "baja" no explican nada, por eso se exige un mínimo.
//
// Mismo umbral que la auditoría de despachos y la reversa de movimientos.
//
// USO
//   validarMotivoBaja()         motivo obligatorio (bajas)
//   validarMotivoBaja(false)    motivo opcional (reactivaciones)
// ============================================================================

export const validarMotivoBaja = (obligatorio = true) => {
    return (req, res, next) => {
        const motivo = req.body?.motivo;

        const vacio =
            motivo === undefined ||
            motivo === null ||
            String(motivo).trim() === "";

        if (vacio) {
            if (obligatorio) {
                return res.status(400).json({
                    error: 'El campo "motivo" es obligatorio: queda en el historial de bajas'
                });
            }

            req.body = { ...(req.body ?? {}), motivo: null };
            return next();
        }

        if (typeof motivo !== "string") {
            return res.status(400).json({
                error: 'El campo "motivo" debe ser texto'
            });
        }

        if (motivo.trim().length < 10) {
            return res.status(400).json({
                error: 'El campo "motivo" debe explicar la razón: usa al menos 10 caracteres'
            });
        }

        if (motivo.length > 250) {
            return res.status(400).json({
                error: 'El campo "motivo" no puede exceder 250 caracteres'
            });
        }

        req.body.motivo = motivo.trim();

        next();
    };
};

export const validarIdBaja = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id debe ser un número válido"
        });
    }

    next();
};
