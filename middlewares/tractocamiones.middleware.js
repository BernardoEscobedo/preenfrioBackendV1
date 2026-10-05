// ============================================================================
// VALIDACIONES DE TRACTOCAMIONES
// ============================================================================
// Las placas se normalizan quitando guiones y espacios: en el andén se
// capturan de todas las formas posibles ("15AN7H", "15-AN-7H", "15 AN 7H")
// y guardarlas sin normalizar haría que la misma unidad se diera de alta
// tres veces.
//
// id_linea_fletera es OPCIONAL: una unidad puede ser independiente.
// ============================================================================

/** Deja solo letras y números, en mayúsculas. */
const normalizarPlaca = (valor) =>
    String(valor).toUpperCase().replace(/[^A-Z0-9]/g, "");

export const validarTractocamion = (req, res, next) => {
    const { id_linea_fletera, placas, numero_economico, estado } = req.body;

    // ---- Línea fletera (opcional) ----
    let lineaNum = null;
    if (
        id_linea_fletera !== undefined &&
        id_linea_fletera !== null &&
        id_linea_fletera !== ""
    ) {
        lineaNum = Number(id_linea_fletera);
        if (!Number.isInteger(lineaNum) || lineaNum <= 0) {
            return res.status(400).json({
                error: 'El campo "id_linea_fletera" debe ser numérico o nulo'
            });
        }
    }

    // ---- Placas ----
    if (!placas || String(placas).trim() === "") {
        return res.status(400).json({
            error: 'El campo "placas" es obligatorio'
        });
    }

    const placasNorm = normalizarPlaca(placas);
    if (placasNorm.length === 0) {
        return res.status(400).json({
            error: 'El campo "placas" no contiene caracteres válidos'
        });
    }
    if (placasNorm.length > 10) {
        return res.status(400).json({
            error: 'El campo "placas" no puede exceder 10 caracteres'
        });
    }

    // ---- Número económico ----
    if (!numero_economico || String(numero_economico).trim() === "") {
        return res.status(400).json({
            error: 'El campo "numero_economico" es obligatorio'
        });
    }

    const economicoNorm = String(numero_economico).trim().toUpperCase();
    if (economicoNorm.length > 10) {
        return res.status(400).json({
            error: 'El campo "numero_economico" no puede exceder 10 caracteres'
        });
    }

    // ---- Estado ----
    const estadoNum = estado === undefined || estado === null ? 1 : Number(estado);
    if (![0, 1].includes(estadoNum)) {
        return res.status(400).json({
            error: 'El campo "estado" debe ser 1 (activo) o 0 (dado de baja)'
        });
    }

    // Normalización
    req.body.id_linea_fletera = lineaNum;
    req.body.placas = placasNorm;
    req.body.numero_economico = economicoNorm;
    req.body.estado = estadoNum;

    next();
};

export const validarIdTractocamion = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de tractocamión debe ser un número válido"
        });
    }

    next();
};
