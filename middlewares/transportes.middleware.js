// ============================================================================
// VALIDACIONES DE TRANSPORTES
// ============================================================================
// Las placas se normalizan quitando guiones y espacios: en el andén se
// capturan de todas las formas posibles ("15AN7H", "15-AN-7H", "15 AN 7H")
// y guardarlas sin normalizar haría que la misma unidad se diera de alta
// tres veces.
//
// El celular se limita a 10 dígitos porque es lo que cabe en la columna y
// porque se usa para llamar al operador cuando el camión no llega a la
// cita: un número con lada internacional o extensiones no sirve en piso.
// ============================================================================

/** Deja solo letras y números, en mayúsculas. */
const normalizarPlaca = (valor) =>
    String(valor).toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Deja solo dígitos: quita paréntesis, guiones y espacios. */
const normalizarCelular = (valor) => String(valor).replace(/\D/g, "");

export const validarTransporte = (req, res, next) => {
    const {
        razon_social,
        nombre_operador,
        celular,
        placas_tracto,
        placas_caja,
        no_economico_caja,
        inocuidad,
        estado
    } = req.body;

    // ---- Razón social ----
    if (
        !razon_social ||
        typeof razon_social !== "string" ||
        razon_social.trim() === ""
    ) {
        return res.status(400).json({
            error: 'El campo "razon_social" es obligatorio (línea transportista)'
        });
    }

    if (razon_social.length > 100) {
        return res.status(400).json({
            error: 'El campo "razon_social" no puede exceder 100 caracteres'
        });
    }

    // ---- Operador ----
    if (
        !nombre_operador ||
        typeof nombre_operador !== "string" ||
        nombre_operador.trim() === ""
    ) {
        return res.status(400).json({
            error: 'El campo "nombre_operador" es obligatorio'
        });
    }

    if (nombre_operador.length > 100) {
        return res.status(400).json({
            error: 'El campo "nombre_operador" no puede exceder 100 caracteres'
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

    // ---- Placas del tracto ----
    if (!placas_tracto || String(placas_tracto).trim() === "") {
        return res.status(400).json({
            error: 'El campo "placas_tracto" es obligatorio'
        });
    }

    const tractoNorm = normalizarPlaca(placas_tracto);

    if (tractoNorm.length === 0) {
        return res.status(400).json({
            error: 'El campo "placas_tracto" no contiene caracteres válidos'
        });
    }

    if (tractoNorm.length > 10) {
        return res.status(400).json({
            error: 'El campo "placas_tracto" no puede exceder 10 caracteres'
        });
    }

    // ---- Placas de la caja ----
    if (!placas_caja || String(placas_caja).trim() === "") {
        return res.status(400).json({
            error: 'El campo "placas_caja" es obligatorio'
        });
    }

    const cajaNorm = normalizarPlaca(placas_caja);

    if (cajaNorm.length === 0) {
        return res.status(400).json({
            error: 'El campo "placas_caja" no contiene caracteres válidos'
        });
    }

    if (cajaNorm.length > 10) {
        return res.status(400).json({
            error: 'El campo "placas_caja" no puede exceder 10 caracteres'
        });
    }

    // Tracto y caja no pueden traer la misma placa: sería un error de
    // captura (se tecleó dos veces el mismo dato).
    if (tractoNorm === cajaNorm) {
        return res.status(400).json({
            error: "Las placas del tracto y de la caja no pueden ser iguales"
        });
    }

    // ---- Número económico ----
    if (!no_economico_caja || String(no_economico_caja).trim() === "") {
        return res.status(400).json({
            error: 'El campo "no_economico_caja" es obligatorio'
        });
    }

    const economicoNorm = String(no_economico_caja).trim().toUpperCase();

    if (economicoNorm.length > 10) {
        return res.status(400).json({
            error: 'El campo "no_economico_caja" no puede exceder 10 caracteres'
        });
    }

    // ---- Inocuidad ----
    // Resultado de la inspección sanitaria de la caja.
    // Se asume aprobada si no viene: el alta normal se captura con la
    // unidad ya revisada.
    const inocuidadNum =
        inocuidad === undefined || inocuidad === null ? 1 : Number(inocuidad);

    if (![0, 1].includes(inocuidadNum)) {
        return res.status(400).json({
            error: 'El campo "inocuidad" debe ser 1 (aprobada) o 0 (rechazada)'
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
    req.body.razon_social = razon_social.trim().toUpperCase();
    req.body.nombre_operador = nombre_operador.trim().toUpperCase();
    req.body.celular = celularNorm;
    req.body.placas_tracto = tractoNorm;
    req.body.placas_caja = cajaNorm;
    req.body.no_economico_caja = economicoNorm;
    req.body.inocuidad = inocuidadNum;
    req.body.estado = estadoNum;

    next();
};

// Valida SOLO el campo de inocuidad, para el endpoint que la actualiza
// desde el andén sin reenviar todos los datos de la unidad.
export const validarInocuidad = (req, res, next) => {
    const { inocuidad } = req.body;

    if (inocuidad === undefined || inocuidad === null) {
        return res.status(400).json({
            error: 'El campo "inocuidad" es obligatorio'
        });
    }

    const inocuidadNum = Number(inocuidad);

    if (![0, 1].includes(inocuidadNum)) {
        return res.status(400).json({
            error: 'El campo "inocuidad" debe ser 1 (aprobada) o 0 (rechazada)'
        });
    }

    req.body.inocuidad = inocuidadNum;

    next();
};

export const validarIdTransporte = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de transporte debe ser un número válido"
        });
    }

    next();
};
