import { aFechaISO, esFechaFutura } from "../utils/fechas.js";

// ============================================================================
// VALIDACIÓN · TRASLADO DE BLOQUE
// ============================================================================
// body: { id_bloque, id_tarimas: [..], id_camara_destino,
//         fecha_movimiento?, hora_movimiento?, temperatura?, observaciones? }
// ============================================================================

const HORA = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;
const entero = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

export const validarTrasladoBloque = (req, res, next) => {
    const b = req.body ?? {};

    if (!entero(b.id_bloque)) return res.status(400).json({ error: "Indica el bloque" });
    if (!entero(b.id_camara_destino)) return res.status(400).json({ error: "Elige la conservación destino" });

    if (!Array.isArray(b.id_tarimas) || b.id_tarimas.length === 0)
        return res.status(400).json({ error: "Elige al menos una tarima" });
    const tarimas = [...new Set(b.id_tarimas.map(Number))];
    if (tarimas.some((t) => !Number.isInteger(t) || t <= 0) || tarimas.length > 12)
        return res.status(400).json({ error: "Tarimas inválidas" });

    let fecha = null;
    if (b.fecha_movimiento) {
        fecha = aFechaISO(b.fecha_movimiento);
        if (!fecha) return res.status(400).json({ error: "La fecha no es válida (AAAA-MM-DD)" });
        if (esFechaFutura(fecha)) return res.status(400).json({ error: "La fecha no puede ser futura" });
    }
    let hora = null;
    if (b.hora_movimiento) {
        if (!HORA.test(String(b.hora_movimiento))) return res.status(400).json({ error: "La hora debe ser HH:MM" });
        hora = String(b.hora_movimiento).length === 5 ? `${b.hora_movimiento}:00` : String(b.hora_movimiento);
    }
    if ((fecha && !hora) || (!fecha && hora)) return res.status(400).json({ error: "Indica fecha y hora juntas" });

    let temp = null;
    if (b.temperatura !== undefined && b.temperatura !== null && b.temperatura !== "") {
        temp = Number(b.temperatura);
        if (isNaN(temp) || temp < -5 || temp > 45) return res.status(400).json({ error: "La temperatura debe estar entre -5 y 45 °C" });
    }
    if (b.observaciones && String(b.observaciones).length > 150)
        return res.status(400).json({ error: "Las observaciones no pueden exceder 150 caracteres" });

    req.body = {
        id_bloque: Number(b.id_bloque),
        id_tarimas: tarimas,
        id_camara_destino: Number(b.id_camara_destino),
        fecha_movimiento: fecha,
        hora_movimiento: hora,
        temperatura: temp,
        observaciones: b.observaciones ? String(b.observaciones).trim() : null,
        // Para validarCamaraEnAlcance("body", "id_camara_destino")
        id_camara: Number(b.id_camara_destino)
    };
    next();
};
