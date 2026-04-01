## Папка `start`

В этой папке находятся скрипты для удобного локального запуска проекта AutoPro.

### Основной скрипт

- **`start.ps1`** — PowerShell‑скрипт, который:
  - проверяет наличие `node`, `npm` и `docker`;
  - поднимает PostgreSQL через `docker compose up -d`;
  - при первом запуске устанавливает зависимости в:
    - корне проекта (`package.json`);
    - `backend`;
    - `frontend`;
  - запускает локальный режим разработки командой `npm run dev` из корня проекта (запускает backend и frontend параллельно).

### Как запустить проект

1. Откройте PowerShell.
2. Перейдите в корень проекта:

   ```powershell
   cd "C:\Projects\autopro"
   ```

3. Запустите скрипт:

   ```powershell
   powershell -ExecutionPolicy Bypass -File ".\start\start.ps1"
   ```

   При необходимости можно пропустить установку зависимостей (если всё уже установлено):

   ```powershell
   powershell -ExecutionPolicy Bypass -File ".\start\start.ps1" -SkipInstall
   ```

### Требования

- Установленный **Node.js** (вместе с `npm`).
- Установленный **Docker Desktop** (или совместимый Docker Engine с `docker compose`).
- Разрешён запуск PowerShell‑скриптов (в примере выше используется `-ExecutionPolicy Bypass` только для одного запуска).

