// ============================================================================
// VALIDACIONES DE PRODUCTORES
// ============================================================================
// El código se normaliza a mayúsculas y sin espacios porque alimenta el
// código de lote: fn_generar_lote toma sus ÚLTIMOS 2 DÍGITOS. Un espacio
// invisible al final desplazaría el corte y produciría un lote distinto
// para la misma fruta.
// ============================================================================

export const validarProductor = (req, res, next) => {
    const { codigo_productor, nombre, activo } = req.body;

    // ---- Código ----
    if (
        !codigo_productor ||
        typeof codigo_productor !== "string" ||
        codigo_productor.trim() === ""
    ) {
        return res.status(400).json({
            error: 'El campo "codigo_productor" es obligatorio'
        });
    }

    const codigo = codigo_productor.trim().toUpperCase();

    // VARCHAR(4) en la BD. Se corta aquí para no depender del error de
    // Postgres, que llega como "value too long for type character varying".
    if (codigo.length > 4) {
        return res.status(400).json({
            error: 'El campo "codigo_productor" no puede exceder 4 caracteres'
        });
    }

    // Sin espacios ni símbolos: va tal cual al código de lote.
    if (!/^[A-Z0-9]+$/.test(codigo)) {
        return res.status(400).json({
            error: 'El campo "codigo_productor" solo admite letras y números, sin espacios'
        });
    }

    // ---- Nombre ----
    if (!nombre || typeof nombre !== "string" || nombre.trim() === "") {
        return res.status(400).json({
            error: 'El campo "nombre" es obligatorio'
        });
    }

    if (nombre.length > 100) {
        return res.status(400).json({
            error: 'El campo "nombre" no puede exceder 100 caracteres'
        });
    }

    // ---- Activo ----
    // Opcional en el alta: si no viene, se asume activo. Al editar sí debe
    // llegar, porque el UPDATE escribe las tres columnas.
    const activoNum = activo === undefined || activo === null ? 1 : Number(activo);

    if (![0, 1].includes(activoNum)) {
        return res.status(400).json({
            error: 'El campo "activo" debe ser 1 (activo) o 0 (dado de baja)'
        });
    }

    // Normalización: se hace aquí para no repetir .trim() en el modelo
    req.body.codigo_productor = codigo;
    req.body.nombre = nombre.trim();
    req.body.activo = activoNum;

    next();
};

export const validarIdProductor = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de productor debe ser un número válido"
        });
    }

    next();
};
