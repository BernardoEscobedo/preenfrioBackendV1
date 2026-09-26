import { aFechaISO, esFechaFutura } from "../utils/fechas.js";

// ============================================================================
// VALIDACIONES DE RECEPCIONES
// ============================================================================
// Aquí se valida el FORMATO de lo que llegó al andén. Lo que exige consultar
// la BD (que la producción exista, que la cámara tenga espacio, que no se
// reciba más de lo planeado) vive en el controller.
//
// POR QUÉ LAS CANTIDADES SE VALIDAN CON TANTO CUIDADO
//   Un INSERT en recepciones dispara los triggers de inventario. Un número
//   mal capturado no genera un error visible: genera una ocupación de
//   cámara equivocada que nadie nota hasta que el conteo físico no cuadra,
//   semanas después. Es más barato rechazar aquí.
//
// CORRECCIONES DE LA AUDITORÍA
//   · "Fecha futura" se evalúa en la zona de operación y comparando texto.
//     Antes new Date("AAAA-MM-DD") se tomaba como medianoche UTC y, en
//     Tapachula, la fecha de MAÑANA pasaba la validación.
//   · Cajas y tarimas exigen enteros: con 2.5 Postgres rechazaba el valor en
//     la columna INT y se respondía 500 en vez de 400.
// ============================================================================

/** true si el valor es un entero >= 0 */
const esEnteroNoNegativo = (n) => Number.isInteger(n) && n >= 0;

export const validarRecepcion = (req, res, next) => {
    const {
        id_produccion,
        id_camara,
        fecha_recepcion,
        hora_recepcion,
        cajas_recibidas,
        tarimas_recibidas,
        tarimas_ingresadas,
        cajas_ingresadas,
        temperatura,
        observaciones
    } = req.body;

    // ---- Producción ----
    if (!id_produccion || isNaN(Number(id_produccion))) {
        return res.status(400).json({
            error: 'El campo "id_produccion" es obligatorio y debe ser numérico'
        });
    }

    // ---- Cámara ----
    // NULL es válido: la producción va directo a CEDA sin pasar por
    // preenfrío. En ese caso el trigger no genera ocupación alguna.
    let camaraNum = null;

    if (id_camara !== undefined && id_camara !== null && id_camara !== "") {
        if (isNaN(Number(id_camara))) {
            return res.status(400).json({
                error: 'El campo "id_camara" debe ser numérico o nulo (nulo = no pasa por preenfrío)'
            });
        }
        camaraNum = Number(id_camara);
    }

    // ---- Fecha ----
    if (!fecha_recepcion) {
        return res.status(400).json({
            error: 'El campo "fecha_recepcion" es obligatorio'
        });
    }

    const fecha = aFechaISO(fecha_recepcion);

    if (!fecha) {
        return res.status(400).json({
            error: 'El campo "fecha_recepcion" no es una fecha válida (usa AAAA-MM-DD)'
        });
    }

    // Recibir "mañana" es siempre un error de captura.
    if (esFechaFutura(fecha)) {
        return res.status(400).json({
            error: "La fecha de recepción no puede ser futura"
        });
    }

    // ---- Hora ----
    if (!hora_recepcion) {
        return res.status(400).json({
            error: 'El campo "hora_recepcion" es obligatorio (formato HH:MM)'
        });
    }

    if (!/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/.test(String(hora_recepcion))) {
        return res.status(400).json({
            error: 'El campo "hora_recepcion" debe tener formato HH:MM o HH:MM:SS'
        });
    }

    // ---- Cantidades recibidas ----
    const cajas = cajas_recibidas === undefined || cajas_recibidas === null
        ? 0
        : Number(cajas_recibidas);

    if (!esEnteroNoNegativo(cajas)) {
        return res.status(400).json({
            error: 'El campo "cajas_recibidas" debe ser un número entero mayor o igual a 0'
        });
    }

    const tarimas = tarimas_recibidas === undefined || tarimas_recibidas === null
        ? 0
        : Number(tarimas_recibidas);

    if (!esEnteroNoNegativo(tarimas)) {
        return res.status(400).json({
            error: 'El campo "tarimas_recibidas" debe ser un número entero mayor o igual a 0'
        });
    }

    // Una recepción sin nada que recibir no tiene sentido y además dejaría
    // la producción en estado "en recepción" sin haber recibido nada.
    if (tarimas === 0 && cajas === 0) {
        return res.status(400).json({
            error: "La recepción debe traer al menos una tarima o una caja"
        });
    }

    // Coherencia cajas ↔ tarimas. Mismo criterio que producción: la regla
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

    // ---- Tarimas ingresadas ----
    // NULL significa "que el trigger calcule lo que quepa". Con valor,
    // significa "el operador vio el patio y confirmó cuántas metió".
    let ingresadasNum = null;

    if (
        tarimas_ingresadas !== undefined &&
        tarimas_ingresadas !== null &&
        tarimas_ingresadas !== ""
    ) {
        ingresadasNum = Number(tarimas_ingresadas);

        if (!esEnteroNoNegativo(ingresadasNum)) {
            return res.status(400).json({
                error: 'El campo "tarimas_ingresadas" debe ser un número entero mayor o igual a 0'
            });
        }

        // No se puede meter a la cámara más de lo que llegó al andén.
        if (ingresadasNum > tarimas) {
            return res.status(400).json({
                error: `No puedes ingresar ${ingresadasNum} tarimas si solo llegaron ${tarimas}`
            });
        }
    }

    // ---- Cajas ingresadas ----
    // Nota: desde la v2.5 el trigger reparte las cajas en proporción a las
    // tarimas que entran y escribe el resultado de vuelta, así que este
    // valor se valida pero no manda. Se conserva para no romper el contrato
    // con el frontend.
    let cajasIngNum = null;

    if (
        cajas_ingresadas !== undefined &&
        cajas_ingresadas !== null &&
        cajas_ingresadas !== ""
    ) {
        cajasIngNum = Number(cajas_ingresadas);

        if (!esEnteroNoNegativo(cajasIngNum)) {
            return res.status(400).json({
                error: 'El campo "cajas_ingresadas" debe ser un número entero mayor o igual a 0'
            });
        }

        if (cajasIngNum > cajas) {
            return res.status(400).json({
                error: `No puedes ingresar ${cajasIngNum} cajas si solo llegaron ${cajas}`
            });
        }
    }

    // ---- Temperatura ----
    // NUMERIC(5,2) en la BD. El rango se acota a lo físicamente posible en
    // fruta: por debajo de -5 °C ya hay daño por congelación y por encima
    // de 45 °C el dato es un error de captura o un termómetro descompuesto.
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
    req.body.id_produccion = Number(id_produccion);
    req.body.id_camara = camaraNum;
    req.body.fecha_recepcion = fecha;
    req.body.cajas_recibidas = cajas;
    req.body.tarimas_recibidas = tarimas;
    req.body.tarimas_ingresadas = ingresadasNum;
    req.body.cajas_ingresadas = cajasIngNum;
    req.body.temperatura = tempNum;
    req.body.observaciones = observaciones ? String(observaciones).trim() : null;

    next();
};

// ----------------------------------------------------------------------------
// Validación de la edición
// ----------------------------------------------------------------------------
// Solo temperatura y observaciones. Las cantidades NO se editan: el trigger
// de reversa (v2.5) reacciona al cambio de ESTADO, no a un cambio de
// cantidades. Un UPDATE de tarimas movería el número en la tabla sin tocar
// la ocupación. Si el número estuvo mal, se cancela y se captura de nuevo.
export const validarEdicionRecepcion = (req, res, next) => {
    const { temperatura, observaciones } = req.body;

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

    req.body.temperatura = tempNum;
    req.body.observaciones = observaciones ? String(observaciones).trim() : null;

    next();
};

export const validarIdRecepcion = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de recepción debe ser un número válido"
        });
    }

    next();
};
