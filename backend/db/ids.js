const TABLES = {
  clients: "clients",
  services: "services",
  parts: "parts",
  mechanics: "mechanics",
  appointments: "appointments",
  history: "history",
  notifications: "notifications",
};

async function nextTableId(client, key) {
  const table = TABLES[key];
  if (!table) throw new Error("Invalid table key");
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${table}`
  );
  return Number(rows[0].n);
}

module.exports = { nextTableId };
