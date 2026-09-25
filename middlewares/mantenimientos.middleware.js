// ============================================================================
// VALIDACIONES DE MANTENIMIENTOS
// ============================================================================
// Aquí se valida el FORMATO. Lo que exige consultar la BD —que no haya otro
// mantenimiento activo en la cámara, qué fruta hay dentro, si la transición
// de estado es válida— vive en el controller.
//
// ⚠️ SOBRE 'tipo' Y 'prioridad'
//   El esquema los declara INT NOT NULL pero no documenta sus valores. Se
//   definieron aquí con el criterio más común en mantenimiento industrial:
//
//       tipo       1 Preventivo · 2 Correctivo · 3 Emergencia
//       prioridad  1 Alta · 2 Media · 3 Baja
//
//   Si en la operación se usan otros, hay que ajustar estas constantes y
//   los CASE de mantenimientos.model.js: son los dos únicos lugares donde
//   se traducen a texto.
// ============================================================================

const TIPOS_VALIDOS = [1, 2, 3];        // 1 Preventivo · 2 Correctivo · 3 Emergencia
const PRIORIDADES_VALIDAS = [1, 2, 3];  // 1 Alta · 2 Media · 3 Baja

// Solo se admite crear en estos dos estados. El 3 (finalizado) no tiene
// sentido al dar de alta y el 4 (cancelado) tampoco: para eso está no
// crearlo.
const ESTADOS_AL_CREAR = [1, 2];        // 1 Programado · 2 En proceso

export const validarMantenimiento = (req, res, next) => {
    const {
        id_camara,
        fecha_inicio,
        hora_inicio,
        tipo,
        motivo,
        prioridad,
        estado
    } = req.body;

    // ---- Cámara ----
    if (!id_camara || isNaN(Number(id_camara))) {
        return res.status(400).json({
            error: 'El campo "id_camara" es obligatorio y debe ser numérico'
        });
    }

    // ---- Fecha de inicio ----
    if (!fecha_inicio) {
        return res.status(400).json({
            error: 'El campo "fecha_inicio" es obligatorio'
        });
    }

    const fecha = new Date(fecha_inicio);

    if (isNaN(fecha.getTime())) {
        return res.status(400).json({
            error: 'El campo "fecha_inicio" no es una fecha válida (usa AAAA-MM-DD)'
        });
    }

    // A diferencia de recepciones y movimientos, aquí SÍ se permite fecha
    // futura: los preventivos se agendan con semanas de anticipación. El
    // tope de 180 días atrapa el error de dedo en el año.
    const limite = new Date();
    limite.setDate(limite.getDate() + 180);

    if (fecha > limite) {
        return res.status(400).json({
            error: "La fecha de inicio está a más de 180 días: revisa el dato"
        });
    }

    // ---- Hora de inicio ----
    if (!hora_inicio) {
        return res.status(400).json({
            error: 'El campo "hora_inicio" es obligatorio (formato HH:MM)'
        });
    }

    if (!/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/.test(String(hora_inicio))) {
        return res.status(400).json({
            error: 'El campo "hora_inicio" debe tener formato HH:MM o HH:MM:SS'
        });
    }

    // ---- Tipo ----
    if (!tipo || !TIPOS_VALIDOS.includes(Number(tipo))) {
        return res.status(400).json({
            error: 'El campo "tipo" debe ser 1 (preventivo), 2 (correctivo) o 3 (emergencia)'
        });
    }

    // ---- Motivo ----
    // VARCHAR(60) en la BD, y es lo que el operador va a leer cuando se
    // pregunte por qué su cámara no recibe fruta. Se exige que diga algo.
    if (!motivo || typeof motivo !== "string" || motivo.trim() === "") {
        return res.status(400).json({
            error: 'El campo "motivo" es obligatorio: explica por qué se para la cámara'
        });
    }

    if (motivo.trim().length < 5) {
        return res.status(400).json({
            error: 'El campo "motivo" debe ser descriptivo: usa al menos 5 caracteres'
        });
    }

    if (motivo.length > 60) {
        return res.status(400).json({
            error: 'El campo "motivo" no puede exceder 60 caracteres'
        });
    }

    // ---- Prioridad ----
    if (!prioridad || !PRIORIDADES_VALIDAS.includes(Number(prioridad))) {
        return res.status(400).json({
            error: 'El campo "prioridad" debe ser 1 (alta), 2 (media) o 3 (baja)'
        });
    }

    // ---- Estado ----
    // Por defecto 1 (programado): lo normal es agendar y después iniciar.
    // Crear directo en 2 bloquea la cámara de inmediato, y es el caso de la
    // falla imprevista.
    const estadoNum =
        estado === undefined || estado === null ? 1 : Number(estado);

    if (!ESTADOS_AL_CREAR.includes(estadoNum)) {
        return res.status(400).json({
            error: 'El campo "estado" al crear debe ser 1 (programado) o 2 (en proceso). Para finalizar o cancelar usa los endpoints correspondientes.'
        });
    }

    // ---- Normalización ----
    req.body.id_camara = Number(id_camara);
    req.body.tipo = Number(tipo);
    req.body.prioridad = Number(prioridad);
    req.body.estado = estadoNum;
    req.body.motivo = motivo.trim();

    // fecha_fin y hora_fin NO se aceptan al crear: las escribe el endpoint
    // de finalizar, con la hora real del cierre. Se fuerzan a null para que
    // un body malicioso no las cuele.
    req.body.fecha_fin = null;
    req.body.hora_fin = null;

    next();
};

// ----------------------------------------------------------------------------
// Edición de datos administrativos
// ----------------------------------------------------------------------------
// No toca el estado: cada transición va por su propio endpoint porque el
// trigger reacciona distinto a cada valor.
export const validarEdicionMantenimiento = (req, res, next) => {
    const { fecha_inicio, hora_inicio, tipo, motivo, prioridad } = req.body;

    if (!fecha_inicio) {
        return res.status(400).json({
            error: 'El campo "fecha_inicio" es obligatorio'
        });
    }

    const fecha = new Date(fecha_inicio);

    if (isNaN(fecha.getTime())) {
        return res.status(400).json({
            error: 'El campo "fecha_inicio" no es una fecha válida'
        });
    }

    if (!hora_inicio) {
        return res.status(400).json({
            error: 'El campo "hora_inicio" es obligatorio'
        });
    }

    if (!/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/.test(String(hora_inicio))) {
        return res.status(400).json({
            error: 'El campo "hora_inicio" debe tener formato HH:MM o HH:MM:SS'
        });
    }

    if (!tipo || !TIPOS_VALIDOS.includes(Number(tipo))) {
        return res.status(400).json({
            error: 'El campo "tipo" debe ser 1 (preventivo), 2 (correctivo) o 3 (emergencia)'
        });
    }

    if (!motivo || typeof motivo !== "string" || motivo.trim().length < 5) {
        return res.status(400).json({
            error: 'El campo "motivo" es obligatorio y debe tener al menos 5 caracteres'
        });
    }

    if (motivo.length > 60) {
        return res.status(400).json({
            error: 'El campo "motivo" no puede exceder 60 caracteres'
        });
    }

    if (!prioridad || !PRIORIDADES_VALIDAS.includes(Number(prioridad))) {
        return res.status(400).json({
            error: 'El campo "prioridad" debe ser 1 (alta), 2 (media) o 3 (baja)'
        });
    }

    req.body.tipo = Number(tipo);
    req.body.prioridad = Number(prioridad);
    req.body.motivo = motivo.trim();

    next();
};

// ----------------------------------------------------------------------------
// Fecha y hora de una transición
// ----------------------------------------------------------------------------
// Las usan iniciar y finalizar. Ambas opcionales: por defecto se toma el
// momento actual. Se permiten para registrar algo que pasó hace rato, que
// en piso ocurre seguido.
export const validarFechaTransicion = (req, res, next) => {
    const { fecha, hora } = req.body;

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
                error: "La fecha no puede ser futura"
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

    req.body.fecha = fechaNorm;
    req.body.hora = horaNorm;

    next();
};

export const validarIdMantenimiento = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de mantenimiento debe ser un número válido"
        });
    }

    next();
};
