import operadoresModel from "../models/operadores.model.js";
import lineasFleterasModel from "../models/lineasFleteras.model.js";

// ============================================================================
// OPERADORES
// ============================================================================
// Catálogo sin alcance por cámara. El acceso lo limita el rol.
//
// ⚠️ CAMBIAR DE LÍNEA
//   Si el operador ya forma parte de algún transporte, no se le cambia la
//   línea fletera: ese servicio quedaría con un operador de otra empresa.
//   Se crea un servicio nuevo con la línea correcta.
// ============================================================================

/**
 * Revisa que la línea indicada exista y esté activa.
 * Devuelve el texto del error, o null si no hay línea o todo cuadra.
 */
const validarLinea = async (id_linea_fletera) => {
    if (id_linea_fletera === null) return null;

    const linea = await lineasFleterasModel.getLineaById(id_linea_fletera);

    if (!linea) return "La línea fletera indicada no existe";
    if (linea.estado === 0) {
        return `La línea fletera "${linea.razon_social}" está dada de baja`;
    }
    return null;
};

// GET /api/preenfrio/operadores?estado=1&id_linea_fletera=3&buscar=texto
const getOperadores = async (req, res) => {
    try {
        const { estado, id_linea_fletera, buscar } = req.query;

        const operadores = await operadoresModel.getOperadores({
            estado: estado !== undefined && estado !== "" ? Number(estado) : null,
            id_linea_fletera: id_linea_fletera ? Number(id_linea_fletera) : null,
            buscar: buscar || null
        });

        res.status(200).json(operadores);
    } catch (error) {
        console.error("Error al obtener operadores:", error);
        res.status(500).json({ error: "Error al obtener los operadores" });
    }
};

// GET /api/preenfrio/operadores/:id
const getOperadorById = async (req, res) => {
    try {
        const { id } = req.params;

        const operador = await operadoresModel.getOperadorById(id);

        if (!operador) {
            return res.status(404).json({ error: "Operador no encontrado" });
        }

        res.status(200).json(operador);
    } catch (error) {
        console.error("Error al obtener el operador:", error);
        res.status(500).json({ error: "Error al obtener el operador" });
    }
};

// POST /api/preenfrio/operadores
const createOperador = async (req, res) => {
    try {
        const { id_linea_fletera, celular } = req.body;

        const errorLinea = await validarLinea(id_linea_fletera);
        if (errorLinea) {
            return res.status(409).json({ error: errorLinea });
        }

        const duplicado = await operadoresModel.existeCelular(celular);
        if (duplicado) {
            return res.status(409).json({
                error: Number(duplicado.estado) === 1
                    ? `Ese celular ya pertenece al operador ${duplicado.nombre}`
                    : `Ese celular pertenece a ${duplicado.nombre}, dado de baja. Reactívalo en vez de crear otro.`
            });
        }

        const nuevo = await operadoresModel.createOperador(req.body);

        res.status(201).json(nuevo);
    } catch (error) {
        console.error("Error al crear el operador:", error);

        if (error.code === "23503") {
            return res.status(409).json({ error: "La línea fletera indicada no existe" });
        }

        res.status(500).json({
            error: "Error al crear el operador" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/operadores/:id
const updateOperador = async (req, res) => {
    try {
        const { id } = req.params;
        const { id_linea_fletera, nombre, celular } = req.body;

        const existente = await operadoresModel.getOperadorById(id);

        if (!existente) {
            return res.status(404).json({ error: "Operador no encontrado" });
        }

        const dependencias = await operadoresModel.getDependencias(id);

        const cambiaLinea =
            (existente.id_linea_fletera ?? null) !== (id_linea_fletera ?? null);

        if (cambiaLinea && Number(dependencias.transportes) > 0) {
            return res.status(409).json({
                error: `Este operador ya forma parte de ${dependencias.transportes} transporte(s): no se le puede cambiar la línea fletera. Crea un servicio nuevo con la línea correcta.`
            });
        }

        if (cambiaLinea) {
            const errorLinea = await validarLinea(id_linea_fletera);
            if (errorLinea) {
                return res.status(409).json({ error: errorLinea });
            }
        }

        const duplicado = await operadoresModel.existeCelular(celular, Number(id));
        if (duplicado) {
            return res.status(409).json({
                error: `Ese celular ya pertenece al operador ${duplicado.nombre}`
            });
        }

        const actualizado = await operadoresModel.updateOperador(id, req.body);

        // vw_despachos lee nombre y celular en vivo: la corrección también
        // se ve en los despachos ya registrados.
        const cambioVisible =
            existente.nombre !== nombre || existente.celular !== celular;

        res.status(200).json({
            ...actualizado,
            aviso: cambioVisible && Number(dependencias.despachos) > 0
                ? `La corrección también se verá en ${dependencias.despachos} despacho(s) ya registrados con este operador.`
                : null
        });
    } catch (error) {
        console.error("Error al actualizar el operador:", error);
        res.status(500).json({ error: "Error al actualizar el operador" });
    }
};

// DELETE /api/preenfrio/operadores/:id
// Baja LÓGICA: los transportes y despachos históricos siguen apuntando aquí.
const bajaOperador = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await operadoresModel.getOperadorById(id);

        if (!existente) {
            return res.status(404).json({ error: "Operador no encontrado" });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "El operador ya está dado de baja"
            });
        }

        const dependencias = await operadoresModel.getDependencias(id);
        const operador = await operadoresModel.bajaOperador(id);

        res.status(200).json({
            mensaje: "Operador dado de baja. Sus transportes ya no podrán usarse en despachos nuevos; el histórico se conserva.",
            operador,
            dependencias
        });
    } catch (error) {
        console.error("Error al dar de baja el operador:", error);
        res.status(500).json({ error: "Error al dar de baja el operador" });
    }
};

// PATCH /api/preenfrio/operadores/:id/reactivar
const reactivarOperador = async (req, res) => {
    try {
        const { id } = req.params;

        const operador = await operadoresModel.reactivarOperador(id);

        if (!operador) {
            return res.status(404).json({ error: "Operador no encontrado" });
        }

        res.status(200).json({
            mensaje: "Operador reactivado correctamente",
            operador
        });
    } catch (error) {
        console.error("Error al reactivar el operador:", error);
        res.status(500).json({ error: "Error al reactivar el operador" });
    }
};

export const operadoresController = {
    getOperadores,
    getOperadorById,
    createOperador,
    updateOperador,
    bajaOperador,
    reactivarOperador
};
