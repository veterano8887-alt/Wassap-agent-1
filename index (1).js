import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import fs from "fs";
import express from "express";
import cors from "cors";

const DB_FILE = "./db.json";
let qrActual = null;       // guarda el último QR recibido
let conectado = false;     // indica si el bot ya está conectado

// --- Base de datos simple en JSON ---
function loadDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]");
  return JSON.parse(fs.readFileSync(DB_FILE));
}
function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Estado de conversación por usuario (en memoria)
const sesiones = {}; // { numero: { paso: 'nombre'|'bloque', nombre: '' } }

// --- Servidor web para el HTML ---
const app = express();
app.use(cors());
app.use(express.static(".")); // sirve archivos desde la raíz del proyecto

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/gestor_clientes.html");
});

app.get("/api/nombres", (req, res) => {
  res.json(loadDB());
});

// Página que muestra el QR como imagen, se autorefresca sola
app.get("/qr", (req, res) => {
  if (conectado) {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding-top:60px;">
        <h1>✅ Ya está conectado a WhatsApp</h1>
        <p>No hace falta escanear nada más.</p>
      </body></html>
    `);
    return;
  }

  if (!qrActual) {
    res.send(`
      <html><head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding-top:60px;">
        <h2>Generando código QR...</h2>
        <p>Esta página se actualiza sola en unos segundos.</p>
      </body></html>
    `);
    return;
  }

  res.send(`
    <html>
    <head>
      <meta http-equiv="refresh" content="15">
      <title>Escanea el QR</title>
    </head>
    <body style="font-family:sans-serif;text-align:center;padding-top:40px;">
      <h1>📲 Escanea este código con WhatsApp</h1>
      <p>Ajustes → Dispositivos vinculados → Vincular un dispositivo</p>
      <img src="${qrActual}" style="width:300px;height:300px;" />
      <p style="color:#888;">Esta página se renueva sola cada 15 segundos con un QR nuevo si hace falta.</p>
    </body>
    </html>
  `);
});

app.listen(3000, () => console.log("Panel disponible en http://localhost:3000"));

// --- Bot de WhatsApp ---
async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true }); // sigue mostrándolo en logs por si acaso
      QRCode.toDataURL(qr, (err, url) => {
        if (!err) qrActual = url;
      });
    }

    if (connection === "close") {
      conectado = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Conexión cerrada, reconectando:", shouldReconnect);
      if (shouldReconnect) iniciarBot();
    } else if (connection === "open") {
      conectado = true;
      qrActual = null;
      console.log("✅ Conectado a WhatsApp");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const numero = msg.key.remoteJid;
    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (!texto) return;

    // Si no hay sesión, es el primer mensaje: bienvenida + pregunta del nombre
    if (!sesiones[numero]) {
      sesiones[numero] = { paso: "nombre" };

      await sock.sendMessage(numero, {
        text: "👋 ¡Hola! Bienvenido/a, quiero ofrecerte mi servicio.",
      });
      await sock.sendMessage(numero, {
        text: "Para registrarte, dime primero: ¿cuál es tu nombre?",
      });
      return;
    }

    const sesion = sesiones[numero];

    if (sesion.paso === "nombre") {
      sesion.nombre = texto.trim();
      sesion.paso = "puerta";
      await sock.sendMessage(numero, {
        text: `Genial, ${sesion.nombre}. ¿Cuál es el número de puerta de tu bloque?`,
      });
      return;
    }

    if (sesion.paso === "puerta") {
      const puerta = texto.trim();

      // Guardar en la "base de datos"
      const db = loadDB();
      db.push({
        numero,
        nombre: sesion.nombre,
        puerta,
        fecha: new Date().toLocaleString(),
      });
      saveDB(db);

      await sock.sendMessage(numero, {
        text: `✅ Registrado correctamente:\nNombre: ${sesion.nombre}\nPuerta: ${puerta}`,
      });

      delete sesiones[numero]; // reiniciamos la sesión
      return;
    }
  });
}

iniciarBot();
