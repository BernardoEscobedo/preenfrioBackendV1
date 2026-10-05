import transportesModel from "../models/transportes.model.js";

// ============================================================================
// TRANSPORTES
// ============================================================================
// Catálogo sin alcance por cámara: una unidad recoge en cualquier planta.
// El acceso lo limita el rol.
//
// UN TRANSPORTE = UN SERVICIO
//   Combinación de línea fletera + operador + tractocamión + caja
//   refrigerada, cada uno elegido de su catálogo. Este controller valida que
//   la combinación tenga sentido antes de guardarla:
//     · las cuatro piezas existen
//     · las cuatro están activas
//     · operador, tracto y caja no pertenecen a OTRA línea fletera
//       (si una pieza no tiene línea asignada, se acepta: es un operador o
//       una unidad independiente)
//
// LA INOCUIDAD YA NO SE REGISTRA AQUÍ
//   Se inspecciona en cada despacho (PATCH /despachos/:id/inocuidad). Una
//   caja aprobada ayer no está aprobada hoy: por eso dejó de ser un dato del
//   catálogo.
//
// UN SERVICIO CON DESPACHOS NO CAMBIA DE COMBINACIÓN
//   La BD lo impide (trg_proteger_transporte_asignado). Aquí se verifica
//   antes para responder un mensaje claro en vez del error crudo.
// ============================================================================

/**
 * Revisa que las cuatro piezas puedan formar un servicio.
 * Devuelve el texto del error, o null si todo cuadra.
 */
const validarPiezas = async (ids) => {
    const p = await transportesModel.getPiezas(ids);

    if (!p.id_linea_fletera) return "La línea fletera indicada no existe";
    if (!p.id_operador) return "El operador indicado no existe";
    if (!p.id_tractocamion) return "El tractocamión indicado no existe";
    if (!p.id_caja_refrigerada) return "La caja refrigerada indicada no existe";

    if (Number(p.estado_linea) !== 1) {
        return `La línea fletera "${p.razon_social}" está dada de baja`;
    }
    if (Number(p.estado_operador) !== 1) {
        return `El operador "${p.nombre_operador}" está dado de baja`;
    }
    if (Number(p.estado_tracto) !== 1) {
        return `El tractocamión ${p.placas_tracto} está dado de baja`;
    }
    if (Number(p.estado_caja) !== 1) {
        return `La caja ${p.placas_caja} está dada de baja`;
    }

    const linea = Number(p.id_linea_fletera);
    if (p.linea_operador !== null && Number(p.linea_operador) !== linea) {
        return `El operador "${p.nombre_operador}" pertenece a otra línea fletera`;
    }
    if (p.linea_tracto !== null && Number(p.linea_tracto) !== linea) {
        return `El tractocamión ${p.placas_tracto} pertenece a otra línea fletera`;
    }
    if (p.linea_caja !== null && Number(p.linea_caja) !== linea) {
        return `La caja ${p.placas_caja} pertenece a otra línea fletera`;
    }

    return null;
};

/** Extrae los cuatro IDs del body ya validado. */
const idsDelBody = (body) => ({
    id_linea_fletera: body.id_linea_fletera,
    id_operador: body.id_operador,
    id_tractocamion: body.id_tractocamion,
    id_caja_refrigerada: body.id_caja_refrigerada
});

/** ¿Cambió alguna de las cuatro piezas respecto al registro guardado? */
const cambiaCombinacion = (existente, ids) =>
    Object.entries(ids).some(
        ([campo, valor]) => Number(existente[campo]) !== Number(valor)
    );

// GET /api/preenfrio/transportes?estado=1&completos=1&buscar=texto
//   ?completos=1          solo servicios con sus cuatro catálogos activos
//                         (dropdown del despacho)
//   ?id_linea_fletera=3   servicios de una línea
const getTransportes = async (req, res) => {
    try {
        const { estado, id_linea_fletera, completos, buscar } = req.query;

        const transportes = await transportesModel.getTransportes({
            estado: estado !== undefined && estado !== "" ? Number(estado) : null,
            id_linea_fletera: id_linea_fletera ? Number(id_linea_fletera) : null,
            completos: completos === "1" || completos === "true",
            buscar: buscar || null
        });

        res.status(200).json(transportes);
    } catch (error) {
        console.error("Error al obtener transportes:", error);
        res.status(500).json({ error: "Error al obtener los transportes" });
    }
};

// GET /api/preenfrio/transportes/:id
const getTransporteById = async (req, res) => {
    try {
        const { id } = req.params;

        const transporte = await transportesModel.getTransporteById(id);

        if (!transporte) {
            return res.status(404).json({ error: "Transporte no encontrado" });
        }

        res.status(200).json(transporte);
    } catch (error) {
        console.error("Error al obtener transporte:", error);
        res.status(500).json({ error: "Error al obtener el transporte" });
    }
};

// POST /api/preenfrio/transportes
const createTransporte = async (req, res) => {
    try {
        const ids = idsDelBody(req.body);

        const errorPiezas = await validarPiezas(ids);
        if (errorPiezas) {
            return res.status(409).json({ error: errorPiezas });
        }

        // El mismo servicio completo no se registra dos veces.
        const duplicado = await transportesModel.existeCombinacion(ids);
        if (duplicado) {
            return res.status(409).json({
                error: Number(duplicado.estado) === 1
                    ? `Ese servicio ya está registrado (transporte #${duplicado.id_transporte}). Úsalo en el despacho.`
                    : `Ese servicio ya existe pero está dado de baja (transporte #${duplicado.id_transporte}). Reactívalo en vez de crear otro.`
            });
        }

        const nuevo = await transportesModel.createTransporte(req.body);

        res.status(201).json(nuevo);
    } catch (error) {
        console.error("Error al crear transporte:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "Alguna de las piezas indicadas no existe"
            });
        }

        res.status(500).json({
            error: "Error al crear el transporte" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/transportes/:id
const updateTransporte = async (req, res) => {
    try {
        const { id } = req.params;
        const ids = idsDelBody(req.body);

        const existente = await transportesModel.getTransporteById(id);

        if (!existente) {
            return res.status(404).json({ error: "Transporte no encontrado" });
        }

        const cambia = cambiaCombinacion(existente, ids);

        if (cambia) {
            // Un servicio que ya sacó fruta no puede convertirse en otra
            // combinación: la inspección de esos despachos quedaría ligada a
            // una caja distinta de la que realmente cargó.
            const dependencias = await transportesModel.getDependencias(id);
            if (Number(dependencias.despachos) > 0) {
                return res.status(409).json({
                    error: `Este transporte ya tiene ${dependencias.despachos} despacho(s): no se puede cambiar su línea, operador, tracto ni caja. Crea otro servicio y asígnalo al borrador.`
                });
            }

            const errorPiezas = await validarPiezas(ids);
            if (errorPiezas) {
                return res.status(409).json({ error: errorPiezas });
            }

            const duplicado = await transportesModel.existeCombinacion(ids, Number(id));
            if (duplicado) {
                return res.status(409).json({
                    error: `Esa combinación ya existe como transporte #${duplicado.id_transporte}`
                });
            }
        }

        const actualizado = await transportesModel.updateTransporte(id, req.body);

        if (!actualizado) {
            return res.status(409).json({
                error: "Alguna de las piezas indicadas no existe"
            });
        }

        res.status(200).json(actualizado);
    } catch (error) {
        console.error("Error al actualizar transporte:", error);

        // Respaldo por si dos personas editan a la vez: el trigger de la BD
        // es la última palabra.
        if (error.code === "P0001") {
            return res.status(409).json({ error: error.message });
        }

        res.status(500).json({ error: "Error al actualizar el transporte" });
    }
};

// DELETE /api/preenfrio/transportes/:id
// Baja LÓGICA: despachos.id_transporte apunta aquí y ante un reclamo hay
// que poder decir quién se llevó la fruta.
const bajaTransporte = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await transportesModel.getTransporteById(id);

        if (!existente) {
            return res.status(404).json({ error: "Transporte no encontrado" });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "El transporte ya está dado de baja"
            });
        }

        const dependencias = await transportesModel.getDependencias(id);
        const transporte = await transportesModel.bajaTransporte(id);

        res.status(200).json({
            mensaje: "Transporte dado de baja. El histórico de despachos se conserva.",
            transporte,
            dependencias
        });
    } catch (error) {
        console.error("Error al dar de baja el transporte:", error);
        res.status(500).json({ error: "Error al dar de baja el transporte" });
    }
};

// PATCH /api/preenfrio/transportes/:id/reactivar
// Solo si el servicio está completo y sus cuatro piezas siguen activas: un
// servicio reactivado con un operador dado de baja aparecería en el
// dropdown del despacho y no se podría inspeccionar.
const reactivarTransporte = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await transportesModel.getTransporteById(id);

        if (!existente) {
            return res.status(404).json({ error: "Transporte no encontrado" });
        }

        if (!existente.catalogos_completos) {
            return res.status(409).json({
                error: "Este transporte es un registro anterior sin sus cuatro catálogos. Vincúlalo con PUT o crea el servicio de nuevo."
            });
        }

        if (!existente.catalogos_activos) {
            return res.status(409).json({
                error: "Alguna de sus piezas (línea, operador, tracto o caja) está dada de baja. Reactívala primero o crea otro servicio."
            });
        }

        const transporte = await transportesModel.reactivarTransporte(id);

        res.status(200).json({
            mensaje: "Transporte reactivado correctamente",
            transporte
        });
    } catch (error) {
        console.error("Error al reactivar el transporte:", error);
        res.status(500).json({ error: "Error al reactivar el transporte" });
    }
};

export const transportesController = {
    getTransportes,
    getTransporteById,
    createTransporte,
    updateTransporte,
    bajaTransporte,
    reactivarTransporte
};
