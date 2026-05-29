const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'citas.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS citas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    telefono TEXT NOT NULL,
    fecha TEXT NOT NULL,
    hora TEXT NOT NULL,
    motivo TEXT,
    status TEXT DEFAULT 'pendiente',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS patients (
    jid TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    telefono TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS conv_state (
    jid TEXT PRIMARY KEY,
    step INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
function getCitas(fecha) {
  if (fecha) return db.prepare('SELECT * FROM citas WHERE fecha = ? ORDER BY hora ASC').all(fecha);
  return db.prepare('SELECT * FROM citas ORDER BY fecha ASC, hora ASC').all();
}
function getBooked(fecha) {
  return db.prepare("SELECT hora FROM citas WHERE fecha = ? AND status != 'cancelada'").all(fecha).map(r => r.hora);
}
function addCita(nombre, telefono, fecha, hora, motivo) {
  return db.prepare('INSERT INTO citas (nombre,telefono,fecha,hora,motivo) VALUES (?,?,?,?,?)').run(nombre,telefono,fecha,hora,motivo);
}
function updateStatus(id, status) {
  db.prepare('UPDATE citas SET status = ? WHERE id = ?').run(status, id);
}
// Normaliza JID eliminando el número de dispositivo que cambia en cada reconexión:
// '521234567890:5@s.whatsapp.net' → '521234567890@s.whatsapp.net'
// '277695455850701:23@lid'        → '277695455850701@lid'
function normalizeJid(jid) {
  if (!jid) return '';
  return jid.replace(/:[0-9]+(@s.whatsapp.net|@lid)$/, '$1');
}

// Migración al arrancar: normaliza JIDs viejos que incluyan número de dispositivo
(function migrateJids() {
  for (const table of ['patients', 'conv_state']) {
    const rows = db.prepare('SELECT jid FROM ' + table).all();
    for (const row of rows) {
      const norm = normalizeJid(row.jid);
      if (norm !== row.jid) {
        try {
          db.prepare('UPDATE ' + table + ' SET jid = ? WHERE jid = ?').run(norm, row.jid);
        } catch {
          db.prepare('DELETE FROM ' + table + ' WHERE jid = ?').run(row.jid);
        }
      }
    }
  }
})();

function getPatient(jid) {
  return db.prepare('SELECT nombre, telefono FROM patients WHERE jid = ?').get(normalizeJid(jid)) || null;
}
function savePatient(jid, nombre, telefono) {
  db.prepare('INSERT OR REPLACE INTO patients (jid, nombre, telefono, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(normalizeJid(jid), nombre, telefono);
}
function getConvState(jid) {
  const row = db.prepare('SELECT step, data FROM conv_state WHERE jid = ?').get(normalizeJid(jid));
  if (!row) return { step: 0 };
  try { return { step: row.step, ...JSON.parse(row.data) }; } catch { return { step: 0 }; }
}
function setConvState(jid, state) {
  const { step = 0, ...data } = state;
  db.prepare('INSERT OR REPLACE INTO conv_state (jid, step, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
    .run(normalizeJid(jid), step, JSON.stringify(data));
}
function clearConvState(jid) {
  db.prepare('DELETE FROM conv_state WHERE jid = ?').run(normalizeJid(jid));
}
// Exportada para poder llamarla después del restore
function migrateJids() {
  for (const table of ['patients', 'conv_state']) {
    const rows = db.prepare('SELECT jid FROM ' + table).all();
    for (const row of rows) {
      const norm = normalizeJid(row.jid);
      if (norm !== row.jid) {
        try { db.prepare('UPDATE ' + table + ' SET jid = ? WHERE jid = ?').run(norm, row.jid); }
        catch { db.prepare('DELETE FROM ' + table + ' WHERE jid = ?').run(row.jid); }
      }
    }
  }
}
migrateJids(); // también al arrancar por si hay datos locales viejos
module.exports = { getCitas, getBooked, addCita, updateStatus, getPatient, savePatient, getConvState, setConvState, clearConvState, migrateJids, normalizeJid, db };