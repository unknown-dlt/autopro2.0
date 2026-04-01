const { nextTableId } = require("../db/ids");

async function getServiceDurationMinutes(client, serviceId) {
  const { rows } = await client.query("SELECT duration FROM services WHERE id = $1", [
    serviceId,
  ]);
  const raw = rows[0] ? Number(rows[0].duration) : 0;
  return raw > 0 ? raw : 60;
}

async function hasMechanicOverlap(client, candidate, ignoreAppointmentId) {
  const mechanicId = Number(candidate.mechanicId || 0);
  const serviceId = Number(candidate.serviceId || 0);
  if (!mechanicId || !candidate.datetime || !serviceId) return false;

  const start = new Date(candidate.datetime);
  if (!Number.isFinite(start.getTime())) return false;

  const durationMinutes = await getServiceDurationMinutes(client, serviceId);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  const { rows } = await client.query(
    `
    SELECT 1
    FROM appointments a
    INNER JOIN services s ON s.id = a.service_id
    WHERE a.mechanic_id = $1
      AND ($2::int IS NULL OR a.id <> $2)
      AND UPPER(TRIM(a.status)) NOT IN ('CANCELLED', 'COMPLETED')
      AND a.datetime <> ''
      AND a.service_id IS NOT NULL
      AND a.datetime::timestamptz < $4::timestamptz
      AND (
        a.datetime::timestamptz
        + (CASE WHEN COALESCE(s.duration, 0) > 0 THEN s.duration ELSE 60 END || ' minutes')::interval
        > $3::timestamptz
      )
  `,
    [mechanicId, ignoreAppointmentId || null, start.toISOString(), end.toISOString()]
  );

  return rows.length > 0;
}

async function applyPartsWriteOff(client, requiredParts) {
  if (!Array.isArray(requiredParts)) return;
  for (const rp of requiredParts) {
    const partId = Number(rp.partId || rp.id);
    const qty = Number(rp.quantity) || 0;
    if (!partId || qty <= 0) continue;
    await client.query(
      "UPDATE parts SET quantity = GREATEST(0, COALESCE(quantity, 0) - $2) WHERE id = $1",
      [partId, qty]
    );
  }
}

async function upsertHistoryCompleted(client, appt) {
  const hid = await nextTableId(client, "history");
  await client.query(
    `
    INSERT INTO history (id, appointment_id, datetime, license_plate, service_id, mechanic_id, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED')
    ON CONFLICT (appointment_id) DO UPDATE SET
      datetime = EXCLUDED.datetime,
      license_plate = EXCLUDED.license_plate,
      service_id = EXCLUDED.service_id,
      mechanic_id = EXCLUDED.mechanic_id,
      status = 'COMPLETED'
  `,
    [
      hid,
      Number(appt.id),
      appt.datetime || "",
      appt.licensePlate || "",
      appt.serviceId == null ? null : Number(appt.serviceId),
      appt.mechanicId == null ? null : Number(appt.mechanicId),
    ]
  );
}

async function clearHistoryForAppointment(client, appointmentId) {
  await client.query("DELETE FROM history WHERE appointment_id = $1", [appointmentId]);
}

async function addNotification(client, message) {
  const id = await nextTableId(client, "notifications");
  const ts = new Date().toISOString();
  await client.query(
    "INSERT INTO notifications (id, message, timestamp) VALUES ($1, $2, $3)",
    [id, message, ts]
  );
  await client.query(`
    DELETE FROM notifications
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY timestamp DESC) AS rn
        FROM notifications
      ) t
      WHERE t.rn > 50
    )
  `);
}

module.exports = {
  getServiceDurationMinutes,
  hasMechanicOverlap,
  applyPartsWriteOff,
  upsertHistoryCompleted,
  clearHistoryForAppointment,
  addNotification,
};
