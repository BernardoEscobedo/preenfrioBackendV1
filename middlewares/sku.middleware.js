// ============================================================================
// VALIDACIONES DE SKU
// ============================================================================
// El turno es el ÚLTIMO carácter del código de lote (B12015-392209-T), que
// tiene longitud fija. Producción maneja turnos del 1 al 5: cualquier otro
// valor rompería el formato del lote.
//
// La BD tiene CHECK (turno BETWEEN 1 AND 5) y un índice único por
// (codigo_sku, calidad). Estas validaciones siguen aquí para devolver un
// mensaje entendible antes de que Postgres responda con un 23514 o 23505.
//
// Código y calidad se guardan en mayúsculas. El código además sin espacios:
// "CPL 0813A" dejaría de coincidir con LIKE 'CPL0813%' y el cálculo de cajas
// por tarima daría 48 en lugar de 42.
//
// En el PUT, 'turno' y 'estado' llegan con su valor actual gracias a
// conservarCampos (ver sku.route.js): el default de 1 solo aplica en el alta.
// ============================================================================

export const TURNO_MIN = 1;
export const TURNO_MAX = 5;

export const validarSku = (req, res, next) => {
    const { codigo_sku, calidad, turno, estado } = req.body;

    // ---- Código ----
    if (!codigo_sku || typeof codigo_sku !== "string" || codigo_sku.trim() === "") {
        return res.status(400).json({
            error: 'El campo "codigo_sku" es obligatorio'
        });
    }

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
    const turnoNum = turno === undefined || turno === null || turno === "" ? 1 : Number(turno);

    if (!Number.isInteger(turnoNum) || turnoNum < TURNO_MIN || turnoNum > TURNO_MAX) {
        return res.status(400).json({
            error: `El campo "turno" debe ser un número del ${TURNO_MIN} al ${TURNO_MAX} (es el último carácter del código de lote)`
        });
    }

    // ---- Estado ----
    const estadoNum = estado === undefined || estado === null ? 1 : Number(estado);

    if (![0, 1].includes(estadoNum)) {
        return res.status(400).json({
            error: 'El campo "estado" debe ser 1 (activo) o 0 (descontinuado)'
        });
    }

    // ---- Normalización ----
    req.body.codigo_sku = codigo;
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
