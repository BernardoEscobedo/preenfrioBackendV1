// ⚠️ Esta línea va PRIMERO, antes que cualquier otro import.
// En ESM los imports se evalúan antes que el cuerpo del archivo: con
// dotenv.config() más abajo, la conexión a la BD se cargaba ANTES que el
// .env. Funcionaba solo porque jwt.middleware llama a dotenv por su cuenta.
// Así no depende de esa casualidad.
import "dotenv/config";

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// La conexión se importa por su efecto: al cargarse prueba la BD y avisa
// en consola si algo anda mal. Mejor enterarse al arrancar que en la
// primera petición del usuario.
import "./database/connection.database.js";

// ---- Bloques 1 y 2 · Seguridad, personal e infraestructura fría ----
import authRouter from "./routes/auth.route.js";
import empleadosRouter from "./routes/empleados.route.js";
import usuariosRouter from "./routes/usuarios.route.js";
import camarasRouter from "./routes/camaras.route.js";

// ---- Bloque 3 · Catálogos de origen y producto ----
import productoresRouter from "./routes/productores.route.js";
import fincasRouter from "./routes/fincas.route.js";
import skuRouter from "./routes/sku.route.js";

// ---- Bloque 4 · Clientes y transporte ----
import cedisRouter from "./routes/cedis.route.js";
import transportesRouter from "./routes/transportes.route.js";

// ---- Bloque 5 · Producción ----
import produccionRouter from "./routes/produccion.route.js";

// ---- Bloque 6 · Recepciones ----
import recepcionesRouter from "./routes/recepciones.route.js";

// ---- Bloque 7 · Ocupaciones y cola ----
import ocupacionesRouter from "./routes/ocupaciones.route.js";

// ---- Bloque 8 · Movimientos de inventario ----
import movimientosRouter from "./routes/movimientos.route.js";

// ---- Bloque 9 · Despachos ----
import despachosRouter from "./routes/despachos.route.js";

// ---- Bloque 10 · Bloques físicos y pulpeos ----
import bloquesRouter from "./routes/bloques.route.js";
import pulpeosRouter from "./routes/pulpeos.route.js";

// ---- Bloque 11 · Mantenimientos ----
import mantenimientosRouter from "./routes/mantenimientos.route.js";

// ============================================================================
// VERIFICACIÓN DE ARRANQUE
// ============================================================================
// Sin JWT_SECRET, jwt.verify falla en cada petición y todo responde "Token
// inválido": parece un problema de sesión y se pierde tiempo buscándolo en
// el frontend. En Render pasa cuando la variable no se capturó en el panel.
// Es mejor que el servidor no arranque y lo diga claro.
if (!process.env.JWT_SECRET) {
    console.error("❌ Falta la variable de entorno JWT_SECRET. El servidor no puede arrancar sin ella.");
    process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// MIDDLEWARES GLOBALES
// ============================================================================

// CORS: se aceptan varios orígenes separados por coma en el .env, para
// cubrir el dev local y el equipo de otra máquina en la red.
//   CORS_ORIGIN=http://localhost:5173,http://192.168.1.50:5173
//
// ⚠️ Sin comillas en el .env: si se escriben, quedan dentro del valor y
// el origen nunca coincide.
const origenesPermitidos = (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

app.use(
    cors({
        origin: (origin, callback) => {
            // Sin origin: Postman, curl o peticiones del mismo servidor
            if (!origin) return callback(null, true);
            if (origenesPermitidos.includes(origin)) return callback(null, true);
            callback(new Error(`Origen no permitido por CORS: ${origin}`));
        },
        credentials: true
    })
);

// El límite sube a 10mb pensando en cargas masivas de producción desde
// Excel. Las fotos NO pasan por aquí: usan multipart (multer).
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ============================================================================
// ARCHIVOS ESTÁTICOS
// ============================================================================
// Las evidencias fotográficas viven en disco, no en la BD: la tabla solo
// guarda la ruta. Sin esta línea las fotos se suben bien pero se ven rotas.
//
// ⚠️ Esta carpeta es PÚBLICA: cualquiera con la URL ve la foto, sin token.
// No es urgente mientras no exista el endpoint de subida, pero cuando se
// implemente conviene servir las evidencias desde una ruta con verifyToken
// en lugar de express.static.
//
// ⚠️ Incluir backend/uploads/ en los respaldos: si solo se respalda la BD,
// al restaurar quedan los registros sin sus imágenes.
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ============================================================================
// RUTAS
// ============================================================================
// Prefijo común: /api/preenfrio
// El frontend lo trae en la baseURL de axios, así que los services solo
// escriben la parte del módulo.
const API = "/api/preenfrio";

app.use(`${API}/auth`, authRouter);

// ---- Bloques 1 y 2 · Seguridad, personal e infraestructura fría ----
app.use(`${API}/empleados`, empleadosRouter);
app.use(`${API}/usuarios`, usuariosRouter);
app.use(`${API}/camaras`, camarasRouter);

// ---- Bloque 3 · Catálogos de origen y producto ----
// Alimentan el código de lote de 15 dígitos:
//   fincas.zona      → letra inicial (A/B/C)
//   productores      → 2 dígitos del código
//   fincas           → 3 dígitos del código
//   sku_pt.turno     → último dígito
app.use(`${API}/productores`, productoresRouter);
app.use(`${API}/fincas`, fincasRouter);
app.use(`${API}/sku`, skuRouter);

// ---- Bloque 4 · Clientes y transporte ----
// cedis_cliente.acronimo es la llave que cruza con el Excel de planeación.
app.use(`${API}/cedis`, cedisRouter);
app.use(`${API}/transportes`, transportesRouter);

// ---- Bloque 5 · Producción ----
// Primer módulo con alcance por cámara.
app.use(`${API}/produccion`, produccionRouter);

// ---- Bloque 6 · Recepciones ----
// Un INSERT aquí mueve inventario vía triggers.
app.use(`${API}/recepciones`, recepcionesRouter);

// ---- Bloque 7 · Ocupaciones y cola ----
// Tablero de cámaras, cola de espera y criticidad por holgura (v2.3).
app.use(`${API}/ocupaciones`, ocupacionesRouter);

// ---- Bloque 8 · Movimientos de inventario ----
// Traslados preenfrío → conserva. Corrección por movimiento inverso (v2.5).
app.use(`${API}/movimientos`, movimientosRouter);

// ---- Bloque 9 · Despachos ----
// Documento, picking multi-cámara y auditoría.
app.use(`${API}/despachos`, despachosRouter);

// ---- Bloque 10 · Bloques físicos y pulpeos ----
// Control de temperatura: la evidencia de la cadena de frío.
app.use(`${API}/bloques`, bloquesRouter);
app.use(`${API}/pulpeos`, pulpeosRouter);

// ---- Bloque 11 · Mantenimientos ----
// Paros temporales de cámara. Es el módulo que bloquea capacidad.
app.use(`${API}/mantenimientos`, mantenimientosRouter);

// Salud del servicio: sirve para verificar que responde sin tocar la BD.
app.get(`${API}/health`, (req, res) => {
    res.status(200).json({
        estado: "ok",
        servicio: "Preenfrío API",
        hora: new Date().toISOString()
    });
});

// ============================================================================
// MANEJO DE ERRORES
// ============================================================================

// 404: cualquier ruta que no exista
app.use((req, res) => {
    res.status(404).json({
        error: `Ruta no encontrada: ${req.method} ${req.originalUrl}`
    });
});

// Error handler global. Va AL FINAL y lleva los 4 parámetros: Express lo
// reconoce como manejador de errores por la firma, no por la posición.
app.use((err, req, res, next) => {
    // Un JSON mal formado es error del cliente, no del servidor. Antes caía
    // como 500 y parecía una falla del backend.
    if (err.type === "entity.parse.failed") {
        return res.status(400).json({
            error: "El cuerpo de la petición no es un JSON válido"
        });
    }

    // Body más grande que el límite de express.json
    if (err.type === "entity.too.large") {
        return res.status(413).json({
            error: "La petición excede el tamaño permitido (10 MB)"
        });
    }

    // El error de CORS llega aquí: conviene responderlo claro en vez de
    // como un 500 genérico, porque es un problema de configuración.
    if (err.message?.startsWith("Origen no permitido")) {
        return res.status(403).json({ error: err.message });
    }

    console.error("❌ Error no controlado:", err);

    res.status(500).json({
        error: "Error interno del servidor",
        // El detalle solo en desarrollo: en producción no conviene exponer
        // trazas internas al cliente.
        detalle: process.env.NODE_ENV === "production" ? undefined : err.message
    });
});

// ============================================================================
// ARRANQUE
// ============================================================================
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`   API:  http://localhost:${PORT}${API}`);
    console.log(`   CORS: ${origenesPermitidos.join(", ")}`);
});
