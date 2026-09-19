// ============================================================================
// CONTROLADOR · FINCAS
// ----------------------------------------------------------------------------
// Reglas de negocio que se validan aquí:
//   · zona debe ser 1, 2 o 3. Con otro valor, fn_generar_lote() devuelve la
//     letra 'X' y todos los lotes de esa finca nacen mal. Se bloquea.
//   · codigo_finca: máximo 3 caracteres y no repetido DENTRO del mismo
//     productor (la tabla no lo impide; la operación sí lo necesita).
//   · id_productor debe existir y estar ACTIVO al dar de alta. Editar una
//     finca vieja cuyo productor ya se dio de baja SÍ se permite: si el
//     sistema lo bloquea, no hay forma de corregir el histórico.
//   · Baja lógica (estado = 0). produccion.id_finca referencia esta tabla.
// ============================================================================

import { FincasModel } from "../models/fincas.model.js";
import { ProductoresModel } from "../models/productores.model.js";

/** Zonas válidas según fn_generar_lote: 1=Chiapas(A) 2=Colima(B) 3=Tabasco(C) */
const ZONAS_VALIDAS = [1, 2, 3];

/** GET /api/preenfrio/fincas?id_productor=1&zona=1&estado=1&buscar=texto */
const listar = async (req, res) => {
    try {
        const { id_productor, zona, estado, buscar } = req.query;
        const fincas = await FincasModel.listar({ id_productor, zona, estado, buscar });
        return res.json(fincas);
    } catch (error) {
        console.error("[fincas.listar]", error);
        return res.status(500).json({ error: "Error al consultar fincas" });
    }
};

/** GET /api/preenfrio/fincas/:id */
const obtener = async (req, res) => {
    try {
        const finca = await FincasModel.obtenerPorId(req.params.id);

        if (!finca) {
            return res.status(404).json({ error: "Finca no encontrada" });
        }

        return res.json(finca);
    } catch (error) {
        console.error("[fincas.obtener]", error);
        return res.status(500).json({ error: "Error al consultar la finca" });
    }
};

/** POST /api/preenfrio/fincas */
const crear = async (req, res) => {
    try {
        const {
            codigo_finca, nombre, org_inv_nombre, zona, id_productor, estado
        } = req.body;

        if (!codigo_finca || !nombre || !org_inv_nombre || !zona || !id_productor) {
            return res.status(400).json({
                error: "codigo_finca, nombre, org_inv_nombre, zona e id_productor son obligatorios"
            });
        }

        const zonaNum = Number(zona);
        if (!ZONAS_VALIDAS.includes(zonaNum)) {
            return res.status(400).json({
                error: "zona inválida. Use 1=Chiapas, 2=Colima o 3=Tabasco"
            });
        }

        const codigo = String(codigo_finca).trim().toUpperCase();
        if (codigo.length > 3) {
            return res.status(400).json({
                error: "codigo_finca admite máximo 3 caracteres"
            });
        }

        const productor = await ProductoresModel.obtenerPorId(id_productor);
        if (!productor) {
            return res.status(400).json({ error: "El productor indicado no existe" });
        }
        if (productor.activo === 0) {
            return res.status(400).json({
                error: `El productor ${productor.nombre} está dado de baja. Reactívelo antes de darle fincas nuevas.`
            });
        }

        const duplicado = await FincasModel.obtenerPorCodigoYProductor(codigo, id_productor);
        if (duplicado) {
            return res.status(409).json({
                error: `El productor ${productor.nombre} ya tiene una finca con el código ${codigo}: ${duplicado.nombre}`
            });
        }

        const nueva = await FincasModel.crear({
            codigo_finca: codigo,
            nombre: String(nombre).trim(),
            org_inv_nombre: String(org_inv_nombre).trim(),
            zona: zonaNum,
            id_productor,
            estado: estado ?? 1
        });

        // Se relee para devolver el productor resuelto y la zona_letra: así
        // el front no necesita un GET extra después de guardar
        const completa = await FincasModel.obtenerPorId(nueva.id_finca);

        return res.status(201).json({
            mensaje: "Finca creada correctamente",
            finca: completa
        });
    } catch (error) {
        console.error("[fincas.crear]", error);
        return res.status(500).json({ error: "Error al crear la finca" });
    }
};

/** PUT /api/preenfrio/fincas/:id */
const actualizar = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            codigo_finca, nombre, org_inv_nombre, zona, id_productor, estado
        } = req.body;

        const existente = await FincasModel.obtenerPorId(id);
        if (!existente) {
            return res.status(404).json({ error: "Finca no encontrada" });
        }

        let zonaNum = null;
        if (zona !== undefined && zona !== null && zona !== "") {
            zonaNum = Number(zona);
            if (!ZONAS_VALIDAS.includes(zonaNum)) {
                return res.status(400).json({
                    error: "zona inválida. Use 1=Chiapas, 2=Colima o 3=Tabasco"
                });
            }
        }

        if (id_productor) {
            const productor = await ProductoresModel.obtenerPorId(id_productor);
            if (!productor) {
                return res.status(400).json({ error: "El productor indicado no existe" });
            }
        }

        let codigo = null;
        if (codigo_finca) {
            codigo = String(codigo_finca).trim().toUpperCase();

            if (codigo.length > 3) {
                return res.status(400).json({
                    error: "codigo_finca admite máximo 3 caracteres"
                });
            }

            // El duplicado se evalúa contra el productor FINAL, que puede ser
            // otro si se está reasignando la finca
            const productorDestino = id_productor || existente.id_productor;

            const duplicado = await FincasModel.obtenerPorCodigoYProductor(
                codigo, productorDestino, id
            );
            if (duplicado) {
                return res.status(409).json({
                    error: `Ese productor ya tiene una finca con el código ${codigo}: ${duplicado.nombre}`
                });
            }
        }

        await FincasModel.actualizar(id, {
            codigo_finca: codigo,
            nombre: nombre ? String(nombre).trim() : null,
            org_inv_nombre: org_inv_nombre ? String(org_inv_nombre).trim() : null,
            zona: zonaNum,
            id_productor: id_productor ?? null,
            estado
        });

        const completa = await FincasModel.obtenerPorId(id);

        return res.json({
            mensaje: "Finca actualizada correctamente",
            finca: completa
        });
    } catch (error) {
        console.error("[fincas.actualizar]", error);
        return res.status(500).json({ error: "Error al actualizar la finca" });
    }
};

/** DELETE /api/preenfrio/fincas/:id → baja LÓGICA */
const darDeBaja = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await FincasModel.obtenerPorId(id);
        if (!existente) {
            return res.status(404).json({ error: "Finca no encontrada" });
        }

        if (existente.estado === 0) {
            return res.status(400).json({ error: "La finca ya está dada de baja" });
        }

        const dependencias = await FincasModel.contarDependencias(id);
        const finca = await FincasModel.darDeBaja(id);

        return res.json({
            mensaje: "Finca dada de baja. El histórico de producción se conserva.",
            finca,
            dependencias
        });
    } catch (error) {
        console.error("[fincas.darDeBaja]", error);
        return res.status(500).json({ error: "Error al dar de baja la finca" });
    }
};

/** PATCH /api/preenfrio/fincas/:id/reactivar */
const reactivar = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await FincasModel.obtenerPorId(id);
        if (!existente) {
            return res.status(404).json({ error: "Finca no encontrada" });
        }

        const finca = await FincasModel.reactivar(id);

        return res.json({
            mensaje: "Finca reactivada correctamente",
            finca
        });
    } catch (error) {
        console.error("[fincas.reactivar]", error);
        return res.status(500).json({ error: "Error al reactivar la finca" });
    }
};

export const FincasController = {
    listar,
    obtener,
    crear,
    actualizar,
    darDeBaja,
    reactivar
};
