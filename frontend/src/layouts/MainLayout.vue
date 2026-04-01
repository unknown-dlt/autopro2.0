<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="logo">
        <div class="logo-icon">
          <img src="/logo-wrench.png" alt="AutoPro" class="logo-mark" />
        </div>
        <div class="logo-text">AutoPro</div>
      </div>
      <nav class="menu">
        <RouterLink
          v-for="item in visibleMenu"
          :key="item.name"
          :to="item.to"
          class="menu-item"
          :class="{ active: $route.name === item.name }"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <div class="main">
      <header class="topbar">
        <div class="role-label">
          <span v-if="role === 'MANAGER'">Менеджер</span>
          <span v-else>Механик</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;position:relative;">
          <div class="notifications">
            <button class="icon-button notifications-button" @click="toggleNotifications">
              <span class="notifications-icon">🔔</span>
              <span v-if="hasUnread" class="notifications-dot"></span>
            </button>
            <transition name="fade-scale">
              <div v-if="showNotifications" class="notifications-panel">
                <div class="panel-title">Уведомления</div>
                <div v-if="!notifications.length" class="empty">
                  Пока нет уведомлений
                </div>
                <ul v-else class="list">
                  <li v-for="n in notifications" :key="n.id" class="item">
                    <span class="msg">{{ n.message }}</span>
                    <span class="time">
                      {{ formatTime(n.timestamp) }}
                    </span>
                  </li>
                </ul>
                <button class="clear-btn" @click="clearNotifications">
                  Очистить уведомления
                </button>
              </div>
            </transition>
          </div>
          <button class="logout" @click="onLogout">Выйти</button>
        </div>
      </header>
      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<script>
import { RouterLink, RouterView } from "vue-router";
import { useAuthStore } from "../store/auth";
import axios from "axios";

export default {
  name: "MainLayout",
  components: { RouterLink, RouterView },
  created() {
    const auth = useAuthStore();
    auth.initFromStorage();
    this.loadNotifications();
  },
  data() {
    return {
      menu: [
        { name: "dashboard", label: "Обзор", to: "/app/dashboard" },
        { name: "clients", label: "Клиенты", to: "/app/clients" },
        { name: "services", label: "Каталог услуг", to: "/app/services" },
        { name: "parts", label: "Склад запчастей", to: "/app/parts" },
        { name: "history", label: "История обслуживаний", to: "/app/history" },
        { name: "schedule", label: "Расписание", to: "/app/schedule" },
        { name: "mechanics", label: "Механики", to: "/app/mechanics" },
        { name: "reports", label: "Отчёты", to: "/app/reports" },
      ],
      notifications: [],
      showNotifications: false,
      lastSeenNotificationId: null,
    };
  },
  computed: {
    role() {
      const auth = useAuthStore();
      return auth.role || "MANAGER";
    },
    visibleMenu() {
      if (this.role === "ASSISTANT") {
        const allowed = ["dashboard", "clients", "services", "history", "parts"];
        return this.menu.filter((m) => allowed.includes(m.name));
      }
      return this.menu;
    },
    hasUnread() {
      if (!this.notifications.length) return false;
      if (!this.lastSeenNotificationId) return true;
      return this.notifications[0].id !== this.lastSeenNotificationId;
    },
  },
  methods: {
    async loadNotifications() {
      try {
        const { data } = await axios.get("/api/notifications");
        this.notifications = data;
      } catch (e) {
        console.warn("Не удалось загрузить уведомления", e);
      }
    },
    toggleNotifications() {
      this.showNotifications = !this.showNotifications;
      if (this.showNotifications && this.notifications.length) {
        this.lastSeenNotificationId = this.notifications[0].id;
      }
    },
    async clearNotifications() {
      try {
        await axios.delete("/api/notifications");
        this.notifications = [];
      } catch (e) {
        console.warn("Ошибка очистки уведомлений", e);
      }
    },
    formatTime(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      return d.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      });
    },
    onLogout() {
      const auth = useAuthStore();
      auth.logout();
      this.$router.push({ name: "login" });
    },
  },
};
</script>

