const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db/pool");
const { withTransaction } = require("../db/transaction");
const { nextTableId } = require("../db/ids");
const { ADVISORY_ID_LOCK } = require("../db/schema");
const { getJwtSecret } = require("../middleware/auth");

const router = express.Router();

const ADVISORY_MECH_KEY1 = 910002;

function mapClient(r) {
  return {
    id: Number(r.id),
    name: r.name,
    phone: r.phone,
    note: r.note,
  };
}

function mapService(r) {
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description,
    duration: Number(r.duration) || 0,
    price: Number(r.price) || 0,
  };
}

function mapPart(r) {
  return {
    id: Number(r.id),
    article: r.article,
    name: r.name,
    price: Number(r.price) || 0,
    quantity: Number(r.quantity) || 0,
  };
}

function mapMechanic(r) {
  return {
    id: Number(r.id),
    fullName: r.full_name,
    position: r.position,
    hireDate: r.hire_date,
    active: !!r.active,
    baseSalary: r.base_salary == null ? undefined : Number(r.base_salary),
    bonusPerService:
      r.bonus_per_service == null ? undefined : Number(r.bonus_per_service),
  };
}

function mapAppointment(r) {
  return {
    id: Number(r.id),
    datetime: r.datetime,
    clientName: r.client_name,
    phone: r.phone,
    carModel: r.car_model,
    carYear: r.car_year,
    licensePlate: r.license_plate,
    vin: r.vin,
    serviceId: r.service_id == null ? null : Number(r.service_id),
    mechanicId: r.mechanic_id == null ? null : Number(r.mechanic_id),
    status: r.status,
    comment: r.comment,
    requiredParts: Array.isArray(r.required_parts) ? r.required_parts : [],
  };
}

async function loadServiceDurationMap(client) {
  const { rows } = await client.query("SELECT id, duration FROM services");
  const m = new Map();
  for (const r of rows) {
    m.set(Number(r.id), Number(r.duration) || 0);
  }
  return m;
}

function getDurationMinutes(serviceMap, serviceId) {
  const raw = serviceMap.get(Number(serviceId));
  if (raw > 0) return raw;
  return 60;
}

async function hasMechanicOverlapTx(
  client,
  serviceMap,
  { mechanicId, datetime, serviceId, ignoreAppointmentId }
) {
  const mid = Number(mechanicId);
  if (!mid || !datetime || !serviceId) return false;
  const start = new Date(datetime);
  if (!Number.isFinite(start.getTime())) return false;
  const durationMinutes = getDurationMinutes(serviceMap, serviceId);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  const { rows } = await client.query(
    `SELECT id, datetime, service_id, status FROM appointments
     WHERE mechanic_id = $1
       AND UPPER(TRIM(status)) NOT IN ('CANCELLED', 'COMPLETED')
       AND ($2::int IS NULL OR id <> $2::int)
     FOR UPDATE`,
    [mid, ignoreAppointmentId == null ? null : Number(ignoreAppointmentId)]
  );

  for (const a of rows) {
    if (!a.datetime || !a.service_id) continue;
    const aStart = new Date(a.datetime);
    if (!Number.isFinite(aStart.getTime())) continue;
    const aDur = getDurationMinutes(serviceMap, Number(a.service_id));
    const aEnd = new Date(aStart.getTime() + aDur * 60 * 1000);
    if (start < aEnd && aStart < end) return true;
  }
  return false;
}

async function acquireMechanicLocks(client, mechanicIds) {
  const ids = [...new Set(mechanicIds.filter((x) => x != null).map((x) => Number(x)))];
  for (const mid of ids) {
    if (!Number.isFinite(mid) || mid <= 0) continue;
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      ADVISORY_MECH_KEY1,
      mid,
    ]);
  }
}

async function applyPartsWriteOffTx(client, requiredParts) {
  if (!Array.isArray(requiredParts) || !requiredParts.length) return;
  for (const rp of requiredParts) {
    const partId = Number(rp.partId || rp.id);
    const qty = Number(rp.quantity) || 0;
    if (!partId || qty <= 0) continue;
    await client.query(
      "UPDATE parts SET quantity = GREATEST(0, quantity::int - $2::int) WHERE id = $1",
      [partId, qty]
    );
  }
}

async function insertNotificationTx(client, message) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_ID_LOCK]);
  const nid = await nextTableId(client, "notifications");
  const ts = new Date().toISOString();
  await client.query(
    "INSERT INTO notifications (id, message, timestamp) VALUES ($1, $2, $3)",
    [nid, message, ts]
  );
  await client.query(`
    DELETE FROM notifications
    WHERE id IN (
      SELECT id FROM (
        SELECT id FROM notifications ORDER BY timestamp DESC OFFSET 50
      ) sub
    )
  `);
}

function assertAssistantAppointmentAccess(user, mechanicIds) {
  if (user.role !== "ASSISTANT" || user.mechanicId == null) return;
  const allowed = Number(user.mechanicId);
  for (const m of mechanicIds) {
    if (m == null) continue;
    if (Number(m) !== allowed) {
      const e = new Error("Недостаточно прав");
      e.status = 403;
      throw e;
    }
  }
}

async function upsertCompletedHistoryTx(client, appointmentRow) {
  const aid = Number(appointmentRow.id);
  const datetime = appointmentRow.datetime || "";
  const lp = appointmentRow.license_plate || "";
  const sid =
    appointmentRow.service_id == null ? null : Number(appointmentRow.service_id);
  const mid =
    appointmentRow.mechanic_id == null ? null : Number(appointmentRow.mechanic_id);

  const upd = await client.query(
    `UPDATE history SET datetime=$2, license_plate=$3, service_id=$4, mechanic_id=$5, status='COMPLETED'
     WHERE appointment_id=$1`,
    [aid, datetime, lp, sid, mid]
  );
  if (upd.rowCount > 0) return;

  await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_ID_LOCK]);
  const hid = await nextTableId(client, "history");
  try {
    await client.query(
      `INSERT INTO history (id, appointment_id, datetime, license_plate, service_id, mechanic_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,'COMPLETED')`,
      [hid, aid, datetime, lp, sid, mid]
    );
  } catch (e) {
    if (e.code === "23505") {
      await client.query(
        `UPDATE history SET datetime=$2, license_plate=$3, service_id=$4, mechanic_id=$5, status='COMPLETED'
         WHERE appointment_id=$1`,
        [aid, datetime, lp, sid, mid]
      );
      return;
    }
    throw e;
  }
}

async function postLogin(req, res) {
  const { role, employeeId, password, captcha } = req.body || {};

  const a = Number(captcha && captcha.a);
  const b = Number(captcha && captcha.b);
  const answer = Number(captcha && captcha.answer);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a + b !== answer) {
    return res.status(400).json({ error: "Неверный ответ на captcha" });
  }

  if (role !== "MANAGER" && role !== "ASSISTANT") {
    return res.status(400).json({ error: "Неизвестная роль" });
  }

  const emp = (employeeId || "").trim();
  if (!emp || !password) {
    return res.status(400).json({ error: "Укажите ID и пароль" });
  }

  const { rows } = await pool.query(
    `SELECT id, employee_id, password_hash, role, display_name, mechanic_id
     FROM users WHERE LOWER(employee_id) = LOWER($1) AND role = $2`,
    [emp, role]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Неверный ID или пароль" });
  }

  const token = jwt.sign(
    {
      sub: String(user.id),
      role: user.role,
      employeeId: user.employee_id,
      mechanicId: user.mechanic_id,
      name: user.display_name,
    },
    getJwtSecret(),
    { expiresIn: "7d" }
  );

  res.json({
    token,
    user: {
      id: user.id,
      role: user.role,
      name: user.display_name,
      employeeId: user.employee_id,
      mechanicId: user.mechanic_id == null ? null : Number(user.mechanic_id),
    },
  });
}

router.get("/dashboard", async (req, res) => {
  try {
    const [partsRes, fullAppsRes, mechRes, svcRes] = await Promise.all([
      pool.query("SELECT quantity, price FROM parts"),
      pool.query(
        "SELECT id, datetime, client_name, phone, car_model, car_year, license_plate, vin, service_id, mechanic_id, status, comment, required_parts FROM appointments ORDER BY id"
      ),
      pool.query(
        "SELECT id, full_name, position, hire_date, active, base_salary, bonus_per_service FROM mechanics WHERE active = TRUE ORDER BY id"
      ),
      pool.query("SELECT id, price FROM services"),
    ]);

    const svcPrice = new Map(
      svcRes.rows.map((r) => [Number(r.id), Number(r.price) || 0])
    );

    const partsCount = partsRes.rows.reduce(
      (sum, p) => sum + (Number(p.quantity) || 0),
      0
    );
    const partsTotalValue = partsRes.rows.reduce(
      (sum, p) =>
        sum + (Number(p.quantity) || 0) * (Number(p.price) || 0),
      0
    );

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const fullApps = fullAppsRes.rows.map(mapAppointment);

    const todaysAppointments = fullApps.filter((a) => {
      const d = new Date(a.datetime);
      return d >= todayStart && d <= todayEnd;
    });

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
      23,
      59,
      59,
      999
    );
    const monthlyActiveAppointments = fullApps.filter((a) => {
      const d = new Date(a.datetime);
      const inMonth = d >= monthStart && d <= monthEnd;
      const status = (a.status || "").toUpperCase();
      const isActive = status !== "COMPLETED" && status !== "CANCELLED";
      return inMonth && isActive;
    });

    const activeAppointments = fullApps.filter((a) => {
      const status = (a.status || "").toUpperCase();
      return status !== "COMPLETED" && status !== "CANCELLED";
    });
    const activeRevenue = activeAppointments.reduce((sum, a) => {
      return sum + (svcPrice.get(a.serviceId) || 0);
    }, 0);

    const dailyWorkMap = {};
    for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      dailyWorkMap[iso] = 0;
    }
    fullApps.forEach((a) => {
      const d = new Date(a.datetime);
      if (d >= monthStart && d <= monthEnd) {
        const iso = d.toISOString().slice(0, 10);
        if (dailyWorkMap[iso] != null) {
          dailyWorkMap[iso] += 1;
        }
      }
    });
    const dailyWork = Object.keys(dailyWorkMap).map((date) => ({
      date,
      count: dailyWorkMap[date],
    }));

    const activeMechanics = mechRes.rows.map(mapMechanic);

    res.json({
      partsCount,
      partsTotalValue,
      appointments: fullApps.length,
      monthlyActiveAppointments: monthlyActiveAppointments.length,
      activeRevenue,
      dailyWork,
      todaysAppointments,
      activeMechanics,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

router.get("/clients", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, phone, note FROM clients ORDER BY id"
  );
  res.json(rows.map(mapClient));
});

router.post("/clients", async (req, res) => {
  try {
    const row = await withTransaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_ID_LOCK]);
      const id = await nextTableId(c, "clients");
      const { rows } = await c.query(
        "INSERT INTO clients (id, name, phone, note) VALUES ($1, $2, $3, $4) RETURNING id, name, phone, note",
        [id, req.body.name, req.body.phone, req.body.note || ""]
      );
      return rows[0];
    });
    res.status(201).json(mapClient(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

router.put("/clients/:id", async (req, res) => {
  const id = Number(req.params.id);
  const cur = await pool.query("SELECT * FROM clients WHERE id = $1", [id]);
  if (!cur.rows[0]) return res.status(404).json({ error: "Клиент не найден" });
  const prev = cur.rows[0];
  const name = req.body.name !== undefined ? req.body.name : prev.name;
  const phone = req.body.phone !== undefined ? req.body.phone : prev.phone;
  const note = req.body.note !== undefined ? req.body.note : prev.note;
  const { rows } = await pool.query(
    "UPDATE clients SET name = $2, phone = $3, note = $4 WHERE id = $1 RETURNING id, name, phone, note",
    [id, name, phone, note]
  );
  res.json(mapClient(rows[0]));
});

router.delete("/clients/:id", async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query("DELETE FROM clients WHERE id = $1", [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Клиент не найден" });
  res.status(204).end();
});

router.get("/services", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, description, duration, price FROM services ORDER BY id"
  );
  res.json(rows.map(mapService));
});

router.post("/services", async (req, res) => {
  const row = await withTransaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_ID_LOCK]);
    const id = await nextTableId(c, "services");
    const { rows } = await c.query(
      "INSERT INTO services (id, name, description, duration, price) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [
        id,
        req.body.name,
        req.body.description || "",
        Number(req.body.duration) || 0,
        Number(req.body.price) || 0,
      ]
    );
    return rows[0];
  });
  res.status(201).json(mapService(row));
});

router.put("/services/:id", async (req, res) => {
  const id = Number(req.params.id);
  const cur = await pool.query("SELECT * FROM services WHERE id = $1", [id]);
  if (!cur.rows[0]) return res.status(404).json({ error: "Услуга не найдена" });
  const p = cur.rows[0];
  const name = req.body.name !== undefined ? req.body.name : p.name;
  const description =
    req.body.description !== undefined ? req.body.description : p.description;
  const duration =
    req.body.duration !== undefined ? Number(req.body.duration) || 0 : p.duration;
  const price =
    req.body.price !== undefined ? Number(req.body.price) || 0 : p.price;
  const { rows } = await pool.query(
    `UPDATE services SET name = $2, description = $3, duration = $4, price = $5
     WHERE id = $1 RETURNING *`,
    [id, name, description, duration, price]
  );
  res.json(mapService(rows[0]));
});

router.delete("/services/:id", async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query("DELETE FROM services WHERE id = $1", [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Услуга не найдена" });
  res.status(204).end();
});

router.get("/parts", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, article, name, price, quantity FROM parts ORDER BY id"
  );
  res.json(rows.map(mapPart));
});

router.post("/parts", async (req, res) => {
  const row = await withTransaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_ID_LOCK]);
    const id = await nextTableId(c, "parts");
    const { rows } = await c.query(
      "INSERT INTO parts (id, article, name, price, quantity) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [
        id,
        req.body.article,
        req.body.name,
        Number(req.body.price) || 0,
        Number(req.body.quantity) || 0,
      ]
    );
    const part = rows[0];
    await insertNotificationTx(
      c,
      `Добавлена позиция на склад: ${part.article || ""} ${part.name || ""} (кол-во ${part.quantity})`
    );
    return part;
  });
  res.status(201).json(mapPart(row));
});

router.put("/parts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const row = await withTransaction(async (c) => {
    const cur = await c.query("SELECT * FROM parts WHERE id = $1 FOR UPDATE", [id]);
    if (!cur.rows[0]) return null;
    const prev = cur.rows[0];
    const { rows } = await c.query(
      `UPDATE parts SET
        article = COALESCE($2, article),
        name = COALESCE($3, name),
        price = COALESCE($4, price),
        quantity = COALESCE($5, quantity)
      WHERE id = $1 RETURNING *`,
      [
        id,
        req.body.article,
        req.body.name,
        req.body.price != null ? Number(req.body.price) : null,
        req.body.quantity != null ? Number(req.body.quantity) : null,
      ]
    );
    const next = rows[0];
    const prevQty = Number(prev.quantity) || 0;
    const nextQty = Number(next.quantity) || 0;
    if (prevQty !== nextQty) {
      await insertNotificationTx(
        c,
        `Изменён остаток на складе: ${next.article || ""} ${next.name || ""} (${prevQty} → ${nextQty})`
      );
    }
    return next;
  });
  if (!row) return res.status(404).json({ error: "Позиция не найдена" });
  res.json(mapPart(row));
});

router.delete("/parts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const ok = await withTransaction(async (c) => {
    const { rows } = await c.query(
      "DELETE FROM parts WHERE id = $1 RETURNING article, name",
      [id]
    );
    if (!rows[0]) return false;
    await insertNotificationTx(
      c,
      `Позиция удалена со склада: ${rows[0].article || ""} ${rows[0].name || ""}`
    );
    return true;
  });
  if (!ok) return res.status(404).json({ error: "Позиция не найдена" });
  res.status(204).end();
});

router.get("/mechanics", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, full_name, position, hire_date, active, base_salary, bonus_per_service FROM mechanics ORDER BY id"
  );
  res.json(rows.map(mapMechanic));
});

router.post("/mechanics", async (req, res) => {
  const row = await withTransaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_ID_LOCK]);
    const id = await nextTableId(c, "mechanics");
    const { rows } = await c.query(
      `INSERT INTO mechanics (id, full_name, position, hire_date, active, base_salary, bonus_per_service)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        id,
        req.body.fullName,
        req.body.position || "",
        req.body.hireDate || "",
        !!req.body.active,
        req.body.baseSalary == null ? null : Number(req.body.baseSalary),
        req.body.bonusPerService == null ? null : Number(req.body.bonusPerService),
      ]
    );
    const m = rows[0];
    await insertNotificationTx(
      c,
      `Добавлен механик: ${m.full_name || "Без имени"}`
    );
    return m;
  });
  res.status(201).json(mapMechanic(row));
});

router.put("/mechanics/:id", async (req, res) => {
  const id = Number(req.params.id);
  const row = await withTransaction(async (c) => {
    const cur = await c.query("SELECT * FROM mechanics WHERE id = $1 FOR UPDATE", [id]);
    if (!cur.rows[0]) return null;
    const prev = cur.rows[0];
    const fullName =
      req.body.fullName !== undefined ? req.body.fullName : prev.full_name;
    const position =
      req.body.position !== undefined ? req.body.position : prev.position;
    const hireDate =
      req.body.hireDate !== undefined ? req.body.hireDate : prev.hire_date;
    const active =
      typeof req.body.active === "boolean" ? req.body.active : prev.active;
    const baseSalary =
      req.body.baseSalary !== undefined
        ? req.body.baseSalary == null
          ? null
          : Number(req.body.baseSalary)
        : prev.base_salary;
    const bonusPerService =
      req.body.bonusPerService !== undefined
        ? req.body.bonusPerService == null
          ? null
          : Number(req.body.bonusPerService)
        : prev.bonus_per_service;
    const { rows } = await c.query(
      `UPDATE mechanics SET
        full_name = $2, position = $3, hire_date = $4, active = $5,
        base_salary = $6, bonus_per_service = $7
      WHERE id = $1 RETURNING *`,
      [id, fullName, position, hireDate, active, baseSalary, bonusPerService]
    );
    const next = rows[0];
    if (typeof req.body.active === "boolean" && prev.active !== next.active) {
      await insertNotificationTx(
        c,
        `Статус механика ${next.full_name || "—"}: ${
          next.active ? "активен" : "неактивен"
        }`
      );
    }
    return next;
  });
  if (!row) return res.status(404).json({ error: "Механик не найден" });
  res.json(mapMechanic(row));
});

router.delete("/mechanics/:id", async (req, res) => {
  const r = await pool.query("DELETE FROM mechanics WHERE id = $1", [
    Number(req.params.id),
  ]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Механик не найден" });
  res.status(204).end();
});

router.get("/appointments", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, datetime, client_name, phone, car_model, car_year, license_plate, vin, service_id, mechanic_id, status, comment, required_parts FROM appointments ORDER BY id"
  );
  res.json(rows.map(mapAppointment));
});

router.post("/appointments", async (req, res) => {
  try {
    const appointment = await withTransaction(async (c) => {
      const serviceMap = await loadServiceDurationMap(c);
      await c.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_ID_LOCK]);
      const id = await nextTableId(c, "appointments");

      const mechanicId = req.body.mechanicId || null;
      assertAssistantAppointmentAccess(req.user, [mechanicId]);

      const mechIds = [mechanicId].filter(Boolean);
      await acquireMechanicLocks(c, mechIds);

      const candidate = {
        mechanicId,
        datetime: req.body.datetime,
        serviceId: req.body.serviceId || null,
        ignoreAppointmentId: null,
      };
      if (
        await hasMechanicOverlapTx(c, serviceMap, {
          mechanicId: candidate.mechanicId,
          datetime: candidate.datetime,
          serviceId: candidate.serviceId,
          ignoreAppointmentId: null,
        })
      ) {
        const err = new Error(
          "Механик уже занят в это время для выбранной услуги"
        );
        err.status = 400;
        throw err;
      }

      const requiredParts = Array.isArray(req.body.requiredParts)
        ? req.body.requiredParts.map((rp) => ({
            partId: Number(rp.partId || rp.id) || null,
            quantity: Number(rp.quantity) || 0,
          }))
        : [];

      const status = req.body.status || "CREATED";
      const { rows } = await c.query(
        `INSERT INTO appointments (id, datetime, client_name, phone, car_model, car_year, license_plate, vin, service_id, mechanic_id, status, comment, required_parts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *`,
        [
          id,
          req.body.datetime,
          req.body.clientName,
          req.body.phone || "",
          req.body.carModel || "",
          req.body.carYear || "",
          req.body.licensePlate || "",
          req.body.vin || "",
          req.body.serviceId == null ? null : Number(req.body.serviceId),
          mechanicId == null ? null : Number(mechanicId),
          status,
          req.body.comment || "",
          JSON.stringify(requiredParts),
        ]
      );
      const ins = rows[0];
      if ((status || "").toUpperCase() === "COMPLETED") {
        await applyPartsWriteOffTx(c, requiredParts);
        await upsertCompletedHistoryTx(c, ins);
      }

      const when = new Date(ins.datetime || Date.now()).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      await insertNotificationTx(
        c,
        `Новая запись: ${when}, клиент ${ins.client_name || "—"}, авто ${ins.car_model || "—"}`
      );

      return ins;
    });
    res.status(201).json(mapAppointment(appointment));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

router.put("/appointments/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const updated = await withTransaction(async (c) => {
      const cur = await c.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [
        id,
      ]);
      if (!cur.rows[0]) {
        const err = new Error("Запись не найдена");
        err.status = 404;
        throw err;
      }
      const prev = cur.rows[0];

      const merged = { ...prev };
      if (req.body.datetime != null) merged.datetime = req.body.datetime;
      if (req.body.clientName != null) merged.client_name = req.body.clientName;
      if (req.body.phone != null) merged.phone = req.body.phone;
      if (req.body.carModel != null) merged.car_model = req.body.carModel;
      if (req.body.carYear != null) merged.car_year = req.body.carYear;
      if (req.body.licensePlate != null) merged.license_plate = req.body.licensePlate;
      if (req.body.vin != null) merged.vin = req.body.vin;
      if (req.body.serviceId !== undefined)
        merged.service_id =
          req.body.serviceId == null ? null : Number(req.body.serviceId);
      if (req.body.mechanicId !== undefined)
        merged.mechanic_id =
          req.body.mechanicId == null ? null : Number(req.body.mechanicId);
      if (req.body.status != null) merged.status = req.body.status;
      if (req.body.comment != null) merged.comment = req.body.comment;
      let requiredParts = prev.required_parts;
      if (Array.isArray(req.body.requiredParts)) {
        requiredParts = req.body.requiredParts.map((rp) => ({
          partId: Number(rp.partId || rp.id) || null,
          quantity: Number(rp.quantity) || 0,
        }));
      }

      assertAssistantAppointmentAccess(req.user, [
        prev.mechanic_id,
        merged.mechanic_id,
      ]);

      const serviceMap = await loadServiceDurationMap(c);
      await acquireMechanicLocks(c, [prev.mechanic_id, merged.mechanic_id]);

      if (
        await hasMechanicOverlapTx(c, serviceMap, {
          mechanicId: merged.mechanic_id,
          datetime: merged.datetime,
          serviceId: merged.service_id,
          ignoreAppointmentId: id,
        })
      ) {
        const err = new Error(
          "Механик уже занят в это время для выбранной услуги"
        );
        err.status = 400;
        throw err;
      }

      const prevStatus = (prev.status || "").toUpperCase();
      const nextStatus = (merged.status || "").toUpperCase();

      const { rows } = await c.query(
        `UPDATE appointments SET
          datetime = $2, client_name = $3, phone = $4, car_model = $5, car_year = $6,
          license_plate = $7, vin = $8, service_id = $9, mechanic_id = $10, status = $11, comment = $12, required_parts = $13::jsonb
        WHERE id = $1 RETURNING *`,
        [
          id,
          merged.datetime,
          merged.client_name,
          merged.phone,
          merged.car_model,
          merged.car_year,
          merged.license_plate,
          merged.vin,
          merged.service_id,
          merged.mechanic_id,
          merged.status,
          merged.comment,
          JSON.stringify(Array.isArray(requiredParts) ? requiredParts : []),
        ]
      );
      const nextRow = rows[0];

      if (prevStatus !== "COMPLETED" && nextStatus === "COMPLETED") {
        await applyPartsWriteOffTx(
          c,
          Array.isArray(requiredParts) ? requiredParts : []
        );
        await upsertCompletedHistoryTx(c, nextRow);
      }

      if (prevStatus !== nextStatus) {
        await insertNotificationTx(
          c,
          `Статус записи #${id} изменён: ${prevStatus || "—"} → ${nextStatus || "—"}`
        );
      }

      return nextRow;
    });
    res.json(mapAppointment(updated));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

router.delete("/appointments/:id", async (req, res) => {
  const id = Number(req.params.id);
  await withTransaction(async (c) => {
    const r = await c.query("DELETE FROM appointments WHERE id = $1", [id]);
    if (r.rowCount > 0) {
      await insertNotificationTx(c, "Запись в расписании удалена");
    }
  });
  res.status(204).end();
});

router.get("/history", async (req, res) => {
  const plate = ((req.query.plate || "") + "").trim();
  let sql = `
    SELECT h.id, h.appointment_id, h.datetime, h.license_plate, h.service_id, h.mechanic_id, h.status,
      a.id AS aid, a.datetime AS adatetime, a.client_name, a.phone, a.car_model, a.car_year,
      a.license_plate AS alicense, a.vin, a.service_id AS aservice_id, a.mechanic_id AS amech_id,
      a.status AS astatus, a.comment, a.required_parts
    FROM history h
    INNER JOIN appointments a ON a.id = h.appointment_id
    WHERE UPPER(TRIM(h.status)) = 'COMPLETED'
  `;
  const params = [];
  if (plate) {
    params.push(plate.toLowerCase());
    sql += ` AND LOWER(TRIM(a.license_plate)) = LOWER(TRIM($1))`;
  }
  sql += " ORDER BY h.datetime DESC";
  const { rows } = await pool.query(sql, params);

  const detailed = rows.map((r) => ({
    id: Number(r.id),
    appointmentId: Number(r.appointment_id),
    datetime: r.datetime,
    licensePlate: r.license_plate,
    serviceId: r.service_id == null ? null : Number(r.service_id),
    mechanicId: r.mechanic_id == null ? null : Number(r.mechanic_id),
    status: r.status,
    appointment: {
      id: Number(r.aid),
      datetime: r.adatetime,
      clientName: r.client_name,
      phone: r.phone,
      carModel: r.car_model,
      carYear: r.car_year,
      licensePlate: r.alicense,
      vin: r.vin,
      serviceId: r.aservice_id == null ? null : Number(r.aservice_id),
      mechanicId: r.amech_id == null ? null : Number(r.amech_id),
      status: r.astatus,
      comment: r.comment,
      requiredParts: Array.isArray(r.required_parts) ? r.required_parts : [],
    },
  }));
  res.json(detailed);
});

router.get("/notifications", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, message, timestamp FROM notifications ORDER BY timestamp DESC"
  );
  res.json(
    rows.map((r) => ({
      id: Number(r.id),
      message: r.message,
      timestamp: r.timestamp,
    }))
  );
});

router.delete("/notifications", async (req, res) => {
  await pool.query("DELETE FROM notifications");
  res.status(204).end();
});

router.get("/reports", async (req, res) => {
  const period = (req.query.period || "").toString();
  const { rows } = await pool.query(
    `SELECT a.datetime, a.service_id, a.mechanic_id,
            s.name AS service_name, s.price AS service_price,
            m.id AS mech_table_id, m.full_name, m.position, m.base_salary, m.bonus_per_service
     FROM appointments a
     LEFT JOIN services s ON s.id = a.service_id
     LEFT JOIN mechanics m ON m.id = a.mechanic_id
     WHERE UPPER(TRIM(a.status)) = 'COMPLETED'
       AND ($1::text = '' OR a.datetime LIKE $1 || '%')`,
    [period]
  );

  let revenue = 0;
  const byService = {};
  const byMechanic = {};
  for (const h of rows) {
    const price = Number(h.service_price) || 0;
    if (h.service_name) {
      revenue += price;
      if (!byService[h.service_name]) {
        byService[h.service_name] = {
          name: h.service_name,
          count: 0,
          revenue: 0,
        };
      }
      byService[h.service_name].count += 1;
      byService[h.service_name].revenue += price;
    }

    if (h.mech_table_id != null) {
      const id = Number(h.mech_table_id);
      if (!byMechanic[id]) {
        const baseSalary =
          h.base_salary != null ? Number(h.base_salary) : 60000;
        const bonusPerService =
          h.bonus_per_service != null ? Number(h.bonus_per_service) : 500;
        byMechanic[id] = {
          id,
          name: h.full_name,
          position: h.position || "",
          baseSalary,
          bonusPerService,
          completedCount: 0,
          bonusTotal: 0,
          totalSalary: 0,
        };
      }
      const row = byMechanic[id];
      row.completedCount += 1;
      row.bonusTotal = row.completedCount * row.bonusPerService;
      row.totalSalary = row.baseSalary + row.bonusTotal;
    }
  }

  const totalPayroll = Object.values(byMechanic).reduce(
    (sum, row) => sum + (row.totalSalary || 0),
    0
  );

  res.json({
    period,
    revenue,
    completedCount: rows.length,
    byService: Object.values(byService),
    totalPayroll,
    byMechanic: Object.values(byMechanic),
  });
});

module.exports = { router, postLogin };
