import { aFechaISO, esFechaFutura } from "../utils/fechas.js";

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
//
// "Fecha futura" se evalúa en la zona de operación y comparando texto
// (utils/fechas.js): en Tapachula, con new Date(), la fecha de MAÑANA
// pasaba la validación.
// ============================================================================

const REGEX_HORA = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

// ----------------------------------------------------------------------------
// Promover de la cola a la cámara
// ----------------------------------------------------------------------------
export const validarPromocion = (req, res, next) => {
    const { tarimas, fecha, hora } = req.body;

    // ---- Tarimas ----
    // fn_promover_de_cola recorta con LEAST(p_tarimas, espera, disponible),
    // así que un número de más no rompe nada: mueve lo que pueda. Pero un
    // cero o un negativo sí es error de captura.
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
    // Se permiten para capturar un ingreso que ocurrió hace rato.
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
                error: "La fecha de ingreso no puede ser futura"
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

    req.body.tarimas = tarimasNum;
    req.body.fecha = fechaNorm;
    req.body.hora = horaNorm;

    next();
};

// ----------------------------------------------------------------------------
// Prioridad manual en la cola
// ----------------------------------------------------------------------------
export const validarPrioridad = (req, res, next) => {
    const { prioridad, motivo } = req.body;

    //   0  → orden normal (criticidad y luego antigüedad)
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

    // Con más de 10 niveles la prioridad deja de significar algo
    if (prioridadNum > 10) {
        return res.status(400).json({
            error: 'El campo "prioridad" no debería exceder 10: con más niveles la fila se vuelve imposible de leer'
        });
    }

    // El motivo es obligatorio al priorizar: saltarse el orden sugerido
    // tiene que quedar justificado. Al regresar a 0 no hace falta: la
    // función de la BD pone el motivo en NULL.
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
