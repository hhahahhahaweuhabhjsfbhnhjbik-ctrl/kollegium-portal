import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";

const inviteButtonId = "portal:request-staff-invite";
const helpButtonId = "portal:request-attorney-help";
const helpModalId = "portal:citizen-help-modal";
const managedRoleNames = ["Гражданин", "Стажер КА", "Юрист", "Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"];
const staffRoleNames = managedRoleNames.filter((name) => name !== "Гражданин");
const channels = {
  invite: "🎫-вступление-в-коллегию",
  help: "🆘-помощь-адвокатам",
  applications: "📨-заявки-портала",
  exams: "🧪-экзамены-и-тесты",
  logs: "📋-журнал-коллегии",
  health: "🟢-активен"
};
const portalCommands = [
  new SlashCommandBuilder().setName("report").setDescription("Сформировать краткий отчёт для руководства")
].map((command) => command.toJSON());

function interactionRoleIds(interaction) {
  const roles = interaction.member?.roles;
  if (roles?.cache) return [...roles.cache.keys()];
  return Array.isArray(roles) ? roles : [];
}

export function parseTechCommand(content) {
  const match = /^!tech(?:\s+(on|off|restart))?$/i.exec(String(content || "").trim());
  return match ? (match[1] || "help").toLowerCase() : null;
}

export function parseGiveawayCommand(content) {
  const match = /^!giveway(?:\s+(on|off|reset))?$/i.exec(String(content || "").trim());
  return match ? (match[1] || "help").toLowerCase() : null;
}

export function canControlService({ authorId, ownerId, isAdministrator }) {
  return authorId === ownerId || isAdministrator === true;
}

async function ensureRoles(guild, member, roleIds, onRoleResolved) {
  if (!member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("Для автоматической настройки Discord боту нужно право «Управлять ролями».");
  }
  const roles = await guild.roles.fetch();
  for (const name of managedRoleNames) {
    const configuredId = roleIds[name];
    let role = configuredId ? roles.get(configuredId) : null;
    if (!role) role = roles.find((candidate) => candidate.name === name) || null;
    if (!role) {
      role = await guild.roles.create({
        name,
        permissions: [],
        reason: "Автоматическая настройка портала Коллегии адвокатов"
      });
    }
    roleIds[name] = role.id;
    await onRoleResolved?.(name, role.id);
  }
  const rolesAboveBot = managedRoleNames.filter((name) => {
    const role = roles.get(roleIds[name]) || guild.roles.cache.get(roleIds[name]);
    return role && member.roles.highest.comparePositionTo(role) <= 0;
  });
  if (rolesAboveBot.length) {
    throw new Error(`Поднимите высшую роль бота выше управляемых ролей: ${rolesAboveBot.join(", ")}.`);
  }
}

function channelOverwrites(guild, botUserId, roleIds, isPublic, managersOnly = false) {
  const view = PermissionFlagsBits.ViewChannel;
  const send = PermissionFlagsBits.SendMessages;
  const history = PermissionFlagsBits.ReadMessageHistory;
  const overwrites = [{
    id: guild.id,
    deny: isPublic ? [send] : [view],
    ...(isPublic ? { allow: [view, history] } : {})
  }, {
    id: botUserId,
    allow: [view, send, history]
  }];
  const visibleRoles = managersOnly ? ["ЗГКА", "ГКА"] : staffRoleNames;
  for (const name of visibleRoles) {
    const roleId = roleIds[name];
    if (roleId) overwrites.push({ id: roleId, allow: [view, send, history] });
  }
  return overwrites;
}

async function ensureCategory(guild, name) {
  if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("Для создания категорий боту нужно право «Управлять каналами».");
  }
  const existing = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildCategory && channel.name === name);
  return existing || guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: "Автоматическая настройка портала Коллегии адвокатов"
  });
}

async function ensureChannel(guild, name, botUserId, roleIds, isPublic, managersOnly = false, parent = null) {
  const legacyNames = {
    "🎫-вступление-в-коллегию": ["получить-код", "вступление-в-коллегию", "🎫-вступление-в-коллегию"],
    "🆘-помощь-адвокатам": ["помощь-адвокатам", "🆘-помощь-адвокатам"],
    "📨-заявки-портала": ["заявки-портала", "📨-заявки-портала"],
    "🧪-экзамены-и-тесты": ["тесты-портала", "экзамены-и-тесты", "🧪-экзамены-и-тесты"],
    "📋-журнал-коллегии": ["журнал-руководства", "журнал-коллегии", "📋-журнал-коллегии"]
  };
  const existing = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildText &&
    (legacyNames[name] || [name]).includes(channel.name));
  if (existing && existing.name !== name && guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await existing.setName(name, "Единое оформление каналов портала Коллегии адвокатов");
  }
  if (existing) {
    if (parent && existing.parentId !== parent.id && guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await existing.setParent(parent.id, { lockPermissions: false, reason: "Единое оформление каналов портала" }).catch(() => {});
    }
    if (guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      const topics = {
        "🎫-вступление-в-коллегию": "Приём заявок и выдача одноразовых кодов для вступления в Коллегию",
        "🆘-помощь-адвокатам": "Граждане могут запросить помощь адвоката. Новые обращения автоматически отправляются на сайт.",
        "📨-заявки-портала": "Новые обращения, экзамены и решения руководства",
        "🧪-экзамены-и-тесты": "Назначения тестов, переаттестации и результаты",
        "📋-журнал-коллегии": "Официальные кадровые события и уведомления руководства"
      };
      if (existing.topic !== topics[name]) await existing.setTopic(topics[name], "Оформление канала портала").catch(() => {});
    }
    return existing;
  }
  if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("Для создания Discord-каналов боту нужно право «Управлять каналами».");
  }
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent?.id,
    topic: {
      "🎫-вступление-в-коллегию": "Приём заявок и выдача одноразовых кодов для вступления в Коллегию",
      "🆘-помощь-адвокатам": "Граждане могут запросить помощь адвоката. Новые обращения автоматически отправляются на сайт.",
      "📨-заявки-портала": "Новые обращения, экзамены и решения руководства",
      "🧪-экзамены-и-тесты": "Назначения тестов, переаттестации и результаты",
      "📋-журнал-коллегии": "Официальные кадровые события и уведомления руководства"
    }[name],
    permissionOverwrites: channelOverwrites(guild, botUserId, roleIds, isPublic, managersOnly),
    reason: "Автоматическая настройка портала Коллегии адвокатов"
  });
}

async function ensureWebhook(channel, name, configuredUrl, onWebhookResolved) {
  if (configuredUrl) return configuredUrl;
  const botMember = channel.guild.members.me;
  if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageWebhooks)) {
    throw new Error(`Для создания webhook в канале «${channel.name}» боту нужно право «Управлять webhook».`);
  }
  const webhooks = await channel.fetchWebhooks();
  const webhookKind = name.includes("Заявки") ? "applications"
    : name.includes("Экзамены") ? "exams"
      : name.includes("Помощь") ? "help"
      : name.includes("Статус") ? "health"
        : "logs";
  let webhook = webhooks.find((candidate) =>
    candidate.name === name ||
    (webhookKind === "applications" && ["Портал: заявки", "Коллегия · Заявки"].includes(candidate.name)) ||
    (webhookKind === "exams" && ["Портал: тесты", "Коллегия · Экзамены"].includes(candidate.name)) ||
    (webhookKind === "help" && ["Портал: помощь", "Коллегия · Помощь"].includes(candidate.name)) ||
    (webhookKind === "health" && ["Портал: статус", "Коллегия · Статус"].includes(candidate.name)) ||
    (webhookKind === "logs" && ["Портал: журнал", "Коллегия · Журнал"].includes(candidate.name)));
  if (!webhook) {
    webhook = await channel.createWebhook({
      name,
      reason: "Уведомления портала Коллегии адвокатов"
    });
  }
  if (!webhook.url) throw new Error(`Discord не вернул адрес webhook для канала «${channel.name}».`);
  await onWebhookResolved?.(webhookKind, webhook.url);
  return webhook.url;
}

async function ensureVoiceChannel(guild, name, parent = null) {
  if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("Для создания голосового канала статуса боту нужно право «Управлять каналами».");
  }
  await guild.channels.fetch();
  const existing = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildVoice &&
    ["статус-портала", "🟢-активен", "🔴-недоступен", "🟡-проверка"].includes(channel.name));
  if (existing) {
    if (existing.name !== name) await existing.setName(name, "Автоматическое обновление статуса портала");
    if (parent && existing.parentId !== parent.id) {
      await existing.setParent(parent.id, { lockPermissions: false, reason: "Единое оформление статуса портала" }).catch(() => {});
    }
    return existing;
  }
  return guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: parent?.id,
    reason: "Создание голосового канала статуса портала"
  });
}

async function ensureInvitePanel(channel, botUserId) {
  const messages = await channel.messages.fetch({ limit: 50 });
  const existing = messages.find((message) => message.author.id === botUserId
    && message.components.some((row) => row.components.some((component) => component.customId === inviteButtonId)));
  const payload = {
    embeds: [new EmbedBuilder()
      .setTitle("Вступление в Коллегию адвокатов")
      .setDescription([
        "Получите одноразовый код приглашения для регистрации сотрудника.",
        "Код действует 7 дней, а повторный запрос доступен раз в 24 часа.",
        "После создания аккаунта руководство рассмотрит заявку на вступление."
      ].join("\n\n"))
      .setColor(0xB09A63)
      .setFooter({ text: "Коллегия адвокатов · Mirror GTA 5 RP" })
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(inviteButtonId)
        .setLabel("Получить код в ЛС")
        .setStyle(ButtonStyle.Primary)
    )],
    allowedMentions: { parse: [] }
  };
  if (existing) await existing.edit(payload);
  else await channel.send(payload);
}

async function ensureHelpPanel(channel, botUserId) {
  const messages = await channel.messages.fetch({ limit: 50 });
  const existing = messages.find((message) => message.author.id === botUserId
    && message.components.some((row) => row.components.some((component) => component.customId === helpButtonId)));
  const payload = {
    embeds: [new EmbedBuilder()
      .setTitle("Нужна помощь адвоката?")
      .setDescription([
        "Нажмите кнопку и кратко опишите ситуацию.",
        "Обращение автоматически появится на сайте у адвокатов.",
        "Ответ адвоката придёт вам в личные сообщения Discord."
      ].join("\n\n"))
      .setColor(0xB09A63)
      .setFooter({ text: "Коллегия адвокатов · помощь гражданам" })
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(helpButtonId)
        .setLabel("Запросить помощь")
        .setStyle(ButtonStyle.Primary)
    )],
    allowedMentions: { parse: [] }
  };
  if (existing) await existing.edit(payload);
  else await channel.send(payload);
}

async function createCaseChannel(guild, botUserId, roleIds, applicationId, citizenId, attorneyId) {
  if (!/^\d{15,22}$/.test(citizenId || "") || !/^\d{15,22}$/.test(attorneyId || "")) return null;
  if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) return null;
  await guild.channels.fetch();
  const categoryName = process.env.DISCORD_CATEGORY_CASES || "Обращения граждан";
  const category = await ensureCategory(guild, categoryName);
  const name = `обращение-${applicationId}`;
  const existing = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildText && channel.name === name);
  if (existing) return existing;
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    topic: `Приватное обращение гражданина №${applicationId}`,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: botUserId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: citizenId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: attorneyId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
    ],
    reason: "Создание приватного канала для обращения гражданина"
  });
}

async function closeCaseChannel(guild, applicationId) {
  await guild.channels.fetch();
  const channel = guild.channels.cache.find((candidate) =>
    candidate.type === ChannelType.GuildText && candidate.name === `обращение-${applicationId}`);
  if (channel && guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await channel.delete("Обращение гражданина закрыто");
  }
}

export function startDiscordBot({
  token,
  guildId,
  roleIds,
  onRoleResolved,
  onWebhookResolved,
  onInviteRequest,
  onDiscordCitizenRequest,
  onPortalCommand,
  onPortalAction,
  onRpCaseReview,
  onServiceCommand,
  onServiceRestart,
  onGiveawayCommand,
  onPresence,
  healthUrl
}) {
  if (!token) {
    console.warn("Discord bot is not started: DISCORD_BOT_TOKEN is empty.");
    return null;
  }
  if (!/^\d{15,22}$/.test(guildId || "")) {
    console.error("Discord bot is not started: DISCORD_GUILD_ID must be the server ID.");
    return null;
  }

  const presenceMap = new Map();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });
  client.on(Events.MessageCreate, (message) => {
    const techAction = parseTechCommand(message.content);
    const giveawayAction = parseGiveawayCommand(message.content);
    if ((!techAction && !giveawayAction) || message.author.bot || message.guildId !== guildId) return;

    void (async () => {
      if (!canControlService({
        authorId: message.author.id,
        ownerId: message.guild.ownerId,
        isAdministrator: message.member?.permissions?.has(PermissionFlagsBits.Administrator)
      })) {
        await message.reply({
          content: "Управлять порталом может только владелец или администратор сервера.",
          allowedMentions: { parse: [], repliedUser: false }
        });
        return;
      }

      if (giveawayAction) {
        if (giveawayAction === "help") {
          await message.reply({
            content: "Команды конкурса: `!giveway on` — включить начисление, `!giveway off` — поставить на паузу, `!giveway reset` — сбросить очки.",
            allowedMentions: { parse: [], repliedUser: false }
          });
          return;
        }
        if (!onGiveawayCommand) throw new Error("Управление конкурсом не настроено.");
        const response = await onGiveawayCommand(giveawayAction, message.author.id);
        await message.reply({
          content: String(response).slice(0, 1900),
          allowedMentions: { parse: [], repliedUser: false }
        });
        return;
      }

      const action = techAction;
      if (action === "help") {
        await message.reply({
          content: "Команды: `!tech on` — включить техработы, `!tech off` — выключить, `!tech restart` — перезапустить портал и бота.",
          allowedMentions: { parse: [], repliedUser: false }
        });
        return;
      }

      if (!onServiceCommand || (action === "restart" && !onServiceRestart)) {
        throw new Error("Управление сервисом не настроено.");
      }

      const response = await onServiceCommand(action);
      await message.reply({
        content: String(response).slice(0, 1900),
        allowedMentions: { parse: [], repliedUser: false }
      });

      if (action === "restart") {
        const timer = setTimeout(() => onServiceRestart(), 1500);
        timer.unref?.();
      }
    })().catch((error) => {
      console.error("Discord tech command failed:", error.message);
      void message.reply({
        content: "Не удалось выполнить команду. Проверьте журнал портала.",
        allowedMentions: { parse: [], repliedUser: false }
      }).catch((replyError) => {
        console.error("Discord tech command response failed:", replyError.message);
      });
    });
  });
  client.discordPresenceMap = presenceMap;
  client.on("presenceUpdate", (_oldPresence, newPresence) => {
    if (!newPresence?.userId) return;
    const status = ["online", "idle", "dnd", "offline"].includes(newPresence.status)
      ? newPresence.status
      : "offline";
    presenceMap.set(newPresence.userId, status);
    onPresence?.(newPresence.userId, status);
  });
  client.once(Events.ClientReady, (readyClient) => {
    void (async () => {
      const guild = await readyClient.guilds.fetch(guildId);
      client.createCaseChannel = (applicationId, citizenId, attorneyId) =>
        createCaseChannel(guild, readyClient.user.id, roleIds, applicationId, citizenId, attorneyId);
      client.closeCaseChannel = (applicationId) => closeCaseChannel(guild, applicationId);
      try {
        const members = await guild.members.fetch();
        for (const member of members.values()) {
          const status = member.presence?.status || "offline";
          const normalized = ["online","idle","dnd","offline"].includes(status) ? status : "offline";
          presenceMap.set(member.id, normalized);
          onPresence?.(member.id, normalized);
        }
      } catch (error) {
        console.error("Discord presence cache could not be loaded:", error.message);
      }
      const member = await guild.members.fetchMe();
      await ensureRoles(guild, member, roleIds, onRoleResolved);
      await guild.channels.fetch();
      const portalCategory = await ensureCategory(guild, process.env.DISCORD_CATEGORY_PORTAL || "Портал Коллегии");
      const managementCategory = await ensureCategory(guild, process.env.DISCORD_CATEGORY_MANAGEMENT || "Управление Коллегией");
      const casesCategory = await ensureCategory(guild, process.env.DISCORD_CATEGORY_CASES || "Обращения граждан");
      const inviteChannel = await ensureChannel(guild, channels.invite, readyClient.user.id, roleIds, true, false, portalCategory);
      const helpChannel = await ensureChannel(guild, channels.help, readyClient.user.id, roleIds, true, false, portalCategory);
      const applicationChannel = await ensureChannel(guild, channels.applications, readyClient.user.id, roleIds, false, false, portalCategory);
      const examChannel = await ensureChannel(guild, channels.exams, readyClient.user.id, roleIds, false, false, portalCategory);
      const logChannel = await ensureChannel(guild, channels.logs, readyClient.user.id, roleIds, false, true, managementCategory);
      let healthVoice = await ensureVoiceChannel(guild, "🟡-проверка", managementCategory);
      await ensureInvitePanel(inviteChannel, readyClient.user.id);
      await ensureHelpPanel(helpChannel, readyClient.user.id);
      try {
        const registeredCommands = await readyClient.application.commands.fetch({ guildId });
        for (const command of portalCommands) {
          const existing = registeredCommands.find((item) => item.name === command.name);
          if (existing) await existing.edit(command);
          else await readyClient.application.commands.create(command, guildId);
        }
      } catch (error) {
        console.error("Discord slash commands could not be registered; verify the applications.commands scope:", error.message);
      }

      const configuredWebhooks = {
        applications: process.env.DISCORD_WEBHOOK_APPLICATIONS || "",
        help: process.env.DISCORD_WEBHOOK_HELP || "",
        exams: process.env.DISCORD_WEBHOOK_EXAMS || "",
        logs: process.env.DISCORD_WEBHOOK_LOGS || ""
      };
      await ensureWebhook(applicationChannel, "Коллегия · Заявки", configuredWebhooks.applications, onWebhookResolved);
      await ensureWebhook(helpChannel, "Коллегия · Помощь", configuredWebhooks.help, onWebhookResolved);
      await ensureWebhook(examChannel, "Коллегия · Экзамены", configuredWebhooks.exams, onWebhookResolved);
      await ensureWebhook(logChannel, "Коллегия · Журнал", configuredWebhooks.logs, onWebhookResolved);

      const publishHealth = async () => {
        let apiOk = false;
        let maintenance = false;
        let apiPing = 0;
        try {
          let target = healthUrl || process.env.DISCORD_HEALTH_URL || `http://127.0.0.1:${process.env.PORT || "3000"}/api/health`;
          if (target && !target.includes("/api/health")) target = `${target.replace(/\/+$/, "")}/api/health`;
          const started = Date.now();
          const response = await globalThis.fetch(target, { signal: AbortSignal.timeout(5000) });
          apiPing = Date.now() - started;
          apiOk = response.ok;
          if (apiOk) maintenance = (await response.json()).maintenance === true;
        } catch {
          apiOk = false;
        }
        const statusName = maintenance
          ? "🟡 Технические работы"
          : apiOk
          ? `🟢 Активен · ${apiPing} мс`
          : `🔴 Недоступен · ${apiPing || "—"} мс`;
        if (healthVoice && healthVoice.name !== statusName) {
          await healthVoice.setName(statusName, "Автоматическое обновление статуса портала").catch(() => {});
        }
      };
      await publishHealth();
      if (!client.discordHealthTimer) {
        client.discordHealthTimer = setInterval(() => {
          void publishHealth();
        }, Number(process.env.DISCORD_HEALTH_INTERVAL_MS || 300000));
        client.discordHealthTimer.unref?.();
      }

      console.log(`Discord bot connected as ${readyClient.user.tag} to "${guild.name}"; roles and portal channels are ready.`);
      if (!member.permissions.has(PermissionFlagsBits.ManageNicknames)) {
        console.error("Discord bot is missing the Manage Nicknames permission.");
      }
    })().catch((error) => {
      console.error("Discord bot connected, but automatic server setup failed:", error.message);
    });
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isButton() && interaction.customId === helpButtonId) {
      const modal = new ModalBuilder()
        .setCustomId(helpModalId)
        .setTitle("Запрос помощи адвоката")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("citizen_name")
              .setLabel("Имя и фамилия персонажа")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(80)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("citizen_details")
              .setLabel("Опишите ситуацию")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMinLength(10)
              .setMaxLength(2000)
          )
        );
      void interaction.showModal(modal).catch((error) => {
        console.error("Discord citizen help modal could not be opened:", error.message);
      });
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === helpModalId) {
      void (async () => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          if (interaction.guildId !== guildId) throw new Error("Обращение можно создать только на сервере Коллегии.");
          if (!onDiscordCitizenRequest) throw new Error("Приём обращений из Discord не настроен.");
          const displayName = interaction.fields.getTextInputValue("citizen_name").trim();
          const details = interaction.fields.getTextInputValue("citizen_details").trim();
          const result = await onDiscordCitizenRequest({
            discordId: interaction.user.id,
            discordUsername: interaction.user.username,
            displayName,
            details
          });
          await interaction.editReply({
            content: `Обращение №${result.applicationId} создано. Адвокат увидит его на сайте; ответ придёт вам в личные сообщения.`,
            allowedMentions: { parse: [] }
          });
        } catch (error) {
          await interaction.editReply({ content: error.message, allowedMentions: { parse: [] } });
        }
      })().catch((error) => {
        console.error("Discord citizen help request failed:", error.message);
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === inviteButtonId) {
      void (async () => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          if (!onInviteRequest) throw new Error("Автоматическая выдача кодов не настроена.");
          await onInviteRequest(interaction.user.id, async (code) => {
            await interaction.user.send({
              content: `Ваш одноразовый код приглашения в Коллегию адвокатов:\n\`${code}\`\n\nВведите его при регистрации сотрудника на портале. Код действует 7 дней и используется один раз.`,
              allowedMentions: { parse: [] }
            });
          });
          await interaction.editReply({
            content: "Готово — одноразовый код отправлен вам в личные сообщения.",
            allowedMentions: { parse: [] }
          });
        } catch (error) {
          await interaction.editReply({
            content: error.message,
            allowedMentions: { parse: [] }
          });
        }
      })().catch((error) => {
        console.error("Discord invite button interaction failed:", error.message);
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("portal:task-complete:")) {
      void (async () => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          if (interaction.guildId !== guildId || !onPortalAction) {
            throw new Error("Действие портала недоступно на этом сервере.");
          }
          const memberRoleIds = interactionRoleIds(interaction);
          const result = await onPortalAction(
            interaction.user.id, interaction.customId.slice("portal:".length), memberRoleIds
          );
          await interaction.editReply({ content: result, allowedMentions: { parse: [] } });
        } catch (error) {
          await interaction.editReply({ content: error.message, allowedMentions: { parse: [] } });
        }
      })().catch((error) => {
        console.error("Discord task approval interaction failed:", error.message);
      });
      return;
    }

    const rpCaseReview = interaction.isButton()
      ? /^portal:rp-case-review:(\d+):(approved|rejected)$/.exec(interaction.customId)
      : null;
    if (rpCaseReview) {
      void (async () => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          if (interaction.guildId !== guildId || !onRpCaseReview) {
            throw new Error("Согласование AI Case доступно только на сервере Коллегии.");
          }
          const result = await onRpCaseReview(
            interaction.user.id,
            interactionRoleIds(interaction),
            Number(rpCaseReview[1]),
            rpCaseReview[2]
          );
          await interaction.message.edit({ components: [] }).catch((error) => {
            console.warn("Could not disable reviewed AI Case buttons:", error.message);
          });
          await interaction.editReply({ content: result, allowedMentions: { parse: [] } });
        } catch (error) {
          await interaction.editReply({ content: error.message, allowedMentions: { parse: [] } });
        }
      })().catch((error) => {
        console.error("Discord AI Case review interaction failed:", error.message);
      });
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    void (async () => {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (interaction.guildId !== guildId) throw new Error("Команды портала доступны только на сервере Коллегии.");
        if (!onPortalCommand) throw new Error("Команды портала не настроены.");
        const options = interaction.commandName === "absence" ? {
          startDate: interaction.options.getString("start_date", true),
          endDate: interaction.options.getString("end_date", true),
          reason: interaction.options.getString("reason", true)
        } : {};
        const memberRoleIds = interactionRoleIds(interaction);
        const result = await onPortalCommand(
          interaction.user.id, interaction.commandName, options, memberRoleIds
        );
        const content = typeof result === "string" ? result : result.content;
        const components = typeof result === "object" && Array.isArray(result.taskActions)
          ? result.taskActions.slice(0, 5).map((task) => new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`portal:task-complete:${task.id}`)
              .setLabel(`Подтвердить #${task.id}`)
              .setStyle(ButtonStyle.Success)
          )) : [];
        await interaction.editReply({
          content: String(content).slice(0, 1900),
          components,
          allowedMentions: { parse: [] }
        });
      } catch (error) { 
        await interaction.editReply({
          content: error.message,
          allowedMentions: { parse: [] }
        });
      }
    })().catch((error) => {
      console.error(`Discord /${interaction.commandName} interaction failed:`, error.message);
    });
  });
  client.on(Events.Error, (error) => {
    console.error("Discord Gateway error:", error.message);
  });
  client.login(token).then(() => {
    console.log("Discord bot login accepted; waiting for server connection.");
  }).catch((error) => {
    console.error("Discord bot login failed. Check DISCORD_BOT_TOKEN:", error.message);
    client.destroy();
  });
  return client;
}
