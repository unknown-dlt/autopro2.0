const express = require("express");
const { pool } = require("../db/pool");
const { withMutationTx } = require("../db/tx");
const { requireRoles } = require("../middleware/auth");
const { nextTableId } = require("../db/ids");
const {
  hasMechanicOverlap,
  applyPartsWriteOff,
  upsertHistoryCompleted,
  clearHistoryForAppointment,
  addNotification,
} = require("../logic/dbMutations");

const r = express.Router();
const both = requireRoles("MANAGER", "ASSISTANT");
const mgr = requireRoles("MANAGER");

function mapClient(row) {
  return {
    id: Number(row.id),
    name: row.name,
    phone: row.phone,
    note: row.note || "",
  };
}

function mapService(row) {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description || "",
    duration: Number(row.duration) || 0,
    price: Number(row.price) || 0,
  };
}

function mapPart(row) {
  return {
    id: Number(row.id),
    article: row.article,
    name: row.name,
    price: Number(row.price) || 0,
    quantity: Number(row.quantity) || 0,
  };
}

function mapMechanic(row) {
  return {
    id: Number(row.id),
    fullName: row.full_name,
    position: row.position || "",
    hireDate: row.hire_date || "",
    active: !!row.active,
    baseSalary: row.base_salary == null ? undefined : Number(row.base_salary),
    bonusPerService:
      row.bonus_per_service == null ? undefined : Number(row.bonus_per_service),
  };
}

function mapAppointment(row) {
  const rp = row.required_parts;
  return {
    id: Number(row.id),
    datetime: row.datetime,
    clientName: row.client_name,
    phone: row.phone || "",
    carModel: row.car_model || "",
    carYear: row.car_year || "",
    licensePlate: row.license_plate || "",
    vin: row.vin || "",
    serviceId: row.service_id == null ? null : Number(row.service_id),
    mechanicId: row.mechanic_id == null ? null : Number(row.mechanic_id),
    status: row.status,
    comment: row.comment || "",
    requiredParts: Array.isArray(rp) ? rp : [],
  };
}

r.get("/dashboard", both, async (req, res) => {
  const [partsRes, apptRes, mechRes] = await Promise.all([
    pool.query("SELECT id, article, name, price, quantity FROM parts"),
    pool.query(
      "SELECT id, datetime, client_name, phone, car_model, car_year, license_plate, vin, service_id, mechanic_id, status, comment, required_parts FROM appointments"
    ),
    pool.query(
      "SELECT id, full_name, position, hire_date, active, base_salary, bonus_per_service FROM mechanics"
    ),
  ]);

  const parts = partsRes.rows.map(mapPart);
  const appointments = apptRes.rows.map(mapAppointment);
  const mechanics = mechRes.rows.map(mapMechanic);

  const partsCount = parts.reduce((sum, p) => sum + (p.quantity || 0), 0);
  const partsTotalValue = parts.reduce(
    (sum, p) => sum + (p.quantity || 0) * (p.price || 0),
    0
  );

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  const todaysAppointments = appointments.filter((a) => {
    const d = new Date(a.datetime);
    return d >= todayStart && d <= todayEnd;
  });

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const monthlyActiveAppointments = appointments.filter((a) => {
    const d = new Date(a.datetime);
    const inMonth = d >= monthStart && d <= monthEnd;
    const status = (a.status || "").toUpperCase();
    const isActive = status !== "COMPLETED" && status !== "CANCELLED";
    return inMonth && isActive;
  });

  const activeAppointments = appointments.filter((a) => {
    const status = (a.status || "").toUpperCase();
    return status !== "COMPLETED" && status !== "CANCELLED";
  });

  const servicesRes = await pool.query("SELECT id, price FROM services");
  const priceByServiceId = {};
  servicesRes.rows.forEach((row) => {
    priceByServiceId[Number(row.id)] = Number(row.price) || 0;
  });

  const activeRevenue = activeAppointments.reduce((sum, a) => {
    return sum + (priceByServiceId[a.serviceId] || 0);
  }, 0);

  const dailyWorkMap = {};
  for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    dailyWorkMap[iso] = 0;
  }
  appointments.forEach((a) => {
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

  const activeMechanics = mechanics.filter((m) => m.active);

  res.json({
    partsCount,
    partsTotalValue,
    appointments: appointments.length,
    monthlyActiveAppointments: monthlyActiveAppointments.length,
    activeRevenue,
    dailyWork,
    todaysAppointments,
    activeMechanics,
  });
});

r.get("/clients", both, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, phone, note FROM clients ORDER BY id"
  );
  res.json(rows.map(mapClient));
});

r.post("/clients", both, async (req, res) => {
  try {
    const row = await withMutationTx(async (client) => {
      const id = await nextTableId(client, "clients");
      const { rows } = await client.query(
        "INSERT INTO clients (id, name, phone, note) VALUES ($1, $2, $3, $4) RETURNING id, name, phone, note",
        [id, req.body.name, req.body.phone, req.body.note || ""]
      );
      return rows[0];
    });
    res.status(201).json(mapClient(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось сохранить клиента" });
  }
});

r.put("/clients/:id", mgr, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: existing } = await pool.query("SELECT * FROM clients WHERE id = $1", [id]);
  if (!existing[0]) return res.status(404).json({ error: "Клиент не найден" });
  const c = existing[0];
  const name = req.body.name != null ? req.body.name : c.name;
  const phone = req.body.phone != null ? req.body.phone : c.phone;
  const note = req.body.note != null ? req.body.note : c.note;
  const { rows } = await pool.query(
    "UPDATE clients SET name = $2, phone = $3, note = $4 WHERE id = $1 RETURNING id, name, phone, note",
    [id, name, phone, note]
  );
  res.json(mapClient(rows[0]));
});

r.delete("/clients/:id", mgr, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query("DELETE FROM clients WHERE id = $1", [id]);
  res.status(204).end();
});

r.get("/services", both, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, description, duration, price FROM services ORDER BY id"
  );
  res.json(rows.map(mapService));
});

r.post("/services", mgr, async (req, res) => {
  const row = await withMutationTx(async (client) => {
    const id = await nextTableId(client, "services");
    const { rows } = await client.query(
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

r.put("/services/:id", mgr, async (req, res) => {
  const id = Number(req.params.id);
  const row = await withMutationTx(async (client) => {
    const { rows } = await client.query("SELECT * FROM services WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const p = rows[0];
    const name = req.body.name != null ? req.body.name : p.name;
    const description =
      req.body.description != null ? req.body.description : p.description;
    const duration =
      req.body.duration != null ? Number(req.body.duration) : Number(p.duration) || 0;
    const price = req.body.price != null ? Number(req.body.price) : Number(p.price) || 0;
    const { rows: out } = await client.query(
      "UPDATE services SET name = $2, description = $3, duration = $4, price = $5 WHERE id = $1 RETURNING *",
      [id, name, description || "", duration, price]
    );
    return out[0];
  });
  if (!row) return res.status(404).json({ error: "Услуга не найдена" });
  res.json(mapService(row));
});

r.delete("/services/:id", mgr, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query("DELETE FROM services WHERE id = $1", [id]);
  res.status(204).end();
});

r.get("/parts", both, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, article, name, price, quantity FROM parts ORDER BY id"
  );
  res.json(rows.map(mapPart));
});

r.post("/parts", mgr, async (req, res) => {
  const part = await withMutationTx(async (client) => {
    const id = await nextTableId(client, "parts");
    const { rows } = await client.query(
      "INSERT INTO parts (id, article, name, price, quantity) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [
        id,
        req.body.article,
        req.body.name,
        Number(req.body.price) || 0,
        Number(req.body.quantity) || 0,
      ]
    );
    const p = rows[0];
    await addNotification(
      client,
      `Добавлена позиция на склад: ${p.article || ""} ${p.name || ""} (кол-во ${p.quantity})`
    );
    return p;
  });
  res.status(201).json(mapPart(part));
});

r.put("/parts/:id", mgr, async (req, res) => {
  const id = Number(req.params.id);
  const next = await withMutationTx(async (client) => {
    const { rows } = await client.query("SELECT * FROM parts WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const prev = rows[0];
    const merged = { ...prev, ...req.body };
    const { rows: out } = await client.query(
      "UPDATE parts SET article = $2, name = $3, price = $4, quantity = $5 WHERE id = $1 RETURNING *",
      [
        id,
        merged.article,
        merged.name,
        Number(merged.price) || 0,
        Number(merged.quantity) || 0,
      ]
    );
    const row = out[0];
    const prevQty = Number(prev.quantity) || 0;
    const nextQty = Number(row.quantity) || 0;
    if (prevQty !== nextQty) {
      await addNotification(
        client,
        `Изменён остаток на складе: ${row.article || ""} ${row.name || ""} (${prevQty} → ${nextQty})`
      );
    }
    return row;
  });
  if (!next) return res.status(404).json({ error: "Позиция не найдена" });
  res.json(mapPart(next));
});

r.delete("/parts/:id", mgr, async (req, res) => {
  await withMutationTx(async (client) => {
    const id = Number(req.params.id);
    const { rows } = await client.query("SELECT * FROM parts WHERE id = $1", [id]);
    const part = rows[0];
    await client.query("DELETE FROM parts WHERE id = $1", [id]);
    if (part) {
      await addNotification(
        client,
        `Позиция удалена со склада: ${part.article || ""} ${part.name || ""}`
      );
    }
  });
  res.status(204).end();
});

r.get("/mechanics", both, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, full_name, position, hire_date, active, base_salary, bonus_per_service FROM mechanics ORDER BY id"
  );
  res.json(rows.map(mapMechanic));
});

r.post("/mechanics", mgr, async (req, res) => {
  const mechanic = await withMutationTx(async (client) => {
    const id = await nextTableId(client, "mechanics");
    const { rows } = await client.query(
      "INSERT INTO mechanics (id, full_name, position, hire_date, active, base_salary, bonus_per_service) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
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
    await addNotification(client, `Добавлен механик: ${m.full_name || "Без имени"}`);
    return m;
  });
  res.status(201).json(mapMechanic(mechanic));
});

r.put("/mechanics/:id", mgr, async (req, res) => {
  const id = Number(req.params.id);
  const row = await withMutationTx(async (client) => {
    const { rows } = await client.query("SELECT * FROM mechanics WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const p = rows[0];
    const fullName = req.body.fullName != null ? req.body.fullName : p.full_name;
    const position = req.body.position != null ? req.body.position : p.position;
    const hireDate = req.body.hireDate != null ? req.body.hireDate : p.hire_date;
    const active = typeof req.body.active === "boolean" ? req.body.active : p.active;
    const baseSalary =
      req.body.baseSalary != null ? req.body.baseSalary : p.base_salary;
    const bonusPerService =
      req.body.bonusPerService != null ? req.body.bonusPerService : p.bonus_per_service;
    const { rows: out } = await client.query(
      "UPDATE mechanics SET full_name = $2, position = $3, hire_date = $4, active = $5, base_salary = $6, bonus_per_service = $7 WHERE id = $1 RETURNING *",
      [id, fullName, position || "", hireDate || "", active, baseSalary, bonusPerService]
    );
    const next = out[0];
    if (typeof req.body.active === "boolean" && p.active !== next.active) {
      await addNotification(
        client,
        `Статус механика ${next.full_name || "—"}: ${next.active ? "активен" : "неактивен"}`
      );
    }
    return next;
  });
  if (!row) return res.status(404).json({ error: "Механик не найден" });
  res.json(mapMechanic(row));
});

r.delete("/mechanics/:id", mgr, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query("DELETE FROM mechanics WHERE id = $1", [id]);
  res.status(204).end();
});

r.get("/appointments", mgr, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, datetime, client_name, phone, car_model, car_year, license_plate, vin, service_id, mechanic_id, status, comment, required_parts FROM appointments ORDER BY id"
  );
  res.json(rows.map(mapAppointment));
});

r.post("/appointments", mgr, async (req, res) => {
  try {
    const appointment = await withMutationTx(async (client) => {
      const id = await nextTableId(client, "appointments");
      const row = {
        id,
        datetime: req.body.datetime,
        clientName: req.body.clientName,
        phone: req.body.phone || "",
        carModel: req.body.carModel || "",
        carYear: req.body.carYear || "",
        licensePlate: req.body.licensePlate || "",
        vin: req.body.vin || "",
        serviceId: req.body.serviceId || null,
        mechanicId: req.body.mechanicId || null,
        status: req.body.status || "CREATED",
        comment: req.body.comment || "",
        requiredParts: Array.isArray(req.body.requiredParts)
          ? req.body.requiredParts.map((rp) => ({
              partId: Number(rp.partId || rp.id) || null,
              quantity: Number(rp.quantity) || 0,
            }))
          : [],
      };

      if (await hasMechanicOverlap(client, row, null)) {
        const err = new Error("OVERLAP");
        err.code = "OVERLAP";
        throw err;
      }

      await client.query(
        `INSERT INTO appointments (id, datetime, client_name, phone, car_model, car_year, license_plate, vin, service_id, mechanic_id, status, comment, required_parts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [
          id,
          row.datetime,
          row.clientName,
          row.phone,
          row.carModel,
          row.carYear,
          row.licensePlate,
          row.vin,
          row.serviceId,
          row.mechanicId,
          row.status,
          row.comment,
          JSON.stringify(row.requiredParts),
        ]
      );

      const st = (row.status || "").toUpperCase();
      if (st === "COMPLETED") {
        await applyPartsWriteOff(client, row.requiredParts);
        await upsertHistoryCompleted(client, row);
      }

      const when = new Date(row.datetime || Date.now()).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      await addNotification(
        client,
        `Новая запись: ${when}, клиент ${row.clientName || "—"}, авто ${row.carModel || "—"}`
      );

      return row;
    });

    res.status(201).json(appointment);
  } catch (e) {
    if (e.code === "OVERLAP") {
      return res
        .status(400)
        .json({ error: "Механик уже занят в это время для выбранной услуги" });
    }
    console.error(e);
    res.status(500).json({ error: "Не удалось создать запись" });
  }
});

r.put("/appointments/:id", mgr, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const updated = await withMutationTx(async (client) => {
      const { rows } = await client.query("SELECT * FROM appointments WHERE id = $1", [id]);
      if (!rows[0]) return { error: 404 };
      const prev = mapAppointment(rows[0]);
      let next = { ...prev, ...req.body };
      if (Array.isArray(req.body.requiredParts)) {
        next.requiredParts = req.body.requiredParts.map((rp) => ({
          partId: Number(rp.partId || rp.id) || null,
          quantity: Number(rp.quantity) || 0,
        }));
      }

      if (await hasMechanicOverlap(client, next, id)) {
        const err = new Error("OVERLAP");
        err.code = "OVERLAP";
        throw err;
      }

      await client.query(
        `UPDATE appointments SET
          datetime = $2, client_name = $3, phone = $4, car_model = $5, car_year = $6,
          license_plate = $7, vin = $8, service_id = $9, mechanic_id = $10, status = $11, comment = $12, required_parts = $13::jsonb
        WHERE id = $1`,
        [
          id,
          next.datetime,
          next.clientName,
          next.phone,
          next.carModel,
          next.carYear,
          next.licensePlate,
          next.vin,
          next.serviceId,
          next.mechanicId,
          next.status,
          next.comment,
          JSON.stringify(next.requiredParts || []),
        ]
      );

      const prevStatus = (prev.status || "").toUpperCase();
      const nextStatus = (next.status || "").toUpperCase();

      if (prevStatus !== "COMPLETED" && nextStatus === "COMPLETED") {
        await applyPartsWriteOff(client, next.requiredParts);
        await upsertHistoryCompleted(client, next);
      } else if (prevStatus === "COMPLETED" && nextStatus !== "COMPLETED") {
        await clearHistoryForAppointment(client, id);
      } else if (nextStatus === "COMPLETED") {
        await upsertHistoryCompleted(client, next);
      }

      if (prevStatus !== nextStatus) {
        await addNotification(
          client,
          `Статус записи #${id} изменён: ${prevStatus || "—"} → ${nextStatus || "—"}`
        );
      }

      const { rows: out } = await client.query("SELECT * FROM appointments WHERE id = $1", [id]);
      return { row: out[0] };
    });

    if (updated.error === 404) {
      return res.status(404).json({ error: "Запись не найдена" });
    }
    res.json(mapAppointment(updated.row));
  } catch (e) {
    if (e.code === "OVERLAP") {
      return res
        .status(400)
        .json({ error: "Механик уже занят в это время для выбранной услуги" });
    }
    console.error(e);
    res.status(500).json({ error: "Не удалось обновить запись" });
  }
});

r.delete("/appointments/:id", mgr, async (req, res) => {
  const id = Number(req.params.id);
  await withMutationTx(async (client) => {
    await clearHistoryForAppointment(client, id);
    await client.query("DELETE FROM appointments WHERE id = $1", [id]);
    await addNotification(client, "Запись в расписании удалена");
  });
  res.status(204).end();
});

r.get("/history", both, async (req, res) => {
  const plate = ((req.query.plate || "") + "").trim().toLowerCase();
  const params = [];
  let where = "WHERE UPPER(TRIM(h.status)) = 'COMPLETED'";
  if (plate) {
    params.push(plate);
    where += " AND LOWER(TRIM(h.license_plate)) = $" + params.length;
  }
  const { rows } = await pool.query(
    `
    SELECT
      h.id AS hid,
      h.appointment_id,
      h.datetime AS h_datetime,
      h.license_plate AS h_license_plate,
      h.service_id AS h_service_id,
      h.mechanic_id AS h_mechanic_id,
      h.status AS h_status,
      a.id AS a_id,
      a.datetime AS a_datetime,
      a.client_name,
      a.phone,
      a.car_model,
      a.car_year,
      a.license_plate AS a_license_plate,
      a.vin,
      a.service_id AS a_service_id,
      a.mechanic_id AS a_mechanic_id,
      a.status AS a_status,
      a.comment,
      a.required_parts
    FROM history h
    LEFT JOIN appointments a ON a.id = h.appointment_id
    ${where}
    ORDER BY h.datetime DESC
  `,
    params
  );

  const detailed = rows.map((row) => {
    const h = {
      id: Number(row.hid),
      appointmentId: Number(row.appointment_id) || 0,
      datetime: row.h_datetime,
      licensePlate: row.h_license_plate,
      serviceId: row.h_service_id == null ? null : Number(row.h_service_id),
      mechanicId: row.h_mechanic_id == null ? null : Number(row.h_mechanic_id),
      status: row.h_status,
    };
    let appointment = null;
    if (row.a_id != null) {
      appointment = mapAppointment({
        id: row.a_id,
        datetime: row.a_datetime,
        client_name: row.client_name,
        phone: row.phone,
        car_model: row.car_model,
        car_year: row.car_year,
        license_plate: row.a_license_plate,
        vin: row.vin,
        service_id: row.a_service_id,
        mechanic_id: row.a_mechanic_id,
        status: row.a_status,
        comment: row.comment,
        required_parts: row.required_parts,
      });
    }
    return { ...h, appointment };
  });

  res.json(detailed);
});

r.get("/notifications", both, async (req, res) => {
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

r.delete("/notifications", both, async (req, res) => {
  await pool.query("DELETE FROM notifications");
  res.status(204).end();
});

r.get("/reports", mgr, async (req, res) => {
  const period = (req.query.period || "").toString();
  const params = [];
  let where = "WHERE UPPER(TRIM(h.status)) = 'COMPLETED'";
  if (period) {
    params.push(period);
    where += " AND h.datetime LIKE $" + params.length + " || '%'";
  }

  const { rows } = await pool.query(
    `
    SELECT h.datetime, h.service_id, h.mechanic_id,
           s.price AS service_price, s.name AS service_name,
           m.id AS mechanic_pk, m.full_name, m.position, m.base_salary, m.bonus_per_service
    FROM history h
    LEFT JOIN services s ON s.id = h.service_id
    LEFT JOIN mechanics m ON m.id = h.mechanic_id
    ${where}
  `,
    params
  );

  let revenue = 0;
  const byService = {};
  const byMechanic = {};
  rows.forEach((h) => {
    const price = Number(h.service_price) || 0;
    const sname = h.service_name || "";
    if (sname) {
      revenue += price;
      if (!byService[sname]) {
        byService[sname] = { name: sname, count: 0, revenue: 0 };
      }
      byService[sname].count += 1;
      byService[sname].revenue += price;
    }

    const mechId = h.mechanic_pk == null ? null : Number(h.mechanic_pk);
    if (mechId != null) {
      const id = mechId;
      if (!byMechanic[id]) {
        const baseSalary =
          h.base_salary == null ? 60000 : Number(h.base_salary);
        const bonusPerService =
          h.bonus_per_service == null ? 500 : Number(h.bonus_per_service);
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
  });

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

module.exports = r;
