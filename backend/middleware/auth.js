const jwt = require("jsonwebtoken");

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s && process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production");
  }
  return s || "autopro-dev-insecure-secret-change-me";
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return res.status(401).json({ error: "Не авторизован" });
  }
  try {
    const payload = jwt.verify(token, getJwtSecret());
    const mechanicId =
      payload.mechanicId != null && payload.mechanicId !== ""
        ? Number(payload.mechanicId)
        : null;
    req.user = {
      id: Number(payload.sub),
      role: payload.role,
      employeeId: payload.employeeId || "",
      name: payload.name || "",
      mechanicId: Number.isFinite(mechanicId) ? mechanicId : null,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Недействительный токен" });
  }
}

module.exports = { authenticate, getJwtSecret };
