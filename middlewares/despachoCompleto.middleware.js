import { aFechaISO, esFechaFutura } from "../utils/fechas.js";

// ============================================================================
// VALIDACIONES · DESPACHO EN UN PASO
// ============================================================================
// Forma del body y normalización. Lo que exige la BD (tarimas disponibles,
// stock, duplicados) lo valida el controller dentro de la transacción.
//
// body:
// {
//   id_cc, fecha_despacho, hora_salida, orden_venta?, cita?, fecha_cita?,
//   temperatura_salida?, observaciones?, confirmar_reasignacion?,
//   id_tarimas: [id_tarima, ...]        tarimas de bloque que suben
//   transporte: {
//     id_linea_fletera,
//     operador:     { id } | { nuevo: { nombre, celular } },
//     tractocamion: { id } | { nuevo: { placas, numero_economico } },
//     tipo_unidad:  1 sencillo | 2 full,
//     cajas: [ { id } | { nuevo: { placas, numero_economico, largo_pies? } } ]
//   },
//   inspeccion: [{ inocuidad: 1, observaciones? }]   una por caja
// }
//
// La fruta sale por TARIMA de bloque, entera (completa, media o mixta).
// ============================================================================

const HORA = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;
const MAX_TARIMAS = 60;
const entero = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
const texto = (v) => (v === undefined || v === null ? "" : String(v).trim());
const placa = (v) => texto(v).toUpperCase().replace(/[^A-Z0-9]/g, "");

const error = (res, msg) => res.status(400).json({ error: msg });

/** { id } existente o { nuevo: {...} }. Devuelve el objeto normalizado o un texto de error. */
const pieza = (p, nombre, normalizarNuevo) => {
    if (!p || typeof p !== "object") return `Falta ${nombre}`;
    if (p.id !== undefined && p.id !== null && p.id !== "") {
        return entero(p.id) ? { id: Number(p.id) } : `${nombre}: id inválido`;
    }
    if (p.nuevo && typeof p.nuevo === "object") return normalizarNuevo(p.nuevo);
    return `Elige ${nombre} o dalo de alta`;
};

const nuevoOperador = (n) => {
    const nombre = texto(n.nombre).replace(/\s+/g, " ").toUpperCase();
    const celular = texto(n.celular).replace(/\D/g, "");
    if (!nombre || nombre.length > 100) return "El nombre del operador es obligatorio (máx. 100)";
    if (celular.length !== 10) return "El celular del operador debe tener 10 dígitos";
    return { nuevo: { nombre, celular } };
};

const nuevoTracto = (n) => {
    const placas = placa(n.placas);
    const numero_economico = texto(n.numero_economico).toUpperCase();
    if (!placas || placas.length > 10) return "Las placas del tracto son obligatorias (máx. 10 sin guiones)";
    if (!numero_economico || numero_economico.length > 10) return "El número económico del tracto es obligatorio (máx. 10)";
    return { nuevo: { placas, numero_economico } };
};

const nuevaCaja = (n) => {
    const placas = placa(n.placas);
    const numero_economico = texto(n.numero_economico).toUpperCase();
    if (!placas || placas.length > 10) return "Las placas de la caja son obligatorias (máx. 10 sin guiones)";
    if (!numero_economico || numero_economico.length > 10) return "El número económico de la caja es obligatorio (máx. 10)";
    let largo_pies = null;
    if (n.largo_pies !== undefined && n.largo_pies !== null && n.largo_pies !== "") {
        if (!entero(n.largo_pies)) return "El largo de la caja debe ser un entero mayor a 0";
        largo_pies = Number(n.largo_pies);
    }
    return { nuevo: { placas, numero_economico, largo_pies } };
};

export const validarDespachoCompleto = (req, res, next) => {
    const b = req.body ?? {};

    // ---- Destino y documento ----
    if (!entero(b.id_cc)) return error(res, "Elige el cliente/CEDIS destino");

    const fecha = b.fecha_despacho ? aFechaISO(b.fecha_despacho) : null;
    if (!fecha) return error(res, "La fecha de despacho es obligatoria (AAAA-MM-DD)");
    if (esFechaFutura(fecha)) return error(res, "La fecha de despacho no puede ser futura: se confirma cuando el camión sale");

    if (!b.hora_salida || !HORA.test(String(b.hora_salida))) return error(res, "La hora de salida es obligatoria (HH:MM)");

    let fechaCita = null;
    if (b.fecha_cita) {
        fechaCita = aFechaISO(b.fecha_cita);
        if (!fechaCita) return error(res, "La fecha de cita no es válida");
        if (fechaCita < fecha) return error(res, "La fecha de cita no puede ser anterior a la de despacho");
    }

    let temp = null;
    if (b.temperatura_salida !== undefined && b.temperatura_salida !== null && b.temperatura_salida !== "") {
        temp = Number(b.temperatura_salida);
        if (isNaN(temp) || temp < -5 || temp > 45) return error(res, "La temperatura de salida debe estar entre -5 y 45 °C");
    }

    if (texto(b.orden_venta).length > 50) return error(res, "La orden de venta no puede exceder 50 caracteres");
    if (texto(b.cita).length > 50) return error(res, "La cita no puede exceder 50 caracteres");
    if (texto(b.observaciones).length > 250) return error(res, "Las observaciones no pueden exceder 250 caracteres");

    // ---- Tarimas ----
    if (!Array.isArray(b.id_tarimas) || b.id_tarimas.length === 0) return error(res, "Elige al menos una tarima");
    const tarimas = [...new Set(b.id_tarimas.map(Number))];
    if (tarimas.some((x) => !Number.isInteger(x) || x <= 0)) return error(res, "Tarimas inválidas");
    if (tarimas.length > MAX_TARIMAS) return error(res, `Máximo ${MAX_TARIMAS} tarimas por despacho`);

    // ---- Transporte ----
    const t = b.transporte;
    if (!t || typeof t !== "object") return error(res, "Faltan los datos del transporte");
    if (!entero(t.id_linea_fletera)) return error(res, "Elige la línea fletera");

    const operador = pieza(t.operador, "el operador", nuevoOperador);
    if (typeof operador === "string") return error(res, operador);
    const tractocamion = pieza(t.tractocamion, "el tractocamión", nuevoTracto);
    if (typeof tractocamion === "string") return error(res, tractocamion);

    const tipo = Number(t.tipo_unidad);
    if (![1, 2].includes(tipo)) return error(res, "Indica si la unidad es sencillo o full");
    if (!Array.isArray(t.cajas) || t.cajas.length !== tipo)
        return error(res, tipo === 2 ? "Una unidad full lleva dos cajas" : "Una unidad sencilla lleva una caja");

    const cajas = [];
    for (const [i, cj] of t.cajas.entries()) {
        const r = pieza(cj, `la caja ${i + 1}`, nuevaCaja);
        if (typeof r === "string") return error(res, r);
        cajas.push(r);
    }
    if (tipo === 2) {
        const [a, c2] = cajas;
        if (a.id && c2.id && a.id === c2.id) return error(res, "Las dos cajas deben ser distintas");
        if (a.nuevo && c2.nuevo && a.nuevo.placas === c2.nuevo.placas) return error(res, "Las dos cajas nuevas tienen las mismas placas");
    }

    // ---- Inspección (una por caja, todas aprobadas) ----
    if (!Array.isArray(b.inspeccion) || b.inspeccion.length !== tipo)
        return error(res, "Registra la inspección de inocuidad de cada caja");
    const inspeccion = [];
    for (const [i, ins] of b.inspeccion.entries()) {
        const v = Number(ins?.inocuidad);
        if (v !== 1) return error(res, `La caja ${i + 1} no está aprobada en inocuidad: no se carga ni se despacha`);
        const obs = texto(ins.observaciones);
        if (obs.length > 500) return error(res, `Caja ${i + 1}: las observaciones no pueden exceder 500 caracteres`);
        inspeccion.push({ inocuidad: 1, observaciones: obs || null });
    }

    req.body = {
        id_cc: Number(b.id_cc),
        fecha_despacho: fecha,
        hora_salida: String(b.hora_salida),
        orden_venta: texto(b.orden_venta).toUpperCase() || null,
        cita: texto(b.cita).toUpperCase() || null,
        fecha_cita: fechaCita,
        temperatura_salida: temp,
        observaciones: texto(b.observaciones) || null,
        confirmar_reasignacion: b.confirmar_reasignacion === true,
        id_tarimas: tarimas,
        transporte: {
            id_linea_fletera: Number(t.id_linea_fletera),
            operador,
            tractocamion,
            tipo_unidad: tipo,
            cajas
        },
        inspeccion
    };
    next();
};
