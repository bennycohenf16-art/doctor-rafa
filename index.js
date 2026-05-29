require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason,
        fetchLatestBaileysVersion, isJidGroup } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const express = require('express');
const Groq = require('groq-sdk');
const fetch = require('node-fetch');
const { getCitas, getBooked, addCita, updateStatus, getPatient, savePatient, getConvState, setConvState, clearConvState, migrateJids, normalizeJid, db } = require('./db');
const schedule = require('./schedule.json');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ADMIN_RAW = (process.env.ADMIN_NUMBER || '').replace(/@.*/, '');
const ADMIN_JID = ADMIN_RAW ? `${ADMIN_RAW}@s.whatsapp.net` : null;
const NOMBRE = process.env.AGENTE_NOMBRE || 'Doctor Rafa';

let qrDataURL = null, botConnected = false, sockInstance = null;
const groqHistory = {};
const lidToPhone = {};
const PANEL_URL = process.env.PANEL_URL || '';
const PANEL_TOKEN = process.env.PANEL_TOKEN || '';
const GH_TOKEN = (process.env.GITHUB_TOKEN || '').replace(/[^\x20-\x7E]/g,'').trim();
const GH_USER = process.env.GITHUB_USER || '';
const BOT_NAME = process.env.BOT_NAME || 'bot';
const SESSION_REPO = 'bot-sessions';

async function restoreSession() {
  if (!GH_TOKEN || !GH_USER) return;
  const { Octokit } = require('@octokit/rest');
  const fs = require('fs');
  const oc = new Octokit({ auth: GH_TOKEN });
  try {
    fs.mkdirSync('./auth_info', { recursive: true });
    const list = await oc.repos.getContent({ owner: GH_USER, repo: SESSION_REPO, path: BOT_NAME });
    for (const f of list.data) {
      const fd = await oc.repos.getContent({ owner: GH_USER, repo: SESSION_REPO, path: f.path });
      fs.writeFileSync('./auth_info/' + f.name, Buffer.from(fd.data.content, 'base64'));
    }
    console.log('[session] Restaurada desde GitHub');
  } catch(e) { if (e.status !== 404) console.log('[session] Sin backup previo'); }
}

let _sessionTimer = null;
function scheduleSessionBackup() {
  if (_sessionTimer) clearTimeout(_sessionTimer);
  _sessionTimer = setTimeout(backupSession, 8000);
}

let _dataTimer = null;
function scheduleDataBackup() {
  if (_dataTimer) clearTimeout(_dataTimer);
  _dataTimer = setTimeout(backupData, 3000);
}

async function restoreData() {
  if (!GH_TOKEN || !GH_USER) { console.log('[data] Sin credenciales GitHub, omitiendo restore'); return; }
  console.log('[data] Restaurando desde GitHub...');
  const { Octokit } = require('@octokit/rest');
  const oc = new Octokit({ auth: GH_TOKEN });
  try {
    const res = await oc.repos.getContent({ owner: GH_USER, repo: SESSION_REPO, path: BOT_NAME + '/citas.json' });
    const citas = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
    const ins = db.prepare('INSERT OR IGNORE INTO citas (id,nombre,telefono,fecha,hora,motivo,status,created_at) VALUES (?,?,?,?,?,?,?,?)');
    db.transaction(() => { for (const c of citas) ins.run(c.id, c.nombre, c.telefono, c.fecha, c.hora, c.motivo||null, c.status, c.created_at); })();
    console.log('[data] Citas restauradas:', citas.length);
  } catch(e) { console.log('[data] citas.json:', e.status === 404 ? 'sin backup aún' : e.message); }
  try {
    const res = await oc.repos.getContent({ owner: GH_USER, repo: SESSION_REPO, path: BOT_NAME + '/patients.json' });
    const pts = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
    const ins = db.prepare('INSERT OR REPLACE INTO patients (jid,nombre,telefono,updated_at) VALUES (?,?,?,?)');
    db.transaction(() => { for (const p of pts) ins.run(normalizeJid(p.jid), p.nombre, p.telefono, p.updated_at); })();
    console.log('[data] Pacientes restaurados:', pts.length);
  } catch(e) { console.log('[data] patients.json:', e.status === 404 ? 'sin backup aún' : e.message); }
  try {
    const res = await oc.repos.getContent({ owner: GH_USER, repo: SESSION_REPO, path: BOT_NAME + '/conv_state.json' });
    const rows = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
    const ins = db.prepare('INSERT OR REPLACE INTO conv_state (jid,step,data,updated_at) VALUES (?,?,?,?)');
    db.transaction(() => { for (const r of rows) ins.run(normalizeJid(r.jid), r.step, r.data, r.updated_at); })();
    console.log('[data] Conversaciones restauradas:', rows.length);
  } catch(e) { console.log('[data] conv_state.json:', e.status === 404 ? 'sin backup aún' : e.message); }
  try {
    const res = await oc.repos.getContent({ owner: GH_USER, repo: SESSION_REPO, path: BOT_NAME + '/groq_history.json' });
    const hist = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
    for (const [jid, msgs] of Object.entries(hist)) groqHistory[jid] = msgs;
    console.log('[data] Historial Groq restaurado:', Object.keys(hist).length, 'chats');
  } catch(e) { console.log('[data] groq_history.json:', e.status === 404 ? 'sin backup aún' : e.message); }
}

async function backupData() {
  if (!GH_TOKEN || !GH_USER) return;
  const { Octokit } = require('@octokit/rest');
  const oc = new Octokit({ auth: GH_TOKEN });
  try {
    try { await oc.repos.createForAuthenticatedUser({ name: SESSION_REPO, private: true, auto_init: true }); await new Promise(r => setTimeout(r, 1500)); } catch {}
    for (const [file, getData] of [
      ['citas.json',      () => db.prepare('SELECT * FROM citas').all()],
      ['patients.json',   () => db.prepare('SELECT * FROM patients').all()],
      ['conv_state.json', () => db.prepare('SELECT * FROM conv_state').all()],
      ['groq_history.json', () => groqHistory]
    ]) {
      const rows = getData();
      const content = Buffer.from(JSON.stringify(rows)).toString('base64');
      let sha;
      try { sha = (await oc.repos.getContent({ owner: GH_USER, repo: SESSION_REPO, path: BOT_NAME + '/' + file })).data.sha; } catch {}
      await oc.repos.createOrUpdateFileContents({ owner: GH_USER, repo: SESSION_REPO, path: BOT_NAME + '/' + file, message: 'data', content, ...(sha ? { sha } : {}) });
    }
    console.log('[data] Backup OK');
  } catch(e) { console.log('[data] Backup error:', e.message); }
}

async function backupSession() {
  if (!GH_TOKEN || !GH_USER) return;
  const { Octokit } = require('@octokit/rest');
  const fs = require('fs');
  const oc = new Octokit({ auth: GH_TOKEN });
  try {
    try { await oc.repos.createForAuthenticatedUser({ name: SESSION_REPO, private: true, auto_init: true }); await new Promise(r => setTimeout(r, 1500)); } catch {}
    const files = fs.existsSync('./auth_info') ? fs.readdirSync('./auth_info').filter(f => f.endsWith('.json')) : [];
    for (const fname of files) {
      const content = Buffer.from(fs.readFileSync('./auth_info/' + fname)).toString('base64');
      let sha;
      try { sha = (await oc.repos.getContent({ owner: GH_USER, repo: SESSION_REPO, path: BOT_NAME + '/' + fname })).data.sha; } catch {}
      await oc.repos.createOrUpdateFileContents({ owner: GH_USER, repo: SESSION_REPO, path: BOT_NAME + '/' + fname, message: 'session', content, ...(sha ? { sha } : {}) });
    }
    console.log('[session] Backup OK');
  } catch(e) { console.log('[session] Backup error:', e.message); }
}

const DATA_FILES = new Set(['citas.json', 'patients.json', 'conv_state.json', 'groq_history.json']);

async function deleteGitHubSession() {
  if (!GH_TOKEN || !GH_USER) return;
  const { Octokit } = require('@octokit/rest');
  const oc = new Octokit({ auth: GH_TOKEN });
  try {
    const list = await oc.repos.getContent({ owner: GH_USER, repo: SESSION_REPO, path: BOT_NAME });
    for (const f of list.data) {
      if (DATA_FILES.has(f.name)) continue; // nunca borrar datos de citas/pacientes
      try { await oc.repos.deleteFile({ owner: GH_USER, repo: SESSION_REPO, path: f.path, message: 'reset session', sha: f.sha }); } catch {}
    }
    console.log('[session] Credenciales WhatsApp eliminadas — citas y pacientes conservados');
  } catch(e) { if (e.status !== 404) console.log('[session] deleteGitHubSession:', e.message); }
}


const DIAS_MAP = { lunes:1, martes:2, miercoles:3, jueves:4, viernes:5, sabado:6, domingo:0 };
const DIAS_ES = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

function parseDate(texto) {
  texto = texto.toLowerCase().trim();
  const now = new Date();
  if (/mañana/.test(texto)) {
    const d = new Date(now); d.setDate(d.getDate()+1); return toDateStr(d);
  }
  if (/hoy/.test(texto)) return toDateStr(now);
  // dd/mm/yyyy or dd-mm-yyyy
  const m1 = texto.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
  if (m1) {
    const day = parseInt(m1[1]), mon = parseInt(m1[2])-1, yr = m1[3] ? parseInt(m1[3]) : now.getFullYear();
    const d = new Date(yr < 100 ? 2000+yr : yr, mon, day);
    if (!isNaN(d.getTime())) return toDateStr(d);
  }
  // "el lunes", "el martes"
  for (const [name, num] of Object.entries(DIAS_MAP)) {
    if (texto.includes(name)) {
      const d = new Date(now);
      const diff = (num - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate()+diff); return toDateStr(d);
    }
  }
  return null;
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDateES(str) {
  const [y,m,d] = str.split('-');
  const dt = new Date(parseInt(y), parseInt(m)-1, parseInt(d));
  return `${d} de ${MESES[dt.getMonth()]} de ${y} (${DIAS_ES[dt.getDay()]})`;
}

async function getBookedSlots(dateStr) {
  return getBooked(dateStr);
}

async function saveCita(nombre, telefono, fecha, hora, motivo) {
  addCita(nombre, telefono, fecha, hora, motivo);
  scheduleDataBackup();
  if (PANEL_URL && PANEL_TOKEN) {
    try {
      const r = await fetch(`${PANEL_URL}/api/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: PANEL_TOKEN, nombre, telefono, fecha, hora, motivo })
      });
      const d = await r.json();
      if (r.ok) console.log('[panel] cita sincronizada OK', fecha, hora);
      else console.error('[panel] ERROR sync cita:', r.status, JSON.stringify(d));
    } catch(e) { console.error('[panel] sync error:', e.message); }
  }
}

async function getAvailableSlots(dateStr) {
  const dt = new Date(dateStr + 'T12:00:00');
  const diaNombre = DIAS_ES[dt.getDay()];
  const dayConfig = schedule.days?.[diaNombre];
  if (!dayConfig?.active) return [];

  const slotMin = schedule.slotDuration || 30;
  const [startH, startM] = dayConfig.start.split(':').map(Number);
  const [endH, endM] = dayConfig.end.split(':').map(Number);
  const lunchFrom = schedule.lunchBreak?.active ? schedule.lunchBreak.from : null;
  const lunchTo   = schedule.lunchBreak?.active ? schedule.lunchBreak.to : null;

  const booked = await getBookedSlots(dateStr);

  // Si la fecha es hoy, no mostrar horarios que ya pasaron (margen de 60 min)
  // dateStr es YYYY-MM-DD (toDateStr). Usamos hora real de México para comparar.
  const mexNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const todayStr = `${mexNow.getFullYear()}-${String(mexNow.getMonth()+1).padStart(2,'0')}-${String(mexNow.getDate()).padStart(2,'0')}`;
  const minCur = (dateStr === todayStr) ? mexNow.getHours() * 60 + mexNow.getMinutes() + 60 : 0;

  const slots = [];
  let cur = startH * 60 + startM;
  const end = endH * 60 + endM;

  while (cur + slotMin <= end) {
    const h = String(Math.floor(cur/60)).padStart(2,'0');
    const m = String(cur%60).padStart(2,'0');
    const timeStr = `${h}:${m}`;

    if (cur < minCur) { cur += slotMin; continue; }

    if (lunchFrom && lunchTo) {
      const [lh,lm] = lunchFrom.split(':').map(Number);
      const [leh,lem] = lunchTo.split(':').map(Number);
      if (cur >= lh*60+lm && cur < leh*60+lem) { cur += slotMin; continue; }
    }

    if (!booked.includes(timeStr)) slots.push(timeStr);
    cur += slotMin;
  }
  return slots;
}

async function askGroq(jid, msg) {
  if (!groqHistory[jid]) groqHistory[jid] = [];
  groqHistory[jid].push({ role:'user', content: msg });
  if (groqHistory[jid].length > 16) groqHistory[jid] = groqHistory[jid].slice(-16);
  const resp = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role:'system', content: `Eres la asistente de Doctor Rafa, clínica médica. Tu trabajo es detectar si el usuario quiere agendar una cita.
- Si el usuario quiere agendar (menciona síntomas, malestares, quiere ver al médico, pide disponibilidad, quiere una consulta, revisión o chequeo): responde ÚNICAMENTE la palabra AGENDA, sin nada más.
- Si es un saludo, pregunta de horarios, dirección u otra cosa: responde normalmente en español, amable y breve.
Teléfono de contacto: .` }, ...groqHistory[jid]],
    max_tokens: 600
  });
  const reply = resp.choices[0].message.content;
  groqHistory[jid].push({ role:'assistant', content: reply });
  return reply;
}

function normalizeLid(lid) {
  // Strip device suffix (:XX) and ensure @lid suffix — '277695455850701:23@lid' → '277695455850701@lid'
  return lid.replace(/:[0-9]+@lid$/, '@lid').replace(/:[0-9]+$/, '');
}

function resolvePhone(jid) {
  if (jid.endsWith('@s.whatsapp.net'))
    return jid.replace(/:[0-9]+@s\.whatsapp\.net$/, '').replace('@s.whatsapp.net', '');
  if (jid.endsWith('@lid')) {
    const key = normalizeLid(jid);
    const p = lidToPhone[key] || lidToPhone[jid];
    return p ? p.replace(/:[0-9]+$/, '') : null;
  }
  return jid.replace(/:[0-9]+(@.*)?$/, '').replace(/@.*$/, '') || null;
}


app.get('/', (req, res) => {
  if (qrDataURL) {
    res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f0f2f5;font-family:sans-serif;">
      <h2>Escanea el QR con WhatsApp</h2>
      <img src="${qrDataURL}" style="width:300px;height:300px;border:4px solid #25d366;border-radius:12px">
      <p style="color:#666">Actualiza si el código expiró</p>
    </body></html>`);
  } else {
    res.send('<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f0f2f5;font-family:sans-serif;"><h2 style="color:#25d366">✅ Bot conectado</h2></body></html>');
  }
});

app.listen(process.env.PORT || 3000);

// ── Bot logic ─────────────────────────────────────────────────────────────────
const STEPS = { IDLE:0, NOMBRE:1, TELEFONO:2, FECHA:3, HORA:4, MOTIVO:5 };

async function handleMessage(sock, jid, texto) {
  const normJid = normalizeJid(jid);
  const state = getConvState(jid);
  console.log(`[state] raw=${jid} norm=${normJid} step=${state.step}`);

  if (state.step === STEPS.IDLE) {
    const respGroq = await askGroq(jid, texto);
    if (respGroq.trim().toUpperCase() === 'AGENDA') {
      const known = getPatient(jid);
      if (known) {
        setConvState(jid, { step: STEPS.FECHA, nombre: known.nombre, telefono: known.telefono });
        return `¡Hola de nuevo, *${known.nombre}*! 😊 ¿Para qué *fecha* te gustaría tu cita?\n_Puedes escribir la fecha (ej: 15/01/2025), decir "mañana" o el día de la semana._`;
      }
      setConvState(jid, { step: STEPS.NOMBRE });
      return '¡Hola! Con gusto te ayudo a agendar tu cita 😊 ¿Me das tu *nombre completo*?';
    }
    return respGroq;
  }

  if (state.step === STEPS.NOMBRE) {
    setConvState(jid, { ...state, nombre: texto, step: STEPS.TELEFONO });
    return `Gracias, ${texto}. ¿Cuál es tu *número de teléfono*? 📱\n_Incluye código de país, sin espacios ni +. Ej: 5215551234567_`;
  }

  if (state.step === STEPS.TELEFONO) {
    const digits = texto.replace(/[^0-9]/g, '');
    const telefono = digits.length >= 7 ? digits : (resolvePhone(jid) || jid.replace(/:[0-9]+(@.*)?$/, '').replace(/@.*$/, ''));
    setConvState(jid, { ...state, telefono, step: STEPS.FECHA });
    return `Perfecto. ¿Para qué *fecha* te gustaría la cita?\n_Puedes escribir la fecha (ej: 15/01/2025), decir "mañana" o el día de la semana (ej: "el martes")._`;
  }

  if (state.step === STEPS.FECHA) {
    const fecha = parseDate(texto);
    if (!fecha) return 'No entendí la fecha 😅 Por favor escríbela así: *dd/mm/yyyy* (ej: 15/01/2025), o di "mañana" o el día de la semana.';
    // Consulta DB en tiempo real para slots disponibles
    const slots = await getAvailableSlots(fecha);
    if (slots.length === 0) {
      return `Lo siento, *no hay horarios disponibles* para el ${formatDateES(fecha)}.\n¿Quieres intentar con otra fecha?`;
    }
    setConvState(jid, { ...state, fecha, slots, step: STEPS.HORA });
    return `Horarios disponibles para el *${formatDateES(fecha)}*:\n\n${slots.map((s,i)=>`${i+1}. ${s}`).join('\n')}\n\nEscribe el *número* o la *hora* que prefieres.`;
  }

  if (state.step === STEPS.HORA) {
    // Re-consulta DB para verificar que los slots sigan disponibles
    const slots = await getAvailableSlots(state.fecha);
    let selected = null;
    const num = parseInt(texto);
    if (!isNaN(num) && num >= 1 && num <= slots.length) selected = slots[num-1];
    else selected = slots.find(s => texto.replace(/[^0-9:]/g,'').includes(s.replace(':',''))) || slots.find(s => s.startsWith(texto.replace(/[^0-9:]/g,'').padStart(2,'0').slice(0,2)));
    if (!selected) return `No encontré ese horario. Por favor elige un número del *1 al ${slots.length}*.`;
    setConvState(jid, { ...state, hora: selected, step: STEPS.MOTIVO });
    return '¿Cuál es el *motivo* de tu consulta?';
  }

  if (state.step === STEPS.MOTIVO) {
    // Verificación final en DB antes de guardar (anti doble-booking)
    const booked = await getBookedSlots(state.fecha);
    if (booked.includes(state.hora)) {
      clearConvState(jid);
      return `Lo siento 😔 el horario *${state.hora}* del ${formatDateES(state.fecha)} acaba de ser tomado por otro paciente.\n\nEscríbeme de nuevo para ver los horarios disponibles actualizados.`;
    }
    const phone = state.telefono || resolvePhone(jid) || jid.replace(/:[0-9]+(@.*)?$/, '').replace(/@.*$/, '');
    await saveCita(state.nombre, phone, state.fecha, state.hora, texto);
    savePatient(jid, state.nombre, phone);
    clearConvState(jid);
    scheduleDataBackup();
    return `✅ *Cita agendada exitosamente*\n\n👤 *Paciente:* ${state.nombre}\n📅 *Fecha:* ${formatDateES(state.fecha)}\n⏰ *Hora:* ${state.hora}\n🩺 *Motivo:* ${texto}\n\n_Te confirmaremos tu cita a la brevedad. ¡Gracias!_`;
  }

  return await askGroq(jid, texto);
}

async function startBot() {
  await restoreSession();
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: true, logger: pino({ level:'silent' }), browser:['Bot','Chrome','3.0'] });
  sock.ev.on('creds.update', () => { saveCreds(); scheduleSessionBackup(); });
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrDataURL = await QRCode.toDataURL(qr);
    if (connection === 'open') {
      qrDataURL = null; botConnected = true; sockInstance = sock;
      setInterval(backupData, 5 * 60 * 1000); // backup cada 5 minutos
    }
    if (connection === 'close') {
      botConnected = false; sockInstance = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        require('fs').rmSync('./auth_info', { recursive: true, force: true });
        await deleteGitHubSession();
      }
      setTimeout(startBot, 3000);
    }
  });
  function storeContact(c) {
    if (!c.lid || !c.id || !c.id.endsWith('@s.whatsapp.net')) return;
    const phone = c.id.replace(/:[0-9]+@s\.whatsapp\.net$/, '').replace('@s.whatsapp.net', '');
    lidToPhone[normalizeLid(c.lid)] = phone; // normalized key
    lidToPhone[c.lid] = phone;               // also raw key just in case
  }
  sock.ev.on('contacts.upsert', cs => cs.forEach(storeContact));
  sock.ev.on('contacts.update', cs => cs.forEach(storeContact));
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.key.remoteJid || isJidGroup(msg.key.remoteJid)) continue;
      const jid = msg.key.remoteJid;
      const texto = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
      if (!texto) continue;
      try {
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
        if (/cat[aá]logo|pdf|informaci[oó]n|brochure|folleto/i.test(texto)) {
          const fs = require('fs');
          const cats = JSON.parse(fs.readFileSync('./catalogs/index.json','utf8'));
          if (cats.length > 0) {
            for (const cat of cats) {
              await sock.sendMessage(jid, { document: fs.readFileSync(`./catalogs/${cat.filename}`), mimetype:'application/pdf', fileName: cat.name.endsWith('.pdf') ? cat.name : cat.name+'.pdf' });
            }
            await sock.sendMessage(jid, { text: '📄 Aquí está la información.' });
            await sock.sendPresenceUpdate('paused', jid);
            continue;
          }
        }
        const reply = await handleMessage(sock, jid, texto);
        if (reply) await sock.sendMessage(jid, { text: reply });
        await sock.sendPresenceUpdate('paused', jid);
      } catch(err) {
        console.error(err);
        await sock.sendPresenceUpdate('paused', jid);
        await sock.sendMessage(jid, { text: 'Ocurrió un error. Intenta de nuevo.' });
      }
    }
  });
}

restoreData()
  .catch(e => console.log('[data] restore error:', e.message))
  .finally(() => {
    migrateJids(); // normaliza JIDs del backup DESPUÉS de restaurar
    return restoreSession()
      .catch(e => console.log('[session] restore error:', e.message))
      .finally(() => startBot());
  });