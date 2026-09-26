import { aFechaISO } from "../utils/fechas.js";

// ============================================================================
// CONSERVAR CAMPOS NO ENVIADOS EN UN PUT
// ============================================================================
// EL BUG QUE CORRIGE
//   Los middlewares de validación ponen defaults a los campos opcionales:
//   estado = 1, inocuidad = 1, turno = 1, id_camara = null... Eso es
//   correcto en el ALTA. Pero el PUT usaba el mismo middleware, y el model
//   escribe todas las columnas. Resultado: cualquier campo que el
//   formulario de edición no mandara se sobrescribía en silencio.
//
//     · Editar un transporte sin mandar 'inocuidad'  → una unidad RECHAZADA
//       quedaba APROBADA
//     · Editar un SKU sin 'turno'                    → cambiaba el último
//       dígito de los lotes nuevos
//     · Editar un catálogo sin 'estado'              → lo reactivaba
//     · Editar una producción sin 'id_camara'        → pasaba a CEDA directo
//     · Editar una producción sin 'fecha_entrega'    → perdía la cita
//
// CÓMO LO CORRIGE
//   Va en la ruta del PUT, ANTES del validador. Lee el registro actual y
//   rellena con su valor todo campo de la lista que no venga en el body.
//   Así el validador nunca llega a poner un default sobre un dato real.
//
//   La distinción importante es undefined contra null:
//     · undefined  → "no lo mandé"          → se conserva el valor actual
//     · null       → "quítalo a propósito"  → se respeta el null
//
// Se hizo como middleware genérico en vez de tocar cada controller: la
// regla es la misma en los seis módulos y así vive en un solo lugar.
// ============================================================================

/**
 * @param {Function} obtener  Método del model que trae el registro por id
 * @param {String[]} campos   Campos opcionales que deben conservarse
 * @param {Object}   alias    Nombres alternos aceptados en el body.
 *                            Ej: { activo: "estado" } para productores, que
 *                            todavía acepta 'activo' por compatibilidad.
 */
export const conservarCampos = (obtener, campos, alias = {}) => {
    return async (req, res, next) => {
        try {
            const existente = await obtener(req.params.id);

            // Si no existe, que el controller responda su 404 de siempre
            if (!existente) return next();

            if (!req.body || typeof req.body !== "object") req.body = {};

            for (const campo of campos) {
                if (req.body[campo] !== undefined) continue;

                // Si el campo llegó con su nombre viejo, el validador lo
                // traduce: aquí no hay que pisarlo con el valor actual.
                const llegoPorAlias = Object.entries(alias).some(
                    ([nombreViejo, destino]) =>
                        destino === campo && req.body[nombreViejo] !== undefined
                );

                if (llegoPorAlias) continue;

                let valor = existente[campo];

                // pg entrega DATE como objeto Date. Se regresa a texto para
                // que el validador lo trate igual que lo que manda el
                // frontend, y para no arrastrar desfases de zona horaria.
                if (valor instanceof Date) valor = aFechaISO(valor);

                req.body[campo] = valor ?? null;
            }

            next();
        } catch (error) {
            console.error("Error al leer el registro a editar:", error);
            res.status(500).json({ error: "Error al leer el registro a editar" });
        }
    };
};
