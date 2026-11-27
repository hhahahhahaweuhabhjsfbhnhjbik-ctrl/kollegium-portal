/**
 * webhooks.test.mjs — тесты модуля доставки Discord-уведомлений.
 *
 * Только встроенные модули Node.js и полностью in-memory фейки:
 * реальная сеть не используется, паузы между повторами инъектируются.
 *
 * Запуск: node webhooks.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DISCORD_EMBED_COLORS,
  WEBHOOK_CHANNELS,
  buildWebhookPayload,
  createWebhookDispatcher,
  describeWebhook,
  isDiscordWebhookUrl,
  pickColor,
  sendWebhook
} from "./webhooks.mjs";

// Печать читается один раз: она нужна почти каждому тесту.
const SEAL = await readFile(new URL("./assets/collegium-seal.png", import.meta.url));

const WEBHOOK_URL = "https://discord.com/api/webhooks/123456789012345678/test-token";
const WEBHOOK_URL_ALT = "https://discordapp.com/api/webhooks/987654321098765432/other-token";

/** Тихий логгер, чтобы тесты не засоряли вывод. */
function silentLogger() {
  return { error() {}, warn() {}, info() {}, log() {} };
}

/** Логгер, запоминающий вызовы. */
function recordingLogger() {
  const errors = [];
  const warns = [];
  return {
    errors,
    warns,
    error(...args) {
      errors.push(args);
    },
    warn(...args) {
      warns.push(args);
    }
  };
}

/** Успешный пустой ответ (204), как у Discord после доставки. */
function noContent() {
  return new Response(null, { status: 204 });
}

/** JSON-ответ с заданным статусом. */
function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

/** Разбирает payload_json из записанного FormData. */
function payloadOf(options) {
  assert.ok(options.body instanceof FormData, "тело запроса должно быть FormData");
  return JSON.parse(options.body.get("payload_json"));
}

/** Создаёт диспетчер с разумными тестовыми настройками по умолчанию. */
function makeDispatcher(overrides = {}) {
  return createWebhookDispatcher({
    fetchImpl: async () => noContent(),
    readFileImpl: async () => SEAL,
    logger: silentLogger(),
    baseDelayMs: 1,
    maxAttempts: 4,
    sleep: async () => {},
    random: () => 0,
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// 1. Успешная доставка
// ---------------------------------------------------------------------------

test("успешная доставка: один fetch, FormData, печать и allowed_mentions", async () => {
  const calls = [];
  const dispatcher = makeDispatcher({
    webhooks: { applications: WEBHOOK_URL },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return noContent();
    }
  });

  try {
    const result = await dispatcher.deliver("applications", {
      title: "Заявка одобрена",
      description: "Кандидат успешно прошёл проверку.",
      fields: [{ name: "Кандидат", value: "Иван", inline: true }]
    });

    assert.deepEqual(result, { ok: true, warning: "", attempts: 1, status: 204 });
    assert.equal(calls.length, 1, "ровно один fetch на успешную доставку");

    const [{ url, options }] = calls;
    assert.equal(String(url), WEBHOOK_URL);
    assert.equal(options.method, "POST");
    assert.ok(options.body instanceof FormData);
    assert.ok(options.signal instanceof AbortSignal, "должен быть сигнал таймаута");

    const payload = payloadOf(options);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });

    const embed = payload.embeds[0];
    assert.equal(embed.title, "Заявка одобрена");
    assert.equal(embed.author.name, "Коллегия адвокатов · Mirror GTA 5 RP");
    assert.equal(embed.footer.text, "Mirror GTA 5 RP · Коллегия адвокатов");
    assert.equal(embed.thumbnail.url, "attachment://collegium-seal.png");
    assert.match(embed.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(embed.color, 5763719, "«одобр» остаётся зелёным");

    // Вложение печати: Blob с правильным именем и типом.
    const seal = options.body.get("files[0]");
    assert.ok(seal instanceof Blob);
    assert.equal(seal.name, "collegium-seal.png");
    assert.equal(seal.type, "image/png");
    assert.equal(seal.size, SEAL.length);

    const snapshot = dispatcher.status();
    assert.equal(snapshot.applications.configured, true);
    assert.equal(snapshot.applications.sent, 1);
    assert.equal(snapshot.applications.failed, 0);
    assert.equal(typeof snapshot.applications.lastSuccessAt, "number");
    assert.equal(snapshot.pending, 0);
    assert.equal(snapshot.queued, 0);
  } finally {
    dispatcher.stop();
    await dispatcher.drain();
  }
});

test("уведомления о обзвоне включают упоминания по ID и ссылочную кнопку", () => {
  const { payload } = buildWebhookPayload({
    title: "Решение по обзвону",
    content: "<@12345678901234567> <@22345678901234567>",
    mentionUsers: ["12345678901234567", "22345678901234567", "invalid"],
    components: [{
      type: 1,
      components: [{ type: 2, style: 5, label: "Перейти", url: "https://discord.com/channels/1/2" }]
    }],
    seal: SEAL
  });
  assert.deepEqual(payload.allowed_mentions, {
    parse: [],
    users: ["12345678901234567", "22345678901234567"]
  });
  assert.equal(payload.content, "<@12345678901234567> <@22345678901234567>");
  assert.equal(payload.components[0].components[0].style, 5);
  assert.equal(payload.components[0].components[0].url, "https://discord.com/channels/1/2");
});

// ---------------------------------------------------------------------------
// 2. Пользовательское вложение
// ---------------------------------------------------------------------------

test("вложение: image attachment и files[1] с правильным типом", async () => {
  const calls = [];
  const dispatcher = makeDispatcher({
    webhooks: { logs: WEBHOOK_URL },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return noContent();
    }
  });

  try {
    const result = await dispatcher.deliver("logs", {
      title: "⚠️ Выговор №7",
      description: "Сотрудник получил дисциплинарное взыскание.",
      file: {
        name: "evidence.png",
        content: Buffer.from("fake-png-bytes"),
        contentType: "image/png"
      }
    });

    assert.equal(result.ok, true);
    const { options } = calls[0];
    const embed = payloadOf(options).embeds[0];

    assert.equal(embed.image.url, "attachment://evidence.png");
    assert.equal(embed.thumbnail.url, "attachment://collegium-seal.png");

    assert.equal(options.body.get("files[0]").name, "collegium-seal.png");
    const attachment = options.body.get("files[1]");
    assert.ok(attachment instanceof Blob);
    assert.equal(attachment.name, "evidence.png");
    assert.equal(attachment.type, "image/png");
  } finally {
    dispatcher.stop();
    await dispatcher.drain();
  }
});

// ---------------------------------------------------------------------------
// 3. Валидация URL
// ---------------------------------------------------------------------------

test("валидация URL: http, чужой хост, чужой путь и мусор отклоняются без fetch", async () => {
  const badUrls = [
    "http://discord.com/api/webhooks/123456789012345678/token",
    "https://evil.example/api/webhooks/123456789012345678/token",
    "https://discord.com/api/other/123456789012345678/token",
    "https://discord.com/api/webhooks/abc/token",
    "https://discord.com/api/webhooks/123456789012345678",
    "совсем не url"
  ];

  for (const url of badUrls) {
    assert.equal(isDiscordWebhookUrl(url), false, `должен отклоняться: ${url}`);
  }
  assert.equal(isDiscordWebhookUrl(WEBHOOK_URL), true);
  assert.equal(isDiscordWebhookUrl(WEBHOOK_URL_ALT), true);
  assert.equal(isDiscordWebhookUrl(new URL(WEBHOOK_URL)), true);
  assert.equal(isDiscordWebhookUrl(""), false);

  const calls = [];
  const dispatcher = makeDispatcher({
    fetchImpl: async (...args) => {
      calls.push(args);
      return noContent();
    }
  });

  try {
    for (const url of badUrls) {
      const result = await dispatcher.deliverToUrl(url, { title: "Тест" });
      assert.equal(result.ok, false);
      assert.equal(result.attempts, 0);
      assert.match(result.warning, /Webhook не отправлен/);
    }
    assert.equal(calls.length, 0, "при некорректном URL fetch не вызывается");
  } finally {
    dispatcher.stop();
  }
});

// ---------------------------------------------------------------------------
// 4. Пустой URL — тихий пропуск
// ---------------------------------------------------------------------------

test("пустой URL: тихий пропуск без fetch и без предупреждения", async () => {
  const calls = [];
  const dispatcher = makeDispatcher({
    fetchImpl: async (...args) => {
      calls.push(args);
      return noContent();
    }
  });

  try {
    const result = await dispatcher.deliver("applications", { title: "Заявка" });
    assert.deepEqual(result, { ok: false, warning: "", attempts: 0, configured: false });
    assert.equal(calls.length, 0);

    const explicit = await dispatcher.deliverToUrl("", { title: "Заявка" });
    assert.deepEqual(explicit, { ok: false, warning: "", attempts: 0, configured: false });

    assert.equal(dispatcher.status().applications.configured, false);
  } finally {
    dispatcher.stop();
  }
});

// ---------------------------------------------------------------------------
// 5. Повторы после сетевых ошибок
// ---------------------------------------------------------------------------

test("повторы: две сетевые ошибки, затем успех — attempts === 3 и retries в status", async () => {
  let calls = 0;
  const delays = [];
  const dispatcher = makeDispatcher({
    webhooks: { logs: WEBHOOK_URL },
    maxAttempts: 4,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("network down");
      return noContent();
    },
    sleep: async (ms) => {
      delays.push(ms);
    }
  });

  try {
    const result = await dispatcher.deliver("logs", { title: "Готовность к обзвону" });

    assert.deepEqual(result, { ok: true, warning: "", attempts: 3, status: 204 });
    assert.equal(calls, 3);
    assert.equal(delays.length, 2, "между тремя попытками две паузы");

    const state = dispatcher.status().logs;
    assert.equal(state.sent, 1);
    assert.equal(state.failed, 0);
    assert.equal(state.retries, 2);
  } finally {
    dispatcher.stop();
    await dispatcher.drain();
  }
});

// ---------------------------------------------------------------------------
// 6. 429 и retry_after
// ---------------------------------------------------------------------------

test("429: retry_after из JSON honoured, затем успех", async () => {
  let calls = 0;
  const delays = [];
  const dispatcher = makeDispatcher({
    webhooks: { exams: WEBHOOK_URL },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(429, { retry_after: 2.5, global: false });
      return noContent();
    },
    sleep: async (ms) => {
      delays.push(ms);
    }
  });

  try {
    const result = await dispatcher.test("exams");
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.deepEqual(delays, [2500], "пауза должна быть ровно из retry_after");
    assert.equal(dispatcher.status().exams.retries, 1);
  } finally {
    dispatcher.stop();
    await dispatcher.drain();
  }
});

test("503: Retry-After в заголовке honoured", async () => {
  let calls = 0;
  const delays = [];
  const dispatcher = makeDispatcher({
    webhooks: { logs: WEBHOOK_URL },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 503, headers: { "retry-after": "1.5" } });
      }
      return noContent();
    },
    sleep: async (ms) => {
      delays.push(ms);
    }
  });

  try {
    const result = await dispatcher.deliver("logs", { title: "Готово" });
    assert.equal(result.ok, true);
    assert.deepEqual(delays, [1500]);
  } finally {
    dispatcher.stop();
    await dispatcher.drain();
  }
});

// ---------------------------------------------------------------------------
// 7. Исчерпание попыток
// ---------------------------------------------------------------------------

test("исчерпание попыток: ok:false, warning с HTTP и числом попыток, без throw", async () => {
  const logger = recordingLogger();
  let calls = 0;
  const dispatcher = makeDispatcher({
    webhooks: { applications: WEBHOOK_URL },
    maxAttempts: 3,
    logger,
    fetchImpl: async () => {
      calls += 1;
      return new Response("server error", { status: 500 });
    }
  });

  try {
    const result = await dispatcher.deliver("applications", { title: "Ошибка доставки" });

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 3);
    assert.equal(result.status, 500);
    assert.match(result.warning, /HTTP 500/);
    assert.match(result.warning, /Попыток: 3/);

    assert.equal(calls, 3);
    const state = dispatcher.status().applications;
    assert.equal(state.failed, 1);
    assert.equal(state.sent, 0);
    assert.equal(state.retries, 2);
    assert.match(state.lastError, /HTTP 500/);
    assert.equal(typeof state.lastErrorAt, "number");

    const failureLog = logger.errors.find((args) => args[0] === "Discord webhook delivery failed:");
    assert.ok(failureLog, "сбой логируется со стабильным префиксом");
  } finally {
    dispatcher.stop();
    await dispatcher.drain();
  }
});

// ---------------------------------------------------------------------------
// 8. Сериализация по URL
// ---------------------------------------------------------------------------

test("очередь: два одновременных deliver в один URL не пересекаются", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;

  const dispatcher = makeDispatcher({
    webhooks: { applications: WEBHOOK_URL },
    fetchImpl: async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return noContent();
    }
  });

  try {
    const [first, second] = await Promise.all([
      dispatcher.deliver("applications", { title: "Первое уведомление" }),
      dispatcher.deliver("applications", { title: "Второе уведомление" })
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(calls, 2);
    assert.equal(maxInFlight, 1, "запросы к одному webhook идут строго последовательно");
    assert.equal(dispatcher.status().pending, 0);
  } finally {
    dispatcher.stop();
    await dispatcher.drain();
  }
});

test("очередь: разные URL доставляются параллельно", { timeout: 2000 }, async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const dispatcher = makeDispatcher({
    webhooks: { applications: WEBHOOK_URL, logs: WEBHOOK_URL_ALT },
    fetchImpl: async (url) => {
      started.push(String(url));
      // Если бы очередь была глобальной, второй fetch не начался бы и тест
      // завис бы до таймаута — здесь обе доставки должны встретиться.
      if (started.length === 2) release();
      await gate;
      return noContent();
    }
  });

  try {
    const [first, second] = await Promise.all([
      dispatcher.deliver("applications", { title: "Заявка" }),
      dispatcher.deliver("logs", { title: "Лог" })
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(started.length, 2);
  } finally {
    dispatcher.stop();
    await dispatcher.drain();
  }
});

// ---------------------------------------------------------------------------
// 9. Отсутствие утечки токена
// ---------------------------------------------------------------------------

test("status() и логи не раскрывают токен webhook", async () => {
  const secret = "super-secret-token";
  const url = `https://discord.com/api/webhooks/123456789012345678/${secret}`;
  const logger = recordingLogger();

  const dispatcher = makeDispatcher({
    webhooks: { logs: url },
    maxAttempts: 1,
    logger,
    fetchImpl: async () => {
      // Худший случай: текст ошибки сам содержит полный URL.
      throw new Error(`fetch failed for ${url}`);
    }
  });

  try {
    const result = await dispatcher.deliver("logs", { title: "Секрет" });
    assert.equal(result.ok, false);

    const serialized = JSON.stringify(dispatcher.status());
    assert.equal(serialized.includes(secret), false, "токен не должен попадать в status()");
    assert.equal(serialized.includes("https://discord.com/api/webhooks"), false);

    const logs = JSON.stringify(logger.errors);
    assert.equal(logs.includes(secret), false, "токен не должен попадать в логи");
    assert.ok(logs.includes("Discord webhook delivery failed:"));

    assert.equal(describeWebhook(url).includes(secret), false);
    assert.equal(describeWebhook(url, "logs").includes(secret), false);
    assert.match(describeWebhook(url, "logs"), /канал логов/);
    assert.match(describeWebhook(url, "logs"), /123456789012345678/);
    assert.equal(describeWebhook(""), "webhook не настроен");
  } finally {
    dispatcher.stop();
  }
});

// ---------------------------------------------------------------------------
// 10. Нормализация embed
// ---------------------------------------------------------------------------

test("buildWebhookPayload: пустые поля отброшены, массивы склеены, лимиты соблюдены", () => {
  const fields = [
    { name: "Пустое", value: "" },
    { name: "", value: "без имени" },
    { name: "Список", value: ["первая", "вторая"], inline: true },
    null,
    { name: "Ноль", value: 0 },
    ...Array.from({ length: 30 }, (_, index) => ({
      name: `Поле ${index}`,
      value: `значение ${index}`
    }))
  ];

  const { payload, form } = buildWebhookPayload({
    title: "Тест\u0000\r\nзаголовок",
    description: "Строка\r\nвторая\u0000",
    fields,
    seal: Buffer.from("seal-bytes"),
    emoji: "✅",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  const embed = payload.embeds[0];
  assert.equal(embed.title, "✅ Тест\nзаголовок");
  assert.equal(embed.description, "Строка\nвторая");
  assert.equal(embed.timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(embed.fields.length, 25, "не больше 25 полей");
  assert.equal(embed.fields[0].name, "Список");
  assert.equal(embed.fields[0].value, "первая\nвторая");
  assert.equal(embed.fields[0].inline, true);
  assert.equal(embed.fields[1].name, "Ноль");
  assert.equal(embed.fields[1].value, "0");
  assert.equal(embed.fields[1].inline, false);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });

  assert.equal(form.get("payload_json"), JSON.stringify(payload));
  assert.equal(form.get("files[0]").name, "collegium-seal.png");
  assert.equal(form.get("files[0]").type, "image/png");
});

test("buildWebhookPayload: обрезка заголовка, описания и полей", () => {
  const { payload, form } = buildWebhookPayload({
    title: "т".repeat(300),
    description: "д".repeat(4000),
    fields: [{ name: "и".repeat(300), value: "з".repeat(2000) }],
    seal: null,
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  const embed = payload.embeds[0];
  assert.equal(embed.title.length, 256);
  assert.equal(embed.description.length, 3000);
  assert.equal(embed.fields[0].name.length, 256);
  assert.equal(embed.fields[0].value.length, 1024);
  assert.equal("thumbnail" in embed, false, "без печати миниатюры нет");
  assert.equal(form.get("files[0]"), null);
});

test("buildWebhookPayload: https-картинка, вложение важнее картинки", () => {
  const imageOnly = buildWebhookPayload({
    title: "Картинка",
    imageUrl: "https://cdn.example.com/image.png",
    seal: null
  });
  assert.equal(imageOnly.payload.embeds[0].image.url, "https://cdn.example.com/image.png");

  const insecure = buildWebhookPayload({
    title: "Картинка",
    imageUrl: "http://cdn.example.com/image.png",
    seal: null
  });
  assert.equal("image" in insecure.payload.embeds[0], false);

  const withFile = buildWebhookPayload({
    title: "Файл",
    imageUrl: "https://cdn.example.com/image.png",
    file: { name: "proof.png", content: Buffer.from("x"), contentType: "image/png" },
    seal: null
  });
  assert.equal(withFile.payload.embeds[0].image.url, "attachment://proof.png");
  assert.equal(withFile.form.get("files[0]").name, "proof.png");
  assert.equal(withFile.form.get("files[1]"), null);
});

test("pickColor сохраняет прежнюю семантику и поддерживает палитру", () => {
  assert.equal(pickColor("Выговор №1"), 15158332);
  assert.equal(pickColor("Тест не пройден"), 15158332);
  assert.equal(pickColor("Кандидат отклонил заявку"), 15158332);
  assert.equal(pickColor("Документ готов к обзвону"), 5763719);
  assert.equal(pickColor("Заявка одобрена"), 5763719);
  assert.equal(pickColor("Нейтральное событие"), 15844367);

  assert.equal(pickColor("Нейтральное событие", "success"), DISCORD_EMBED_COLORS.success);
  assert.equal(pickColor("Нейтральное событие", "info"), DISCORD_EMBED_COLORS.info);
  assert.equal(pickColor("Нейтральное событие", "gold"), DISCORD_EMBED_COLORS.gold);

  for (const value of Object.values(DISCORD_EMBED_COLORS)) {
    assert.ok(Number.isInteger(value));
    assert.ok(value >= 0 && value <= 0xffffff);
  }
  assert.deepEqual(WEBHOOK_CHANNELS, ["applications", "help", "exams", "logs", "health", "careerInterviews"]);
});

// ---------------------------------------------------------------------------
// Тестовое сообщение и неизвестный канал
// ---------------------------------------------------------------------------

test("test(kind) отправляет тематический embed с каналом, временем и версией", async () => {
  const calls = [];
  const fixedNow = Date.parse("2026-01-01T12:00:00.000Z");
  const dispatcher = makeDispatcher({
    webhooks: { exams: WEBHOOK_URL },
    now: () => fixedNow,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return noContent();
    }
  });

  try {
    const result = await dispatcher.test("exams");
    assert.equal(result.ok, true);

    const embed = payloadOf(calls[0].options).embeds[0];
    assert.equal(embed.title, "🧪 Проверка канала");
    assert.ok(embed.fields.some((field) => field.name === "Канал" && field.value === "канал экзаменов"));
    assert.ok(embed.fields.some((field) =>
      field.name === "Время сервера" && field.value === "2026-01-01T12:00:00.000Z"));
    assert.ok(embed.fields.some((field) => field.name === "Версия портала" && field.value === "1.0.0"));
    assert.equal(embed.color, DISCORD_EMBED_COLORS.info);
  } finally {
    dispatcher.stop();
    await dispatcher.drain();
  }
});

test("неизвестный канал: deliver/test бросают понятную ошибку", async () => {
  let calls = 0;
  const dispatcher = makeDispatcher({
    webhooks: { applications: WEBHOOK_URL },
    fetchImpl: async () => {
      calls += 1;
      return noContent();
    }
  });

  try {
    await assert.rejects(() => dispatcher.deliver("unknown", { title: "x" }), /Неизвестный канал/);
    await assert.rejects(() => dispatcher.test("unknown"), /Неизвестный канал/);
    assert.equal(calls, 0);
  } finally {
    dispatcher.stop();
  }
});

// ---------------------------------------------------------------------------
// 11. Обратная совместимость sendWebhook
// ---------------------------------------------------------------------------

test("sendWebhook: возвращает \"\" при успехе и ровно один fetch", async () => {
  const calls = [];
  const warning = await sendWebhook(
    WEBHOOK_URL,
    "Заявка одобрена",
    "Проверка пройдена.",
    [],
    async (url, options) => {
      calls.push({ url, options });
      return noContent();
    }
  );

  assert.equal(warning, "");
  assert.equal(calls.length, 1);
  const payload = payloadOf(calls[0].options);
  assert.equal(payload.embeds[0].thumbnail.url, "attachment://collegium-seal.png");
  assert.equal(calls[0].options.body.get("files[0]").name, "collegium-seal.png");
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test("sendWebhook: вложение уходит как files[1] после печати", async () => {
  const calls = [];
  const warning = await sendWebhook(
    WEBHOOK_URL,
    "⚠️ Выговор",
    "Основание указано.",
    [],
    async (url, options) => {
      calls.push({ url, options });
      return noContent();
    },
    { name: "evidence.png", content: Buffer.from("evidence"), contentType: "image/png" }
  );

  assert.equal(warning, "");
  const embed = payloadOf(calls[0].options).embeds[0];
  assert.equal(embed.image.url, "attachment://evidence.png");
  assert.equal(calls[0].options.body.get("files[1]").type, "image/png");
});

test("sendWebhook: прежние русские сообщения об ошибках и отсутствие throw", async () => {
  // HTTP-ошибка — прежний формат.
  const httpWarning = await sendWebhook(
    WEBHOOK_URL,
    "Тест",
    "Описание",
    [],
    async () => new Response("bad", { status: 500 }),
    null,
    { logger: silentLogger() }
  );
  assert.equal(httpWarning, "Webhook Discord ответил HTTP 500.");

  // Транспортная ошибка — прежний общий текст.
  const networkWarning = await sendWebhook(
    WEBHOOK_URL,
    "Тест",
    "Описание",
    [],
    async () => {
      throw new Error("boom");
    },
    null,
    { logger: silentLogger() }
  );
  assert.equal(
    networkWarning,
    "Заявка сохранена, но Discord webhook не ответил. Проверьте конфигурацию сервера."
  );

  // Некорректный URL — без вызова fetch.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return noContent();
  };
  assert.equal(
    await sendWebhook("http://discord.com/api/webhooks/123/token", "Тест", "Описание", [], fetchImpl),
    "Webhook не отправлен: разрешён только HTTPS Discord webhook URL."
  );
  assert.equal(
    await sendWebhook("мусор", "Тест", "Описание", [], fetchImpl),
    "Webhook не отправлен: URL в настройке сервера некорректен."
  );
  assert.equal(await sendWebhook("", "Тест", "Описание", [], fetchImpl), "");
  assert.equal(calls, 0);
});

test("sendWebhook: отсутствие печати не ломает доставку (без миниатюры)", async () => {
  const calls = [];
  const warning = await sendWebhook(
    WEBHOOK_URL,
    "Тест",
    "Описание",
    [],
    async (url, options) => {
      calls.push({ url, options });
      return noContent();
    },
    null,
    {
      logger: silentLogger(),
      readFileImpl: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
    }
  );

  assert.equal(warning, "");
  assert.equal(calls.length, 1);
  const embed = payloadOf(calls[0].options).embeds[0];
  assert.equal("thumbnail" in embed, false);
  assert.equal(calls[0].options.body.get("files[0]"), null);
});
