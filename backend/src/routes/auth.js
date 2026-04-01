const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db/pool");
const { getJwtSecret } = require("../middleware/auth");

async function login(req, res) {
  const { employeeId, password, captcha } = req.body || {};

  const a = Number(captcha && captcha.a);
  const b = Number(captcha && captcha.b);
  const answer = Number(captcha && captcha.answer);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a + b !== answer) {
    return res.status(400).json({ error: "Неверный ответ на captcha" });
  }

  const idRaw = (employeeId || "").trim();
  if (!idRaw || !password) {
    return res.status(400).json({ error: "Укажите ID и пароль" });
  }

  const { rows } = await pool.query(
    "SELECT id, employee_id, password_hash, role, display_name FROM users WHERE LOWER(employee_id) = LOWER($1)",
    [idRaw]
  );
  const user = rows[0];
  if (!user) {
    return res.status(401).json({ error: "Неверный ID или пароль" });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "Неверный ID или пароль" });
  }

  const payload = {
    sub: String(user.id),
    role: user.role,
    employeeId: user.employee_id,
    name: user.display_name || "",
  };

  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: "8h" });

  res.json({
    token,
    user: {
      id: user.id,
      role: user.role,
      name: user.display_name || "",
      employeeId: user.employee_id,
    },
  });
}

function me(req, res) {
  res.json({
    user: {
      id: req.user.id,
      role: req.user.role,
      name: req.user.name,
      employeeId: req.user.employeeId,
    },
  });
}

module.exports = { login, me };
