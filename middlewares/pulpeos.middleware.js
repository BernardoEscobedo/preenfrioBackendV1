// ============================================================================
// VALIDACIONES DE PULPEOS
// ============================================================================
// El pulpeo mide temperatura DENTRO de la fruta, no el aire de la cámara.
// Por eso el rango que se acepta es más estrecho que en recepciones: una
// pulpa no puede estar a 40 °C ni a -4 °C sin estar ya dañada.
//
// Las temperaturas se validan con cuidado porque son EVIDENCIA: si hay un
// reclamo por cadena de frío, estos números son lo que se presenta.
// ============================================================================

// Rango físicamente posible en pulpa de fruta.
// Por debajo de -2 °C hay daño por congelación; por encima de 40 °C el dato
// es un error de captura o un termómetro descompuesto.
const TEMP_MINIMA = -2;
const TEMP_MAXIMA = 40;

export const validarPulpeo = (req, res, next) => {
    const {
        id_bloque,
        fecha_hora,
        numero_pulpeo,
        temperatura_objetivo,
        temperatura_promedio,
        observaciones,
        detalle
    } = req.body;

    // ---- Bloque ----
    if (!id_bloque || isNaN(Number(id_bloque))) {
        return res.status(400).json({
            error: 'El campo "id_bloque" es obligatorio: el pulpeo se toma sobre un bloque físico'
        });
    }

    // ---- Fecha y hora ----
    // Opcional: por defecto CURRENT_TIMESTAMP. Se permite indicarla para
    // capturar una medición tomada hace rato en papel.
    let fechaNorm = null;

    if (fecha_hora) {
        const fecha = new Date(fecha_hora);

        if (isNaN(fecha.getTime())) {
            return res.status(400).json({
                error: 'El campo "fecha_hora" no es una fecha válida'
            });
        }

        if (fecha > new Date()) {
            return res.status(400).json({
                error: "La fecha del pulpeo no puede ser futura"
            });
        }

        fechaNorm = fecha_hora;
    }

    // ---- Número de pulpeo ----
    // Opcional: el controller calcula el siguiente si no viene. Los pulpeos
    // se numeran en secuencia para seguir la curva de enfriamiento.
    let numeroNorm = null;

    if (numero_pulpeo !== undefined && numero_pulpeo !== null && numero_pulpeo !== "") {
        numeroNorm = Number(numero_pulpeo);

        if (isNaN(numeroNorm) || !Number.isInteger(numeroNorm) || numeroNorm <= 0) {
            return res.status(400).json({
                error: 'El campo "numero_pulpeo" debe ser un número entero mayor a 0'
            });
        }
    }

    // ---- Temperatura objetivo ----
    // NOT NULL en la BD: sin objetivo, la medición no se puede evaluar.
    if (
        temperatura_objetivo === undefined ||
        temperatura_objetivo === null ||
        temperatura_objetivo === ""
    ) {
        return res.status(400).json({
            error: 'El campo "temperatura_objetivo" es obligatorio: sin él no se puede saber si la fruta ya enfrió'
        });
    }

    const objetivo = Number(temperatura_objetivo);

    if (isNaN(objetivo)) {
        return res.status(400).json({
            error: 'El campo "temperatura_objetivo" debe ser numérico'
        });
    }

    if (objetivo < TEMP_MINIMA || objetivo > TEMP_MAXIMA) {
        return res.status(400).json({
            error: `El campo "temperatura_objetivo" está fuera de rango (${TEMP_MINIMA} a ${TEMP_MAXIMA} °C)`
        });
    }

    // ---- Temperatura promedio ----
    if (
        temperatura_promedio === undefined ||
        temperatura_promedio === null ||
        temperatura_promedio === ""
    ) {
        return res.status(400).json({
            error: 'El campo "temperatura_promedio" es obligatorio: es la lectura del termómetro'
        });
    }

    const promedio = Number(temperatura_promedio);

    if (isNaN(promedio)) {
        return res.status(400).json({
            error: 'El campo "temperatura_promedio" debe ser numérico'
        });
    }

    if (promedio < TEMP_MINIMA || promedio > TEMP_MAXIMA) {
        return res.status(400).json({
            error: `El campo "temperatura_promedio" está fuera de rango (${TEMP_MINIMA} a ${TEMP_MAXIMA} °C). Revisa la lectura o el termómetro.`
        });
    }

    // ---- Observaciones ----
    if (observaciones && String(observaciones).length > 250) {
        return res.status(400).json({
            error: 'El campo "observaciones" no puede exceder 250 caracteres'
        });
    }

    // ---- Detalle por proceso ----
    // Opcional: si el bloque tiene un solo lote, la medición del encabezado
    // ya lo dice todo. Cuando viene, cada línea se valida igual que el
    // encabezado.
    let detalleNorm = [];

    if (detalle !== undefined && detalle !== null) {
        if (!Array.isArray(detalle)) {
            return res.status(400).json({
                error: 'El campo "detalle" debe ser un arreglo de mediciones por proceso'
            });
        }

        for (const [i, linea] of detalle.entries()) {
            const fila = i + 1;

            if (!linea.id_produccion || isNaN(Number(linea.id_produccion))) {
                return res.status(400).json({
                    error: `Detalle fila ${fila}: "id_produccion" es obligatorio y debe ser numérico`
                });
            }

            const tarimas = Number(linea.cantidad_tarimas);

            if (isNaN(tarimas) || !Number.isInteger(tarimas) || tarimas <= 0) {
                return res.status(400).json({
                    error: `Detalle fila ${fila}: "cantidad_tarimas" debe ser un entero mayor a 0`
                });
            }

            let tempLinea = null;

            if (
                linea.temperatura !== undefined &&
                linea.temperatura !== null &&
                linea.temperatura !== ""
            ) {
                tempLinea = Number(linea.temperatura);

                if (isNaN(tempLinea)) {
                    return res.status(400).json({
                        error: `Detalle fila ${fila}: "temperatura" debe ser numérica`
                    });
                }

                if (tempLinea < TEMP_MINIMA || tempLinea > TEMP_MAXIMA) {
                    return res.status(400).json({
                        error: `Detalle fila ${fila}: temperatura fuera de rango (${TEMP_MINIMA} a ${TEMP_MAXIMA} °C)`
                    });
                }
            }

            detalleNorm.push({
                id_produccion: Number(linea.id_produccion),
                cantidad_tarimas: tarimas,
                temperatura: tempLinea,
                fecha_hora: linea.fecha_hora ?? null
            });
        }

        // Un mismo proceso dos veces en el mismo pulpeo reventaría el
        // UNIQUE(id_pulpeo, id_produccion) a media transacción.
        const ids = detalleNorm.map((d) => d.id_produccion);
        const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);

        if (repetidos.length > 0) {
            return res.status(400).json({
                error: `El detalle repite el proceso ${repetidos[0]}: cada lote debe aparecer una sola vez por pulpeo`
            });
        }
    }

    // ---- Normalización ----
    req.body.id_bloque = Number(id_bloque);
    req.body.fecha_hora = fechaNorm;
    req.body.numero_pulpeo = numeroNorm;
    req.body.temperatura_objetivo = objetivo;
    req.body.temperatura_promedio = promedio;
    req.body.observaciones = observaciones ? String(observaciones).trim() : null;
    req.body.detalle = detalleNorm;

    next();
};

// Edición: solo lo administrativo. Las temperaturas no se editan porque una
// lectura es un hecho puntual, no un dato corregible.
export const validarEdicionPulpeo = (req, res, next) => {
    const { numero_pulpeo, observaciones } = req.body;

    let numeroNorm = null;

    if (numero_pulpeo !== undefined && numero_pulpeo !== null && numero_pulpeo !== "") {
        numeroNorm = Number(numero_pulpeo);

        if (isNaN(numeroNorm) || !Number.isInteger(numeroNorm) || numeroNorm <= 0) {
            return res.status(400).json({
                error: 'El campo "numero_pulpeo" debe ser un número entero mayor a 0'
            });
        }
    }

    if (observaciones && String(observaciones).length > 250) {
        return res.status(400).json({
            error: 'El campo "observaciones" no puede exceder 250 caracteres'
        });
    }

    req.body.numero_pulpeo = numeroNorm;
    req.body.observaciones = observaciones ? String(observaciones).trim() : null;

    next();
};

export const validarIdPulpeo = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de pulpeo debe ser un número válido"
        });
    }

    next();
};
