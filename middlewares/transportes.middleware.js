// ============================================================================
// VALIDACIONES DE TRANSPORTES
// ============================================================================
// Desde la etapa 1 de catálogos, un transporte ya NO se captura con texto
// libre (razón social, operador, celular, placas): se arma eligiendo una
// pieza de cada catálogo. Por eso aquí solo se validan los cuatro IDs y el
// estado.
//
// Las reglas de formato que antes vivían aquí se movieron a cada catálogo:
//   · placas normalizadas sin guiones ni espacios → tractocamiones / cajas
//   · celular de 10 dígitos                       → operadores
//   · razón social                                → lineas_fleteras
//
// Lo que exige consultar la BD —que las piezas existan, estén activas y
// pertenezcan a la misma línea— vive en el controller.
//
// ⚠️ YA NO SE VALIDA 'inocuidad'
//   Antes, si no venía, se asumía 1 (aprobada). Ahora la inspección es por
//   despacho (despachos.middleware.js → validarInocuidadDespacho) y nunca se
//   aprueba por omisión.
// ============================================================================

const IDS_PIEZAS = [
    ["id_linea_fletera", "la línea fletera"],
    ["id_operador", "el operador"],
    ["id_tractocamion", "el tractocamión"],
    ["id_caja_refrigerada", "la caja refrigerada"]
];

export const validarTransporte = (req, res, next) => {
    const { estado } = req.body;

    // ---- Las cuatro piezas del servicio ----
    for (const [campo, descripcion] of IDS_PIEZAS) {
        const valor = req.body[campo];

        if (valor === undefined || valor === null || valor === "") {
            return res.status(400).json({
                error: `El campo "${campo}" es obligatorio: selecciona ${descripcion} del catálogo`
            });
        }

        const numero = Number(valor);
        if (!Number.isInteger(numero) || numero <= 0) {
            return res.status(400).json({
                error: `El campo "${campo}" debe ser un número entero válido`
            });
        }

        req.body[campo] = numero;
    }

    // ---- Estado ----
    const estadoNum = estado === undefined || estado === null ? 1 : Number(estado);
    if (![0, 1].includes(estadoNum)) {
        return res.status(400).json({
            error: 'El campo "estado" debe ser 1 (activo) o 0 (dado de baja)'
        });
    }

    req.body.estado = estadoNum;

    // Los campos de texto del esquema anterior ya no se aceptan desde la
    // API: el model los copia de los catálogos. Se descartan para que nadie
    // crea que capturarlos aquí tiene efecto.
    delete req.body.razon_social;
    delete req.body.nombre_operador;
    delete req.body.celular;
    delete req.body.placas_tracto;
    delete req.body.placas_caja;
    delete req.body.no_economico_caja;
    delete req.body.inocuidad;

    next();
};

export const validarIdTransporte = (req, res, next) => {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
        return res.status(400).json({
            error: "El id de transporte debe ser un número válido"
        });
    }

    next();
};
