const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { pool } = require("./pool");

const DATA_FILE = path.join(__dirname, "..", "data.json");

const ADVISORY_ID_LOCK = 910001;

function normalizeDataShape(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  return {
    clients: Array.isArray(safe.clients) ? safe.clients : [],
    services: Array.isArray(safe.services) ? safe.services : [],
    parts: Array.isArray(safe.parts) ? safe.parts : [],
    mechanics: Array.isArray(safe.mechanics) ? safe.mechanics : [],
    appointments: Array.isArray(safe.appointments) ? safe.appointments : [],
    history: Array.isArray(safe.history) ? safe.history : [],
    notifications: Array.isArray(safe.notifications) ? safe.notifications : [],
  };
}

async function createSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      duration INTEGER NOT NULL DEFAULT 0,
      price INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS parts (
      id INTEGER PRIMARY KEY,
      article TEXT NOT NULL,
      name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS mechanics (
      id INTEGER PRIMARY KEY,
      full_name TEXT NOT NULL,
      position TEXT NOT NULL DEFAULT '',
      hire_date TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      base_salary INTEGER,
      bonus_per_service INTEGER
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY,
      datetime TEXT NOT NULL,
      client_name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      car_model TEXT NOT NULL DEFAULT '',
      car_year TEXT NOT NULL DEFAULT '',
      license_plate TEXT NOT NULL DEFAULT '',
      vin TEXT NOT NULL DEFAULT '',
      service_id INTEGER,
      mechanic_id INTEGER,
      status TEXT NOT NULL DEFAULT 'CREATED',
      comment TEXT NOT NULL DEFAULT '',
      required_parts JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY,
      appointment_id INTEGER NOT NULL,
      datetime TEXT NOT NULL,
      license_plate TEXT NOT NULL DEFAULT '',
      service_id INTEGER,
      mechanic_id INTEGER,
      status TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id BIGINT PRIMARY KEY,
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      employee_id TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('MANAGER', 'ASSISTANT')),
      display_name TEXT NOT NULL DEFAULT '',
      mechanic_id INTEGER REFERENCES mechanics(id)
    );
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id_lower ON users (LOWER(employee_id));
  `);
}

async function migrateSchema(client) {
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mechanic_id INTEGER REFERENCES mechanics(id);
  `);
}

async function ensureHistoryAppointmentUnique(client) {
  await client.query(`
    DELETE FROM history h
    USING history h2
    WHERE h.appointment_id = h2.appointment_id
      AND h.id > h2.id;
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS history_appointment_id_unique
    ON history (appointment_id);
  `);
}

async function replaceAllDataFromJson(client, rawData) {
  const data = normalizeDataShape(rawData);
  await client.query("BEGIN");
  try {
    await client.query(
      "UPDATE users SET mechanic_id = NULL WHERE mechanic_id IS NOT NULL"
    );
    await client.query(`
      TRUNCATE TABLE
        clients,
        services,
        parts,
        mechanics,
        appointments,
        history,
        notifications
      RESTART IDENTITY;
    `);

    for (const c of data.clients) {
      await client.query(
        "INSERT INTO clients (id, name, phone, note) VALUES ($1, $2, $3, $4)",
        [Number(c.id), c.name || "", c.phone || "", c.note || ""]
      );
    }

    for (const s of data.services) {
      await client.query(
        "INSERT INTO services (id, name, description, duration, price) VALUES ($1, $2, $3, $4, $5)",
        [
          Number(s.id),
          s.name || "",
          s.description || "",
          Number(s.duration) || 0,
          Number(s.price) || 0,
        ]
      );
    }

    for (const p of data.parts) {
      await client.query(
        "INSERT INTO parts (id, article, name, price, quantity) VALUES ($1, $2, $3, $4, $5)",
        [
          Number(p.id),
          p.article || "",
          p.name || "",
          Number(p.price) || 0,
          Number(p.quantity) || 0,
        ]
      );
    }

    for (const m of data.mechanics) {
      await client.query(
        "INSERT INTO mechanics (id, full_name, position, hire_date, active, base_salary, bonus_per_service) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          Number(m.id),
          m.fullName || "",
          m.position || "",
          m.hireDate || "",
          !!m.active,
          m.baseSalary == null ? null : Number(m.baseSalary),
          m.bonusPerService == null ? null : Number(m.bonusPerService),
        ]
      );
    }

    for (const a of data.appointments) {
      await client.query(
        "INSERT INTO appointments (id, datetime, client_name, phone, car_model, car_year, license_plate, vin, service_id, mechanic_id, status, comment, required_parts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)",
        [
          Number(a.id),
          a.datetime || "",
          a.clientName || "",
          a.phone || "",
          a.carModel || "",
          a.carYear || "",
          a.licensePlate || "",
          a.vin || "",
          a.serviceId == null ? null : Number(a.serviceId),
          a.mechanicId == null ? null : Number(a.mechanicId),
          a.status || "CREATED",
          a.comment || "",
          JSON.stringify(Array.isArray(a.requiredParts) ? a.requiredParts : []),
        ]
      );
    }

    for (const h of data.history) {
      const st = (h.status || "").toUpperCase();
      if (st !== "COMPLETED") continue;
      const aid = Number(h.appointmentId) || 0;
      if (!aid) continue;
      await client.query(
        `INSERT INTO history (id, appointment_id, datetime, license_plate, service_id, mechanic_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED')
         ON CONFLICT (appointment_id) DO NOTHING`,
        [
          Number(h.id),
          aid,
          h.datetime || "",
          h.licensePlate || "",
          h.serviceId == null ? null : Number(h.serviceId),
          h.mechanicId == null ? null : Number(h.mechanicId),
        ]
      );
    }

    for (const n of data.notifications) {
      await client.query(
        "INSERT INTO notifications (id, message, timestamp) VALUES ($1, $2, $3)",
        [Number(n.id), n.message || "", n.timestamp || ""]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function seedUsersIfEmpty(client) {
  const { rows } = await client.query("SELECT COUNT(*)::int AS c FROM users");
  if (Number(rows[0].c) > 0) return;

  await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_ID_LOCK]);

  const { rows: again } = await client.query("SELECT COUNT(*)::int AS c FROM users");
  if (Number(again[0].c) > 0) return;

  const rounds = Number(process.env.BCRYPT_ROUNDS || 10);
  const mgrId = (process.env.INIT_MANAGER_EMPLOYEE_ID || "manager1").trim();
  const asstId = (process.env.INIT_ASSISTANT_EMPLOYEE_ID || "mech1").trim();
  const mgrPass = process.env.INIT_MANAGER_PASSWORD || "password123";
  const asstPass = process.env.INIT_ASSISTANT_PASSWORD || "password123";

  const h1 = await bcrypt.hash(mgrPass, rounds);
  const h2 = await bcrypt.hash(asstPass, rounds);

  const { rows: mechRows } = await client.query(
    "SELECT id FROM mechanics ORDER BY id LIMIT 1"
  );
  const defaultMechanicId =
    mechRows[0] && mechRows[0].id != null ? Number(mechRows[0].id) : null;

  await client.query(
    `INSERT INTO users (employee_id, password_hash, role, display_name, mechanic_id) VALUES
     ($1, $2, 'MANAGER', $3, NULL),
     ($4, $5, 'ASSISTANT', $6, $7)`,
    [
      mgrId,
      h1,
      "Тест менеджер",
      asstId,
      h2,
      "Тест сотрудник",
      defaultMechanicId,
    ]
  );

  if (!process.env.INIT_MANAGER_PASSWORD) {
    console.warn(
      "[autopro] Seeded default users (manager1/mech1, password123). Set INIT_*_PASSWORD and JWT_SECRET in production."
    );
  }
}

async function initDb() {
  const client = await pool.connect();
  try {
    await createSchema(client);
    await migrateSchema(client);
    await ensureHistoryAppointmentUnique(client);

    const { rows } = await client.query("SELECT COUNT(*)::int AS cnt FROM services");
    const servicesCount = Number(rows[0] && rows[0].cnt) || 0;
    if (servicesCount === 0) {
      const seedRaw = fs.readFileSync(DATA_FILE, "utf-8");
      const seed = normalizeDataShape(JSON.parse(seedRaw));
      await replaceAllDataFromJson(client, seed);
    }

    await client.query("BEGIN");
    try {
      await seedUsersIfEmpty(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {
    client.release();
  }
}

module.exports = {
  initDb,
  normalizeDataShape,
  replaceAllDataFromJson,
  ADVISORY_ID_LOCK,
};
