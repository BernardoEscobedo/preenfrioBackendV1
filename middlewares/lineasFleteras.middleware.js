// ============================================================================
// VALIDACIONES DE LÍNEAS FLETERAS
// ============================================================================
// El RFC se guarda en mayúsculas y sin espacios ni guiones: es la llave que
// evita dar de alta dos veces a la misma empresa.
//
// El teléfono se limita a 10 dígitos porque es lo que cabe en la columna y
// lo que sirve para llamar desde piso cuando la unidad no llega.
// ============================================================================

/** Deja solo letras (incluye Ñ y &) y números, en mayúsculas. */
const normalizarRfc = (valor) =>
    String(valor).toUpperCase().replace(/[^A-ZÑ&0-9]/g, "");

/** Deja solo dígitos: quita paréntesis, guiones y espacios. */
const normalizarTelefono = (valor) => String(valor).replace(/\D/g, "");

// RFC mexicano: 3 letras (persona moral) o 4 (persona física), 6 dígitos de
// fecha y 3 de homoclave.
const PATRON_RFC = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

export const validarLineaFletera = (req, res, next) => {
    const { razon_social, rfc, telefono_contacto, estado } = req.body;

    // ---- Razón social ----
    if (
        !razon_social ||
        typeof razon_social !== "string" ||
        razon_social.trim() === ""
    ) {
        return res.status(400).json({
            error: 'El campo "razon_social" es obligatorio'
        });
    }

    if (razon_social.trim().length > 100) {
        return res.status(400).json({
            error: 'El campo "razon_social" no puede exceder 100 caracteres'
        });
    }

    // ---- RFC ----
    if (!rfc || String(rfc).trim() === "") {
        return res.status(400).json({
            error: 'El campo "rfc" es obligatorio'
        });
    }

    const rfcNorm = normalizarRfc(rfc);
    if (!PATRON_RFC.test(rfcNorm)) {
        return res.status(400).json({
            error: 'El campo "rfc" no tiene un formato válido (12 caracteres persona moral, 13 persona física)'
        });
    }

    // ---- Teléfono de contacto ----
    if (!telefono_contacto) {
        return res.status(400).json({
            error: 'El campo "telefono_contacto" es obligatorio'
        });
    }

    const telefonoNorm = normalizarTelefono(telefono_contacto);
    if (telefonoNorm.length !== 10) {
        return res.status(400).json({
            error: 'El campo "telefono_contacto" debe tener exactamente 10 dígitos'
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
    req.body.rfc = rfcNorm;
    req.body.telefono_contacto = telefonoNorm;
    req.body.estado = estadoNum;

    next();
};

export const validarIdLineaFletera = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de la línea fletera debe ser un número válido"
        });
    }

    next();
};
