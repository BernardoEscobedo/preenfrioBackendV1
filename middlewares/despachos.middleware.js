// ============================================================================
// VALIDACIONES DE DESPACHOS
// ============================================================================
// AquÃ­ se valida el FORMATO del documento, del picking y de la inspecciÃ³n.
// Lo que exige consultar la BD â€”que el transporte estÃ© completo y activo,
// que la ocupaciÃ³n tenga fruta suficiente, que el despacho siga en
// borradorâ€” vive en el controller.
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
            error: 'El campo "id_transporte" es obligatorio y debe ser numÃ©rico'
        });
    }

    // ---- Cliente / CEDIS ----
    if (!id_cc || isNaN(Number(id_cc))) {
        return res.status(400).json({
            error: 'El campo "id_cc" es obligatorio: indica a quÃ© cliente y CEDIS va el despacho'
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
            error: 'El campo "fecha_despacho" no es una fecha vÃ¡lida (usa AAAA-MM-DD)'
        });
    }

    // A diferencia de recepciones y movimientos, aquÃ­ SÃ se permite fecha
    // futura: los despachos se programan con dÃ­as de anticipaciÃ³n contra la
    // cita del CEDIS. El tope de 30 dÃ­as atrapa el error de dedo en el aÃ±o.
    const limite = new Date();
    limite.setDate(limite.getDate() + 30);

    if (fecha > limite) {
        return res.status(400).json({
            error: "La fecha de despacho estÃ¡ a mÃ¡s de 30 dÃ­as: revisa el dato"
        });
    }

    // ---- Hora de salida ----
    // Opcional al crear el borrador: cuando se arma el picking todavÃ­a no
    // se sabe a quÃ© hora sale el camiÃ³n.
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
    // Se hereda de la producciÃ³n, pero se puede ajustar: las citas se
    // reprograman.
    let fechaCitaNorm = null;
    if (fecha_cita) {
        const fc = new Date(fecha_cita);
        if (isNaN(fc.getTime())) {
            return res.status(400).json({
                error: 'El campo "fecha_cita" no es una fecha vÃ¡lida (usa AAAA-MM-DD)'
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
    // El dato que respalda la cadena de frÃ­o ante el cliente. Mismo rango
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
                error: 'El campo "temperatura_salida" debe ser numÃ©rico'
            });
        }
        if (tempNum < -5 || tempNum > 45) {
            return res.status(400).json({
                error: 'El campo "temperatura_salida" estÃ¡ fuera de rango (-5 a 45 Â°C)'
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

    // ---- NormalizaciÃ³n ----
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

    // La inspecciÃ³n NO se captura en el encabezado: tiene su propio
    // endpoint. Se descarta para que el PUT no pueda aprobarla de paso.
    delete req.body.inocuidad;
    delete req.body.inocuidad_fecha;
    delete req.body.inocuidad_id_usuario;
    delete req.body.inocuidad_observaciones;

    next();
};

// ----------------------------------------------------------------------------
// InspecciÃ³n de inocuidad del despacho
// ----------------------------------------------------------------------------
// Resultado de revisar la caja en el andÃ©n ANTES de cargar: limpieza,
// olores, plagas y estado de la unidad.
//   1 = aprobada Â· 0 = rechazada
//
// âš ï¸ NO hay valor por defecto. El middleware anterior de transportes
// asumÃ­a 1 si el campo no venÃ­a: omitir el dato aprobaba la unidad. AquÃ­
// una inspecciÃ³n no capturada es un 400, nunca una aprobaciÃ³n.
//
// El usuario y la fecha NO se reciben del body: el usuario sale de la
// sesiÃ³n (req.id_usuario) y la fecha la pone la BD.
export const validarInocuidadDespacho = (req, res, next) => {
    const { inocuidad, inocuidad_observaciones } = req.body;

    if (inocuidad === undefined || inocuidad === null || inocuidad === "") {
        return res.status(400).json({
            error: 'El campo "inocuidad" es obligatorio: 1 (aprobada) o 0 (rechazada)'
        });
    }

    const inocuidadNum = Number(inocuidad);
    if (![0, 1].includes(inocuidadNum)) {
        return res.status(400).json({
            error: 'El campo "inocuidad" debe ser 1 (aprobada) o 0 (rechazada)'
        });
    }

    if (
        inocuidad_observaciones !== undefined &&
        inocuidad_observaciones !== null &&
        String(inocuidad_observaciones).length > 500
    ) {
        return res.status(400).json({
            error: 'El campo "inocuidad_observaciones" no puede exceder 500 caracteres'
        });
    }

    req.body.inocuidad = inocuidadNum;
    req.body.inocuidad_observaciones =
        inocuidad_observaciones && String(inocuidad_observaciones).trim() !== ""
            ? String(inocuidad_observaciones).trim()
            : null;

    next();
};

// ----------------------------------------------------------------------------
// LÃ­nea del picking
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

    // ---- OcupaciÃ³n de origen ----
    // Obligatoria. El trigger puede deducir la cÃ¡mara sin ella, pero
    // entonces descontarÃ­a de "la activa de la cÃ¡mara" con LIMIT 1, que es
    // el montÃ³n equivocado en cuanto conviven varios procesos.
    if (!id_ocupacion_origen || isNaN(Number(id_ocupacion_origen))) {
        return res.status(400).json({
            error: 'El campo "id_ocupacion_origen" es obligatorio: indica de quÃ© montÃ³n exacto sale la fruta'
        });
    }

    // ---- Bloque fÃ­sico ----
    // Opcional: no toda la fruta se maneja en bloques armados.
    let bloqueNum = null;
    if (id_bloque !== undefined && id_bloque !== null && id_bloque !== "") {
        if (isNaN(Number(id_bloque))) {
            return res.status(400).json({
                error: 'El campo "id_bloque" debe ser numÃ©rico o nulo'
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
            error: 'El campo "cantidad_tarimas" debe ser un nÃºmero entero mayor o igual a 0'
        });
    }

    const cajas = cantidad_cajas === undefined || cantidad_cajas === null
        ? 0
        : Number(cantidad_cajas);

    if (isNaN(cajas) || !Number.isInteger(cajas) || cajas < 0) {
        return res.status(400).json({
            error: 'El campo "cantidad_cajas" debe ser un nÃºmero entero mayor o igual a 0'
        });
    }

    if (tarimas === 0 && cajas === 0) {
        return res.status(400).json({
            error: "La lÃ­nea debe llevar al menos una tarima o una caja"
        });
    }

    // Coherencia cajas â†” tarimas. Mismo criterio que el resto del sistema.
    if (tarimas > 0 && cajas > 0) {
        if (tarimas > cajas) {
            return res.status(400).json({
                error: `Revisa las cantidades: ${tarimas} tarimas con solo ${cajas} cajas no es posible`
            });
        }

        if (cajas > tarimas * 60) {
            return res.status(400).json({
                error: `Revisa las cantidades: ${cajas} cajas no caben en ${tarimas} tarimas (mÃ¡ximo ~48 por tarima)`
            });
        }
    }

    // ---- Temperatura de la lÃ­nea ----
    let tempNum = null;
    if (temperatura !== undefined && temperatura !== null && temperatura !== "") {
        tempNum = Number(temperatura);
        if (isNaN(tempNum)) {
            return res.status(400).json({
                error: 'El campo "temperatura" debe ser numÃ©rico'
            });
        }
        if (tempNum < -5 || tempNum > 45) {
            return res.status(400).json({
                error: 'El campo "temperatura" estÃ¡ fuera de rango (-5 a 45 Â°C)'
            });
        }
    }

    if (observaciones && String(observaciones).length > 250) {
        return res.status(400).json({
            error: 'El campo "observaciones" no puede exceder 250 caracteres'
        });
    }

    // ---- NormalizaciÃ³n ----
    req.body.id_ocupacion_origen = Number(id_ocupacion_origen);
    req.body.id_bloque = bloqueNum;
    req.body.cantidad_tarimas = tarimas;
    req.body.cantidad_cajas = cajas;
    req.body.temperatura = tempNum;
    req.body.observaciones = observaciones ? String(observaciones).trim() : null;

    next();
};

// ----------------------------------------------------------------------------
// Motivo de correcciÃ³n
// ----------------------------------------------------------------------------
// Se exige al editar un despacho CERRADO o al reabrirlo. Sin motivo, la
// tabla de auditorÃ­a no sirve de nada: seis meses despuÃ©s nadie recuerda
// por quÃ© se tocÃ³ un documento que ya habÃ­a salido.
export const validarMotivo = (req, res, next) => {
    const { motivo } = req.body;

    if (!motivo || typeof motivo !== "string" || motivo.trim() === "") {
        return res.status(400).json({
            error: 'El campo "motivo" es obligatorio para modificar un despacho cerrado'
        });
    }

    if (motivo.trim().length < 10) {
        return res.status(400).json({
            error: 'El campo "motivo" debe explicar la correcciÃ³n: usa al menos 10 caracteres'
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
            error: "El id de despacho debe ser un nÃºmero vÃ¡lido"
        });
    }

    next();
};

export const validarIdDetalle = (req, res, next) => {
    const { id_detalle } = req.params;

    if (!id_detalle || isNaN(Number(id_detalle))) {
        return res.status(400).json({
            error: "El id de la lÃ­nea debe ser un nÃºmero vÃ¡lido"
        });
    }

    next();
};