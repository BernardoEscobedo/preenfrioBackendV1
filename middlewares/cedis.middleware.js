// ============================================================================
// VALIDACIONES DE CEDIS / CLIENTE
// ============================================================================
// El acrónimo se normaliza a mayúsculas y sin espacios porque es la LLAVE
// que cruza con el Excel de planeación semanal. Un espacio invisible al
// final haría que la importación no encontrara el destino y creara un
// duplicado, o peor: que asignara la fruta al CEDIS equivocado.
//
// La BD ya tiene el índice único sobre UPPER(acronimo), pero se valida aquí
// para devolver un mensaje entendible antes del error 23505.
// ============================================================================

export const validarCedis = (req, res, next) => {
    const { cliente, cedis, acronimo, estado } = req.body;

    // ---- Cliente ----
    if (!cliente || typeof cliente !== "string" || cliente.trim() === "") {
        return res.status(400).json({
            error: 'El campo "cliente" es obligatorio (ej. WALMART, CHEDRAUI)'
        });
    }

    if (cliente.length > 80) {
        return res.status(400).json({
            error: 'El campo "cliente" no puede exceder 80 caracteres'
        });
    }

    // ---- CEDIS ----
    if (!cedis || typeof cedis !== "string" || cedis.trim() === "") {
        return res.status(400).json({
            error: 'El campo "cedis" es obligatorio (ej. VILLAHERMOSA, SAN MARTIN)'
        });
    }

    if (cedis.length > 80) {
        return res.status(400).json({
            error: 'El campo "cedis" no puede exceder 80 caracteres'
        });
    }

    // ---- Acrónimo ----
    if (!acronimo || typeof acronimo !== "string" || acronimo.trim() === "") {
        return res.status(400).json({
            error: 'El campo "acronimo" es obligatorio: es la llave que cruza con el Excel de planeación'
        });
    }

    // Se quitan los espacios INTERNOS además de los de los extremos: el
    // Excel a veces trae "WM VHSA" y otras "WMVHSA", y deben ser el mismo.
    const acronimoNorm = acronimo.trim().toUpperCase().replace(/\s+/g, "");

    if (acronimoNorm.length > 50) {
        return res.status(400).json({
            error: 'El campo "acronimo" no puede exceder 50 caracteres'
        });
    }

    // Sin símbolos raros: va a cruzarse por coincidencia exacta de texto.
    // Se permiten guiones porque algunos acrónimos ya los usan.
    if (!/^[A-Z0-9_-]+$/.test(acronimoNorm)) {
        return res.status(400).json({
            error: 'El campo "acronimo" solo admite letras, números, guion y guion bajo'
        });
    }

    // ---- Estado ----
    const estadoNum = estado === undefined || estado === null ? 1 : Number(estado);

    if (![0, 1].includes(estadoNum)) {
        return res.status(400).json({
            error: 'El campo "estado" debe ser 1 (activo) o 0 (dado de baja)'
        });
    }

    // Normalización: cliente y cedis en mayúsculas para que el catálogo se
    // vea uniforme aunque se capture desde pantallas distintas.
    req.body.cliente = cliente.trim().toUpperCase();
    req.body.cedis = cedis.trim().toUpperCase();
    req.body.acronimo = acronimoNorm;
    req.body.estado = estadoNum;

    next();
};

export const validarIdCedis = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de cliente/CEDIS debe ser un número válido"
        });
    }

    next();
};
