import { defineStore } from "pinia";
import axios from "axios";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    user: null,
    token: localStorage.getItem("autopro-token") || "",
  }),
  getters: {
    isAuthenticated(state) {
      return !!state.token;
    },
    role(state) {
      return state.user && state.user.role;
    },
  },
  actions: {
    async login({ employeeId, password, captcha }) {
      const resp = await axios.post("/api/login", {
        employeeId,
        password,
        captcha,
      });
      this.user = resp.data.user;
      this.token = resp.data.token;
      localStorage.setItem("autopro-token", this.token);
      axios.defaults.headers.common.Authorization = "Bearer " + this.token;
    },
    initFromStorage() {
      if (this.token) {
        axios.defaults.headers.common.Authorization = "Bearer " + this.token;
      }
    },
    async fetchMe() {
      if (!this.token) return;
      const { data } = await axios.get("/api/me");
      this.user = data.user;
    },
    logout() {
      this.user = null;
      this.token = "";
      localStorage.removeItem("autopro-token");
      delete axios.defaults.headers.common.Authorization;
    },
  },
});

