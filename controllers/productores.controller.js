import productoresModel from "../models/productores.model.js";

// ============================================================================
// PRODUCTORES
// ============================================================================
// Catálogo sin alcance por cámara: un productor no pertenece a un preenfrío.
// El acceso lo limita el rol (coordinador+ para escribir), no la ubicación.
//
// v2.2: 'activo' pasó a llamarse 'estado' en toda la aplicación. Los valores
// son los mismos (1 activo · 0 dado de baja).
//
// La validación de formato vive en productores.middleware.js. Aquí solo
// queda lo que necesita consultar la BD: duplicados y dependencias.
// ============================================================================

// GET /api/preenfrio/productores?estado=1&buscar=texto
const getProductores = async (req, res) => {
    try {
        const { estado, buscar } = req.query;

        const productores = await productoresModel.getProductores({
            estado: estado !== undefined && estado !== "" ? Number(estado) : null,
            buscar: buscar || null
        });

        res.status(200).json(productores);
    } catch (error) {
        console.error("Error al obtener productores:", error);
        res.status(500).json({ error: "Error al obtener los productores" });
    }
};

// GET /api/preenfrio/productores/:id
const getProductorById = async (req, res) => {
    try {
        const { id } = req.params;
        const productor = await productoresModel.getProductorById(id);

        if (!productor) {
            return res.status(404).json({ error: "Productor no encontrado" });
        }

        res.status(200).json(productor);
    } catch (error) {
        console.error("Error al obtener productor:", error);
        res.status(500).json({ error: "Error al obtener el productor" });
    }
};

// POST /api/preenfrio/productores
const createProductor = async (req, res) => {
    try {
        const { codigo_productor } = req.body;

        // Se valida antes de insertar para dar un mensaje claro en vez de
        // dejar que reviente el índice UNIQUE.
        const duplicado = await productoresModel.existeCodigo(codigo_productor);
        if (duplicado) {
            return res.status(409).json({
                error: `El código "${codigo_productor}" ya está en uso por: ${duplicado.nombre}`
            });
        }

        const nuevo = await productoresModel.createProductor(req.body);
        res.status(201).json(nuevo);
    } catch (error) {
        console.error("Error al crear productor:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Ese código de productor ya existe"
            });
        }

        res.status(500).json({
            error: "Error al crear el productor" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/productores/:id
const updateProductor = async (req, res) => {
    try {
        const { id } = req.params;
        const { codigo_productor } = req.body;

        // Se excluye el propio id: guardar sin cambiar el código no debe
        // marcar conflicto consigo mismo.
        const duplicado = await productoresModel.existeCodigo(
            codigo_productor,
            Number(id)
        );
        if (duplicado) {
            return res.status(409).json({
                error: `El código "${codigo_productor}" ya está en uso por: ${duplicado.nombre}`
            });
        }

        const actualizado = await productoresModel.updateProductor(id, req.body);

        if (!actualizado) {
            return res.status(404).json({ error: "Productor no encontrado" });
        }

        res.status(200).json(actualizado);
    } catch (error) {
        console.error("Error al actualizar productor:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Ese código de productor ya existe"
            });
        }

        res.status(500).json({ error: "Error al actualizar el productor" });
    }
};

// DELETE /api/preenfrio/productores/:id
// Baja LÓGICA: nunca se borra la fila. fincas y produccion apuntan aquí y
// el histórico tiene que poder resolver su origen.
const bajaProductor = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await productoresModel.getProductorById(id);
        if (!existente) {
            return res.status(404).json({ error: "Productor no encontrado" });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "El productor ya está dado de baja"
            });
        }

        // Se informa qué queda colgando: el usuario merece saber que sus
        // fincas siguen ahí y que las producciones viejas no se tocan.
        const dependencias = await productoresModel.getDependencias(id);
        const productor = await productoresModel.bajaProductor(id);

        res.status(200).json({
            mensaje: "Productor dado de baja. El histórico se conserva.",
            productor,
            dependencias
        });
    } catch (error) {
        console.error("Error al dar de baja el productor:", error);
        res.status(500).json({ error: "Error al dar de baja el productor" });
    }
};

// PATCH /api/preenfrio/productores/:id/reactivar
const reactivarProductor = async (req, res) => {
    try {
        const { id } = req.params;
        const productor = await productoresModel.reactivarProductor(id);

        if (!productor) {
            return res.status(404).json({ error: "Productor no encontrado" });
        }

        res.status(200).json({
            mensaje: "Productor reactivado correctamente",
            productor
        });
    } catch (error) {
        console.error("Error al reactivar el productor:", error);
        res.status(500).json({ error: "Error al reactivar el productor" });
    }
};

export const productoresController = {
    getProductores,
    getProductorById,
    createProductor,
    updateProductor,
    bajaProductor,
    reactivarProductor
};
