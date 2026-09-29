// ============================================================================
// VALIDACIONES DE EVIDENCIAS (fotos y videos en SharePoint)
// ============================================================================
// El archivo NO pasa por el backend: aquí solo se validan los datos con los
// que se pide la sesión de carga. SharePoint recibe el archivo directo del
// frontend, y al confirmar el backend vuelve a verificar tamaño y tipo
// contra lo que SharePoint dice que se subió.
//
// ⚙️ LÍMITES
//   Ajustables aquí. Las fotos conviene comprimirlas en el frontend antes de
//   subirlas (1600 px de lado, calidad 80%): pasan de 5 MB a ~400 KB.
// ============================================================================

export const LIMITES = {
    // Por archivo
    FOTO_BYTES: 10 * 1024 * 1024,     // 10 MB
    VIDEO_BYTES: 200 * 1024 * 1024,   // 200 MB

    // Por documento
    FOTOS_POR_DESPACHO: 3,
    VIDEOS_POR_DESPACHO: 1,
    FOTOS_POR_PULPEO: 3,
    VIDEOS_POR_PULPEO: 1
};

export const TIPOS = { FOTO: 1, VIDEO: 2 };

export const MIME_PERMITIDOS = {
    [TIPOS.FOTO]: {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/heic": "heic",
        "image/heif": "heif"
    },
    [TIPOS.VIDEO]: {
        "video/mp4": "mp4",
        "video/quicktime": "mov",
        "video/webm": "webm",
        "video/3gpp": "3gp"
    }
};

// ----------------------------------------------------------------------------
// Solicitud de sesión de carga
// ----------------------------------------------------------------------------
export const validarSolicitudCarga = (req, res, next) => {
    const {
        tipo_archivo,
        nombre_original,
        mime_type,
        tamano_bytes,
        descripcion,
        id_pulpeo_detalle
    } = req.body;

    // ---- Tipo ----
    const tipo = Number(tipo_archivo ?? TIPOS.FOTO);

    if (![TIPOS.FOTO, TIPOS.VIDEO].includes(tipo)) {
        return res.status(400).json({
            error: 'El campo "tipo_archivo" debe ser 1 (foto) o 2 (video)'
        });
    }

    // ---- MIME ----
    const mime = String(mime_type ?? "").toLowerCase().trim();

    if (!MIME_PERMITIDOS[tipo][mime]) {
        return res.status(400).json({
            error: `Formato no permitido para ${tipo === TIPOS.FOTO ? "foto" : "video"}. Acepta: ${Object.keys(MIME_PERMITIDOS[tipo]).join(", ")}`
        });
    }

    // ---- Tamaño ----
    const tamano = Number(tamano_bytes);

    if (!Number.isInteger(tamano) || tamano <= 0) {
        return res.status(400).json({
            error: 'El campo "tamano_bytes" es obligatorio y debe ser un entero mayor a 0'
        });
    }

    const limite = tipo === TIPOS.FOTO ? LIMITES.FOTO_BYTES : LIMITES.VIDEO_BYTES;

    if (tamano > limite) {
        return res.status(400).json({
            error: `El archivo pesa ${(tamano / 1048576).toFixed(1)} MB y el máximo es ${limite / 1048576} MB`
        });
    }

    // ---- Nombre original ----
    // Solo informativo: el nombre en SharePoint lo genera el backend.
    if (nombre_original && String(nombre_original).length > 255) {
        return res.status(400).json({
            error: 'El campo "nombre_original" no puede exceder 255 caracteres'
        });
    }

    if (descripcion && String(descripcion).length > 250) {
        return res.status(400).json({
            error: 'El campo "descripcion" no puede exceder 250 caracteres'
        });
    }

    // ---- Desglose de pulpeo (opcional) ----
    let detalle = null;

    if (id_pulpeo_detalle !== undefined && id_pulpeo_detalle !== null && id_pulpeo_detalle !== "") {
        if (isNaN(Number(id_pulpeo_detalle))) {
            return res.status(400).json({
                error: 'El campo "id_pulpeo_detalle" debe ser numérico'
            });
        }
        detalle = Number(id_pulpeo_detalle);
    }

    req.body.tipo_archivo = tipo;
    req.body.mime_type = mime;
    req.body.tamano_bytes = tamano;
    req.body.extension = MIME_PERMITIDOS[tipo][mime];
    req.body.nombre_original = nombre_original ? String(nombre_original).trim() : null;
    req.body.descripcion = descripcion ? String(descripcion).trim() : null;
    req.body.id_pulpeo_detalle = detalle;

    next();
};

// ----------------------------------------------------------------------------
// Confirmación de la carga
// ----------------------------------------------------------------------------
export const validarConfirmacion = (req, res, next) => {
    const { token_carga, item_id } = req.body;

    if (!token_carga || typeof token_carga !== "string") {
        return res.status(400).json({
            error: 'El campo "token_carga" es obligatorio: es el que devolvió la solicitud de sesión'
        });
    }

    if (!item_id || typeof item_id !== "string" || item_id.length > 200) {
        return res.status(400).json({
            error: 'El campo "item_id" es obligatorio: es el "id" que devuelve SharePoint al terminar la carga'
        });
    }

    next();
};

// ----------------------------------------------------------------------------
// Parámetros de ruta
// ----------------------------------------------------------------------------
const ORIGENES = ["despachos", "pulpeos"];

export const validarOrigen = (req, res, next) => {
    if (!ORIGENES.includes(req.params.origen)) {
        return res.status(400).json({
            error: `El origen debe ser: ${ORIGENES.join(", ")}`
        });
    }
    next();
};

export const validarIdEvidencia = (req, res, next) => {
    for (const campo of ["id", "id_evidencia"]) {
        const valor = req.params[campo];
        if (valor !== undefined && (valor === "" || isNaN(Number(valor)))) {
            return res.status(400).json({
                error: `El parámetro "${campo}" debe ser un número válido`
            });
        }
    }
    next();
};
