<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <div class="logo-icon">AP</div>
        <h1>AutoPro</h1>
        <p>CRM автосервиса — вход</p>
      </div>
      <form class="login-form" @submit.prevent="submit">
        <label class="field">
          <span>ID работника</span>
          <input
            :value="employeeId"
            required
            @input="onEmployeeIdInput($event)"
            @keydown="onEmployeeIdKeydown"
          />
        </label>
        <label class="field">
          <span>Пароль</span>
          <input v-model="password" type="password" required />
        </label>
        <label class="field">
          <span>Captcha</span>
          <div class="captcha-row">
            <div class="captcha-question">{{ captchaQuestion }}</div>
            <input v-model="captchaInput" required />
          </div>
        </label>
        <div v-if="error" class="error">{{ error }}</div>
        <button type="submit" class="primary-btn">Войти</button>
      </form>
    </div>
  </div>
</template>

<script>
import { useAuthStore } from "../store/auth";

export default {
  name: "LoginPage",
  data() {
    return {
      employeeId: "",
      password: "",
      captchaA: 0,
      captchaB: 0,
      captchaInput: "",
      error: "",
    };
  },
  computed: {
    captchaQuestion() {
      return `${this.captchaA} + ${this.captchaB} = ?`;
    },
  },
  created() {
    this.generateCaptcha();
  },
  methods: {
    generateCaptcha() {
      this.captchaA = Math.floor(Math.random() * 9) + 1;
      this.captchaB = Math.floor(Math.random() * 9) + 1;
      this.captchaInput = "";
    },
    onEmployeeIdKeydown(e) {
      const controlKeys = [
        "Backspace",
        "Delete",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Tab",
        "Enter",
        "Home",
        "End",
      ];
      if (controlKeys.includes(e.key) || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      const allowed = /^[A-Za-z0-9]$/;
      if (!allowed.test(e.key)) {
        e.preventDefault();
      }
    },
    onEmployeeIdInput(e) {
      const raw = e.target.value || "";
      this.employeeId = raw.replace(/[^A-Za-z0-9]/g, "");
    },
    async submit() {
      this.error = "";
      try {
        const expected = this.captchaA + this.captchaB;
        if (Number(this.captchaInput) !== expected) {
          this.error = "Неверный ответ на captcha";
          this.generateCaptcha();
          return;
        }
        const auth = useAuthStore();
        await auth.login({
          employeeId: this.employeeId.trim(),
          password: this.password,
          captcha: {
            a: this.captchaA,
            b: this.captchaB,
            answer: Number(this.captchaInput),
          },
        });
        this.$router.push({ name: "dashboard" });
      } catch (e) {
        this.error =
          (e.response && e.response.data && e.response.data.error) ||
          "Ошибка входа";
        this.generateCaptcha();
      }
    },
  },
};
</script>

