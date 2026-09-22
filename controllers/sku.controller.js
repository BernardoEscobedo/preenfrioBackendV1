import skuModel from "../models/sku.model.js";

// ============================================================================
// SKU DE PRODUCTO TERMINADO
// ============================================================================
// Catálogo sin alcance por cámara: el SKU describe el producto, no dónde
// está. El acceso lo limita el rol.
//
// v2.2 · LA BAJA AHORA ES LÓGICA
//   DELETE /sku/:id ya no borra: marca estado = 0, igual que productores y
//   fincas. Es lo que se usa para descontinuar un empaque.
//
//   El borrado físico se movió a su propio endpoint (/sku/:id/eliminar) y
//   queda reservado a un caso puntual: el alta mal capturada que nunca
//   llegó a usarse. Separarlos evita que una acción irreversible se
//   dispare desde el mismo botón que la reversible.
// ============================================================================

// GET /api/preenfrio/sku?estado=1&turno=1&calidad=PRIMERA&buscar=texto
const getSkus = async (req, res) => {
    try {
        const { estado, turno, calidad, buscar } = req.query;

        const skus = await skuModel.getSkus({
            estado: estado !== undefined && estado !== "" ? Number(estado) : null,
            turno: turno ? Number(turno) : null,
            calidad: calidad || null,
            buscar: buscar || null
        });

        res.status(200).json(skus);
    } catch (error) {
        console.error("Error al obtener SKU:", error);
        res.status(500).json({ error: "Error al obtener los SKU" });
    }
};

// GET /api/preenfrio/sku/:id
const getSkuById = async (req, res) => {
    try {
        const { id } = req.params;
        const sku = await skuModel.getSkuById(id);

        if (!sku) {
            return res.status(404).json({ error: "SKU no encontrado" });
        }

        res.status(200).json(sku);
    } catch (error) {
        console.error("Error al obtener SKU:", error);
        res.status(500).json({ error: "Error al obtener el SKU" });
    }
};

// POST /api/preenfrio/sku
const createSku = async (req, res) => {
    try {
        const { codigo_sku, calidad } = req.body;

        // El duplicado se mide por código + calidad: el mismo empaque en
        // PRIMERA y en SEGUNDA son dos SKU legítimos.
        const duplicado = await skuModel.existeSku(codigo_sku, calidad);
        if (duplicado) {
            return res.status(409).json({
                error: `Ya existe el SKU "${codigo_sku}" con calidad "${calidad}"`
            });
        }

        const nuevo = await skuModel.createSku(req.body);

        // Se relee para devolver cajas_por_tarima, que es campo calculado
        const completo = await skuModel.getSkuById(nuevo.id_sku);

        res.status(201).json(completo);
    } catch (error) {
        console.error("Error al crear SKU:", error);

        // v2.2: la BD ya tiene el índice único
        if (error.code === "23505") {
            return res.status(409).json({
                error: "Ya existe un SKU con ese código y calidad"
            });
        }

        // v2.2: CHECK sobre turno
        if (error.code === "23514") {
            return res.status(400).json({
                error: "Datos inválidos: el turno debe ser 1 o 2"
            });
        }

        res.status(500).json({
            error: "Error al crear el SKU" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/sku/:id
const updateSku = async (req, res) => {
    try {
        const { id } = req.params;
        const { codigo_sku, calidad } = req.body;

        const existente = await skuModel.getSkuById(id);
        if (!existente) {
            return res.status(404).json({ error: "SKU no encontrado" });
        }

        const duplicado = await skuModel.existeSku(codigo_sku, calidad, Number(id));
        if (duplicado) {
            return res.status(409).json({
                error: `Ya existe otro SKU "${codigo_sku}" con calidad "${calidad}"`
            });
        }

        await skuModel.updateSku(id, req.body);
        const completo = await skuModel.getSkuById(id);

        res.status(200).json(completo);
    } catch (error) {
        console.error("Error al actualizar SKU:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Ya existe un SKU con ese código y calidad"
            });
        }

        if (error.code === "23514") {
            return res.status(400).json({
                error: "Datos inválidos: el turno debe ser 1 o 2"
            });
        }

        res.status(500).json({ error: "Error al actualizar el SKU" });
    }
};

// DELETE /api/preenfrio/sku/:id
// Baja LÓGICA (v2.2). Es la vía normal para descontinuar un empaque.
const bajaSku = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await skuModel.getSkuById(id);
        if (!existente) {
            return res.status(404).json({ error: "SKU no encontrado" });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "El SKU ya está dado de baja"
            });
        }

        const dependencias = await skuModel.getDependencias(id);
        const sku = await skuModel.bajaSku(id);

        res.status(200).json({
            mensaje: "SKU dado de baja. El histórico de producción se conserva.",
            sku,
            dependencias
        });
    } catch (error) {
        console.error("Error al dar de baja el SKU:", error);
        res.status(500).json({ error: "Error al dar de baja el SKU" });
    }
};

// PATCH /api/preenfrio/sku/:id/reactivar
const reactivarSku = async (req, res) => {
    try {
        const { id } = req.params;
        const sku = await skuModel.reactivarSku(id);

        if (!sku) {
            return res.status(404).json({ error: "SKU no encontrado" });
        }

        res.status(200).json({
            mensaje: "SKU reactivado correctamente",
            sku
        });
    } catch (error) {
        console.error("Error al reactivar el SKU:", error);
        res.status(500).json({ error: "Error al reactivar el SKU" });
    }
};

// DELETE /api/preenfrio/sku/:id/eliminar
// Borrado FÍSICO e irreversible. Solo para corregir un alta mal capturada
// que nunca se usó: si alguna producción lo referencia, se rechaza.
//
// Va en un endpoint aparte del /sku/:id para que la acción destructiva no
// comparta botón con la baja lógica.
const deleteSku = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await skuModel.getSkuById(id);
        if (!existente) {
            return res.status(404).json({ error: "SKU no encontrado" });
        }

        const dependencias = await skuModel.getDependencias(id);

        if (Number(dependencias.producciones) > 0) {
            return res.status(409).json({
                error: `No se puede eliminar: ${dependencias.producciones} producción(es) usan este SKU. Dalo de baja en lugar de borrarlo.`
            });
        }

        const eliminado = await skuModel.deleteSku(id);

        res.status(200).json({
            mensaje: "SKU eliminado definitivamente",
            sku: eliminado
        });
    } catch (error) {
        console.error("Error al eliminar SKU:", error);

        // Red de seguridad por si algo se insertó entre la verificación y
        // el borrado.
        if (error.code === "23503") {
            return res.status(409).json({
                error: "No se puede eliminar: el SKU tiene producciones asociadas"
            });
        }

        res.status(500).json({ error: "Error al eliminar el SKU" });
    }
};

export const skuController = {
    getSkus,
    getSkuById,
    createSku,
    updateSku,
    bajaSku,
    reactivarSku,
    deleteSku
};
