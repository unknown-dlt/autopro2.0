const { createApp } = require("./app");
const { initDb } = require("./db/migrate");

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    const app = createApp();
    app.listen(PORT, () => {
      console.log(`AutoPro backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database or start server:", err);
    process.exit(1);
  });
