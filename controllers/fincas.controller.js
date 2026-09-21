import fincasModel from "../models/fincas.model.js";
import productoresModel from "../models/productores.model.js";

// ============================================================================
// FINCAS
// ============================================================================
// Catálogo sin alcance por cámara: una finca es el ORIGEN de la fruta, no su
// destino. El recorte por planta empieza en producción y recepciones.
//
// El formato (zona válida, longitudes, normalización) lo resuelve
// fincas.middleware.js. Aquí queda lo que exige consultar la BD: que el
// productor exista y esté activo, y que el código no se repita dentro de él.
// ============================================================================

// GET /api/preenfrio/fincas?id_productor=1&zona=1&estado=1&buscar=texto
const getFincas = async (req, res) => {
    try {
        const { id_productor, zona, estado, buscar } = req.query;

        const fincas = await fincasModel.getFincas({
            id_productor: id_productor ? Number(id_productor) : null,
            zona: zona ? Number(zona) : null,
            estado: estado !== undefined && estado !== "" ? Number(estado) : null,
            buscar: buscar || null
        });

        res.status(200).json(fincas);
    } catch (error) {
        console.error("Error al obtener fincas:", error);
        res.status(500).json({ error: "Error al obtener las fincas" });
    }
};

// GET /api/preenfrio/fincas/:id
const getFincaById = async (req, res) => {
    try {
        const { id } = req.params;
        const finca = await fincasModel.getFincaById(id);

        if (!finca) {
            return res.status(404).json({ error: "Finca no encontrada" });
        }

        res.status(200).json(finca);
    } catch (error) {
        console.error("Error al obtener finca:", error);
        res.status(500).json({ error: "Error al obtener la finca" });
    }
};

// POST /api/preenfrio/fincas
const createFinca = async (req, res) => {
    try {
        const { codigo_finca, id_productor } = req.body;

        const productor = await productoresModel.getProductorById(id_productor);
        if (!productor) {
            return res.status(409).json({
                error: "El productor indicado no existe"
            });
        }

        // No se permite colgar fincas nuevas de un productor dado de baja:
        // sería crear operación sobre algo que ya se cerró.
        if (productor.activo === 0) {
            return res.status(409).json({
                error: `El productor "${productor.nombre}" está dado de baja. Reactívalo antes de darle fincas nuevas.`
            });
        }

        const duplicado = await fincasModel.existeCodigo(codigo_finca, id_productor);
        if (duplicado) {
            return res.status(409).json({
                error: `El productor "${productor.nombre}" ya tiene una finca con el código "${codigo_finca}": ${duplicado.nombre}`
            });
        }

        const nueva = await fincasModel.createFinca(req.body);

        // Se relee para devolver el productor resuelto y la zona_letra, que
        // es lo que la pantalla necesita para mostrar el prefijo del lote.
        const completa = await fincasModel.getFincaById(nueva.id_finca);

        res.status(201).json(completa);
    } catch (error) {
        console.error("Error al crear finca:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "El productor indicado no existe"
            });
        }

        res.status(500).json({
            error: "Error al crear la finca" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/fincas/:id
const updateFinca = async (req, res) => {
    try {
        const { id } = req.params;
        const { codigo_finca, id_productor } = req.body;

        const existente = await fincasModel.getFincaById(id);
        if (!existente) {
            return res.status(404).json({ error: "Finca no encontrada" });
        }

        // Al editar NO se exige que el productor esté activo: si se
        // bloqueara, no habría forma de corregir datos de fincas viejas.
        const productor = await productoresModel.getProductorById(id_productor);
        if (!productor) {
            return res.status(409).json({
                error: "El productor indicado no existe"
            });
        }

        // El duplicado se evalúa contra el productor FINAL, que puede ser
        // otro si se está reasignando la finca.
        const duplicado = await fincasModel.existeCodigo(
            codigo_finca,
            id_productor,
            Number(id)
        );
        if (duplicado) {
            return res.status(409).json({
                error: `Ese productor ya tiene una finca con el código "${codigo_finca}": ${duplicado.nombre}`
            });
        }

        await fincasModel.updateFinca(id, req.body);
        const completa = await fincasModel.getFincaById(id);

        res.status(200).json(completa);
    } catch (error) {
        console.error("Error al actualizar finca:", error);

        if (error.code === "23503") {
            return res.status(409).json({
                error: "El productor indicado no existe"
            });
        }

        res.status(500).json({ error: "Error al actualizar la finca" });
    }
};

// DELETE /api/preenfrio/fincas/:id
// Baja LÓGICA: produccion.id_finca sigue apuntando aquí.
const bajaFinca = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await fincasModel.getFincaById(id);
        if (!existente) {
            return res.status(404).json({ error: "Finca no encontrada" });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "La finca ya está dada de baja"
            });
        }

        const dependencias = await fincasModel.getDependencias(id);
        const finca = await fincasModel.bajaFinca(id);

        res.status(200).json({
            mensaje: "Finca dada de baja. El histórico de producción se conserva.",
            finca,
            dependencias
        });
    } catch (error) {
        console.error("Error al dar de baja la finca:", error);
        res.status(500).json({ error: "Error al dar de baja la finca" });
    }
};

// PATCH /api/preenfrio/fincas/:id/reactivar
const reactivarFinca = async (req, res) => {
    try {
        const { id } = req.params;
        const finca = await fincasModel.reactivarFinca(id);

        if (!finca) {
            return res.status(404).json({ error: "Finca no encontrada" });
        }

        res.status(200).json({
            mensaje: "Finca reactivada correctamente",
            finca
        });
    } catch (error) {
        console.error("Error al reactivar la finca:", error);
        res.status(500).json({ error: "Error al reactivar la finca" });
    }
};

export const fincasController = {
    getFincas,
    getFincaById,
    createFinca,
    updateFinca,
    bajaFinca,
    reactivarFinca
};
