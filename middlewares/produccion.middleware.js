import { aFechaISO, semanaISO } from "../utils/fechas.js";

// ============================================================================
// VALIDACIONES DE PRODUCCIÓN
// ============================================================================
// Aquí se valida el FORMATO de la línea del plan. Lo que exige consultar la
// BD (que la finca exista, que el productor cuadre con la finca, que la
// cámara esté dentro del alcance) vive en el controller y en
// alcance.middleware.js.
//
// POR QUÉ SE VALIDA LA SEMANA CONTRA LA FECHA
//   El código de lote lleva semana y fecha de empaque como campos
//   independientes. Si no cuadran entre sí, el lote queda inconsistente:
//   dice "semana 38" pero la fecha cae en la 37. Como la fruta del sábado
//   de una semana sale del preenfrío en la siguiente, la diferencia de una
//   semana es legítima y se permite; más que eso es error de captura.
//
// POR QUÉ NO SE VALIDA 'estado'
//   No entra por el body. Lo mantiene el trigger de la BD según lo recibido
//   y la cancelación tiene su propio endpoint.
//
// CORRECCIONES DE LA AUDITORÍA
//   · semanaISO vive ahora en utils/fechas.js y trabaja todo en UTC. La
//     versión anterior mezclaba hora local con una fecha parseada en UTC y
//     los lunes calculaba la semana anterior.
//   · Las fechas se comparan como texto 'AAAA-MM-DD', no como Date.
//   · Cajas, tarimas y tránsito exigen enteros: con 2.5, Postgres rechazaba
//     el valor en la columna INT y se respondía 500 en vez de 400.
//   · En el PUT, los campos opcionales ya llegan con su valor actual gracias
//     a conservarCampos (ver produccion.route.js). Los defaults de aquí solo
//     aplican de verdad en el alta.
// ============================================================================

/** true si el valor es un entero >= 0 */
const esEnteroNoNegativo = (n) => Number.isInteger(n) && n >= 0;

export const validarProduccion = (req, res, next) => {
    const {
        semana,
        region,
        id_finca,
        id_productor,
        fecha_empaque,
        transito,
        fecha_entrega,
        id_cc,
        id_sku,
        cajas_procesadas,
        estiba_pallets,
        comentarios,
        id_camara
    } = req.body;

    // ---- Semana ----
    // Va al código de lote con LPAD a 2 dígitos, así que 53 es el tope real.
    if (!semana || isNaN(Number(semana))) {
        return res.status(400).json({
            error: 'El campo "semana" es obligatorio y debe ser numérico'
        });
    }

    const semanaNum = Number(semana);

    if (!Number.isInteger(semanaNum) || semanaNum < 1 || semanaNum > 53) {
        return res.status(400).json({
            error: 'El campo "semana" debe ser un entero entre 1 y 53'
        });
    }

    // ---- Fecha de empaque ----
    // Es la que rige la antigüedad en la cola de preenfrío: la fruta más
    // vieja entra y sale primero. Un error aquí altera todo el orden.
    if (!fecha_empaque) {
        return res.status(400).json({
            error: 'El campo "fecha_empaque" es obligatorio'
        });
    }

    const fechaEmpaque = aFechaISO(fecha_empaque);

    if (!fechaEmpaque) {
        return res.status(400).json({
            error: 'El campo "fecha_empaque" no es una fecha válida (usa AAAA-MM-DD)'
        });
    }

    // Coherencia semana ↔ fecha. Se permite 1 de diferencia porque la fruta
    // empacada en sábado suele planearse contra la semana siguiente.
    const semanaCalculada = semanaISO(fechaEmpaque);
    const diferencia = Math.abs(semanaCalculada - semanaNum);

    // El 51 cubre el salto de fin de año (semana 52 o 53 contra semana 1)
    if (diferencia > 1 && diferencia < 51) {
        return res.status(400).json({
            error: `La semana ${semanaNum} no corresponde a la fecha de empaque ${fechaEmpaque} (es semana ${semanaCalculada}). Revisa cuál de los dos está mal: ambos forman parte del código de lote.`
        });
    }

    // ---- Catálogos obligatorios ----
    const catalogos = [
        ["id_finca", id_finca],
        ["id_productor", id_productor],
        ["id_cc", id_cc],
        ["id_sku", id_sku]
    ];

    for (const [campo, valor] of catalogos) {
        if (!valor || isNaN(Number(valor))) {
            return res.status(400).json({
                error: `El campo "${campo}" es obligatorio y debe ser numérico`
            });
        }
    }

    // ---- Cámara ----
    // NULL es un valor VÁLIDO: significa que va directo a CEDA sin pasar
    // por preenfrío. Por eso se acepta ausente o explícitamente nulo.
    let camaraNum = null;

    if (id_camara !== undefined && id_camara !== null && id_camara !== "") {
        if (isNaN(Number(id_camara))) {
            return res.status(400).json({
                error: 'El campo "id_camara" debe ser numérico o nulo (nulo = va directo a CEDA)'
            });
        }
        camaraNum = Number(id_camara);
    }

    // ---- Cantidades ----
    const cajas = cajas_procesadas === undefined || cajas_procesadas === null
        ? 0
        : Number(cajas_procesadas);

    if (!esEnteroNoNegativo(cajas)) {
        return res.status(400).json({
            error: 'El campo "cajas_procesadas" debe ser un número entero mayor o igual a 0'
        });
    }

    const tarimas = estiba_pallets === undefined || estiba_pallets === null
        ? 0
        : Number(estiba_pallets);

    if (!esEnteroNoNegativo(tarimas)) {
        return res.status(400).json({
            error: 'El campo "estiba_pallets" debe ser un número entero mayor o igual a 0'
        });
    }

    // Coherencia cajas ↔ tarimas.
    // La regla es 48 cajas por tarima (42 en la familia CPL0813). No se
    // valida contra el SKU exacto porque eso exigiría consultar la BD; se
    // usa 48 como tope teórico y solo se rechaza lo absurdo: declarar más
    // tarimas que cajas, o tantas cajas que no cabrían en esas tarimas ni
    // apretándolas.
    if (tarimas > 0 && cajas > 0) {
        if (tarimas > cajas) {
            return res.status(400).json({
                error: `Revisa las cantidades: ${tarimas} tarimas con solo ${cajas} cajas no es posible`
            });
        }

        // Margen amplio (60 por tarima) para no estorbar en casos reales de
        // estiba especial. Lo que atrapa es el error de dedo del tipo
        // "1 tarima, 4800 cajas".
        if (cajas > tarimas * 60) {
            return res.status(400).json({
                error: `Revisa las cantidades: ${cajas} cajas no caben en ${tarimas} tarimas (máximo ~48 por tarima)`
            });
        }
    }

    // ---- Tránsito ----
    // Días de camino al CEDIS. Opcional: no todos los destinos lo traen.
    let transitoNum = null;

    if (transito !== undefined && transito !== null && transito !== "") {
        transitoNum = Number(transito);

        if (!esEnteroNoNegativo(transitoNum)) {
            return res.status(400).json({
                error: 'El campo "transito" debe ser un número entero de días mayor o igual a 0'
            });
        }

        if (transitoNum > 30) {
            return res.status(400).json({
                error: 'El campo "transito" supera los 30 días: revisa el dato'
            });
        }
    }

    // ---- Fecha de entrega ----
    // Se hereda como fecha de cita en el despacho. Opcional al planear,
    // porque a veces la cita se consigue después.
    let fechaEntregaNorm = null;

    if (fecha_entrega) {
        fechaEntregaNorm = aFechaISO(fecha_entrega);

        if (!fechaEntregaNorm) {
            return res.status(400).json({
                error: 'El campo "fecha_entrega" no es una fecha válida (usa AAAA-MM-DD)'
            });
        }

        // Entregar antes de empacar es imposible: es un error de captura.
        // La comparación es de texto: 'AAAA-MM-DD' ordena igual que la fecha.
        if (fechaEntregaNorm < fechaEmpaque) {
            return res.status(400).json({
                error: "La fecha de entrega no puede ser anterior a la fecha de empaque"
            });
        }
    }

    // ---- Campos de texto ----
    if (region && String(region).length > 60) {
        return res.status(400).json({
            error: 'El campo "region" no puede exceder 60 caracteres'
        });
    }

    if (comentarios && String(comentarios).length > 250) {
        return res.status(400).json({
            error: 'El campo "comentarios" no puede exceder 250 caracteres'
        });
    }

    // ---- Normalización ----
    req.body.semana = semanaNum;
    req.body.fecha_empaque = fechaEmpaque;
    req.body.region = region ? String(region).trim().toUpperCase() : null;
    req.body.id_finca = Number(id_finca);
    req.body.id_productor = Number(id_productor);
    req.body.id_cc = Number(id_cc);
    req.body.id_sku = Number(id_sku);
    req.body.id_camara = camaraNum;
    req.body.cajas_procesadas = cajas;
    req.body.estiba_pallets = tarimas;
    req.body.transito = transitoNum;
    req.body.fecha_entrega = fechaEntregaNorm;
    req.body.comentarios = comentarios ? String(comentarios).trim() : null;

    next();
};

// ----------------------------------------------------------------------------
// Validación de la reasignación de cámara
// ----------------------------------------------------------------------------
// Solo mira id_camara. Acepta null explícito para sacar una producción del
// preenfrío y mandarla directo a CEDA.
export const validarReasignacion = (req, res, next) => {
    const { id_camara } = req.body;

    // undefined es distinto de null: el primero significa "olvidaste
    // mandar el campo", el segundo "quítale la cámara a propósito".
    if (id_camara === undefined) {
        return res.status(400).json({
            error: 'El campo "id_camara" es obligatorio (usa null para marcar que va directo a CEDA)'
        });
    }

    if (id_camara === null || id_camara === "") {
        req.body.id_camara = null;
        return next();
    }

    if (isNaN(Number(id_camara))) {
        return res.status(400).json({
            error: 'El campo "id_camara" debe ser numérico o null'
        });
    }

    req.body.id_camara = Number(id_camara);

    next();
};

export const validarIdProduccion = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de producción debe ser un número válido"
        });
    }

    next();
};
