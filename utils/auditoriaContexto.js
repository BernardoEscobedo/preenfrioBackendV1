import { db } from "../database/connection.database.js";

// ============================================================================
// CONTEXTO DE AUDITORÍA PARA CAMBIOS DE ESTADO
// ============================================================================
// El historial de bajas lo escribe un TRIGGER de la base de datos
// (fn_registrar_cambio_estado), no el backend. Así queda registro aunque el
// cambio se haga directo en Supabase.
//
// Para que el trigger sepa QUIÉN hizo el cambio y POR QUÉ, esta función abre
// una transacción y fija dos variables de sesión antes de ejecutar el
// trabajo:
//
//     app.id_usuario   el usuario del token
//     app.motivo       el motivo que capturó
//
// El tercer parámetro de set_config (true) limita el valor a ESTA
// transacción. Es importante: las conexiones del pool se reutilizan, y sin
// eso el motivo de una baja podría "heredarse" al siguiente cambio de otra
// petición.
//
// USO
//   await conContextoAuditoria(
//       { id_usuario: req.id_usuario, motivo: req.body.motivo },
//       (client) => client.query(`UPDATE camaras SET estado = 0 WHERE ...`)
//   );
//
//   Todo lo que se ejecute con `client` dentro del callback queda en la
//   misma transacción y con el mismo contexto. Si algo falla, se revierte
//   todo, historial incluido.
// ============================================================================

export const conContextoAuditoria = async ({ id_usuario, motivo }, trabajo) => {
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        await client.query(
            `SELECT set_config('app.id_usuario', $1, true),
                    set_config('app.motivo', $2, true)`,
            [
                id_usuario ? String(id_usuario) : "",
                motivo ? String(motivo) : ""
            ]
        );

        const resultado = await trabajo(client);

        await client.query("COMMIT");
        return resultado;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};
