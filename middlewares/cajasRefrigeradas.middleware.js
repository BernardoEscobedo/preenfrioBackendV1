// ============================================================================
// VALIDACIONES DE CAJAS REFRIGERADAS
// ============================================================================
// Mismo criterio de placas que tractocamiones: sin guiones ni espacios.
//
// largo_pies es OPCIONAL y es la longitud nominal (48, 53...), no la
// capacidad de carga. La BD solo exige que sea mayor a 0.
//
// id_linea_fletera es OPCIONAL: una caja puede ser independiente.
// ============================================================================

/** Deja solo letras y números, en mayúsculas. */
const normalizarPlaca = (valor) =>
    String(valor).toUpperCase().replace(/[^A-Z0-9]/g, "");

export const validarCajaRefrigerada = (req, res, next) => {
    const {
        id_linea_fletera,
        placas,
        numero_economico,
        largo_pies,
        estado
    } = req.body;

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

    // ---- Largo en pies (opcional) ----
    let largoNum = null;
    if (largo_pies !== undefined && largo_pies !== null && largo_pies !== "") {
        largoNum = Number(largo_pies);
        if (!Number.isInteger(largoNum) || largoNum <= 0) {
            return res.status(400).json({
                error: 'El campo "largo_pies" debe ser un número entero mayor a 0 (por ejemplo 48 o 53)'
            });
        }
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
    req.body.largo_pies = largoNum;
    req.body.estado = estadoNum;

    next();
};

export const validarIdCajaRefrigerada = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de la caja refrigerada debe ser un número válido"
        });
    }

    next();
};
