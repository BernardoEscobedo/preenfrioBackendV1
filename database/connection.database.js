import 'dotenv/config'
import pg from 'pg'

const { Pool, Client } = pg

const db = new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    allowExitOnIdle: true
});

//verificar la conexion
try{
    await db.query('SELECT NOW()')
    console.log('✅ Conexión exitosa a PostgreSQL')
}catch(error){
    console.error('❌ Error en la conexión a la BD:', error)
}

//const client = new Client ();
export { db };