import jwt from "jsonwebtoken";
import crypto from "crypto";
import evidenciasModel from "../models/evidencias.model.js";
import bloquesModel from "../models/bloques.model.js";
import {
    sharepointConfigurado,
    rutaEvidencias,
    crearSesionCarga,
    obtenerArchivo,
    eliminarArchivo,
    idBiblioteca
} from "../utils/sharepoint.js";
import { LIMITES, TIPOS } from "../middlewares/evidencias.middleware.js";

// ============================================================================
// EVIDENCIAS · FOTOS Y VIDEOS EN SHAREPOINT
// ============================================================================
// El archivo NUNCA pasa por este servidor. El flujo tiene tres pasos:
//
//   1. POST /evidencias/:origen/:id/sesion
//      El backend valida permisos y límites, crea una sesión de carga en
//      SharePoint y devuelve:
//        · upload_url   URL preautenticada de SharePoint
//        · token_carga  comprobante firmado de QUÉ se autorizó subir
//
//   2. El frontend sube el archivo DIRECTO a upload_url (PUT por pedazos).
//      SharePoint responde con el archivo creado; su "id" es el item_id.
//
//   3. POST /evidencias/confirmar  { token_carga, item_id }
//      El backend verifica en SharePoint que el archivo exista, esté en la
//      carpeta autorizada, tenga el nombre generado y no exceda el tamaño.
//      Si todo cuadra lo registra; si no, lo borra de SharePoint.
//
// POR QUÉ EL token_carga
//   Sin él, alguien podría confirmar cualquier archivo de la biblioteca
//   como evidencia de cualquier despacho. El token amarra el archivo al
//   documento, al usuario y al nombre que el backend generó, y caduca.
//
// PARA VER UN ARCHIVO
//   GET /evidencias/:origen/archivo/:id_evidencia/url devuelve un enlace
//   de descarga temporal generado por Microsoft Graph. Caduca en minutos:
//   las fotos nunca quedan públicas.
// ============================================================================

const PROPOSITO_TOKEN = "carga_evidencia";
const DURACION_TOKEN = "6h";

/** Mensaje uniforme cuando faltan las variables de SharePoint. */
const noConfigurado = (res) =>
    res.status(503).json({
        error: "El almacenamiento de evidencias en SharePoint no está configurado en el servidor (variables SP_*)."
    });

/** ¿El usuario ve alguna de estas cámaras? Sin cámaras = documento sin planta. */
const tieneAlcance = (camarasDocumento, camarasUsuario) => {
    if (!Array.isArray(camarasUsuario)) return true;
    if (camarasDocumento.length === 0) return true;
    return camarasDocumento.some((c) => camarasUsuario.includes(Number(c)));
};

// ----------------------------------------------------------------------------
// Resolver el documento padre y validar alcance
// ----------------------------------------------------------------------------
// Devuelve { documento, carpeta, prefijo } o { status, error }.
const resolverDocumento = async (origen, id, camarasUsuario) => {
    if (origen === "despachos") {
        const despacho = await evidenciasModel.getDespacho(id);

        if (!despacho) {
            return { status: 404, error: "Despacho no encontrado" };
        }

        const camaras = await evidenciasModel.getCamarasDespacho(id);

        if (!tieneAlcance(camaras, camarasUsuario)) {
            return { status: 403, error: "No tienes acceso a ese despacho" };
        }

        const anio = String(despacho.fecha_despacho instanceof Date
            ? despacho.fecha_despacho.getFullYear()
            : String(despacho.fecha_despacho).slice(0, 4));

        return {
            documento: despacho,
            carpeta: rutaEvidencias("Despachos", anio, despacho.folio_despacho),
            prefijo: `DESP-${despacho.folio_despacho}`
        };
    }

    // pulpeos
    const pulpeo = await evidenciasModel.getPulpeo(id);

    if (!pulpeo) {
        return { status: 404, error: "Pulpeo no encontrado" };
    }

    const camaras = await bloquesModel.getCamarasDelBloque(pulpeo.id_bloque);

    if (!tieneAlcance(camaras, camarasUsuario)) {
        return { status: 403, error: "No tienes acceso a ese pulpeo" };
    }

    const anio = String(new Date(pulpeo.fecha_hora).getFullYear());

    return {
        documento: pulpeo,
        carpeta: rutaEvidencias("Pulpeos", anio, pulpeo.codigo_bloque, `pulpeo-${pulpeo.id_pulpeo}`),
        prefijo: `PULP-${pulpeo.codigo_bloque}-${pulpeo.numero_pulpeo ?? pulpeo.id_pulpeo}`
    };
};

/** ¿Hay lugar para otra evidencia de este tipo? Devuelve el error o null. */
const validarCupo = async (origen, id, tipo) => {
    const conteo = await evidenciasModel.contar(origen, id);

    const maxFotos = origen === "despachos" ? LIMITES.FOTOS_POR_DESPACHO : LIMITES.FOTOS_POR_PULPEO;
    const maxVideos = origen === "despachos" ? LIMITES.VIDEOS_POR_DESPACHO : LIMITES.VIDEOS_POR_PULPEO;

    if (tipo === TIPOS.FOTO && conteo.fotos >= maxFotos) {
        return `Ya tiene ${conteo.fotos} foto(s): el máximo es ${maxFotos}. Elimina una antes de subir otra.`;
    }

    if (tipo === TIPOS.VIDEO && conteo.videos >= maxVideos) {
        return `Ya tiene ${conteo.videos} video(s): el máximo es ${maxVideos}.`;
    }

    return null;
};

// ----------------------------------------------------------------------------
// PASO 1 · POST /api/preenfrio/evidencias/:origen/:id/sesion
// ----------------------------------------------------------------------------
const crearSesion = async (req, res) => {
    try {
        if (!sharepointConfigurado()) return noConfigurado(res);

        const { origen, id } = req.params;
        const {
            tipo_archivo,
            nombre_original,
            mime_type,
            tamano_bytes,
            extension,
            descripcion,
            id_pulpeo_detalle
        } = req.body;

        const resuelto = await resolverDocumento(origen, id, req.camaras);

        if (resuelto.error) {
            return res.status(resuelto.status).json({ error: resuelto.error });
        }

        // ---- Reglas por origen ----
        if (origen === "pulpeos") {
            if (Number(resuelto.documento.estado) !== 1) {
                return res.status(409).json({
                    error: "El pulpeo está cancelado: no admite evidencias"
                });
            }

            if (
                id_pulpeo_detalle &&
                !(await evidenciasModel.detallePerteneceAPulpeo(id_pulpeo_detalle, id))
            ) {
                return res.status(409).json({
                    error: "Ese desglose no pertenece a este pulpeo"
                });
            }
        }

        const sinCupo = await validarCupo(origen, id, tipo_archivo);

        if (sinCupo) {
            return res.status(409).json({ error: sinCupo });
        }

        // ---- Nombre único, generado aquí ----
        // Fecha legible + sufijo aleatorio: nunca choca y se entiende al
        // abrir la carpeta en SharePoint.
        const sello = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const aleatorio = crypto.randomBytes(3).toString("hex");
        const nombre_archivo = `${resuelto.prefijo}_${sello}_${aleatorio}.${extension}`;

        const sesion = await crearSesionCarga(resuelto.carpeta, nombre_archivo);

        // ---- Comprobante de lo autorizado ----
        const token_carga = jwt.sign(
            {
                proposito: PROPOSITO_TOKEN,
                origen,
                id_padre: Number(id),
                id_pulpeo_detalle: id_pulpeo_detalle ?? null,
                carpeta: resuelto.carpeta,
                nombre_archivo,
                nombre_original,
                tipo_archivo,
                mime_type,
                tamano_bytes,
                descripcion,
                id_usuario: req.id_usuario
            },
            process.env.JWT_SECRET,
            { expiresIn: DURACION_TOKEN }
        );

        res.status(201).json({
            mensaje: "Sesión de carga creada. Sube el archivo directo a upload_url y confirma con token_carga.",
            upload_url: sesion.uploadUrl,
            expira: sesion.expirationDateTime,
            nombre_archivo,
            token_carga,
            // Instrucciones para el frontend
            instrucciones: {
                metodo: "PUT",
                // Cada pedazo debe ser múltiplo de 320 KiB (salvo el último)
                tamano_pedazo_bytes: 320 * 1024 * 10,  // 3.2 MB
                encabezados: ["Content-Length", "Content-Range: bytes inicio-fin/total"],
                nota: "No envíes el header Authorization a upload_url: ya está preautenticada."
            }
        });
    } catch (error) {
        console.error("Error al crear la sesión de carga:", error);

        if (error.status) {
            return res.status(502).json({
                error: `No se pudo preparar la carga en SharePoint: ${error.message}`
            });
        }

        res.status(500).json({ error: "Error al preparar la carga de la evidencia" });
    }
};

// ----------------------------------------------------------------------------
// PASO 3 · POST /api/preenfrio/evidencias/confirmar
// ----------------------------------------------------------------------------
const confirmarCarga = async (req, res) => {
    const { token_carga, item_id } = req.body;

    try {
        if (!sharepointConfigurado()) return noConfigurado(res);

        // ---- El comprobante ----
        let datos;

        try {
            datos = jwt.verify(token_carga, process.env.JWT_SECRET);
        } catch {
            return res.status(400).json({
                error: "El comprobante de carga es inválido o caducó. Vuelve a solicitar la sesión."
            });
        }

        if (datos.proposito !== PROPOSITO_TOKEN) {
            return res.status(400).json({ error: "Comprobante de carga inválido" });
        }

        // Solo quien pidió la sesión puede confirmarla
        if (Number(datos.id_usuario) !== Number(req.id_usuario)) {
            return res.status(403).json({
                error: "Esta carga la inició otro usuario"
            });
        }

        // Se revalida el alcance: pudo cambiar desde que se pidió la sesión
        const resuelto = await resolverDocumento(datos.origen, datos.id_padre, req.camaras);

        if (resuelto.error) {
            return res.status(resuelto.status).json({ error: resuelto.error });
        }

        // ---- El archivo, según SharePoint ----
        let archivo;

        try {
            archivo = await obtenerArchivo(item_id);
        } catch (error) {
            if (error.status === 404) {
                return res.status(404).json({
                    error: "SharePoint no encuentra ese archivo. ¿Terminó de subirse?"
                });
            }
            throw error;
        }

        // ---- Verificaciones: que sea exactamente lo autorizado ----
        const rutaPadre = decodeURIComponent(archivo.parentReference?.path ?? "");
        const limite = datos.tipo_archivo === TIPOS.FOTO ? LIMITES.FOTO_BYTES : LIMITES.VIDEO_BYTES;
        const familia = datos.tipo_archivo === TIPOS.FOTO ? "image/" : "video/";
        const mimeReal = String(archivo.file?.mimeType ?? "").toLowerCase();

        const problemas = [];

        if (archivo.name !== datos.nombre_archivo) {
            problemas.push("el nombre no coincide con el autorizado");
        }

        if (!rutaPadre.endsWith(`root:/${datos.carpeta}`)) {
            problemas.push("no está en la carpeta autorizada");
        }

        if (Number(archivo.size) > limite) {
            problemas.push(`excede el tamaño máximo (${limite / 1048576} MB)`);
        }

        // SharePoint deduce el tipo por la extensión; si no lo sabe, lo deja
        // como application/octet-stream y se acepta.
        if (mimeReal && mimeReal !== "application/octet-stream" && !mimeReal.startsWith(familia)) {
            problemas.push(`el tipo real (${mimeReal}) no corresponde a ${datos.tipo_archivo === TIPOS.FOTO ? "una foto" : "un video"}`);
        }

        // El cupo se revisa otra vez: dos cargas en paralelo pudieron pasar
        // ambas la primera revisión.
        const sinCupo = await validarCupo(datos.origen, datos.id_padre, datos.tipo_archivo);

        if (sinCupo) problemas.push(sinCupo);

        if (problemas.length > 0) {
            // Un archivo que no se registra no debe quedarse ocupando espacio
            // ni aparecer después como evidencia huérfana.
            await eliminarArchivo(item_id).catch((e) =>
                console.error("No se pudo borrar el archivo rechazado:", e.message)
            );

            return res.status(409).json({
                error: `Se rechazó la evidencia: ${problemas.join("; ")}. El archivo se eliminó de SharePoint.`
            });
        }

        // ---- Registro ----
        const evidencia = await evidenciasModel.crear(datos.origen, {
            id_padre: datos.id_padre,
            id_pulpeo_detalle: datos.id_pulpeo_detalle,
            tipo_archivo: datos.tipo_archivo,
            nombre_archivo: archivo.name,
            nombre_original: datos.nombre_original,
            mime_type: mimeReal || datos.mime_type,
            tamano_bytes: Number(archivo.size),
            sharepoint_drive_id: idBiblioteca(),
            sharepoint_item_id: archivo.id,
            web_url: archivo.webUrl ?? null,
            descripcion: datos.descripcion,
            id_usuario: req.id_usuario
        });

        res.status(201).json({
            mensaje: `${datos.tipo_archivo === TIPOS.FOTO ? "Foto" : "Video"} registrado como evidencia.`,
            evidencia
        });
    } catch (error) {
        console.error("Error al confirmar la evidencia:", error);

        // Confirmar dos veces el mismo archivo
        if (error.code === "23505") {
            return res.status(409).json({
                error: "Ese archivo ya estaba registrado como evidencia"
            });
        }

        if (error.status) {
            return res.status(502).json({
                error: `No se pudo verificar el archivo en SharePoint: ${error.message}`
            });
        }

        res.status(500).json({ error: "Error al registrar la evidencia" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/evidencias/:origen/:id
// ----------------------------------------------------------------------------
// Lista las evidencias del documento. No incluye enlaces: se piden uno por
// uno al mostrarlas, porque caducan.
const listar = async (req, res) => {
    try {
        const { origen, id } = req.params;

        const resuelto = await resolverDocumento(origen, id, req.camaras);

        if (resuelto.error) {
            return res.status(resuelto.status).json({ error: resuelto.error });
        }

        const evidencias = await evidenciasModel.listar(origen, id);
        const conteo = await evidenciasModel.contar(origen, id);

        res.status(200).json({
            limites: {
                fotos: origen === "despachos" ? LIMITES.FOTOS_POR_DESPACHO : LIMITES.FOTOS_POR_PULPEO,
                videos: origen === "despachos" ? LIMITES.VIDEOS_POR_DESPACHO : LIMITES.VIDEOS_POR_PULPEO
            },
            conteo,
            evidencias
        });
    } catch (error) {
        console.error("Error al listar evidencias:", error);
        res.status(500).json({ error: "Error al obtener las evidencias" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/evidencias/:origen/archivo/:id_evidencia/url
// ----------------------------------------------------------------------------
// Enlace de descarga temporal. El frontend lo pone en el <img> o <video>.
// No se hace redirect porque un <img> no puede mandar el token de sesión.
const obtenerUrl = async (req, res) => {
    try {
        if (!sharepointConfigurado()) return noConfigurado(res);

        const { origen, id_evidencia } = req.params;
        const llave = origen === "despachos" ? "id_despacho" : "id_pulpeo";

        const evidencia = await evidenciasModel.getById(origen, id_evidencia);

        if (!evidencia) {
            return res.status(404).json({ error: "Evidencia no encontrada" });
        }

        const resuelto = await resolverDocumento(origen, evidencia[llave], req.camaras);

        if (resuelto.error) {
            return res.status(resuelto.status).json({ error: resuelto.error });
        }

        const archivo = await obtenerArchivo(evidencia.sharepoint_item_id);
        const url = archivo["@microsoft.graph.downloadUrl"];

        if (!url) {
            return res.status(502).json({
                error: "SharePoint no devolvió un enlace de descarga"
            });
        }

        res.status(200).json({
            url,
            nombre_archivo: evidencia.nombre_archivo,
            mime_type: evidencia.mime_type,
            tipo_archivo: evidencia.tipo_archivo,
            nota: "El enlace caduca en pocos minutos: pídelo de nuevo cada vez que se muestre."
        });
    } catch (error) {
        console.error("Error al obtener el enlace de la evidencia:", error);

        if (error.status === 404) {
            return res.status(410).json({
                error: "El archivo ya no existe en SharePoint (¿se borró desde la biblioteca?)"
            });
        }

        res.status(500).json({ error: "Error al obtener el enlace de la evidencia" });
    }
};

// ----------------------------------------------------------------------------
// DELETE /api/preenfrio/evidencias/:origen/archivo/:id_evidencia
// ----------------------------------------------------------------------------
// Las evidencias respaldan reclamos, así que borrarlas es restringido:
//   · Despacho en BORRADOR  → coordinador+ (se tomó mal la foto)
//   · Despacho CERRADO      → solo admin (el camión ya salió)
//   · Pulpeo                → solo admin (es evidencia de cadena de frío)
//
// El archivo va a la papelera de reciclaje de SharePoint: se puede
// recuperar desde ahí durante el periodo de retención del sitio.
const eliminar = async (req, res) => {
    try {
        if (!sharepointConfigurado()) return noConfigurado(res);

        const { origen, id_evidencia } = req.params;
        const llave = origen === "despachos" ? "id_despacho" : "id_pulpeo";
        const esAdmin = Number(req.id_role) === 1;

        const evidencia = await evidenciasModel.getById(origen, id_evidencia);

        if (!evidencia) {
            return res.status(404).json({ error: "Evidencia no encontrada" });
        }

        const resuelto = await resolverDocumento(origen, evidencia[llave], req.camaras);

        if (resuelto.error) {
            return res.status(resuelto.status).json({ error: resuelto.error });
        }

        if (!esAdmin) {
            if (origen === "pulpeos") {
                return res.status(403).json({
                    error: "Las evidencias de pulpeo son prueba de la cadena de frío: solo un administrador puede eliminarlas."
                });
            }

            if (Number(resuelto.documento.estado) === 2) {
                return res.status(403).json({
                    error: "El despacho ya está cerrado: solo un administrador puede eliminar sus evidencias."
                });
            }
        }

        // Primero SharePoint: si falla, la fila sigue y se puede reintentar.
        // Si el archivo ya no existía (404), se limpia la fila igual.
        try {
            await eliminarArchivo(evidencia.sharepoint_item_id);
        } catch (error) {
            if (error.status !== 404) throw error;
        }

        const eliminada = await evidenciasModel.eliminar(origen, id_evidencia);

        console.warn(
            `[evidencias.delete] Usuario ${req.id_usuario} eliminó ${origen}/${id_evidencia} (${eliminada.nombre_archivo}).`
        );

        res.status(200).json({
            mensaje: "Evidencia eliminada. El archivo quedó en la papelera de reciclaje de SharePoint.",
            evidencia: eliminada
        });
    } catch (error) {
        console.error("Error al eliminar la evidencia:", error);

        if (error.status) {
            return res.status(502).json({
                error: `SharePoint no permitió eliminar el archivo: ${error.message}`
            });
        }

        res.status(500).json({ error: "Error al eliminar la evidencia" });
    }
};

export const evidenciasController = {
    crearSesion,
    confirmarCarga,
    listar,
    obtenerUrl,
    eliminar
};
