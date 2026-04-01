/**
 * After authenticate: MANAGER passes. ASSISTANT is limited on mutating catalog, reports, notifications clear, appointment delete.
 * Appointment POST/PUT body checks (mechanic scope) stay in route handlers.
 */
function assistantRouteGuard(req, res, next) {
  const u = req.user;
  if (!u || u.role !== "ASSISTANT") return next();

  const method = req.method.toUpperCase();
  const p = (req.path || "").replace(/\/$/, "") || "/";

  if (method === "GET" && p === "/reports") {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  const readOnlyCatalog = [
    /^\/clients$/,
    /^\/services$/,
    /^\/parts$/,
    /^\/mechanics$/,
  ];
  if (readOnlyCatalog.some((re) => re.test(p)) && method !== "GET") {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  if (method === "DELETE" && p === "/notifications") {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  if (method === "DELETE" && /^\/appointments\/\d+$/.test(p)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  return next();
}

module.exports = { assistantRouteGuard };
