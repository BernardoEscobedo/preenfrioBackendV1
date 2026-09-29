// ============================================================================
// CLIENTE DE SHAREPOINT (Microsoft Graph)
// ============================================================================
// Las evidencias (fotos y videos) viven en una biblioteca de documentos de
// SharePoint, no en el servidor. El backend nunca recibe el archivo:
//
//   1. El backend crea una SESIÓN DE CARGA en SharePoint y le da al
//      frontend la URL (preautenticada, caduca en horas).
//   2. El frontend sube el archivo DIRECTO a esa URL, en pedazos.
//   3. El frontend avisa al backend con el id del archivo; el backend lo
//      verifica en SharePoint y lo registra en la BD.
//
//   Para VER un archivo, el backend pide a Graph un enlace de descarga
//   temporal y se lo da al frontend. El enlace caduca en minutos: las fotos
//   nunca quedan públicas.
//
//   Resultado: Render no carga ni un byte de las fotos o videos.
//
// ---- VARIABLES DE ENTORNO (Render → Environment) ----
//   SP_TENANT_ID       Id del tenant de Chanitos (Azure AD / Entra ID)
//   SP_CLIENT_ID       Id de la aplicación registrada en Entra ID
//   SP_CLIENT_SECRET   Secreto de esa aplicación
//   SP_DRIVE_ID        Id de la biblioteca de documentos donde se guardan
//   SP_CARPETA_RAIZ    Carpeta base dentro de la biblioteca
//                      (opcional, por defecto "Preenfrio/Evidencias")
//
// ---- PERMISOS ----
//   La aplicación necesita el permiso de aplicación de Graph
//   "Sites.Selected", concedido SOLO sobre el sitio de evidencias. Es el
//   mínimo: la app no puede leer ningún otro sitio de la empresa.
//   (Files.ReadWrite.All también funciona, pero da acceso a TODO SharePoint.)
//
// Usa fetch nativo (Node 18+): no requiere dependencias nuevas.
// ============================================================================

const GRAPH = "https://graph.microsoft.com/v1.0";

const CARPETA_RAIZ = (process.env.SP_CARPETA_RAIZ || "Preenfrio/Evidencias")
    .replace(/^\/+|\/+$/g, "");

/** true si están todas las variables. Sin ellas, el módulo responde 503. */
export const sharepointConfigurado = () =>
    Boolean(
        process.env.SP_TENANT_ID &&
        process.env.SP_CLIENT_ID &&
        process.env.SP_CLIENT_SECRET &&
        process.env.SP_DRIVE_ID
    );

// ----------------------------------------------------------------------------
// Token de aplicación (client credentials), con caché
// ----------------------------------------------------------------------------
// El token dura ~1 hora. Se reutiliza hasta un minuto antes de vencer para
// no pedir uno nuevo en cada petición.
let cacheToken = { valor: null, expira: 0 };

const obtenerToken = async () => {
    if (cacheToken.valor && Date.now() < cacheToken.expira - 60_000) {
        return cacheToken.valor;
    }

    const respuesta = await fetch(
        `https://login.microsoftonline.com/${process.env.SP_TENANT_ID}/oauth2/v2.0/token`,
        {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: process.env.SP_CLIENT_ID,
                client_secret: process.env.SP_CLIENT_SECRET,
                scope: "https://graph.microsoft.com/.default",
                grant_type: "client_credentials"
            })
        }
    );

    const datos = await respuesta.json();

    if (!respuesta.ok) {
        const error = new Error(
            `No se pudo autenticar con Microsoft: ${datos.error_description || datos.error || respuesta.status}`
        );
        error.status = 502;
        throw error;
    }

    cacheToken = {
        valor: datos.access_token,
        expira: Date.now() + Number(datos.expires_in) * 1000
    };

    return cacheToken.valor;
};

// ----------------------------------------------------------------------------
// Llamada genérica a Graph
// ----------------------------------------------------------------------------
const graph = async (metodo, ruta, cuerpo = null) => {
    const token = await obtenerToken();

    const respuesta = await fetch(`${GRAPH}${ruta}`, {
        method: metodo,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(cuerpo ? { "Content-Type": "application/json" } : {})
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });

    // DELETE responde 204 sin cuerpo
    if (respuesta.status === 204) return null;

    const datos = await respuesta.json().catch(() => ({}));

    if (!respuesta.ok) {
        const error = new Error(
            `SharePoint respondió ${respuesta.status}: ${datos?.error?.message || "sin detalle"}`
        );
        error.status = respuesta.status;
        error.graphCode = datos?.error?.code;
        throw error;
    }

    return datos;
};

/** Codifica cada segmento de una ruta sin romper las diagonales. */
const codificarRuta = (ruta) =>
    ruta.split("/").filter(Boolean).map(encodeURIComponent).join("/");

const driveId = () => process.env.SP_DRIVE_ID;

// ----------------------------------------------------------------------------
// API pública del módulo
// ----------------------------------------------------------------------------

/** Ruta completa de una subcarpeta, dentro de la carpeta raíz. */
export const rutaEvidencias = (...segmentos) =>
    [CARPETA_RAIZ, ...segmentos].filter(Boolean).join("/");

/**
 * Crea una sesión de carga para subir un archivo directo desde el frontend.
 * Las carpetas intermedias que no existan las crea SharePoint.
 *
 * conflictBehavior 'fail': si ya existe un archivo con ese nombre, falla.
 * Los nombres los genera el backend y son únicos, así que nunca se pisa
 * una evidencia existente.
 *
 * @returns {{ uploadUrl: string, expirationDateTime: string }}
 */
export const crearSesionCarga = async (carpeta, nombreArchivo) => {
    const ruta = codificarRuta(`${carpeta}/${nombreArchivo}`);

    return graph(
        "POST",
        `/drives/${driveId()}/root:/${ruta}:/createUploadSession`,
        {
            item: {
                "@microsoft.graph.conflictBehavior": "fail",
                name: nombreArchivo
            }
        }
    );
};

/**
 * Metadatos de un archivo. Incluye "@microsoft.graph.downloadUrl", el
 * enlace de descarga preautenticado que caduca en unos minutos.
 */
export const obtenerArchivo = async (itemId) =>
    graph("GET", `/drives/${driveId()}/items/${encodeURIComponent(itemId)}`);

/** Elimina un archivo. Va a la papelera de reciclaje del sitio. */
export const eliminarArchivo = async (itemId) =>
    graph("DELETE", `/drives/${driveId()}/items/${encodeURIComponent(itemId)}`);

/** Id de la biblioteca configurada, para guardarlo junto a cada evidencia. */
export const idBiblioteca = () => driveId();
