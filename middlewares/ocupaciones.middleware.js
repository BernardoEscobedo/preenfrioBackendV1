// ============================================================================
// VALIDACIONES DE OCUPACIONES Y COLA
// ============================================================================
// Este módulo no da de alta ocupaciones: las generan los triggers. Solo se
// validan los parámetros de las dos acciones que el operador dispara sobre
// la cola.
//
// Las funciones de la BD ya validan lo suyo (que la fila exista, que sea de
// tipo cola, que haya espacio) y devuelven un mensaje. Lo que se valida
// aquí es el FORMATO, para no gastar un viaje a la BD con datos que de
// entrada no tienen sentido.
// ============================================================================

export const validarPromocion = (req, res, next) => {
    const { tarimas, fecha, hora } = req.body;

    // ---- Tarimas ----
    // fn_promover_de_cola recorta con LEAST(p_tarimas, espera, disponible),
    // así que un número de más no rompe nada: mueve lo que pueda. Pero un
    // cero o un negativo sí es error de captura y la función lo rechazaría
    // con "Cantidad inválida de tarimas" tras un viaje innecesario.
    if (tarimas === undefined || tarimas === null || tarimas === "") {
        return res.status(400).json({
            error: 'El campo "tarimas" es obligatorio: indica cuántas quieres ingresar'
        });
    }

    const tarimasNum = Number(tarimas);

    if (isNaN(tarimasNum) || !Number.isInteger(tarimasNum)) {
        return res.status(400).json({
            error: 'El campo "tarimas" debe ser un número entero'
        });
    }

    if (tarimasNum <= 0) {
        return res.status(400).json({
            error: 'El campo "tarimas" debe ser mayor a 0'
        });
    }

    // ---- Fecha y hora del ingreso ----
    // Opcionales: la función usa CURRENT_DATE y CURRENT_TIME por defecto.
    // Se permiten para capturar un ingreso que ocurrió hace rato y se está
    // registrando después, que en piso pasa seguido.
    let fechaNorm = null;

    if (fecha) {
        const f = new Date(fecha);

        if (isNaN(f.getTime())) {
            return res.status(400).json({
                error: 'El campo "fecha" no es una fecha válida (usa AAAA-MM-DD)'
            });
        }

        const finDeHoy = new Date();
        finDeHoy.setHours(23, 59, 59, 999);

        if (f > finDeHoy) {
            return res.status(400).json({
                error: "La fecha de ingreso no puede ser futura"
            });
        }

        fechaNorm = fecha;
    }

    let horaNorm = null;

    if (hora) {
        if (!/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/.test(String(hora))) {
            return res.status(400).json({
                error: 'El campo "hora" debe tener formato HH:MM o HH:MM:SS'
            });
        }
        horaNorm = hora;
    }

    req.body.tarimas = tarimasNum;
    req.body.fecha = fechaNorm;
    req.body.hora = horaNorm;

    next();
};

export const validarPrioridad = (req, res, next) => {
    const { prioridad, motivo } = req.body;

    // ---- Prioridad ----
    //   0  → orden normal (por fecha de empaque)
    //   1+ → urgente; a mayor número, más al frente
    if (prioridad === undefined || prioridad === null || prioridad === "") {
        return res.status(400).json({
            error: 'El campo "prioridad" es obligatorio (0 = orden normal, 1 o más = urgente)'
        });
    }

    const prioridadNum = Number(prioridad);

    if (isNaN(prioridadNum) || !Number.isInteger(prioridadNum)) {
        return res.status(400).json({
            error: 'El campo "prioridad" debe ser un número entero'
        });
    }

    if (prioridadNum < 0) {
        return res.status(400).json({
            error: 'El campo "prioridad" no puede ser negativo (usa 0 para el orden normal)'
        });
    }

    // Tope arbitrario pero útil: con más de 10 niveles la prioridad deja de
    // significar algo y nadie recuerda por qué un 47 va antes que un 39.
    if (prioridadNum > 10) {
        return res.status(400).json({
            error: 'El campo "prioridad" no debería exceder 10: con más niveles la fila se vuelve imposible de leer'
        });
    }

    // ---- Motivo ----
    // Obligatorio al priorizar: saltarse el orden de antigüedad tiene que
    // quedar justificado, porque alguien va a preguntar por qué esa fruta
    // entró antes que la más vieja.
    //
    // Al regresar a 0 no hace falta: la propia función de la BD pone el
    // motivo en NULL para no dejar un "URGENTE" colgando.
    if (prioridadNum > 0) {
        if (!motivo || typeof motivo !== "string" || motivo.trim() === "") {
            return res.status(400).json({
                error: 'El campo "motivo" es obligatorio al priorizar: deja constancia de por qué esta fruta se adelanta'
            });
        }

        if (motivo.length > 200) {
            return res.status(400).json({
                error: 'El campo "motivo" no puede exceder 200 caracteres'
            });
        }
    }

    req.body.prioridad = prioridadNum;
    req.body.motivo = motivo ? String(motivo).trim() : null;

    next();
};

export const validarIdOcupacion = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de ocupación debe ser un número válido"
        });
    }

    next();
};
