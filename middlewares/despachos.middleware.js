// ============================================================================
// VALIDACIONES DE DESPACHOS
// ============================================================================
// Aquí se valida el FORMATO del documento y del picking. Lo que exige
// consultar la BD —que el transporte esté aprobado, que la ocupación tenga
// fruta suficiente, que el despacho siga en borrador— vive en el controller.
// ============================================================================

// ----------------------------------------------------------------------------
// Encabezado del despacho
// ----------------------------------------------------------------------------
export const validarDespacho = (req, res, next) => {
    const {
        id_transporte,
        id_cc,
        fecha_despacho,
        hora_salida,
        orden_venta,
        cita,
        fecha_cita,
        temperatura_salida,
        observaciones
    } = req.body;

    // ---- Transporte ----
    if (!id_transporte || isNaN(Number(id_transporte))) {
        return res.status(400).json({
            error: 'El campo "id_transporte" es obligatorio y debe ser numérico'
        });
    }

    // ---- Cliente / CEDIS ----
    if (!id_cc || isNaN(Number(id_cc))) {
        return res.status(400).json({
            error: 'El campo "id_cc" es obligatorio: indica a qué cliente y CEDIS va el despacho'
        });
    }

    // ---- Fecha del despacho ----
    if (!fecha_despacho) {
        return res.status(400).json({
            error: 'El campo "fecha_despacho" es obligatorio'
        });
    }

    const fecha = new Date(fecha_despacho);

    if (isNaN(fecha.getTime())) {
        return res.status(400).json({
            error: 'El campo "fecha_despacho" no es una fecha válida (usa AAAA-MM-DD)'
        });
    }

    // A diferencia de recepciones y movimientos, aquí SÍ se permite fecha
    // futura: los despachos se programan con días de anticipación contra la
    // cita del CEDIS. El tope de 30 días atrapa el error de dedo en el año.
    const limite = new Date();
    limite.setDate(limite.getDate() + 30);

    if (fecha > limite) {
        return res.status(400).json({
            error: "La fecha de despacho está a más de 30 días: revisa el dato"
        });
    }

    // ---- Hora de salida ----
    // Opcional al crear el borrador: cuando se arma el picking todavía no
    // se sabe a qué hora sale el camión.
    let horaNorm = null;

    if (hora_salida) {
        if (!/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/.test(String(hora_salida))) {
            return res.status(400).json({
                error: 'El campo "hora_salida" debe tener formato HH:MM o HH:MM:SS'
            });
        }
        horaNorm = hora_salida;
    }

    // ---- Fecha de cita ----
    // Se hereda de la producción, pero se puede ajustar: las citas se
    // reprograman.
    let fechaCitaNorm = null;

    if (fecha_cita) {
        const fc = new Date(fecha_cita);

        if (isNaN(fc.getTime())) {
            return res.status(400).json({
                error: 'El campo "fecha_cita" no es una fecha válida (usa AAAA-MM-DD)'
            });
        }

        // Llegar antes de salir es imposible.
        if (fc < fecha) {
            return res.status(400).json({
                error: "La fecha de cita no puede ser anterior a la fecha de despacho"
            });
        }

        fechaCitaNorm = fecha_cita;
    }

    // ---- Temperatura de salida ----
    // El dato que respalda la cadena de frío ante el cliente. Mismo rango
    // que en recepciones y movimientos.
    let tempNum = null;

    if (
        temperatura_salida !== undefined &&
        temperatura_salida !== null &&
        temperatura_salida !== ""
    ) {
        tempNum = Number(temperatura_salida);

        if (isNaN(tempNum)) {
            return res.status(400).json({
                error: 'El campo "temperatura_salida" debe ser numérico'
            });
        }

        if (tempNum < -5 || tempNum > 45) {
            return res.status(400).json({
                error: 'El campo "temperatura_salida" está fuera de rango (-5 a 45 °C)'
            });
        }
    }

    // ---- Campos de texto ----
    if (orden_venta && String(orden_venta).length > 50) {
        return res.status(400).json({
            error: 'El campo "orden_venta" no puede exceder 50 caracteres'
        });
    }

    if (cita && String(cita).length > 50) {
        return res.status(400).json({
            error: 'El campo "cita" no puede exceder 50 caracteres'
        });
    }

    if (observaciones && String(observaciones).length > 250) {
        return res.status(400).json({
            error: 'El campo "observaciones" no puede exceder 250 caracteres'
        });
    }

    // ---- Normalización ----
    req.body.id_transporte = Number(id_transporte);
    req.body.id_cc = Number(id_cc);
    req.body.hora_salida = horaNorm;
    req.body.fecha_cita = fechaCitaNorm;
    req.body.temperatura_salida = tempNum;
    req.body.orden_venta = orden_venta
        ? String(orden_venta).trim().toUpperCase()
        : null;
    req.body.cita = cita ? String(cita).trim().toUpperCase() : null;
    req.body.observaciones = observaciones ? String(observaciones).trim() : null;

    next();
};

// ----------------------------------------------------------------------------
// Línea del picking
// ----------------------------------------------------------------------------
export const validarLinea = (req, res, next) => {
    const {
        id_ocupacion_origen,
        id_bloque,
        cantidad_tarimas,
        cantidad_cajas,
        temperatura,
        observaciones
    } = req.body;

    // ---- Ocupación de origen ----
    // Obligatoria. El trigger puede deducir la cámara sin ella, pero
    // entonces descontaría de "la activa de la cámara" con LIMIT 1, que es
    // el montón equivocado en cuanto conviven varios procesos.
    if (!id_ocupacion_origen || isNaN(Number(id_ocupacion_origen))) {
        return res.status(400).json({
            error: 'El campo "id_ocupacion_origen" es obligatorio: indica de qué montón exacto sale la fruta'
        });
    }

    // ---- Bloque físico ----
    // Opcional: no toda la fruta se maneja en bloques armados.
    let bloqueNum = null;

    if (id_bloque !== undefined && id_bloque !== null && id_bloque !== "") {
        if (isNaN(Number(id_bloque))) {
            return res.status(400).json({
                error: 'El campo "id_bloque" debe ser numérico o nulo'
            });
        }
        bloqueNum = Number(id_bloque);
    }

    // ---- Cantidades ----
    const tarimas = cantidad_tarimas === undefined || cantidad_tarimas === null
        ? 0
        : Number(cantidad_tarimas);

    if (isNaN(tarimas) || !Number.isInteger(tarimas) || tarimas < 0) {
        return res.status(400).json({
            error: 'El campo "cantidad_tarimas" debe ser un número entero mayor o igual a 0'
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

    if (tarimas === 0 && cajas === 0) {
        return res.status(400).json({
            error: "La línea debe llevar al menos una tarima o una caja"
        });
    }

    // Coherencia cajas ↔ tarimas. Mismo criterio que el resto del sistema.
    if (tarimas > 0 && cajas > 0) {
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

    // ---- Temperatura de la línea ----
    let tempNum = null;

    if (temperatura !== undefined && temperatura !== null && temperatura !== "") {
        tempNum = Number(temperatura);

        if (isNaN(tempNum)) {
            return res.status(400).json({
                error: 'El campo "temperatura" debe ser numérico'
            });
        }

        if (tempNum < -5 || tempNum > 45) {
            return res.status(400).json({
                error: 'El campo "temperatura" está fuera de rango (-5 a 45 °C)'
            });
        }
    }

    if (observaciones && String(observaciones).length > 250) {
        return res.status(400).json({
            error: 'El campo "observaciones" no puede exceder 250 caracteres'
        });
    }

    // ---- Normalización ----
    req.body.id_ocupacion_origen = Number(id_ocupacion_origen);
    req.body.id_bloque = bloqueNum;
    req.body.cantidad_tarimas = tarimas;
    req.body.cantidad_cajas = cajas;
    req.body.temperatura = tempNum;
    req.body.observaciones = observaciones ? String(observaciones).trim() : null;

    next();
};

// ----------------------------------------------------------------------------
// Motivo de corrección
// ----------------------------------------------------------------------------
// Se exige al editar un despacho CERRADO o al reabrirlo. Sin motivo, la
// tabla de auditoría no sirve de nada: seis meses después nadie recuerda
// por qué se tocó un documento que ya había salido.
export const validarMotivo = (req, res, next) => {
    const { motivo } = req.body;

    if (!motivo || typeof motivo !== "string" || motivo.trim() === "") {
        return res.status(400).json({
            error: 'El campo "motivo" es obligatorio para modificar un despacho cerrado'
        });
    }

    if (motivo.trim().length < 10) {
        return res.status(400).json({
            error: 'El campo "motivo" debe explicar la corrección: usa al menos 10 caracteres'
        });
    }

    if (motivo.length > 250) {
        return res.status(400).json({
            error: 'El campo "motivo" no puede exceder 250 caracteres'
        });
    }

    req.body.motivo = motivo.trim();

    next();
};

export const validarIdDespacho = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de despacho debe ser un número válido"
        });
    }

    next();
};

export const validarIdDetalle = (req, res, next) => {
    const { id_detalle } = req.params;

    if (!id_detalle || isNaN(Number(id_detalle))) {
        return res.status(400).json({
            error: "El id de la línea debe ser un número válido"
        });
    }

    next();
};
