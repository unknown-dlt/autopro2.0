import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../store/auth";
import LoginPage from "../views/LoginPage.vue";
import DashboardPage from "../views/DashboardPage.vue";
import ClientsPage from "../views/ClientsPage.vue";
import ServicesPage from "../views/ServicesPage.vue";
import PartsPage from "../views/PartsPage.vue";
import HistoryPage from "../views/HistoryPage.vue";
import SchedulePage from "../views/SchedulePage.vue";
import MechanicsPage from "../views/MechanicsPage.vue";
import ReportsPage from "../views/ReportsPage.vue";

const routes = [
  { path: "/", name: "login", component: LoginPage },
  {
    path: "/app",
    component: () => import("../layouts/MainLayout.vue"),
    meta: { requiresAuth: true },
    children: [
      { path: "dashboard", name: "dashboard", component: DashboardPage },
      { path: "clients", name: "clients", component: ClientsPage },
      { path: "services", name: "services", component: ServicesPage },
      { path: "parts", name: "parts", component: PartsPage },
      { path: "history", name: "history", component: HistoryPage },
      { path: "schedule", name: "schedule", component: SchedulePage },
      { path: "mechanics", name: "mechanics", component: MechanicsPage },
      { path: "reports", name: "reports", component: ReportsPage },
      { path: "", redirect: { name: "dashboard" } },
    ],
  },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to, from, next) => {
  const auth = useAuthStore();
  auth.initFromStorage();
  if (auth.token && !auth.user) {
    try {
      await auth.fetchMe();
    } catch {
      auth.logout();
    }
  }
  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    next({ name: "login" });
  } else if (to.name === "login" && auth.isAuthenticated) {
    next({ name: "dashboard" });
  } else {
    if (auth.role === "ASSISTANT") {
      const allowed = [
        "dashboard",
        "schedule",
        "clients",
        "services",
        "history",
        "parts",
        "mechanics",
      ];
      if (to.name && !allowed.includes(to.name.toString())) {
        next({ name: "dashboard" });
        return;
      }
    }
    next();
  }
});

export default router;

