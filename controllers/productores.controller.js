// ============================================================================
// CONTROLADOR · PRODUCTORES
// ----------------------------------------------------------------------------
// Reglas de negocio que se validan aquí (no en la BD):
//   · codigo_productor: 1 a 4 caracteres, único en todo el catálogo.
//     El código de lote toma sus ÚLTIMOS 2 dígitos (ver fn_generar_lote),
//     así que dos productores con código terminando igual producirían lotes
//     idénticos. El UNIQUE es real y se valida antes de insertar para
//     devolver un mensaje claro en vez del error 23505 de Postgres.
//   · La baja es lógica (activo = 0). Nunca DELETE: hay FK desde fincas y
//     produccion; borrar rompería la trazabilidad del lote.
// ============================================================================

import { ProductoresModel } from "../models/productores.model.js";

/** GET /api/preenfrio/productores?activo=1&buscar=texto */
const listar = async (req, res) => {
    try {
        const { activo, buscar } = req.query;
        const productores = await ProductoresModel.listar({ activo, buscar });
        return res.json(productores);
    } catch (error) {
        console.error("[productores.listar]", error);
        return res.status(500).json({ error: "Error al consultar productores" });
    }
};

/** GET /api/preenfrio/productores/:id */
const obtener = async (req, res) => {
    try {
        const productor = await ProductoresModel.obtenerPorId(req.params.id);

        if (!productor) {
            return res.status(404).json({ error: "Productor no encontrado" });
        }

        return res.json(productor);
    } catch (error) {
        console.error("[productores.obtener]", error);
        return res.status(500).json({ error: "Error al consultar el productor" });
    }
};

/** POST /api/preenfrio/productores */
const crear = async (req, res) => {
    try {
        const { codigo_productor, nombre, activo } = req.body;

        if (!codigo_productor || !nombre) {
            return res.status(400).json({
                error: "codigo_productor y nombre son obligatorios"
            });
        }

        const codigo = String(codigo_productor).trim().toUpperCase();

        if (codigo.length > 4) {
            return res.status(400).json({
                error: "codigo_productor admite máximo 4 caracteres"
            });
        }

        const duplicado = await ProductoresModel.obtenerPorCodigo(codigo);
        if (duplicado) {
            return res.status(409).json({
                error: `El código ${codigo} ya está en uso por: ${duplicado.nombre}`
            });
        }

        const nuevo = await ProductoresModel.crear({
            codigo_productor: codigo,
            nombre: String(nombre).trim(),
            activo: activo ?? 1
        });

        return res.status(201).json({
            mensaje: "Productor creado correctamente",
            productor: nuevo
        });
    } catch (error) {
        console.error("[productores.crear]", error);
        return res.status(500).json({ error: "Error al crear el productor" });
    }
};

/** PUT /api/preenfrio/productores/:id */
const actualizar = async (req, res) => {
    try {
        const { id } = req.params;
        const { codigo_productor, nombre, activo } = req.body;

        const existente = await ProductoresModel.obtenerPorId(id);
        if (!existente) {
            return res.status(404).json({ error: "Productor no encontrado" });
        }

        let codigo = null;

        if (codigo_productor) {
            codigo = String(codigo_productor).trim().toUpperCase();

            if (codigo.length > 4) {
                return res.status(400).json({
                    error: "codigo_productor admite máximo 4 caracteres"
                });
            }

            // Se excluye el propio id: reenviar su mismo código no es duplicado
            const duplicado = await ProductoresModel.obtenerPorCodigo(codigo, id);
            if (duplicado) {
                return res.status(409).json({
                    error: `El código ${codigo} ya está en uso por: ${duplicado.nombre}`
                });
            }
        }

        const actualizado = await ProductoresModel.actualizar(id, {
            codigo_productor: codigo,
            nombre: nombre ? String(nombre).trim() : null,
            activo
        });

        return res.json({
            mensaje: "Productor actualizado correctamente",
            productor: actualizado
        });
    } catch (error) {
        console.error("[productores.actualizar]", error);
        return res.status(500).json({ error: "Error al actualizar el productor" });
    }
};

/**
 * DELETE /api/preenfrio/productores/:id  → baja LÓGICA
 * Se informan las dependencias para que el usuario sepa qué queda colgando:
 * las fincas y producciones históricas siguen existiendo, el productor
 * simplemente deja de ofrecerse en los selectores.
 */
const darDeBaja = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await ProductoresModel.obtenerPorId(id);
        if (!existente) {
            return res.status(404).json({ error: "Productor no encontrado" });
        }

        if (existente.activo === 0) {
            return res.status(400).json({ error: "El productor ya está dado de baja" });
        }

        const dependencias = await ProductoresModel.contarDependencias(id);
        const productor = await ProductoresModel.darDeBaja(id);

        return res.json({
            mensaje: "Productor dado de baja. El histórico se conserva.",
            productor,
            dependencias
        });
    } catch (error) {
        console.error("[productores.darDeBaja]", error);
        return res.status(500).json({ error: "Error al dar de baja el productor" });
    }
};

/** PATCH /api/preenfrio/productores/:id/reactivar */
const reactivar = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await ProductoresModel.obtenerPorId(id);
        if (!existente) {
            return res.status(404).json({ error: "Productor no encontrado" });
        }

        const productor = await ProductoresModel.reactivar(id);

        return res.json({
            mensaje: "Productor reactivado correctamente",
            productor
        });
    } catch (error) {
        console.error("[productores.reactivar]", error);
        return res.status(500).json({ error: "Error al reactivar el productor" });
    }
};

export const ProductoresController = {
    listar,
    obtener,
    crear,
    actualizar,
    darDeBaja,
    reactivar
};
