// ============================================================================
// VALIDACIONES DE FINCAS
// ============================================================================
// La zona se valida con dureza porque es el PRIMER carácter del código de
// lote. fn_generar_lote la traduce así:
//     1 → A (Chiapas) · 2 → B (Colima) · 3 → C (Tabasco) · cualquier otra → X
//
// Una zona inválida no truena nada: la función devuelve 'X' y sigue. Todos
// los lotes de esa finca nacen mal y el error se descubre semanas después,
// con fruta ya despachada. Por eso se bloquea aquí en vez de confiar en el
// ELSE de la función.
// ============================================================================

const ZONAS_VALIDAS = [1, 2, 3]; // 1=Chiapas(A) · 2=Colima(B) · 3=Tabasco(C)

export const validarFinca = (req, res, next) => {
    const {
        codigo_finca,
        nombre,
        org_inv_nombre,
        zona,
        id_productor,
        estado
    } = req.body;

    // ---- Código ----
    if (
        !codigo_finca ||
        typeof codigo_finca !== "string" ||
        codigo_finca.trim() === ""
    ) {
        return res.status(400).json({
            error: 'El campo "codigo_finca" es obligatorio'
        });
    }

    const codigo = codigo_finca.trim().toUpperCase();

    // VARCHAR(3): son exactamente los 3 dígitos que van al código de lote.
    if (codigo.length > 3) {
        return res.status(400).json({
            error: 'El campo "codigo_finca" no puede exceder 3 caracteres'
        });
    }

    if (!/^[A-Z0-9]+$/.test(codigo)) {
        return res.status(400).json({
            error: 'El campo "codigo_finca" solo admite letras y números, sin espacios'
        });
    }

    // ---- Nombre ----
    if (!nombre || typeof nombre !== "string" || nombre.trim() === "") {
        return res.status(400).json({
            error: 'El campo "nombre" es obligatorio'
        });
    }

    if (nombre.length > 70) {
        return res.status(400).json({
            error: 'El campo "nombre" no puede exceder 70 caracteres'
        });
    }

    // ---- Organización de inventario ----
    if (
        !org_inv_nombre ||
        typeof org_inv_nombre !== "string" ||
        org_inv_nombre.trim() === ""
    ) {
        return res.status(400).json({
            error: 'El campo "org_inv_nombre" es obligatorio'
        });
    }

    if (org_inv_nombre.length > 70) {
        return res.status(400).json({
            error: 'El campo "org_inv_nombre" no puede exceder 70 caracteres'
        });
    }

    // ---- Zona ----
    if (!zona || !ZONAS_VALIDAS.includes(Number(zona))) {
        return res.status(400).json({
            error: 'El campo "zona" debe ser 1 (Chiapas), 2 (Colima) o 3 (Tabasco)'
        });
    }

    // ---- Productor ----
    // Aquí solo se valida que sea numérico. Que EXISTA y esté activo lo
    // verifica el controller, porque requiere consultar la BD.
    if (!id_productor || isNaN(Number(id_productor))) {
        return res.status(400).json({
            error: 'El campo "id_productor" es obligatorio y debe ser numérico'
        });
    }

    // ---- Estado ----
    // Opcional en el alta: si no viene, la finca nace activa.
    const estadoNum = estado === undefined || estado === null ? 1 : Number(estado);

    if (![0, 1].includes(estadoNum)) {
        return res.status(400).json({
            error: 'El campo "estado" debe ser 1 (activa) o 0 (dada de baja)'
        });
    }

    // Normalización
    req.body.codigo_finca = codigo;
    req.body.nombre = nombre.trim();
    req.body.org_inv_nombre = org_inv_nombre.trim();
    req.body.zona = Number(zona);
    req.body.id_productor = Number(id_productor);
    req.body.estado = estadoNum;

    next();
};

export const validarIdFinca = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de finca debe ser un número válido"
        });
    }

    next();
};
