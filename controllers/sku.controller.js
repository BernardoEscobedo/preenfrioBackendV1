// ============================================================================
// CONTROLADOR · SKU DE PRODUCTO TERMINADO
// ----------------------------------------------------------------------------
// Reglas de negocio que se validan aquí:
//   · turno solo admite 1 o 2. Es el último dígito del código de lote; un
//     valor fuera de rango rompe el formato de 15 dígitos.
//   · No se permiten dos SKU con el mismo codigo_sku Y la misma calidad.
//     Mismo código en distinta calidad sí es válido: son productos distintos.
//   · sku_pt no tiene columna de estado, así que la baja es DELETE físico y
//     solo se autoriza si NINGUNA producción lo referencia. Borrar un SKU en
//     uso dejaría producciones sin calidad (produccion la resuelve por JOIN).
// ============================================================================

import { SkuModel } from "../models/sku.model.js";

/** Turnos válidos. Es el último dígito del código de lote. */
const TURNOS_VALIDOS = [1, 2];

/** GET /api/preenfrio/sku?turno=1&calidad=PRIMERA&buscar=texto */
const listar = async (req, res) => {
    try {
        const { turno, calidad, buscar } = req.query;
        const skus = await SkuModel.listar({ turno, calidad, buscar });
        return res.json(skus);
    } catch (error) {
        console.error("[sku.listar]", error);
        return res.status(500).json({ error: "Error al consultar los SKU" });
    }
};

/** GET /api/preenfrio/sku/:id */
const obtener = async (req, res) => {
    try {
        const sku = await SkuModel.obtenerPorId(req.params.id);

        if (!sku) {
            return res.status(404).json({ error: "SKU no encontrado" });
        }

        return res.json(sku);
    } catch (error) {
        console.error("[sku.obtener]", error);
        return res.status(500).json({ error: "Error al consultar el SKU" });
    }
};

/** POST /api/preenfrio/sku */
const crear = async (req, res) => {
    try {
        const { codigo_sku, calidad, turno } = req.body;

        if (!codigo_sku || !calidad) {
            return res.status(400).json({
                error: "codigo_sku y calidad son obligatorios"
            });
        }

        const codigo = String(codigo_sku).trim().toUpperCase();
        if (codigo.length > 10) {
            return res.status(400).json({
                error: "codigo_sku admite máximo 10 caracteres"
            });
        }

        const turnoNum = turno === undefined || turno === null ? 1 : Number(turno);
        if (!TURNOS_VALIDOS.includes(turnoNum)) {
            return res.status(400).json({
                error: "turno inválido. Solo se admite 1 o 2 (último dígito del código de lote)"
            });
        }

        const calidadNorm = String(calidad).trim().toUpperCase();

        const duplicado = await SkuModel.obtenerPorCodigoYCalidad(codigo, calidadNorm);
        if (duplicado) {
            return res.status(409).json({
                error: `Ya existe el SKU ${codigo} con calidad ${calidadNorm}`
            });
        }

        const nuevo = await SkuModel.crear({
            codigo_sku: codigo,
            calidad: calidadNorm,
            turno: turnoNum
        });

        // Se relee para devolver también cajas_por_tarima (campo calculado)
        const completo = await SkuModel.obtenerPorId(nuevo.id_sku);

        return res.status(201).json({
            mensaje: "SKU creado correctamente",
            sku: completo
        });
    } catch (error) {
        console.error("[sku.crear]", error);
        return res.status(500).json({ error: "Error al crear el SKU" });
    }
};

/** PUT /api/preenfrio/sku/:id */
const actualizar = async (req, res) => {
    try {
        const { id } = req.params;
        const { codigo_sku, calidad, turno } = req.body;

        const existente = await SkuModel.obtenerPorId(id);
        if (!existente) {
            return res.status(404).json({ error: "SKU no encontrado" });
        }

        let turnoNum = null;
        if (turno !== undefined && turno !== null && turno !== "") {
            turnoNum = Number(turno);
            if (!TURNOS_VALIDOS.includes(turnoNum)) {
                return res.status(400).json({
                    error: "turno inválido. Solo se admite 1 o 2"
                });
            }
        }

        const codigo = codigo_sku ? String(codigo_sku).trim().toUpperCase() : null;
        const calidadNorm = calidad ? String(calidad).trim().toUpperCase() : null;

        if (codigo && codigo.length > 10) {
            return res.status(400).json({
                error: "codigo_sku admite máximo 10 caracteres"
            });
        }

        // El duplicado se evalúa contra los valores FINALES: puede cambiar
        // solo la calidad y chocar con otro SKU del mismo código
        if (codigo || calidadNorm) {
            const duplicado = await SkuModel.obtenerPorCodigoYCalidad(
                codigo || existente.codigo_sku,
                calidadNorm || existente.calidad,
                id
            );
            if (duplicado) {
                return res.status(409).json({
                    error: `Ya existe otro SKU con ese código y calidad (id ${duplicado.id_sku})`
                });
            }
        }

        await SkuModel.actualizar(id, {
            codigo_sku: codigo,
            calidad: calidadNorm,
            turno: turnoNum
        });

        const completo = await SkuModel.obtenerPorId(id);

        return res.json({
            mensaje: "SKU actualizado correctamente",
            sku: completo
        });
    } catch (error) {
        console.error("[sku.actualizar]", error);
        return res.status(500).json({ error: "Error al actualizar el SKU" });
    }
};

/**
 * DELETE /api/preenfrio/sku/:id
 * Borrado FÍSICO, permitido solo si ninguna producción lo usa. Si hay
 * dependencias se devuelve 409 con el conteo, para que el usuario entienda
 * por qué no puede borrarlo en lugar de ver un error de FK.
 */
const eliminar = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await SkuModel.obtenerPorId(id);
        if (!existente) {
            return res.status(404).json({ error: "SKU no encontrado" });
        }

        const dependencias = await SkuModel.contarDependencias(id);

        if (dependencias.producciones > 0) {
            return res.status(409).json({
                error: `No se puede eliminar: ${dependencias.producciones} producción(es) usan este SKU. Modifíquelo en lugar de borrarlo.`,
                dependencias
            });
        }

        const sku = await SkuModel.eliminar(id);

        return res.json({
            mensaje: "SKU eliminado correctamente",
            sku
        });
    } catch (error) {
        console.error("[sku.eliminar]", error);
        return res.status(500).json({ error: "Error al eliminar el SKU" });
    }
};

export const SkuController = {
    listar,
    obtener,
    crear,
    actualizar,
    eliminar
};
