import { aFechaISO, esFechaFutura, hoyISO, sumarDiasISO } from "../utils/fechas.js";

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
//
// CORRECCIONES DE LA AUDITORÍA
//   · Las fechas se evalúan en la zona de operación y comparando texto.
//     Antes, en Tapachula, la fecha de MAÑANA pasaba "no puede ser futura".
//   · Crear directo en estado 2 (en proceso) con fecha futura bloqueaba la
//     cámara DESDE AHORA: el trigger no espera a la fecha, bloquea en
//     cuanto el estado es 2. Si es futuro, se programa (estado 1).
// ============================================================================

const TIPOS_VALIDOS = [1, 2, 3];        // 1 Preventivo · 2 Correctivo · 3 Emergencia
const PRIORIDADES_VALIDAS = [1, 2, 3];  // 1 Alta · 2 Media · 3 Baja

// Solo se admite crear en estos dos estados. El 3 (finalizado) no tiene
// sentido al dar de alta y el 4 (cancelado) tampoco: para eso está no
// crearlo.
const ESTADOS_AL_CREAR = [1, 2];        // 1 Programado · 2 En proceso

const REGEX_HORA = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

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

    const fecha = aFechaISO(fecha_inicio);

    if (!fecha) {
        return res.status(400).json({
            error: 'El campo "fecha_inicio" no es una fecha válida (usa AAAA-MM-DD)'
        });
    }

    // A diferencia de recepciones y movimientos, aquí SÍ se permite fecha
    // futura: los preventivos se agendan con semanas de anticipación. El
    // tope de 180 días atrapa el error de dedo en el año.
    if (fecha > sumarDiasISO(hoyISO(), 180)) {
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

    if (!REGEX_HORA.test(String(hora_inicio))) {
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

    // Un paro "en proceso" que empieza en el futuro es una contradicción, y
    // además bloquearía la cámara desde ahora: el trigger reacciona al
    // estado, no a la fecha.
    if (estadoNum === 2 && esFechaFutura(fecha)) {
        return res.status(400).json({
            error: "Un mantenimiento con fecha futura no puede nacer 'en proceso': bloquearía la cámara desde ahora. Créalo como programado (estado 1) e inícialo cuando llegue el técnico."
        });
    }

    // ---- Normalización ----
    req.body.id_camara = Number(id_camara);
    req.body.fecha_inicio = fecha;
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

    const fecha = aFechaISO(fecha_inicio);

    if (!fecha) {
        return res.status(400).json({
            error: 'El campo "fecha_inicio" no es una fecha válida (usa AAAA-MM-DD)'
        });
    }

    if (!hora_inicio) {
        return res.status(400).json({
            error: 'El campo "hora_inicio" es obligatorio'
        });
    }

    if (!REGEX_HORA.test(String(hora_inicio))) {
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

    req.body.fecha_inicio = fecha;
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
//
// Que la fecha de fin no quede antes del inicio lo valida el controller,
// porque necesita el registro existente.
export const validarFechaTransicion = (req, res, next) => {
    const { fecha, hora } = req.body;

    let fechaNorm = null;

    if (fecha) {
        fechaNorm = aFechaISO(fecha);

        if (!fechaNorm) {
            return res.status(400).json({
                error: 'El campo "fecha" no es una fecha válida (usa AAAA-MM-DD)'
            });
        }

        if (esFechaFutura(fechaNorm)) {
            return res.status(400).json({
                error: "La fecha no puede ser futura"
            });
        }
    }

    let horaNorm = null;

    if (hora) {
        if (!REGEX_HORA.test(String(hora))) {
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
