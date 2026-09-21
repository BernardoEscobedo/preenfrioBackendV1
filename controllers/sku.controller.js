import skuModel from "../models/sku.model.js";

// ============================================================================
// SKU DE PRODUCTO TERMINADO
// ============================================================================
// Catálogo sin alcance por cámara: el SKU describe el producto, no dónde
// está. El acceso lo limita el rol.
//
// A DIFERENCIA DE PRODUCTORES Y FINCAS, LA BAJA ES FÍSICA
//   sku_pt no tiene columna de estado. Por eso el DELETE verifica primero
//   que ninguna producción lo use: produccion resuelve la calidad por JOIN
//   contra esta tabla, y borrar un SKU en uso dejaría esos registros sin
//   poder mostrar de qué producto hablan.
// ============================================================================

// GET /api/preenfrio/sku?turno=1&calidad=PRIMERA&buscar=texto
const getSkus = async (req, res) => {
    try {
        const { turno, calidad, buscar } = req.query;

        const skus = await skuModel.getSkus({
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
        res.status(500).json({ error: "Error al actualizar el SKU" });
    }
};

// DELETE /api/preenfrio/sku/:id
// Borrado FÍSICO. Se verifica primero para poder explicar el motivo en vez
// de devolver un error de FK que el usuario no entiende.
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
                error: `No se puede eliminar: ${dependencias.producciones} producción(es) usan este SKU. Edítalo en lugar de borrarlo.`
            });
        }

        const eliminado = await skuModel.deleteSku(id);

        res.status(200).json({
            mensaje: "SKU eliminado correctamente",
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
    deleteSku
};
