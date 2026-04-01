const express = require("express");
const cors = require("cors");
const { authenticate } = require("./middleware/auth");
const { login, me } = require("./routes/auth");
const privateRoutes = require("./routes/private");

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const api = express.Router();
  api.post("/login", login);

  const secured = express.Router();
  secured.use(authenticate);
  secured.get("/me", me);
  secured.use(privateRoutes);

  api.use(secured);
  app.use("/api", api);

  return app;
}

module.exports = { createApp };
