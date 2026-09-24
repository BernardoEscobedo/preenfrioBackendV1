// ============================================================================
// VALIDACIONES DE MOVIMIENTOS DE INVENTARIO
// ============================================================================
// Aquí se valida el FORMATO del traslado. Lo que exige consultar la BD
// —que la ocupación de origen exista, que tenga suficientes tarimas, que la
// cámara destino sea de conservación— vive en el controller.
//
// POR QUÉ SE VALIDA CON TANTO CUIDADO
//   Un INSERT aquí dispara trg_sync_ocupacion_movimiento, que descuenta de
//   una cámara y suma a otra. Un número mal capturado no genera un error
//   visible: genera inventario fantasma en una cámara y un faltante en la
//   otra. Nadie lo nota hasta el conteo físico.
// ============================================================================

/**
 * Tipos de movimiento que ESTE módulo puede crear.
 *
 * El 1 (ingreso a preenfrío) lo genera trg_sync_ocupacion_recepcion y el 3
 * (salida por despacho) lo genera trg_despacho_detalle_movimiento. Dejar
 * que se capturen a mano desde aquí significaría dos vías para el mismo
 * hecho: una recepción registrada Y un ingreso manual dejarían la cámara
 * con el doble de fruta de la que llegó.
 */
const TIPOS_PERMITIDOS = [2]; // 2 = preenfrío → conservación

export const validarMovimiento = (req, res, next) => {
    const {
        tipo_movimiento,
        id_ocupacion_origen,
        id_camara_destino,
        fecha_movimiento,
        hora_movimiento,
        cantidad_tarimas,
        cantidad_cajas,
        temperatura,
        observaciones
    } = req.body;

    // ---- Tipo de movimiento ----
    // Por defecto 2: es el único que este módulo maneja, así que el
    // frontend no tiene por qué mandarlo.
    const tipoNum =
        tipo_movimiento === undefined || tipo_movimiento === null
            ? 2
            : Number(tipo_movimiento);

    if (!TIPOS_PERMITIDOS.includes(tipoNum)) {
        return res.status(400).json({
            error: 'Este módulo solo registra traslados de preenfrío a conservación (tipo 2). Los ingresos los genera la recepción y las salidas el despacho.'
        });
    }

    // ---- Ocupación de origen ----
    // Obligatoria, y no por capricho: el trigger tiene un camino alterno
    // que busca "la activa de la cámara" con LIMIT 1 cuando no se manda.
    // Eso descuenta del montón equivocado en cuanto conviven varios
    // procesos en la misma cámara.
    if (!id_ocupacion_origen || isNaN(Number(id_ocupacion_origen))) {
        return res.status(400).json({
            error: 'El campo "id_ocupacion_origen" es obligatorio: indica de qué montón exacto sale la fruta'
        });
    }

    // ---- Cámara destino ----
    if (!id_camara_destino || isNaN(Number(id_camara_destino))) {
        return res.status(400).json({
            error: 'El campo "id_camara_destino" es obligatorio y debe ser numérico'
        });
    }

    // ---- Fecha ----
    if (!fecha_movimiento) {
        return res.status(400).json({
            error: 'El campo "fecha_movimiento" es obligatorio'
        });
    }

    const fecha = new Date(fecha_movimiento);

    if (isNaN(fecha.getTime())) {
        return res.status(400).json({
            error: 'El campo "fecha_movimiento" no es una fecha válida (usa AAAA-MM-DD)'
        });
    }

    // Mover fruta "mañana" es siempre error de captura. Se compara contra
    // el final del día de hoy para no pelear con zonas horarias.
    const finDeHoy = new Date();
    finDeHoy.setHours(23, 59, 59, 999);

    if (fecha > finDeHoy) {
        return res.status(400).json({
            error: "La fecha del movimiento no puede ser futura"
        });
    }

    // ---- Hora ----
    if (!hora_movimiento) {
        return res.status(400).json({
            error: 'El campo "hora_movimiento" es obligatorio (formato HH:MM)'
        });
    }

    if (!/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/.test(String(hora_movimiento))) {
        return res.status(400).json({
            error: 'El campo "hora_movimiento" debe tener formato HH:MM o HH:MM:SS'
        });
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

    // Un movimiento sin nada que mover no tiene sentido, y además dejaría
    // una fila en la bitácora que no corresponde a ningún hecho físico.
    if (tarimas === 0 && cajas === 0) {
        return res.status(400).json({
            error: "El movimiento debe llevar al menos una tarima o una caja"
        });
    }

    // Coherencia cajas ↔ tarimas. Mismo criterio que recepciones: la regla
    // es ~48 cajas por tarima, se deja margen amplio y solo se rechaza lo
    // imposible.
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

    // ---- Temperatura ----
    // Es el dato que justifica el traslado: la fruta pasa a conservación
    // cuando ya alcanzó su temperatura objetivo. Mismo rango que en
    // recepciones.
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
                error: 'El campo "temperatura" está fuera de rango (-5 a 45 °C). Revisa la lectura.'
            });
        }
    }

    // ---- Observaciones ----
    if (observaciones && String(observaciones).length > 250) {
        return res.status(400).json({
            error: 'El campo "observaciones" no puede exceder 250 caracteres'
        });
    }

    // ---- Normalización ----
    req.body.tipo_movimiento = tipoNum;
    req.body.id_ocupacion_origen = Number(id_ocupacion_origen);
    req.body.id_camara_destino = Number(id_camara_destino);
    req.body.cantidad_tarimas = tarimas;
    req.body.cantidad_cajas = cajas;
    req.body.temperatura = tempNum;
    req.body.observaciones = observaciones ? String(observaciones).trim() : null;

    // El despacho no aplica a los traslados: se fuerza a null para que un
    // body malicioso no lo cuele.
    req.body.id_despacho = null;

    next();
};

export const validarIdMovimiento = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de movimiento debe ser un número válido"
        });
    }

    next();
};
