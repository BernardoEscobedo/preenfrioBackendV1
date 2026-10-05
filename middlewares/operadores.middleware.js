// ============================================================================
// VALIDACIONES DE OPERADORES
// ============================================================================
// El celular se limita a 10 dígitos porque es lo que cabe en la columna y
// porque se usa para llamar al operador cuando el camión no llega a la
// cita: un número con lada internacional o extensiones no sirve en piso.
//
// id_linea_fletera es OPCIONAL: un operador puede ser independiente.
// ============================================================================

/** Deja solo dígitos: quita paréntesis, guiones y espacios. */
const normalizarCelular = (valor) => String(valor).replace(/\D/g, "");

export const validarOperador = (req, res, next) => {
    const { id_linea_fletera, nombre, celular, estado } = req.body;

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

    // ---- Nombre ----
    if (!nombre || typeof nombre !== "string" || nombre.trim() === "") {
        return res.status(400).json({
            error: 'El campo "nombre" es obligatorio'
        });
    }

    if (nombre.trim().length > 100) {
        return res.status(400).json({
            error: 'El campo "nombre" no puede exceder 100 caracteres'
        });
    }

    // ---- Celular ----
    if (!celular) {
        return res.status(400).json({
            error: 'El campo "celular" es obligatorio: se usa para localizar al operador'
        });
    }

    const celularNorm = normalizarCelular(celular);
    if (celularNorm.length !== 10) {
        return res.status(400).json({
            error: 'El campo "celular" debe tener exactamente 10 dígitos'
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
    req.body.nombre = nombre.trim().toUpperCase();
    req.body.celular = celularNorm;
    req.body.estado = estadoNum;

    next();
};

export const validarIdOperador = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de operador debe ser un número válido"
        });
    }

    next();
};
