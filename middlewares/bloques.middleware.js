// ============================================================================
// VALIDACIONES DE BLOQUES Y PULPEOS
// ============================================================================
// Aquí se valida el FORMATO. Lo que exige consultar la BD —que la
// producción exista, que el bloque no esté ya despachado, que las tarimas
// no excedan lo que hay en cámara— vive en los controllers.
// ============================================================================

// ----------------------------------------------------------------------------
// Encabezado del bloque
// ----------------------------------------------------------------------------
export const validarBloque = (req, res, next) => {
    const { codigo_bloque, fecha_hora_armado, temperatura_ingreso } = req.body;

    // ---- Código ----
    // Es UNIQUE en la BD y se dicta por radio en piso, así que se normaliza
    // sin espacios: "B 001" y "B001" tienen que ser el mismo bloque.
    if (
        !codigo_bloque ||
        typeof codigo_bloque !== "string" ||
        codigo_bloque.trim() === ""
    ) {
        return res.status(400).json({
            error: 'El campo "codigo_bloque" es obligatorio (ej. B001)'
        });
    }

    const codigo = codigo_bloque.trim().toUpperCase().replace(/\s+/g, "");

    if (codigo.length > 50) {
        return res.status(400).json({
            error: 'El campo "codigo_bloque" no puede exceder 50 caracteres'
        });
    }

    if (!/^[A-Z0-9_-]+$/.test(codigo)) {
        return res.status(400).json({
            error: 'El campo "codigo_bloque" solo admite letras, números, guion y guion bajo'
        });
    }

    // ---- Fecha y hora de armado ----
    // Opcional: por defecto CURRENT_TIMESTAMP. Se permite indicarla para
    // capturar un bloque que se armó hace rato.
    let fechaNorm = null;

    if (fecha_hora_armado) {
        const fecha = new Date(fecha_hora_armado);

        if (isNaN(fecha.getTime())) {
            return res.status(400).json({
                error: 'El campo "fecha_hora_armado" no es una fecha válida'
            });
        }

        if (fecha > new Date()) {
            return res.status(400).json({
                error: "La fecha de armado no puede ser futura"
            });
        }

        fechaNorm = fecha_hora_armado;
    }

    // ---- Temperatura de ingreso ----
    // La que traía la fruta al armar el montón. Es el punto de partida de
    // la curva de enfriamiento.
    let tempNum = null;

    if (
        temperatura_ingreso !== undefined &&
        temperatura_ingreso !== null &&
        temperatura_ingreso !== ""
    ) {
        tempNum = Number(temperatura_ingreso);

        if (isNaN(tempNum)) {
            return res.status(400).json({
                error: 'El campo "temperatura_ingreso" debe ser numérico'
            });
        }

        if (tempNum < -5 || tempNum > 45) {
            return res.status(400).json({
                error: 'El campo "temperatura_ingreso" está fuera de rango (-5 a 45 °C)'
            });
        }
    }

    req.body.codigo_bloque = codigo;
    req.body.fecha_hora_armado = fechaNorm;
    req.body.temperatura_ingreso = tempNum;

    next();
};

// ----------------------------------------------------------------------------
// Línea del bloque
// ----------------------------------------------------------------------------
export const validarLineaBloque = (req, res, next) => {
    const { id_produccion, cantidad_tarimas, cantidad_cajas } = req.body;

    if (!id_produccion || isNaN(Number(id_produccion))) {
        return res.status(400).json({
            error: 'El campo "id_produccion" es obligatorio y debe ser numérico'
        });
    }

    const tarimas = Number(cantidad_tarimas);

    if (isNaN(tarimas) || !Number.isInteger(tarimas) || tarimas <= 0) {
        return res.status(400).json({
            error: 'El campo "cantidad_tarimas" debe ser un número entero mayor a 0'
        });
    }

    const cajas = cantidad_cajas === undefined || cantidad_cajas === null
        ? 0
        : Number(cantidad_cajas);

    if (isNaN(cajas) || !Number.isInteger(cajas) || cajas < 0) {
        return res.status(400).json({
            error: 'El campo "cantidad_cajas" debe ser un número entero mayor o igual a 0'
        });
    }

    // Coherencia cajas ↔ tarimas. Mismo criterio que el resto del sistema:
    // ~48 cajas por tarima, margen amplio, solo se rechaza lo imposible.
    if (cajas > 0) {
        if (tarimas > cajas) {
            return res.status(400).json({
                error: `Revisa las cantidades: ${tarimas} tarimas con solo ${cajas} cajas no es posible`
            });
        }

        if (cajas > tarimas * 60) {
            return res.status(400).json({
                error: `Revisa las cantidades: ${cajas} cajas no caben en ${tarimas} tarimas (máximo ~48 por tarima)`
            });
        }
    }

    req.body.id_produccion = Number(id_produccion);
    req.body.cantidad_tarimas = tarimas;
    req.body.cantidad_cajas = cajas;

    next();
};

export const validarIdBloque = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de bloque debe ser un número válido"
        });
    }

    next();
};

export const validarIdDetalleBloque = (req, res, next) => {
    const { id_detalle } = req.params;

    if (!id_detalle || isNaN(Number(id_detalle))) {
        return res.status(400).json({
            error: "El id de la línea debe ser un número válido"
        });
    }

    next();
};
