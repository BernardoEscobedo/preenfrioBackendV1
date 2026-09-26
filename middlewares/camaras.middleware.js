// ============================================================================
// VALIDACIONES DE CÁMARAS
// ============================================================================
// Las capacidades se validan con cuidado porque son el tope que usan los
// triggers: si se captura 0 o un valor absurdo, el sistema mandará toda la
// fruta a la cola o permitirá sobrellenar la cámara.
//
// CORRECCIÓN DE LA AUDITORÍA
//   Las capacidades exigen enteros. Con 20.5, Postgres rechazaba el valor
//   en la columna INT y se respondía 500 en vez de 400.
// ============================================================================

const TIPOS_VALIDOS = [1, 2]; // 1=preenfrío · 2=conservación

export const validarCamara = (req, res, next) => {
    const {
        nombre_camara,
        tipo_camara,
        ubicacion,
        capacidad_max_tarimas,
        capacidad_max_cajas,
        capacidad_max_bloques
    } = req.body;

    // ---- Nombre ----
    if (!nombre_camara || typeof nombre_camara !== "string" || nombre_camara.trim() === "") {
        return res.status(400).json({
            error: 'El campo "nombre_camara" es obligatorio'
        });
    }

    if (nombre_camara.length > 60) {
        return res.status(400).json({
            error: 'El campo "nombre_camara" no puede exceder 60 caracteres'
        });
    }

    // ---- Tipo ----
    if (!tipo_camara || !TIPOS_VALIDOS.includes(Number(tipo_camara))) {
        return res.status(400).json({
            error: 'El campo "tipo_camara" debe ser 1 (preenfrío) o 2 (conservación)'
        });
    }

    // ---- Ubicación ----
    if (!ubicacion || typeof ubicacion !== "string" || ubicacion.trim() === "") {
        return res.status(400).json({
            error: 'El campo "ubicacion" es obligatorio (ej. Finca Doña Nelly)'
        });
    }

    if (ubicacion.length > 60) {
        return res.status(400).json({
            error: 'El campo "ubicacion" no puede exceder 60 caracteres'
        });
    }

    // ---- Capacidades ----
    // Tarimas es la que realmente gobierna: fn_tarimas_disponibles y los
    // triggers de cola trabajan con ella. Por eso debe ser mayor a cero.
    const tarimas = Number(capacidad_max_tarimas);

    if (!Number.isInteger(tarimas) || tarimas <= 0) {
        return res.status(400).json({
            error: 'El campo "capacidad_max_tarimas" debe ser un número entero mayor a 0'
        });
    }

    const cajas = Number(capacidad_max_cajas);

    if (!Number.isInteger(cajas) || cajas < 0) {
        return res.status(400).json({
            error: 'El campo "capacidad_max_cajas" debe ser un número entero (>= 0)'
        });
    }

    const bloques = Number(capacidad_max_bloques);

    if (!Number.isInteger(bloques) || bloques < 0) {
        return res.status(400).json({
            error: 'El campo "capacidad_max_bloques" debe ser un número entero (>= 0)'
        });
    }

    // Coherencia: 48 cajas = 1 tarima (42 en la familia CPL0813). Si las
    // cajas no alcanzan ni para una por tarima, algo se capturó mal y se
    // rechaza. El 0 sí se permite: significa "no se controla por cajas".
    if (cajas > 0 && cajas < tarimas) {
        return res.status(400).json({
            error: `Revisa las capacidades: ${cajas} cajas para ${tarimas} tarimas no es coherente (cada tarima lleva ~48 cajas)`
        });
    }

    // Normalización
    req.body.nombre_camara = nombre_camara.trim();
    req.body.ubicacion = ubicacion.trim();
    req.body.tipo_camara = Number(tipo_camara);
    req.body.capacidad_max_tarimas = tarimas;
    req.body.capacidad_max_cajas = cajas;
    req.body.capacidad_max_bloques = bloques;

    next();
};

export const validarIdCamara = (req, res, next) => {
    const { id_camara } = req.params;

    if (!id_camara || isNaN(Number(id_camara))) {
        return res.status(400).json({
            error: "El id de cámara debe ser un número válido"
        });
    }

    next();
};
