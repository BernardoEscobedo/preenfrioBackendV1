import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// La conexión se importa por su efecto: al cargarse prueba la BD y avisa
// en consola si algo anda mal. Mejor enterarse al arrancar que en la
// primera petición del usuario.
import "./database/connection.database.js";

// ---- Rutas ----
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


dotenv.config();

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

// ---- Bloque 1 y 2 · Seguridad, personal e infraestructura fría ----
app.use(`${API}/empleados`, empleadosRouter);
app.use(`${API}/usuarios`, usuariosRouter);
app.use(`${API}/camaras`, camarasRouter);
app.use(`${API}/productores`, productoresRouter);
app.use(`${API}/fincas`, fincasRouter);
app.use(`${API}/sku`, skuRouter);
app.use(`${API}/cedis`, cedisRouter);
app.use(`${API}/transportes`, transportesRouter);
app.use(`${API}/produccion`, produccionRouter);


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
    console.error("❌ Error no controlado:", err);

    // El error de CORS llega aquí: conviene responderlo claro en vez de
    // como un 500 genérico, porque es un problema de configuración.
    if (err.message?.startsWith("Origen no permitido")) {
        return res.status(403).json({ error: err.message });
    }

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
