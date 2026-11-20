const form = document.querySelector("#setup-form");
const hostFields = document.querySelector("#host-fields");
const clientFields = document.querySelector("#client-fields");
const adminFields = document.querySelector("#admin-fields");
const adminNote = document.querySelector("#admin-note");
const callbackHint = document.querySelector("#discord-callback-hint");
const errorBox = document.querySelector("#setup-error");
const submitButton = document.querySelector("#submit");
let adminExists = false;

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || "host";
}

function updateMode() {
  const hostMode = selectedMode() === "host";
  hostFields.classList.toggle("hidden", !hostMode);
  clientFields.classList.toggle("hidden", hostMode);
  const showAdmin = hostMode && !adminExists;
  adminFields.classList.toggle("hidden", !showAdmin);
  adminNote.classList.toggle("hidden", !showAdmin);
  for (const input of adminFields.querySelectorAll("input")) input.required = showAdmin;
  document.querySelector("#server-url").required = !hostMode;
  updateDiscordCallback();
}

function updateDiscordCallback() {
  const publicUrl = document.querySelector("#public-url").value.trim();
  if (selectedMode() !== "host" || !publicUrl) {
    callbackHint.classList.add("hidden");
    callbackHint.textContent = "";
    return;
  }
  try {
    callbackHint.textContent = `Добавьте этот адрес в Discord Developer Portal → OAuth2 → Redirects: ${new URL("/api/discord/callback", publicUrl)}`;
    callbackHint.classList.remove("hidden");
  } catch {
    callbackHint.classList.add("hidden");
    callbackHint.textContent = "";
  }
}

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", updateMode);
}
document.querySelector("#public-url").addEventListener("input", updateDiscordCallback);

window.portalSetup.getState().then((state) => {
  adminExists = state.adminExists;
  document.querySelector("#data-directory").textContent = state.dataDirectory;
  document.querySelector("#env-path").textContent = state.envPath;
  if (state.config?.mode) {
    document.querySelector(`input[name="mode"][value="${state.config.mode}"]`).checked = true;
  } else {
    document.querySelector('input[name="mode"][value="host"]').checked = true;
  }
  if (state.config?.serverUrl) document.querySelector("#server-url").value = state.config.serverUrl;
  if (state.config?.publicUrl) document.querySelector("#public-url").value = state.config.publicUrl;
  updateMode();
}).catch((error) => {
  errorBox.textContent = error.message;
  errorBox.classList.remove("hidden");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.classList.add("hidden");
  submitButton.disabled = true;
  submitButton.textContent = "Запускаем…";
  const mode = selectedMode();
  const settings = { mode };
  if (mode === "client") {
    settings.serverUrl = document.querySelector("#server-url").value.trim();
  } else {
    settings.publicUrl = document.querySelector("#public-url").value.trim();
    if (!adminExists) {
      settings.username = document.querySelector("#admin-username").value.trim();
      settings.displayName = document.querySelector("#admin-display-name").value.trim();
      settings.password = document.querySelector("#admin-password").value;
    }
  }
  try {
    await window.portalSetup.save(settings);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
    submitButton.disabled = false;
    submitButton.textContent = "Сохранить и открыть портал";
  }
});
