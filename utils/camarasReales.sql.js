// ============================================================================
// CÁMARAS DONDE ESTÁ REALMENTE LA FRUTA DE UNA PRODUCCIÓN
// ============================================================================
// EL PROBLEMA QUE RESUELVE
//   bloques y pulpeos resolvían el alcance con produccion.id_camara, que es
//   la cámara del PLAN. Pero al llegar el camión el supervisor puede
//   desviarlo a otra cámara, y después la fruta pasa a conservación.
//
//   Resultado: el supervisor de la cámara donde realmente estaba la fruta
//   no podía ver ni pulpear ese bloque, y el de la cámara planeada sí,
//   aunque esa fruta nunca llegó ahí.
//
// CÓMO SE RESUELVE
//   Las cámaras "reales" de una producción son la unión de:
//     1. donde se RECIBIÓ   (recepciones activas con cámara)
//     2. a donde se TRASLADÓ (movimientos tipo 2, incluidas las reversas)
//     3. la PLANEADA, solo si todavía no hay ninguna recepción con cámara
//
//   El punto 3 mantiene el comportamiento anterior para la fruta que aún no
//   llega: el supervisor de la cámara planeada puede preparar el bloque.
//
// USO
//   Es un fragmento SQL que recibe el alias de la tabla produccion y
//   devuelve una columna de ids de cámara. Se usa como tabla derivada:
//
//     CROSS JOIN LATERAL (${SQL_CAMARAS_REALES("p")}) AS cr(id_camara)
//
//   o dentro de un EXISTS / ARRAY(...). Vive en un solo archivo para que
//   bloques y pulpeos no puedan llegar a criterios distintos.
// ============================================================================

export const SQL_CAMARAS_REALES = (p) => `
    SELECT r.id_camara
    FROM recepciones r
    WHERE r.id_produccion = ${p}.id_produccion
      AND r.estado = 1
      AND r.id_camara IS NOT NULL

    UNION

    SELECT m.id_camara_destino
    FROM movimientos_inventario m
    WHERE m.id_produccion = ${p}.id_produccion
      AND m.tipo_movimiento = 2
      AND m.id_camara_destino IS NOT NULL

    UNION

    SELECT ${p}.id_camara
    WHERE ${p}.id_camara IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM recepciones r2
          WHERE r2.id_produccion = ${p}.id_produccion
            AND r2.estado = 1
            AND r2.id_camara IS NOT NULL
      )
`;
