// ============================================================================
// VALIDACIONES DE SKU
// ============================================================================
// El turno solo admite 1 o 2 porque es el ÚLTIMO dígito del código de lote,
// que tiene una longitud fija de 15. Un 10 o un 0 romperían el formato y
// los lotes dejarían de ser comparables entre sí.
//
// v2.2: la BD ya tiene CHECK sobre turno y un índice único por
// (codigo_sku, calidad). Estas validaciones siguen aquí para devolver un
// mensaje entendible antes de que Postgres responda con un 23514 o 23505.
//
// Código y calidad se guardan en mayúsculas: el catálogo se captura desde
// varios lados (pantalla, importación del Excel) y sin normalizar acabarían
// conviviendo "PRIMERA", "Primera" y "primera" como calidades distintas.
//
// CORRECCIÓN DE LA AUDITORÍA · EL CÓDIGO SE LIMPIA DE ESPACIOS
//   Productores, fincas, cedis y bloques ya quitaban los espacios; el SKU
//   no. Un "CPL 0813A" dejaba de coincidir con LIKE 'CPL0813%' y el cálculo
//   de cajas por tarima daba 48 en lugar de 42: todas las tarimas de esa
//   familia quedaban mal estimadas.
//
//   En el PUT, 'turno' y 'estado' ya llegan con su valor actual gracias a
//   conservarCampos (ver sku.route.js): el default de 1 solo aplica de
//   verdad en el alta.
// ============================================================================

const TURNOS_VALIDOS = [1, 2];

export const validarSku = (req, res, next) => {
    const { codigo_sku, calidad, turno, estado } = req.body;

    // ---- Código ----
    if (!codigo_sku || typeof codigo_sku !== "string" || codigo_sku.trim() === "") {
        return res.status(400).json({
            error: 'El campo "codigo_sku" es obligatorio'
        });
    }

    // Sin espacios internos: "CPL 0813A" y "CPL0813A" son el mismo empaque.
    const codigo = codigo_sku.trim().toUpperCase().replace(/\s+/g, "");

    if (codigo.length > 10) {
        return res.status(400).json({
            error: 'El campo "codigo_sku" no puede exceder 10 caracteres'
        });
    }

    if (!/^[A-Z0-9_-]+$/.test(codigo)) {
        return res.status(400).json({
            error: 'El campo "codigo_sku" solo admite letras, números, guion y guion bajo'
        });
    }

    // ---- Calidad ----
    if (!calidad || typeof calidad !== "string" || calidad.trim() === "") {
        return res.status(400).json({
            error: 'El campo "calidad" es obligatorio (ej. PRIMERA, SEGUNDA)'
        });
    }

    if (calidad.length > 70) {
        return res.status(400).json({
            error: 'El campo "calidad" no puede exceder 70 caracteres'
        });
    }

    // ---- Turno ----
    // La BD tiene DEFAULT 1, así que se respeta ese criterio cuando no viene.
    const turnoNum = turno === undefined || turno === null ? 1 : Number(turno);

    if (!TURNOS_VALIDOS.includes(turnoNum)) {
        return res.status(400).json({
            error: 'El campo "turno" debe ser 1 o 2 (es el último dígito del código de lote)'
        });
    }

    // ---- Estado ----
    // Opcional en el alta: si no viene, el SKU nace activo.
    const estadoNum = estado === undefined || estado === null ? 1 : Number(estado);

    if (![0, 1].includes(estadoNum)) {
        return res.status(400).json({
            error: 'El campo "estado" debe ser 1 (activo) o 0 (descontinuado)'
        });
    }

    // Normalización
    req.body.codigo_sku = codigo;
    // En la calidad sí se conservan los espacios internos ("PRIMERA ESPECIAL"),
    // solo se colapsan los repetidos.
    req.body.calidad = calidad.trim().toUpperCase().replace(/\s+/g, " ");
    req.body.turno = turnoNum;
    req.body.estado = estadoNum;

    next();
};

export const validarIdSku = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de SKU debe ser un número válido"
        });
    }

    next();
};
