// ⚠️ Esta línea va PRIMERO: en ESM los imports se evalúan antes que el
// cuerpo del archivo, y la conexión a la BD necesita el .env ya cargado.
import "dotenv/config";

import express from "express";
import cors from "cors";

// La conexión se importa por su efecto: al cargarse prueba la BD y avisa
// en consola si algo anda mal.
import "./database/connection.database.js";

import { sharepointConfigurado } from "./utils/sharepoint.js";

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

// ---- v3.0 · Evidencias en SharePoint y bajas con historial ----
import evidenciasRouter from "./routes/evidencias.route.js";
import bajasRouter from "./routes/bajas.route.js";

// ============================================================================
// VERIFICACIÓN DE ARRANQUE
// ============================================================================
// Sin JWT_SECRET todo respondería "Token inválido" y parecería un problema
// de sesión. Es mejor que el servidor no arranque y lo diga claro.
if (!process.env.JWT_SECRET) {
    console.error("❌ Falta la variable de entorno JWT_SECRET. El servidor no puede arrancar sin ella.");
    process.exit(1);
}

// SharePoint es opcional para arrancar: sin él todo funciona menos las
// evidencias, que responden 503 con un mensaje claro.
if (!sharepointConfigurado()) {
    console.warn("⚠️  SharePoint no configurado (SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_DRIVE_ID): las evidencias estarán deshabilitadas.");
}

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// MIDDLEWARES GLOBALES
// ============================================================================

// CORS: varios orígenes separados por coma en el .env, SIN comillas.
//   CORS_ORIGIN=http://localhost:5173,http://192.168.1.50:5173
const origenesPermitidos = (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (origenesPermitidos.includes(origin)) return callback(null, true);
            callback(new Error(`Origen no permitido por CORS: ${origin}`));
        },
        credentials: true
    })
);

// 10mb pensando en cargas masivas de producción desde Excel. Las fotos y
// videos NO pasan por aquí: van directo del navegador a SharePoint.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// v3.0: se retiró app.use("/uploads", express.static(...)). Las evidencias
// ya no viven en disco, y esa carpeta era pública: cualquiera con la URL
// veía la foto sin sesión.

// ============================================================================
// RUTAS
// ============================================================================
const API = "/api/preenfrio";

app.use(`${API}/auth`, authRouter);

// ---- Bloques 1 y 2 ----
app.use(`${API}/empleados`, empleadosRouter);
app.use(`${API}/usuarios`, usuariosRouter);
app.use(`${API}/camaras`, camarasRouter);

// ---- Bloque 3 · alimentan el código de lote de 15 dígitos ----
app.use(`${API}/productores`, productoresRouter);
app.use(`${API}/fincas`, fincasRouter);
app.use(`${API}/sku`, skuRouter);

// ---- Bloque 4 ----
app.use(`${API}/cedis`, cedisRouter);
app.use(`${API}/transportes`, transportesRouter);

// ---- Bloques 5 a 11 · operación ----
app.use(`${API}/produccion`, produccionRouter);
app.use(`${API}/recepciones`, recepcionesRouter);
app.use(`${API}/ocupaciones`, ocupacionesRouter);
app.use(`${API}/movimientos`, movimientosRouter);
app.use(`${API}/despachos`, despachosRouter);
app.use(`${API}/bloques`, bloquesRouter);
app.use(`${API}/pulpeos`, pulpeosRouter);
app.use(`${API}/mantenimientos`, mantenimientosRouter);

// ---- v3.0 ----
// Fotos y videos de despachos y pulpeos, almacenados en SharePoint
app.use(`${API}/evidencias`, evidenciasRouter);
// Bajas de cámaras y empleados + historial (solo admin)
app.use(`${API}/bajas`, bajasRouter);

// Salud del servicio: verifica que responde sin tocar la BD.
app.get(`${API}/health`, (req, res) => {
    res.status(200).json({
        estado: "ok",
        servicio: "Preenfrío API",
        version: "3.0",
        sharepoint: sharepointConfigurado(),
        hora: new Date().toISOString()
    });
});

// ============================================================================
// MANEJO DE ERRORES
// ============================================================================

app.use((req, res) => {
    res.status(404).json({
        error: `Ruta no encontrada: ${req.method} ${req.originalUrl}`
    });
});

// Va AL FINAL y con 4 parámetros: Express lo reconoce por la firma.
app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") {
        return res.status(400).json({
            error: "El cuerpo de la petición no es un JSON válido"
        });
    }

    if (err.type === "entity.too.large") {
        return res.status(413).json({
            error: "La petición excede el tamaño permitido (10 MB)"
        });
    }

    if (err.message?.startsWith("Origen no permitido")) {
        return res.status(403).json({ error: err.message });
    }

    console.error("❌ Error no controlado:", err);

    res.status(500).json({
        error: "Error interno del servidor",
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
    console.log(`   SharePoint: ${sharepointConfigurado() ? "configurado" : "NO configurado"}`);
});
