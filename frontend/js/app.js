/**
 * app.js — bootstraps the frontend: session check, sign-in / password flows,
 * the application shell, and the page modules.
 */
import { api } from "./api/client.js";
import { $, $$ } from "./core/dom.js";
import { currentPage, registerPage, startRouter } from "./core/router.js";
import { initShell, refreshBadges, setProfile } from "./core/shell.js";
import { can, loadLookups, state } from "./core/state.js";
import { closeModal, formModal, initDynamicModal, openModal, showFieldErrors, clearFieldErrors, readForm, toast, toastError, withBusy } from "./core/ui.js";

import audit from "./pages/audit.js";
import cash from "./pages/cash.js";
import dashboard from "./pages/dashboard.js";
import debtors from "./pages/debtors.js";
import dsr from "./pages/dsr.js";
import expenses from "./pages/expenses.js";
import git from "./pages/git.js";
import reports from "./pages/reports.js";
import rtt from "./pages/rtt.js";
import setup from "./pages/setup.js";
import stock from "./pages/stock.js";
import truck from "./pages/truck.js";

[dashboard, truck, dsr, rtt, stock, git, cash, debtors, expenses, reports, audit, setup].forEach(registerPage);

let started = false;
let badgeTimer = null;

/* Screens ----------------------------------------------------------------------- */

function showScreen(name) {
  $("#bootScreen").hidden = name !== "boot";
  $("#authScreen").hidden = name !== "auth";
  $("#appShell").hidden = name !== "app";
}

function showLogin(message) {
  showScreen("auth");
  $("#loginForm").hidden = false;
  $("#resetForm").hidden = true;
  const banner = $("#loginForm .form-error");
  clearFieldErrors($("#loginForm"));
  if (message) {
    banner.textContent = message;
    banner.hidden = false;
  }
  $("#loginUsername").focus();
}

let passwordMode = { kind: "reset", token: null };

function showPasswordForm(kind, { token = null, lead } = {}) {
  passwordMode = { kind, token };
  showScreen("auth");
  $("#loginForm").hidden = true;
  $("#resetForm").hidden = false;
  $("#resetForm").reset();
  clearFieldErrors($("#resetForm"));
  $("#currentPasswordField").hidden = kind !== "change";
  $("#resetForm h1").textContent = kind === "change" ? "Change your password" : "Set a new password";
  $("#resetLead").textContent = lead ?? "Choose a password of at least 10 characters with letters and numbers.";
  ($("#currentPasswordField").hidden ? $("#resetPassword") : $("#currentPassword")).focus();
}

/* Session ----------------------------------------------------------------------------- */

function applyPermissionVisibility() {
  $$("[data-permission]").forEach((el) => {
    if (!can(el.dataset.permission)) el.hidden = true;
  });
}

async function enterApp(profile) {
  state.user = profile;
  if (profile.mustChangePassword) {
    showPasswordForm("change", { lead: "Your administrator set a temporary password. Choose a new one to continue." });
    return;
  }
  await loadLookups();
  setProfile(profile);
  applyPermissionVisibility();
  showScreen("app");
  if (!started) {
    started = true;
    startRouter();
  }
  refreshBadges();
  clearInterval(badgeTimer);
  badgeTimer = setInterval(refreshBadges, 60_000);
}

async function logout() {
  try {
    await api.post("/auth/logout");
  } finally {
    window.location.replace(window.location.pathname);
  }
}

function changePasswordDialog() {
  formModal({
    title: "Change password",
    intro: "Other devices signed in to your account will be signed out.",
    fields: [
      { name: "currentPassword", label: "Current password", type: "password", span: true, autocomplete: "current-password" },
      { name: "newPassword", label: "New password", type: "password", autocomplete: "new-password", hint: "At least 10 characters, letters and numbers." },
      { name: "confirmPassword", label: "Confirm new password", type: "password", autocomplete: "new-password" },
    ],
    submitLabel: "Change password",
    onSubmit: async (values, { form, close }) => {
      if (values.newPassword !== values.confirmPassword) {
        showFieldErrors(form, { message: "The new passwords do not match.", fields: { confirmPassword: "Does not match the new password." } });
        return;
      }
      await api.post("/auth/change-password", { currentPassword: values.currentPassword ?? "", newPassword: values.newPassword ?? "" });
      close();
      toast("Password changed.", "success");
    },
  });
}

/* Static wiring ---------------------------------------------------------------------- */

function bindAuthForms() {
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const values = readForm(form);
    await withBusy(form.querySelector("button[type=submit]"), async () => {
      try {
        const res = await api.post("/auth/login", { username: values.username ?? "", password: values.password ?? "" });
        form.reset();
        // Page modules were initialised for the previous session (station scope,
        // hidden controls); start clean instead of re-using them.
        if (started) {
          window.location.reload();
          return;
        }
        await enterApp(res.data);
      } catch (err) {
        showFieldErrors(form, err);
      }
    });
  });

  $("#resetForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const values = readForm(form);
    if (values.newPassword !== values.confirmPassword) {
      showFieldErrors(form, { message: "The new passwords do not match.", fields: { confirmPassword: "Does not match the new password." } });
      return;
    }
    await withBusy(form.querySelector("button[type=submit]"), async () => {
      try {
        if (passwordMode.kind === "change") {
          const res = await api.post("/auth/change-password", { currentPassword: values.currentPassword ?? "", newPassword: values.newPassword ?? "" });
          await enterApp(res.data);
        } else {
          await api.post("/auth/password-reset/confirm", { token: passwordMode.token, newPassword: values.newPassword ?? "" });
          history.replaceState(null, "", window.location.pathname);
          showLogin();
          $("#loginForm .lead").textContent = "Password updated. Sign in with your new password.";
        }
      } catch (err) {
        showFieldErrors(form, err);
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="back-to-login"]')) {
      e.preventDefault();
      history.replaceState(null, "", window.location.pathname);
      if (passwordMode.kind === "change") logout();
      else showLogin();
    }
  });
}

function bindModalsAndActions() {
  document.addEventListener("click", async (e) => {
    const opener = e.target.closest("[data-open-modal]");
    if (opener) {
      const id = opener.dataset.openModal;
      try {
        await currentPage()?.modals?.[id]?.();
        openModal(id);
      } catch (err) {
        toastError(err);
      }
      return;
    }
    const closer = e.target.closest("[data-close-modal]");
    if (closer) {
      closeModal(closer.dataset.closeModal);
      return;
    }
    const submit = e.target.closest("[data-submit]");
    if (submit) {
      document.getElementById(submit.dataset.submit)?.requestSubmit();
      return;
    }
    const action = e.target.closest("#appShell [data-action]");
    if (action && !action.closest(".menu")) {
      const handler = currentPage()?.actions?.[action.dataset.action];
      if (handler) handler(action, e);
    }
  });
  $$(".overlay:not(#dynamicModal)").forEach((overlay) =>
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("show");
    }),
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $$(".overlay.show").forEach((o) => o.classList.remove("show"));
  });
}

window.addEventListener("auth:expired", () => {
  if (!state.user) return;
  state.user = null;
  clearInterval(badgeTimer);
  $$(".overlay.show").forEach((o) => o.classList.remove("show"));
  showLogin("Your session has expired. Please sign in again.");
});

/* Boot ------------------------------------------------------------------------------------ */

async function boot() {
  initDynamicModal();
  bindAuthForms();
  bindModalsAndActions();
  initShell({ onLogout: logout, onChangePassword: changePasswordDialog });

  const reset = new URLSearchParams(window.location.hash.slice(1)).get("reset");
  if (reset) {
    try {
      const res = await api.post("/auth/password-reset/verify", { token: reset });
      showPasswordForm("reset", { token: reset, lead: `Set a new password for ${res.data.fullName} (${res.data.username}).` });
    } catch (err) {
      history.replaceState(null, "", window.location.pathname);
      showLogin(err.message);
    }
    return;
  }

  try {
    const me = await api.get("/auth/me");
    await enterApp(me.data);
  } catch (err) {
    showLogin(err.status === 401 ? undefined : err.message);
  }
}

boot();
