# Полное описание проекта AutoPro (актуальная версия)

Документ предназначен для того, чтобы LLM (например, ChatGPT) могла восстановить полную картину проекта: назначение, структуру, внешний вид, сценарии, бизнес-логику, API, формат хранения данных и ограничения пользовательского ввода.

---

## 1. Назначение проекта

**AutoPro** — веб-приложение (CRM/учёт) для **автосервиса**. Сервис объединяет в едином интерфейсе:

- **Расписание** (записи клиентов на обслуживание, создание/редактирование/удаление, модальные детали);
- **Каталог услуг** (CRUD: создание/редактирование/удаление, длительность услуги и цена);
- **Склад запчастей** (учёт позиций, изменение количества, связанные списания при выполнении работ);
- **Учёт механиков** (сотрудники/работники, активность, учёт выплат и доплат);
- **История обслуживаний** (показываются только завершённые работы, фильтр по госномеру);
- **Отчёты** (выручка, количество завершённых работ, зарплатный фонд по механикам, график работ по дням);
- **Уведомления** внутри интерфейса (панель в шапке).

### Хранилище данных

На текущей версии **используется JSON-файл**:

- `backend/data.json`

База данных PostgreSQL **не используется**.

---

## 2. Общая структура проекта

В корне `autopro/` находятся:

- `package.json` — скрипты запуска (в том числе `npm run dev` через `concurrently`);
- `backend/` — Node.js/Express сервер и файл `data.json`;
- `frontend/` — Vue 3 приложение (Vite + Router + Pinia);
- документация: `README.md`, `Курсовая_AutoPro.md`, этот файл.

Каталог `start/` содержит локальные скрипты запуска проекта для Windows.

---

## 3. Внешний вид и компоновка интерфейса

Интерфейс — единый SPA на **Vue 3** с фиолетовой палитрой, карточками, скруглёнными кнопками и анимациями.

Основные визуальные блоки:

- **Sidebar** (левое меню) — `frontend/src/layouts/MainLayout.vue`;
- **Topbar** (шапка) — роль пользователя, панель уведомлений, кнопка «Выйти»;
- Центральная область — текущая страница через `<router-view />`.

Стиль сосредоточен в:

- `frontend/src/assets/main.css`

---

## 4. Компоненты и страницы фронтенда

Маршруты задаются в `frontend/src/router/index.js`.

Страницы (views):

- `LoginPage.vue` — логин/авторизация с капчей;
- `DashboardPage.vue` — обзор и график работ за месяц;
- `ClientsPage.vue` — управление клиентами;
- `ServicesPage.vue` — управление услугами;
- `PartsPage.vue` — управление складом запчастей;
- `HistoryPage.vue` — история завершённых работ (фильтр по госномеру, модальное окно деталей);
- `SchedulePage.vue` — календарь, форма записи, модальное окно и управление requiredParts;
- `MechanicsPage.vue` — управление механиками/активностью;
- `ReportsPage.vue` — отчёты за период.

Глобальная точка входа:

- `frontend/src/main.js`

Сам компонент:

- `frontend/src/App.vue` содержит только `<router-view />`.

---

## 5. Технологический стек и зависимости

### 5.1 Frontend

- Vue.js 3
- Vue Router
- Pinia
- Vite
- Axios

В `frontend/vite.config.js` настроено:

- alias `@` → `frontend/src`;
- proxy: `/api` → `http://localhost:3000`;
- порт Vite — 5173 (или ближайший свободный порт при занятости).

### 5.2 Backend

- Node.js
- Express (HTTP-сервер)
- cors (CORS middleware)
- `fs`/`path` (чтение/запись JSON-файла)

Единственный server-файл:

- `backend/server.js`

Он поднимает API на порту `process.env.PORT || 3000`.

---

## 6. Авторизация и роли

### 6.1 Логин

Авторизация реализована через:

- `POST /api/login`

Входные поля:

- `role` — `MANAGER` или `ASSISTANT`;
- `employeeId` — идентификатор сотрудника;
- `password`;
- `captcha` — простая капча в формате суммы двух чисел.

Токен:

- возвращается фиксированный токен `autopro-demo-token`;
- фронтенд сохраняет его в `localStorage` и выставляет в axios-заголовке `Authorization: Bearer <token>`.

### 6.2 Ограничения ввода на логине

В `LoginPage.vue` поле **ID работника** принимает только:

- латиница (A–Z),
- цифры (0–9),
- спецсимволы/пробелы фильтруются.

Это сделано для снижения риска некорректного/вредоносного ввода.

### 6.3 Middleware auth в backend

Все маршруты под `/api` (кроме `/api/login`) проходят через middleware авторизации:

- если токен неверный/отсутствует — ответ `401`.

---

## 7. API backend (маршруты и назначение)

Базовый URL API:

- `http://localhost:3000`

Все методы описаны в `backend/server.js`. Префикс маршрутов — `/api`.

Ключевые endpoints:

1. **Dashboard**
   - `GET /api/dashboard`
   - возвращает:
     - статистику по частям на складе,
     - количество записей,
     - активную выручку,
     - `todaysAppointments`,
     - `activeMechanics`,
     - `dailyWork` (график по дням месяца: `count` — число записей в день).

2. **Clients (клиенты)**
   - `GET /api/clients`
   - `POST /api/clients`
   - `PUT /api/clients/:id`
   - `DELETE /api/clients/:id`

3. **Services (услуги)**
   - `GET /api/services`
   - `POST /api/services`
   - `PUT /api/services/:id`
   - `DELETE /api/services/:id`

4. **Parts (склад запчастей)**
   - `GET /api/parts`
   - `POST /api/parts`
   - `PUT /api/parts/:id`
   - `DELETE /api/parts/:id`

5. **Mechanics (механики)**
   - `GET /api/mechanics`
   - `POST /api/mechanics`
   - `PUT /api/mechanics/:id`
   - `DELETE /api/mechanics/:id`

6. **Appointments (записи/заказы/расписание)**
   - `GET /api/appointments`
   - `POST /api/appointments`
   - `PUT /api/appointments/:id`
   - `DELETE /api/appointments/:id`

7. **History (история)**
   - `GET /api/history`
   - query: `plate` (опционально)
   - возвращает только элементы `history` со статусом `COMPLETED`.

8. **Notifications**
   - `GET /api/notifications`
   - `DELETE /api/notifications`

9. **Reports (отчёты)**
   - `GET /api/reports?period=YYYY-MM`
   - возвращает:
     - `revenue`
     - `completedCount`
     - разбиение `byService` (сколько и выручка по услугам)
     - `totalPayroll` (фонд оплаты труда)
     - `byMechanic` (таблица зарплаты по механикам)

---

## 8. Модель данных (структура `backend/data.json`)

Файл `backend/data.json` содержит корневые массивы/ключи:

- `clients` — клиенты (`id`, `name`, `phone`, `note`);
- `services` — услуги (`id`, `name`, `description`, `duration`, `price`);
- `parts` — запчасти (`id`, `article`, `name`, `price`, `quantity`);
- `mechanics` — механики (`id`, `fullName`, `position`, `hireDate`, `active`, `baseSalary`, `bonusPerService`);
- `appointments` — записи:
  - `id`, `datetime` (ISO), `clientName`, `phone`, `carModel`, `carYear`,
  - `licensePlate`, `vin`,
  - `serviceId`, `mechanicId`,
  - `status` (`CREATED`, `CONFIRMED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`),
  - `comment`,
  - `requiredParts` — массив `{ partId, quantity }`.
- `history` — история завершённых работ (массив ссылок на appointments):
  - `id`, `appointmentId`, `datetime`, `licensePlate`, `serviceId`, `mechanicId`, `status`.
- `notifications` — уведомления:
  - `id`, `message`, `timestamp`.

---

## 9. Бизнес-логика и правила работы системы

### 9.1 Списание запчастей при завершении записи

Если запись сохраняется/обновляется с статусом **`COMPLETED`**, backend вызывает:

- `applyPartsWriteOff(data, requiredParts)`

Списание уменьшает `data.parts[].quantity` для каждой позиции в `requiredParts`.

### 9.2 Расчёт зарплат в отчётах

`GET /api/reports` использует завершённую историю (COMPLETED) за период:

- выручка складывается по ценам услуг;
- доплата механика зависит от `bonusPerService` и количества выполненных работ;
- итоговый `totalSalary = baseSalary + bonusTotal`.

### 9.3 Новая логика занятости механика (важная часть доработки)

В `backend/server.js` добавлена функция проверки пересечений:

- длительность новой/существующей записи вычисляется из `services.duration` (в минутах);
- строится интервал времени:
  - начало = `datetime`
  - конец = `datetime + durationMinutes`.

Проверка происходит при:

- `POST /api/appointments`
- `PUT /api/appointments/:id`

Условия блокировки:

- существующая запись механика блокирует новый слот, если её статус **не** `COMPLETED` и **не** `CANCELLED`;
- если новый слот пересекается по времени — сервер возвращает `400` с сообщением об ошибке (мастер занят).

Освобождение времени:

- если запись механика ранее была переведена в `COMPLETED` или `CANCELLED` **раньше конца интервала**, то она перестаёт блокировать пересекающееся время;
- пользователь может создавать новую запись для механика в освободившемся промежутке.

Это обеспечивает поведение “занято/свободно” по реальному статусу записи.

---

## 10. Взаимодействие frontend ↔ backend

Фронтенд работает через axios и делает запросы по путям `/api/...`.

Так как настроен proxy в `vite.config.js`:

- браузер отправляет запросы на `http://localhost:<vitePort>/api/...`;
- Vite проксирует их на `http://localhost:3000`.

Полученные JSON-данные используются для:

- отрисовки таблиц/списков (услуги, склад, клиенты, механики);
- построения расписания (appointments → группировка по дням/часам);
- построения отчётов и графика.

---

## 11. Описание пользовательских ограничений ввода и UX

На разных страницах используются функции из:

- `frontend/src/utils/inputFilters.js`

Например:

- `nameOnly` — имя/ФИО: только буквы/пробелы/дефис/апостроф;
- `vinOnly` — VIN: только буквы/цифры, максимум 17;
- `digitsOnlyMax` — числа с ограничением длины;
- `formatPhone` — формат телефона и контроль количества цифр.

Дополнительно:

- в `SchedulePage.vue` поле телефона блокирует ввод более чем **11 цифр**;
- комментарий в записи заменён на `textarea`, который **автоувеличивается по высоте** при вводе (ограничение по max-height, чтобы не “разваливать” блок).

---

## 12. Локальный запуск (папка start)

Для удобства добавлена папка:

- `start/`

Содержит:

- `start.bat` — запускает `start.ps1` через `cmd` (двойной клик в Windows);
- `start.ps1` — проверяет наличие `node`/`npm`, при необходимости делает `npm install` в `backend` и `frontend`, затем запускает `npm run dev` из корня.

---

## 13. Ключевые файлы проекта (для ориентира)

Backend:

- `backend/server.js` — Express + все маршруты API, business-логика (занятость механика, списание деталей, отчёты).
- `backend/data.json` — “хранилище данных” всей системы.

Frontend:

- `frontend/src/router/index.js` — маршрутизация и защита по role;
- `frontend/src/layouts/MainLayout.vue` — общий интерфейс (sidebar/topbar/уведомления);
- `frontend/src/views/SchedulePage.vue` — расписание, форма записи, requiredParts, обработка ошибок от API;
- `frontend/src/views/DashboardPage.vue` — график работ за месяц и обзор.
- `frontend/src/assets/main.css` — стиль интерфейса.

---

## 14. Итог

AutoPro — учебное/курсовое веб-приложение для автосервиса, построенное на Vue 3 + Node/Express и хранении данных в JSON-файле. Проект включает все необходимые сценарии: авторизацию, расписание, склад, отчёты и уведомления. В расписании реализована дополнительная бизнес-логика занятости механика с учётом длительности услуги и освобождения слота при статусах `COMPLETED/CANCELLED`.

