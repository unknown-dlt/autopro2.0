const express = require("express");
const cors = require("cors");
const { authenticate } = require("./middleware/auth");
const { assistantRouteGuard } = require("./middleware/roles");
const { router: apiRouter, postLogin } = require("./routes/api");

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.post("/api/login", postLogin);

  app.use("/api", authenticate);
  app.use("/api", assistantRouteGuard);
  app.use("/api", apiRouter);

  return app;
}

module.exports = { createApp };
