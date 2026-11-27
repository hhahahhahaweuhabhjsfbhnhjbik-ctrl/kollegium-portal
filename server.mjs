import { createServer } from "node:http";
import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { readFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { startDiscordBot } from "./discord-bot.mjs";
import { WEBHOOK_CHANNELS, createWebhookDispatcher, describeWebhook, isDiscordWebhookUrl, sendWebhook } from "./webhooks.mjs";
import { rpPracticeCases } from "./web/js/data/rp-practice.js";
import { rpInterviewCases } from "./web/js/data/rp-interviews.js";
import { rpInterviewExtraCases } from "./web/js/data/rp-interviews-extra.js";

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const roles = ["Стажер КА", "Юрист", "Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА", "Губернатор"];
const citizenRole = "Гражданин";
const managementRoles = ["ГКА", "ЗГКА"];
const governorUserId = 43;
const governorRole = "Губернатор";
const careerLawExamRoles = ["Стажер КА"];
const careerLawExamSubjects = ["ak", "uk", "pk"];
const careerLawyerJointCallsRequired = 2;
const activityReportTypes = Object.freeze({
  call: "Вызов",
  bail: "Залог"
});
const activityReportCallRoles = new Set(["Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"]);
const giveawayPointsPerReport = Object.freeze({ call: 1, bail: 2 });
const rpCaseOfficerDepartments = new Set(["LSDP", "FIB", "LSSD", "USSS"]);
const rpCaseQuestionCounts = Object.freeze([0, 3, 6, 12, 24, 48]);
const careerRpPracticeCases = Object.freeze([...rpInterviewCases, ...rpInterviewExtraCases].slice(0, 3));
const activityReportPhotoMaxBytes = 15 * 1024 * 1024;
const auditTestNotificationTypes = Object.freeze({
  role: { title: "Тест: изменение должности", body: "Проверка уведомления кадрового аудита об изменении должности." },
  status: { title: "Тест: изменение статуса", body: "Проверка уведомления кадрового аудита об изменении статуса сотрудника." },
  dismissal: { title: "Тест: увольнение", body: "Проверка уведомления кадрового аудита об увольнении сотрудника." }
});
const portalPageRoutes = new Set([
  "/page/home",
  "/page/career",
  "/page/memo",
  "/page/appeals",
  "/page/iski",
  "/page/exams",
  "/page/practice",
  "/page/laws",
  "/page/rating",
  "/page/audit",
  "/page/decrees",
  "/page/awards",
  "/page/giveaway",
  "/page/reports"
]);
const taskPriorities = ["low", "normal", "high", "critical"];
const defaultRatingWeights = Object.freeze({
  documentsApproved: 2,
  casesClosed: 2,
  lawsuitsFiled: 3,
  tasksCompleted: 2,
  reviews: 1
});
const maintenancePage = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Технические работы — Коллегия адвокатов</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #101515; color: #eee8d5; }
    body { min-height: 100vh; display: grid; place-items: center; margin: 0; padding: 24px; box-sizing: border-box; }
    main { max-width: 560px; padding: 36px; border: 1px solid #756b42; border-radius: 20px; background: #171d1c; text-align: center; }
    h1 { color: #d3bb70; }
    p { line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <h1>Технические работы</h1>
    <p>Портал временно недоступен. Мы устраняем неполадки и скоро вернёмся.</p>
  </main>
</body>
</html>`;

function recordEmploymentEvent(db, { userId, actorId, fromRole, toRole, fromStatus, toStatus, details = "" }) {
  if (fromRole === toRole && fromStatus === toStatus) return;
  const priorService = fromRole === citizenRole && toRole !== citizenRole
    ? db.prepare(`SELECT 1 FROM member_employment_history
        WHERE user_id = ? AND event_type IN ('hired','promoted','role_changed','dismissed','reinstated') LIMIT 1`).get(userId)
    : null;
  const eventType = fromStatus === "active" && toStatus === "suspended"
    ? "dismissed"
    : fromStatus !== "active" && toStatus === "active"
      ? "reinstated"
      : fromRole === citizenRole && toRole !== citizenRole
        ? (priorService ? "reinstated" : "hired")
        : fromStatus !== toStatus
          ? "status_changed"
          : nextRank[fromRole] === toRole ? "promoted" : "role_changed";
  db.prepare(`INSERT INTO member_employment_history
    (user_id,actor_id,event_type,from_role,to_role,from_status,to_status,details)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(userId, actorId || null, eventType, fromRole, toRole, fromStatus, toStatus, details);
}
const taskStatuses = ["new", "accepted", "in_progress", "review", "revision", "completed", "cancelled"];
const calendarEventTypes = ["court", "interview", "exam", "attestation", "meeting", "lecture", "training", "other"];
const nextRank = { "Стажер КА": "Юрист", "Юрист": "Адвокат", "Адвокат": "Ст.Адвокат", "Ст.Адвокат": "ЗГКА" };
const documentRoles = ["Юрист", "Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"];
const roleActions = {
  "Стажер КА": ["exam", "training", "practice"],
  "Юрист": ["exam", "practice", "training"],
  "Адвокат": ["exam", "promotion", "practice"],
  "Ст.Адвокат": ["practice"],
  "ЗГКА": ["practice"],
  "ГКА": ["practice"],
  [citizenRole]: ["citizen_help", "citizen_complaint", "employment"]
};
const applicationNames = {
  exam: "Заявка на проверку знаний",
  training: "Запрос на обучение у старшего адвоката",
  practice: "Запрос практики / помощи по делу",
  promotion: "Заявка на повышение",
  admin: "Организационный вопрос",
  citizen_help: "Запрос гражданина на помощь адвоката",
  citizen_complaint: "Жалоба гражданина",
  employment: "Заявка на вступление в Коллегию"
};
const lawFiles = {
  ak: "Административный Кодекс (Редакция от 14.11.2026).txt",
  uk: "Уголовный Кодекс (Редакция от 23.11.2026).txt",
  pk: "Процессуальный Кодекс (Редакция от 23.11.2026).txt",
  charter: "Конституция.txt",
  zot: "Закон о закрытых и охраняемых территориях (Редакция от 23.11.2026).txt",
  advocacy: "Закон об адвокатуре и адвокатской деятельности (Редакция от 09.11.2026).txt",
  road: "Дорожный Кодекс (Редакция от 14.11.2026).txt",
  labor: "Трудовой Кодекс (Редакция от 23.11.2026).txt",
  ethics: "Этический Кодекс (Редакция от 01.10.2026).txt",
  documents: "Закон о документообороте.txt",
  justice: "Закон о Департаменте юстиции.txt"
};
const suppliedLawKeys = new Set(["ak", "uk", "pk", "charter", "road", "labor", "ethics", "documents", "justice"]);
const attorneyRoles = ["Адвокат", "Ст.Адвокат"];
const examBank = {
  "Стажер КА": [
    { q: "За сколько минут государственный адвокат обязан принять вызов в рацию департамента?", a: ["А) 1 минута", "Б) 3 минуты", "В) 5 минут"], correct: 1 },
    { q: "За какое время адвокат должен прибыть после принятия вызова?", a: ["А) 3 минуты", "Б) 5 минут", "В) 10 минут"], correct: 1 },
    { q: "Могут ли стажёр или юрист проходить на ЗОТ без контроля старшего адвоката?", a: ["А) Да, при наличии удостоверения", "Б) Нет, только под контролем руководства или старших адвокатов", "В) Да, только в КПЗ LSPD"], correct: 1 },
    { q: "Сколько времени сотрудник обязан хранить видеозапись задержания?", a: ["А) 24 часа", "Б) 48 часов", "В) Не менее 72 часов"], correct: 2 },
    { q: "Какова максимальная длительность конфиденциальной беседы с задерживаемым?", a: ["А) До 5 минут", "Б) До 10 минут", "В) До 15 минут"], correct: 1 }
  ],
  "Юрист": [
    { q: "Как долго хранится видеофиксация сотрудниками государственных структур по указанной норме ПК?", a: ["24 часа с окончания записи", "72 часа с окончания записи", "7 суток с момента задержания"], correct: 1 },
    { q: "Обязан ли сотрудник обеспечить право на адвоката, если задержанный выразил такое намерение?", a: ["Да, на любой стадии процесса задержания", "Только до начала задержания", "Только по решению суда"], correct: 0 },
    { q: "Какой срок ожидания ответа адвоката установлен в приведенном положении ПК?", a: ["3 минуты", "5 минут", "10 минут"], correct: 0 },
    { q: "Может ли юрист сопровождать адвоката при оказании помощи по запросу задержанного?", a: ["Нет", "Да", "Только с разрешения прокурора"], correct: 1 },
    { q: "Что предусмотрено ПК, если в отношении сотрудника подан иск или жалоба в прокуратуру?", a: ["Сохранить относящиеся к делу видеоматериалы до окончательного решения", "Удалить материалы по требованию сотрудника", "Хранить их ровно 3 минуты"], correct: 0 }
  ],
  "Адвокат": [
    { q: "На сколько минут приостанавливается допрос по запросу адвоката и каков общий лимит?", a: ["А) 5 минут / 30 минут", "Б) 10 минут / до 60 минут", "В) 15 минут / до 90 минут"], correct: 1 },
    { q: "Можно ли адвокату изменить залог по сравнению с суммой УК?", a: ["А) Повысить не более чем в 2 раза, снизить нельзя", "Б) Любое повышение и снижение", "В) Снизить до 50%, повышение запрещено"], correct: 0 },
    { q: "Допустимо ли задерживать неприкосновенное лицо без угрозы или ордера?", a: ["А) Да, до 1 часа", "Б) Нет, только при угрозе жизни и здоровью или по ордеру AS/PTD/суду", "В) Достаточно одобрения прокурора"], correct: 1 },
    { q: "Входят ли ожидание адвоката и конфиденциальная беседа в час задержания?", a: ["А) Да", "Б) Нет, процессуальные паузы не засчитываются", "В) Засчитывается только беседа"], correct: 1 },
    { q: "Что запрещено делать с видеоматериалами при иске или жалобе против сотрудника?", a: ["А) Сохранять до решения", "Б) Удалять в течение суток", "В) Передавать заявителю"], correct: 0 }
  ]
};
const lawExamBank = {
  ak: [
    { q: "Какую территорию охватывает юрисдикция FIB при привлечении к административной ответственности?", a: ["Только территорию города", "Весь штат", "Только федеральные здания"], correct: 1 },
    { q: "Что считается административным правонарушением по АК?", a: ["Противоправное действие или бездействие, за которое установлена административная ответственность", "Любое нарушение внутреннего распорядка", "Только преступление с причинением вреда"], correct: 0 },
    { q: "Когда правонарушение считается совершённым умышленно?", a: ["Если лицо не знало о своих действиях", "Если лицо осознавало противоправность и желало или сознательно допускало последствия", "Только если был предварительный сговор"], correct: 1 },
    { q: "Что может сделать уполномоченное лицо при малозначительном административном правонарушении?", a: ["Освободить от ответственности и ограничиться устным замечанием, кроме случаев судебного решения или решения прокуратуры", "Всегда назначить максимальное наказание", "Передать дело только в федеральный суд"], correct: 0 },
    { q: "Кто, согласно общим положениям АК, может рассматривать административные дела?", a: ["Только LSPD", "Уполномоченные органы, суд и прокуратура в рамках указанной юрисдикции", "Только адвокатская коллегия"], correct: 1 }
  ],
  pk: [
    { q: "Каков максимальный срок задержания подозреваемого по приведённому определению ПК?", a: ["30 минут", "1 час с момента фактического задержания", "3 часа"], correct: 1 },
    { q: "Когда подозреваемый или обвиняемый считается невиновным?", a: ["Пока его виновность не доказана", "Пока он сам не докажет невиновность", "Только до предъявления обвинения"], correct: 0 },
    { q: "На ком лежит бремя доказывания обвинения?", a: ["На стороне обвинения", "На подозреваемом", "На адвокате защиты"], correct: 0 },
    { q: "Как следует толковать сомнения в виновности подозреваемого или обвиняемого?", a: ["В пользу обвинения", "В пользу подозреваемого или обвиняемого", "По усмотрению сотрудника, проводящего задержание"], correct: 1 },
    { q: "Как должен поступить сотрудник с относящимися к делу видеоматериалами при поданной жалобе или иске?", a: ["Сохранить их до окончательного решения", "Удалить в течение суток", "Оставить только копию у заявителя"], correct: 0 }
  ],
  uk: [
    { q: "Что признаётся преступлением по УК?", a: ["Любое нарушение правил организации", "Виновно совершённое общественно опасное деяние, запрещённое кодексом под угрозой наказания", "Любое причинение имущественного ущерба"], correct: 1 },
    { q: "Сколько элементов образует состав преступления по УК?", a: ["Два", "Три", "Четыре"], correct: 2 },
    { q: "Кто относится к соучастникам преступления наряду с исполнителем?", a: ["Организатор, подстрекатель и пособник", "Только потерпевший", "Только свидетель"], correct: 0 },
    { q: "Когда преступление признаётся совершённым группой лиц?", a: ["При совместном участии двух или более исполнителей", "Если об этом заявил потерпевший", "При участии любого свидетеля"], correct: 0 },
    { q: "При каком условии причинение вреда в состоянии необходимой обороны не является преступлением?", a: ["Если вред явно превышает опасность посягательства", "Если защищают личность или права от опасного насилия и не превышают пределы обороны", "Только после письменного разрешения суда"], correct: 1 }
  ],
  zot: [
    { q: "Что определяет территорию как закрытую и охраняемую (статья 1)?", a: ["Любая территория государственного учреждения", "Территория, доступ на которую ограничен или запрещён законодательством", "Только территория федеральной тюрьмы"], correct: 1 },
    { q: "Что обязан сделать правоохранитель до решения о задержании человека на ЗОТ (статья 3)?", a: ["Немедленно задержать", "Установить законность нахождения человека на территории", "Потребовать пропуск у каждого присутствующего"], correct: 1 },
    { q: "Кто вправе выдать пропуск на любую ЗОТ (статья 7)?", a: ["Губернатор или Вице-Губернатор", "Только руководитель организации, занимающей ЗОТ", "Любой сотрудник правоохранительного органа"], correct: 0 },
    { q: "На каких ЗОТ руководство организации может выдать временный пропуск (статья 9)?", a: ["На любую территорию штата", "На ЗОТ своей организации или подразделения", "Только на территорию аэропорта"], correct: 1 },
    { q: "Когда сотрудники EMS могут пройти в красную зону ИАЛС (статья 53)?", a: ["Только с разрешения охраны", "Для неотложной помощи при поступившем вызове и для приёма поставок медицинских препаратов", "В любое время без служебной причины"], correct: 1 }
  ],
  advocacy: [
    { q: "Как стажёр и юрист могут выполнять адвокатскую деятельность по статье 1.8?", a: ["Полностью самостоятельно", "Помогать старшим сотрудникам; полный объём деятельности — только под контролем", "Только после получения лицензии частного адвоката"], correct: 1 },
    { q: "Что руководство обязано делать весь период контроля за членами Коллегии (статья 2.5)?", a: ["Вести видеофиксацию", "Публиковать отчёт в открытом доступе", "Получать разрешение суда"], correct: 0 },
    { q: "Что должно быть указано в запросе адвоката на материалы дела по статье 3.1?", a: ["Только имя доверителя", "Ссылка на номер искового заявления, принятого судом", "Разрешение каждого сотрудника организации"], correct: 1 },
    { q: "Где и в каких условиях адвокат может конфиденциально встретиться с подзащитным по статье 3.4?", a: ["В любом помещении учреждения", "В специально предназначенном помещении, обеспечивающем полную конфиденциальность", "Только в здании суда"], correct: 1 },
    { q: "Когда частный адвокат обязан покинуть закрытую территорию по статье 8.4?", a: ["Только после требования прокурора", "Когда нет оснований для исполнения обязанностей или их выполнение завершено", "Никогда, если у него есть лицензия"], correct: 1 }
  ],
  road: [
    { q: "Что устанавливает Дорожный кодекс согласно статье 1?", a: ["Единые правила дорожного движения и порядок дорожного движения", "Порядок выдачи лицензий адвокатам", "Только правила парковки"], correct: 0 },
    { q: "Какое направление движения установлено на дорогах штата?", a: ["Левостороннее", "Правостороннее", "Направление определяется водителем"], correct: 1 },
    { q: "Кто считается водителем по статье 1?", a: ["Только владелец транспортного средства", "Лицо, управляющее транспортным средством; к нему приравнивается обучающий вождению", "Любой пассажир"], correct: 1 },
    { q: "Какова предельная скорость мопеда в определении статьи 1?", a: ["Не более 80 км/ч", "Не более 130 км/ч", "Не более 200 км/ч"], correct: 1 },
    { q: "Что отличает обгон от опережения в определениях Дорожного кодекса?", a: ["Обгон связан с выездом на полосу встречного движения", "Обгон возможен только на парковке", "Обгон и опережение определены как одно понятие"], correct: 0 }
  ],
  labor: [
    { q: "Какие отношения регулирует Трудовой кодекс SA?", a: ["Трудовые отношения между работниками и работодателями", "Только отношения между адвокатом и доверителем", "Только правила дорожного движения"], correct: 0 },
    { q: "Какова одна из целей трудового законодательства по статье 1.1?", a: ["Защита прав и интересов работников и работодателей", "Отмена трудовых договоров", "Регулирование судебных исков"], correct: 0 },
    { q: "Какова максимальная длительность испытательного срока или стажировки по статье 2.3?", a: ["1 день", "3 дня", "7 дней"], correct: 1 },
    { q: "На каких основаниях могут возникнуть трудовые отношения?", a: ["Только после устного согласия", "Избрание, назначение, утверждение, контракт или трудовой договор", "Только по решению суда"], correct: 1 },
    { q: "Чему не должны противоречить договор и устав частной организации?", a: ["Трудовому кодексу", "Только внутреннему расписанию", "Правилам дорожного движения"], correct: 0 }
  ],
  ethics: [
    { q: "Какова цель Этического кодекса по пункту 1.1?", a: ["Регламентировать поведение государственного служащего при исполнении обязанностей", "Устанавливать размеры заработной платы", "Регулировать дорожное движение"], correct: 0 },
    { q: "На кого распространяется обязательность профессиональной этики по пункту 1.2?", a: ["Только на рядовых служащих", "На работников и руководителей всех государственных органов штата", "Только на руководителей"], correct: 1 },
    { q: "Как следует поступить при конфликте интересов?", a: ["Продолжить участие без уведомления", "Воздержаться от участия, чтобы избежать корысти", "Передать решение гражданину"], correct: 1 },
    { q: "Чьи интересы работник должен ставить в приоритет по пункту 2.1?", a: ["Личные интересы", "Интересы государства и общества", "Интересы только своего отдела"], correct: 1 },
    { q: "Что запрещено руководителю по пункту 4.1?", a: ["Самовольно демонстрировать и использовать власть", "Создавать благоприятные условия для подчинённых", "Организовывать работу"], correct: 0 }
  ],
  documents: [
    { q: "Что регулирует Закон о документообороте по пункту 1.1?", a: ["Создание, оформление, подписание, публикацию, изменение и хранение документов", "Порядок дорожного движения", "Только работу судов"], correct: 0 },
    { q: "Что нужно делать со второй и последующими страницами документа на двух и более страницах?", a: ["Нумеровать", "Оставлять без отметок", "Подписывать каждую отдельным договором"], correct: 0 },
    { q: "Что обязан сделать автор перед подписанием или публикацией документа?", a: ["Проверить его соответствие закону о документообороте и другим актам", "Сначала отправить копию в Discord", "Удалить дату документа"], correct: 0 },
    { q: "Что входит в обязательные реквизиты документа по пункту 1.5?", a: ["Заголовок, текст и подпись", "Только имя автора", "Только герб"], correct: 0 },
    { q: "Как исчисляется установленный период времени, если закон не предусматривает иное?", a: ["Полностью, независимо от выходных и праздников", "Только в рабочие дни", "Только с начала следующего месяца"], correct: 0 }
  ],
  justice: [
    { q: "Какие организации названы в составе Департамента юстиции в статье 2?", a: ["FIB, Прокуратура и Федеральная тюрьма Болингброук", "LSPD, EMS и Мэрия", "Только Верховный суд"], correct: 0 },
    { q: "Кому подчинена Прокуратура согласно статье 3?", a: ["Офису Генерального прокурора", "Дорожному департаменту", "Коллегии адвокатов"], correct: 0 },
    { q: "Кто возглавляет центральный орган системы прокуратуры по статье 8.3?", a: ["Генеральный прокурор", "Председатель коллегии адвокатов", "Губернатор города"], correct: 0 },
    { q: "Что входит в направления деятельности Прокуратуры по статье 7?", a: ["Приём, регистрация и рассмотрение обращений", "Выдача водительских удостоверений", "Назначение адвокатов гражданам"], correct: 0 },
    { q: "Кому подчиняется Генеральный прокурор по статье 8.3?", a: ["Исключительно Федеральному правительству", "Любому руководителю организации", "Только Верховному суду"], correct: 0 }
  ]
};
const lawExamTitles = {
  ak: "Административный кодекс",
  pk: "Процессуальный кодекс",
  uk: "Уголовный кодекс",
  zot: "Закон о закрытых и охраняемых территориях",
  advocacy: "Закон об адвокатуре",
  road: "Дорожный кодекс",
  labor: "Трудовой кодекс",
  ethics: "Этический кодекс",
  documents: "Закон о документообороте",
  justice: "Закон о Департаменте юстиции"
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const safeEqual = (left, right) => {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(String(left || ""));
  const b = Buffer.isBuffer(right) ? right : Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
};
const cleanUser = (user) => ({
  id: user.id, username: user.username, displayName: user.display_name,
  email: user.email || "", role: user.role, status: user.status,
  hasFullGkaAccess: Boolean(Number(user.full_gka_access)),
  createdAt: user.created_at, reattestDue: user.reattest_due || null,
  discordLinked: Boolean(user.discord_id), discordUsername: user.discord_username || "",
  discordAvatarUrl: user.discord_avatar_url || "",
  discordLinkedAt: user.discord_linked_at || null,
  discordSyncError: user.discord_sync_error || "",
  discordNicknameError: user.discord_nickname_error || "",
  documentCount: Number(user.document_count || 0), lawsuitCount: Number(user.lawsuit_count || 0)
});

function hasGkaAccess(user) {
  return user.role === "ГКА" ||
    (user.role === "ЗГКА" && Number(user.full_gka_access) === 1);
}

function hasFullGkaAccess(user) {
  return Number(user.full_gka_access) === 1;
}

function quoteSqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function createPermanentUserDeletion(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((row) => row.name);
  const columnInfo = new Map(tables.map((table) => [
    table,
    new Map(db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all()
      .map((column) => [column.name, column]))
  ]));
  const inbound = new Map(tables.map((table) => [table, []]));

  for (const childTable of tables) {
    const groups = new Map();
    for (const foreignKey of db.prepare(`PRAGMA foreign_key_list(${quoteSqlIdentifier(childTable)})`).all()) {
      if (!groups.has(foreignKey.id)) groups.set(foreignKey.id, []);
      groups.get(foreignKey.id).push(foreignKey);
    }
    for (const group of groups.values()) {
      group.sort((left, right) => left.seq - right.seq);
      const parentTable = group[0].table;
      if (!inbound.has(parentTable)) continue;
      inbound.get(parentTable).push({
        childTable,
        columns: group.map(({ from, to }) => ({ child: from, parent: to })),
        onDelete: String(group[0].on_delete).toUpperCase()
      });
    }
  }

  return (userId) => {
    let removedRows = 0;
    const visited = new Set();
    const removeRow = (table, rowId) => {
      const key = `${table}:${rowId}`;
      if (visited.has(key)) return;
      const quotedTable = quoteSqlIdentifier(table);
      const row = db.prepare(`SELECT rowid AS __rowid, * FROM ${quotedTable} WHERE rowid = ?`).get(rowId);
      if (!row) return;
      visited.add(key);

      for (const foreignKey of inbound.get(table) || []) {
        const values = foreignKey.columns.map(({ parent }) => row[parent]);
        if (values.some((value) => value === null || value === undefined)) continue;
        const where = foreignKey.columns.map(({ child }) => `${quoteSqlIdentifier(child)} = ?`).join(" AND ");
        const children = db.prepare(`SELECT rowid AS __rowid, * FROM ${quoteSqlIdentifier(foreignKey.childTable)}
          WHERE ${where}`).all(...values);
        const canNull = foreignKey.columns.every(({ child }) => {
          const column = columnInfo.get(foreignKey.childTable)?.get(child);
          return column && !column.notnull && !column.pk;
        });

        for (const child of children) {
          if (foreignKey.onDelete === "SET NULL" ||
              (["NO ACTION", "RESTRICT", "SET DEFAULT"].includes(foreignKey.onDelete) && canNull)) {
            const assignments = foreignKey.columns.map(({ child: column }) => `${quoteSqlIdentifier(column)} = NULL`).join(", ");
            db.prepare(`UPDATE ${quoteSqlIdentifier(foreignKey.childTable)} SET ${assignments} WHERE rowid = ?`)
              .run(child.__rowid);
          } else {
            removeRow(foreignKey.childTable, child.__rowid);
          }
        }
      }

      const deleted = db.prepare(`DELETE FROM ${quotedTable} WHERE rowid = ?`).run(rowId);
      removedRows += Number(deleted.changes);
    };

    removeRow("users", Number(userId));
    return removedRows;
  };
}

function migrateActivityReportTypes(db) {
  const schema = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'activity_reports'`).get()?.sql || "";
  if (/\bbail\b/i.test(schema)) return;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      ALTER TABLE activity_report_attachments RENAME TO activity_report_attachments_legacy;
      ALTER TABLE activity_reports RENAME TO activity_reports_legacy;
      CREATE TABLE activity_reports (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        report_type TEXT NOT NULL CHECK (report_type IN ('call','lawsuit','prosecutor_complaint','bail')),
        occurred_at TEXT NOT NULL,
        reference TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        decision TEXT NOT NULL DEFAULT '',
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO activity_reports SELECT * FROM activity_reports_legacy;
      CREATE TABLE activity_report_attachments (
        report_id INTEGER PRIMARY KEY REFERENCES activity_reports(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
        content BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO activity_report_attachments SELECT * FROM activity_report_attachments_legacy;
      DROP TABLE activity_report_attachments_legacy;
      DROP TABLE activity_reports_legacy;
      CREATE INDEX activity_reports_status_idx ON activity_reports(status, occurred_at DESC);
      CREATE INDEX activity_reports_user_idx ON activity_reports(user_id, id DESC);
      COMMIT;
    `);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error("Миграция отчётов повредила связи в базе данных.");
}

function recordGiveawayPointsForApprovedReport(db, report, lawyerTripStatus = report.lawyer_trip_status) {
  const eligible = db.prepare(`SELECT campaign_epoch, week_start FROM giveaway_report_eligibility
    WHERE report_id = ?`).get(report.id);
  const basePoints = giveawayPointsPerReport[report.report_type] || 0;
  if (!eligible || !basePoints) return;
  const tripBonus = report.report_type === "call" &&
    Number(report.lawyer_trip_claimed) === 1 && lawyerTripStatus === "approved" ? 1 : 0;
  db.prepare(`INSERT INTO giveaway_point_entries
    (report_id, user_id, report_type, points, campaign_epoch, week_start)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(report_id) DO UPDATE SET points = excluded.points`)
    .run(report.id, report.user_id, report.report_type, basePoints + tripBonus,
      eligible.campaign_epoch, eligible.week_start);
}

function addActivityReportLawyerParticipants(db, reports) {
  const participantsForReport = db.prepare(`SELECT participant.user_id, user.display_name
    FROM activity_report_lawyer_participants participant
    JOIN users user ON user.id = participant.user_id
    WHERE participant.report_id = ? ORDER BY user.display_name COLLATE NOCASE`);
  return reports.map((report) => ({
    ...report,
    lawyer_trip_participants: participantsForReport.all(report.id)
  }));
}

function createDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'Стажер КА',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
      full_gka_access INTEGER NOT NULL DEFAULT 0 CHECK (full_gka_access IN (0,1)),
      discord_id TEXT UNIQUE,
      discord_username TEXT NOT NULL DEFAULT '',
      discord_avatar_url TEXT NOT NULL DEFAULT '',
      discord_sync_error TEXT NOT NULL DEFAULT '',
      discord_nickname_error TEXT NOT NULL DEFAULT '',
      reattest_due TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS weekly_reset_runs (
      id INTEGER PRIMARY KEY,
      created_by INTEGER NOT NULL REFERENCES users(id),
      archived_at TEXT NOT NULL,
      counts_json TEXT NOT NULL DEFAULT '{}',
      restored_at TEXT,
      restored_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS lawsuits (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      document_id INTEGER NOT NULL REFERENCES documents(id),
      title TEXT NOT NULL,
      court TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted','in_review','hearing','decided','rejected')),
      decision TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      due_at TEXT,
      updated_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS lawsuit_history (
      id INTEGER PRIMARY KEY,
      lawsuit_id INTEGER NOT NULL REFERENCES lawsuits(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS invites (
      code_hash TEXT PRIMARY KEY,
      created_by INTEGER NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS discord_invite_issuance (
      discord_user_id TEXT PRIMARY KEY,
      invite_hash TEXT NOT NULL,
      issued_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portal_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rating_settings_history (
      id INTEGER PRIMARY KEY,
      updated_by INTEGER NOT NULL REFERENCES users(id),
      weights_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS discord_link_states (
      state_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      requested_role TEXT,
      stage_role TEXT NOT NULL DEFAULT '',
      study_read_at TEXT,
      interview_status TEXT NOT NULL DEFAULT 'not_required'
        CHECK (interview_status IN ('not_required','waiting','ready')),
      interview_ready_at TEXT,
      career_flow INTEGER NOT NULL DEFAULT 0 CHECK (career_flow IN (0,1)),
      details TEXT NOT NULL,
      passport_id TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      due_at TEXT,
      promotion_data_json TEXT NOT NULL DEFAULT '{}',
      review_data_json TEXT NOT NULL DEFAULT '{}',
      result TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      reviewed_by INTEGER REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id),
      requested_lawyer_id INTEGER REFERENCES users(id),
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT,
      archived_at TEXT,
      archive_run_id INTEGER REFERENCES weekly_reset_runs(id)
    );
    CREATE TABLE IF NOT EXISTS application_history (
      id INTEGER PRIMARY KEY,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS application_attachments (
      id INTEGER PRIMARY KEY,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS promotion_practice_slots (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stage_role TEXT NOT NULL CHECK (stage_role IN ('Стажер КА','Юрист')),
      slot_no INTEGER NOT NULL CHECK (slot_no BETWEEN 1 AND 6),
      partner_name TEXT NOT NULL DEFAULT '',
      evidence_url TEXT NOT NULL DEFAULT '',
      image_name TEXT NOT NULL DEFAULT '',
      image_type TEXT NOT NULL DEFAULT '',
      image_content BLOB,
      skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, stage_role, slot_no),
      CHECK (skipped = 0 OR slot_no > 3)
    );
    CREATE INDEX IF NOT EXISTS promotion_practice_stage_idx
      ON promotion_practice_slots(stage_role, user_id, slot_no);
    CREATE TABLE IF NOT EXISTS promotion_decree_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_number INTEGER NOT NULL DEFAULT 0 CHECK (next_number >= 0),
      first_application_id INTEGER NOT NULL DEFAULT 0 CHECK (first_application_id >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS promotion_decrees (
      id INTEGER PRIMARY KEY,
      decree_number INTEGER NOT NULL UNIQUE,
      bbcode TEXT NOT NULL,
      sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS promotion_decree_items (
      id INTEGER PRIMARY KEY,
      decree_id INTEGER NOT NULL REFERENCES promotion_decrees(id) ON DELETE CASCADE,
      application_id INTEGER UNIQUE REFERENCES applications(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      character_name TEXT NOT NULL,
      passport_id TEXT NOT NULL,
      from_role TEXT NOT NULL,
      to_role TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS application_messages (
      id INTEGER PRIMARY KEY,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message','contact')),
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reprimands (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      issued_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL,
      photo_name TEXT NOT NULL,
      photo_type TEXT NOT NULL,
      photo BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at TEXT,
      archive_run_id INTEGER REFERENCES weekly_reset_runs(id),
      revoked_at TEXT,
      revoked_by INTEGER,
      revoked_by_name TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS reprimands_user_idx ON reprimands(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS activity_reports (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_type TEXT NOT NULL CHECK (report_type IN ('call','lawsuit','prosecutor_complaint','bail')),
      occurred_at TEXT NOT NULL,
      reference TEXT NOT NULL,
      reference_url TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      decision TEXT NOT NULL DEFAULT '',
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS activity_report_attachments (
      report_id INTEGER PRIMARY KEY REFERENCES activity_reports(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
      content BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS activity_report_lawyer_participants (
      report_id INTEGER NOT NULL REFERENCES activity_reports(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (report_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS activity_report_lawyer_participants_user_idx
      ON activity_report_lawyer_participants(user_id, report_id);
    CREATE INDEX IF NOT EXISTS activity_reports_status_idx ON activity_reports(status, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS activity_reports_user_idx ON activity_reports(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS portal_notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      href TEXT NOT NULL DEFAULT '',
      discord_error TEXT NOT NULL DEFAULT '',
      discord_sent_at TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS portal_notifications_user_idx ON portal_notifications(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      discord_dm_enabled INTEGER NOT NULL DEFAULT 1 CHECK (discord_dm_enabled IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS promotion_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lawyer_calls_required INTEGER NOT NULL DEFAULT 0 CHECK (lawyer_calls_required BETWEEN 0 AND 100),
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS lawyer_reviews (
      id INTEGER PRIMARY KEY,
      application_id INTEGER NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
      lawyer_id INTEGER NOT NULL REFERENCES users(id),
      reviewer_id INTEGER NOT NULL REFERENCES users(id),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS exam_results (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
      track TEXT NOT NULL,
      score INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      answers_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS career_law_exam_passes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stage_role TEXT NOT NULL,
      subject TEXT NOT NULL CHECK (subject IN ('ak','uk','pk')),
      exam_result_id INTEGER NOT NULL REFERENCES exam_results(id) ON DELETE CASCADE,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, stage_role, subject)
    );
    CREATE TABLE IF NOT EXISTS career_path_progress (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stage_role TEXT NOT NULL CHECK (stage_role IN ('Стажер КА','Юрист')),
      started_at TEXT,
      tutorial_seen_at TEXT,
      laws_reviewed_at TEXT,
      interview_prompt_dismissed_at TEXT,
      interview_ready_at TEXT,
      PRIMARY KEY (user_id, stage_role)
    );
    CREATE TABLE IF NOT EXISTS attestations (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      track TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','passed','failed')),
      score INTEGER,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS rp_practice_completions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      case_id TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, case_id)
    );
    CREATE TABLE IF NOT EXISTS rp_career_practice_completions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stage_role TEXT NOT NULL CHECK (stage_role IN ('Стажер КА','Юрист')),
      case_id TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, stage_role, case_id)
    );
    CREATE TABLE IF NOT EXISTS rp_career_practice_sessions (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      stage_role TEXT NOT NULL CHECK (stage_role IN ('Стажер КА','Юрист')),
      case_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS rp_custom_cases (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      source_details TEXT NOT NULL,
      difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
      officer_kindness INTEGER NOT NULL CHECK (officer_kindness BETWEEN 1 AND 5),
      depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 5),
      scenario_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'private' CHECK (status IN ('private','pending','public','rejected')),
      completed_at TEXT,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS rp_custom_cases_status_idx ON rp_custom_cases(status, id DESC);
    CREATE INDEX IF NOT EXISTS rp_custom_cases_user_idx ON rp_custom_cases(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      template TEXT NOT NULL,
      title TEXT NOT NULL,
      bbcode TEXT NOT NULL,
      forum_url TEXT NOT NULL DEFAULT '',
      forum_status TEXT NOT NULL DEFAULT 'draft'
        CHECK (forum_status IN ('draft','pending','approved','rejected')),
      forum_review_note TEXT NOT NULL DEFAULT '',
      forum_reviewed_by INTEGER REFERENCES users(id),
      forum_reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS document_sequences (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
      due_at TEXT,
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new','accepted','in_progress','review','revision','completed','cancelled')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      review_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS task_assignees (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      assigned_by INTEGER NOT NULL REFERENCES users(id),
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (task_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS task_history (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS task_attachments (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      uploaded_by INTEGER NOT NULL REFERENCES users(id),
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL CHECK (event_type IN ('court','interview','exam','attestation','meeting','lecture','training','other')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
      is_all_staff INTEGER NOT NULL DEFAULT 0 CHECK (is_all_staff IN (0,1)),
      responsible_id INTEGER NOT NULL REFERENCES users(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at TEXT,
      archive_run_id INTEGER REFERENCES weekly_reset_runs(id)
    );
    CREATE TABLE IF NOT EXISTS calendar_event_participants (
      event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      added_by INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (event_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS calendar_reminder_deliveries (
      event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lead_minutes INTEGER NOT NULL CHECK (lead_minutes IN (60,1440)),
      last_attempt_at TEXT NOT NULL,
      sent_at TEXT,
      PRIMARY KEY (event_id,user_id,lead_minutes)
    );
    CREATE TABLE IF NOT EXISTS achievements (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '★',
      metric TEXT NOT NULL CHECK (metric IN ('approved_lawsuits','closed_requests','approved_documents','high_reviews','service_days','manual')),
      threshold INTEGER NOT NULL CHECK (threshold > 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_achievements (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      achievement_id INTEGER NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
      awarded_by INTEGER REFERENCES users(id),
      awarded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, achievement_id)
    );
    CREATE TABLE IF NOT EXISTS user_awards (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      granted_by INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('thanks','certificate','special','individual')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS staff_reserve (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      added_by INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'considering' CHECK (status IN ('considering','ready')),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS absence_requests (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      review_note TEXT NOT NULL DEFAULT '',
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at TEXT,
      archive_run_id INTEGER REFERENCES weekly_reset_runs(id)
    );
    CREATE TABLE IF NOT EXISTS member_characteristics (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      evaluator_id INTEGER NOT NULL REFERENCES users(id),
      criterion TEXT NOT NULL CHECK (criterion IN ('law','discipline','activity','professionalism','citizens','teamwork')),
      score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS member_employment_history (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id),
      event_type TEXT NOT NULL CHECK (event_type IN ('hired','promoted','role_changed','dismissed','reinstated','status_changed')),
      from_role TEXT NOT NULL,
      to_role TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS academy_materials (
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('constitutional','administrative','criminal','labor','advocacy','court','documents','internal')),
      kind TEXT NOT NULL CHECK (kind IN ('lecture','manual','exercise')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      updated_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS applications_user_idx ON applications(user_id, created_at);
    CREATE INDEX IF NOT EXISTS application_attachments_app_idx ON application_attachments(application_id);
    CREATE INDEX IF NOT EXISTS application_messages_app_idx ON application_messages(application_id, id);
    CREATE INDEX IF NOT EXISTS attestations_user_idx ON attestations(user_id, due_at);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS lawsuits_user_idx ON lawsuits(user_id, created_at);
    CREATE INDEX IF NOT EXISTS lawsuit_history_case_idx ON lawsuit_history(lawsuit_id, id DESC);
    CREATE INDEX IF NOT EXISTS application_history_app_idx ON application_history(application_id, id DESC);
    CREATE INDEX IF NOT EXISTS tasks_updated_idx ON tasks(updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS task_assignees_user_idx ON task_assignees(user_id, task_id);
    CREATE INDEX IF NOT EXISTS task_history_task_idx ON task_history(task_id, id DESC);
    CREATE INDEX IF NOT EXISTS task_attachments_task_idx ON task_attachments(task_id, id);
    CREATE INDEX IF NOT EXISTS calendar_events_starts_idx ON calendar_events(starts_at, id);
    CREATE INDEX IF NOT EXISTS calendar_event_participants_user_idx ON calendar_event_participants(user_id, event_id);
    CREATE INDEX IF NOT EXISTS calendar_reminder_delivery_user_idx ON calendar_reminder_deliveries(user_id, sent_at);
    CREATE INDEX IF NOT EXISTS absence_requests_user_idx ON absence_requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS member_characteristics_user_idx ON member_characteristics(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS member_employment_history_user_idx ON member_employment_history(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS academy_materials_category_idx ON academy_materials(category, updated_at DESC);
  `);
  const promotionDecreeItemColumns = db.prepare("PRAGMA table_info(promotion_decree_items)").all();
  if (!promotionDecreeItemColumns.some((item) => item.name === "user_id")) {
    db.exec("ALTER TABLE promotion_decree_items ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  }
  db.prepare(`UPDATE promotion_decree_items SET user_id = (
    SELECT user_id FROM applications WHERE applications.id = promotion_decree_items.application_id
  ) WHERE user_id IS NULL AND application_id IS NOT NULL`).run();
  db.prepare(`INSERT OR IGNORE INTO promotion_decree_state (id, next_number, first_application_id)
    SELECT 1, 0, COALESCE(MAX(id), 0) FROM applications`).run();
  migrateActivityReportTypes(db);
  db.prepare(`UPDATE rp_custom_cases SET status = 'private'
    WHERE status IN ('pending', 'public')`).run();
  const activityReportColumns = db.prepare("PRAGMA table_info(activity_reports)").all();
  for (const [column, definition] of [
    ["lawyer_trip_claimed", "INTEGER NOT NULL DEFAULT 0 CHECK (lawyer_trip_claimed IN (0,1))"],
    ["lawyer_trip_status", "TEXT NOT NULL DEFAULT 'none' CHECK (lawyer_trip_status IN ('none','pending','approved','rejected'))"],
    ["lawyer_trip_decision", "TEXT NOT NULL DEFAULT ''"],
    ["lawyer_trip_reviewed_by", "INTEGER REFERENCES users(id)"],
    ["lawyer_trip_reviewed_at", "TEXT"]
  ]) {
    if (!activityReportColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE activity_reports ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS giveaway_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
      campaign_epoch INTEGER NOT NULL DEFAULT 1 CHECK (campaign_epoch >= 1),
      updated_by_discord_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS giveaway_report_eligibility (
      report_id INTEGER PRIMARY KEY REFERENCES activity_reports(id) ON DELETE CASCADE,
      campaign_epoch INTEGER NOT NULL,
      week_start TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS giveaway_point_entries (
      report_id INTEGER PRIMARY KEY REFERENCES activity_reports(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_type TEXT NOT NULL CHECK (report_type IN ('call','bail')),
      points INTEGER NOT NULL CHECK (points IN (1,2)),
      campaign_epoch INTEGER NOT NULL,
      week_start TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS giveaway_manual_point_entries (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      points INTEGER NOT NULL CHECK (points > 0),
      campaign_epoch INTEGER NOT NULL,
      week_start TEXT NOT NULL,
      awarded_by_discord_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS giveaway_points_week_idx
      ON giveaway_point_entries(campaign_epoch, week_start, user_id);
    CREATE INDEX IF NOT EXISTS giveaway_manual_points_week_idx
      ON giveaway_manual_point_entries(campaign_epoch, week_start, user_id);
    CREATE TABLE IF NOT EXISTS giveaway_events (
      id INTEGER PRIMARY KEY,
      action TEXT NOT NULL CHECK (action IN ('on','off','reset')),
      actor_discord_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare("INSERT OR IGNORE INTO giveaway_state (id) VALUES (1)").run();
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  if (!userColumns.some((item) => item.name === "full_gka_access")) {
    db.exec("ALTER TABLE users ADD COLUMN full_gka_access INTEGER NOT NULL DEFAULT 0 CHECK (full_gka_access IN (0,1))");
  }
  const careerPathColumns = db.prepare("PRAGMA table_info(career_path_progress)").all();
  for (const [column, definition] of [
    ["interview_prompt_dismissed_at", "TEXT"],
    ["interview_ready_at", "TEXT"]
  ]) {
    if (!careerPathColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE career_path_progress ADD COLUMN ${column} ${definition}`);
    }
  }
  db.prepare("UPDATE users SET full_gka_access = 0 WHERE username != ? AND full_gka_access != 0")
    .run("yyte");
  db.prepare(`UPDATE users SET role = 'ЗГКА', full_gka_access = 1
    WHERE username = ? AND (role != 'ЗГКА' OR full_gka_access != 1)`).run("yyte");
  db.prepare("UPDATE users SET display_name = 'Yuti Prince' WHERE username = 'yyte'");
  const governorMigration = db.prepare("SELECT value FROM portal_settings WHERE key = ?")
    .get("governor-role-migration-v1");
  if (!governorMigration && db.prepare("SELECT 1 FROM users WHERE id = ?").get(governorUserId)) {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(governorRole, governorUserId);
    db.prepare("INSERT INTO portal_settings (key, value) VALUES (?, ?)")
      .run("governor-role-migration-v1", "done");
  }

  const applicationColumns = db.prepare("PRAGMA table_info(applications)").all();
  for (const [column, definition] of [
    ["assigned_to", "INTEGER REFERENCES users(id)"],
    ["requested_lawyer_id", "INTEGER REFERENCES users(id)"],
    ["completed_at", "TEXT"],
    ["passport_id", "TEXT NOT NULL DEFAULT ''"],
    ["priority", "TEXT NOT NULL DEFAULT 'normal'"],
    ["due_at", "TEXT"],
    ["promotion_data_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["review_data_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["stage_role", "TEXT NOT NULL DEFAULT ''"],
    ["study_read_at", "TEXT"],
    ["interview_status", "TEXT NOT NULL DEFAULT 'not_required'"],
    ["interview_ready_at", "TEXT"],
    ["career_flow", "INTEGER NOT NULL DEFAULT 0"],
    ["archived_at", "TEXT"],
    ["archive_run_id", "INTEGER REFERENCES weekly_reset_runs(id)"]
  ]) {
    if (!applicationColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE applications ADD COLUMN ${column} ${definition}`);
    }
  }
  for (const [table, column, definition] of [
    ["activity_reports", "reference_url", "TEXT NOT NULL DEFAULT ''"],
    ["calendar_events", "archived_at", "TEXT"],
    ["calendar_events", "archive_run_id", "INTEGER REFERENCES weekly_reset_runs(id)"],
    ["absence_requests", "archived_at", "TEXT"],
    ["absence_requests", "archive_run_id", "INTEGER REFERENCES weekly_reset_runs(id)"],
    ["reprimands", "archived_at", "TEXT"],
    ["reprimands", "archive_run_id", "INTEGER REFERENCES weekly_reset_runs(id)"],
    ["reprimands", "revoked_at", "TEXT"],
    ["reprimands", "revoked_by", "INTEGER"],
    ["reprimands", "revoked_by_name", "TEXT NOT NULL DEFAULT ''"]
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS applications_archive_idx ON applications(archived_at, type, status);
    CREATE INDEX IF NOT EXISTS calendar_events_archive_idx ON calendar_events(archived_at, status, starts_at);
    CREATE INDEX IF NOT EXISTS absence_requests_archive_idx ON absence_requests(archived_at, status, created_at);
    CREATE INDEX IF NOT EXISTS reprimands_archive_idx ON reprimands(archived_at, created_at);
    CREATE INDEX IF NOT EXISTS weekly_reset_runs_created_idx ON weekly_reset_runs(created_at DESC, id DESC)`);
  const documentColumns = db.prepare("PRAGMA table_info(documents)").all();
  for (const [column, definition] of [
    ["forum_url", "TEXT NOT NULL DEFAULT ''"],
    ["forum_status", "TEXT NOT NULL DEFAULT 'draft'"],
    ["forum_review_note", "TEXT NOT NULL DEFAULT ''"],
    ["forum_reviewed_by", "INTEGER REFERENCES users(id)"],
    ["forum_reviewed_at", "TEXT"]
  ]) {
    if (!documentColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE documents ADD COLUMN ${column} ${definition}`);
    }
  }
  const lawsuitColumns = db.prepare("PRAGMA table_info(lawsuits)").all();
  for (const [column, definition] of [
    ["priority", "TEXT NOT NULL DEFAULT 'normal'"],
    ["due_at", "TEXT"]
  ]) {
    if (!lawsuitColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE lawsuits ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS lawsuits_due_idx ON lawsuits(due_at, status)");
  const examResultColumns = db.prepare("PRAGMA table_info(exam_results)").all();
  if (!examResultColumns.some((column) => column.name === "application_id")) {
    db.exec("ALTER TABLE exam_results ADD COLUMN application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL");
  }
  db.exec("CREATE INDEX IF NOT EXISTS exam_results_application_idx ON exam_results(application_id, track, id)");
  db.exec("INSERT OR IGNORE INTO promotion_settings (id, lawyer_calls_required) VALUES (1, 0)");
  for (const [column, definition] of [
    ["discord_id", "TEXT"],
    ["discord_username", "TEXT NOT NULL DEFAULT ''"],
    ["discord_avatar_url", "TEXT NOT NULL DEFAULT ''"],
    ["discord_sync_error", "TEXT NOT NULL DEFAULT ''"],
    ["discord_nickname_error", "TEXT NOT NULL DEFAULT ''"],
    ["forum_profile_url", "TEXT NOT NULL DEFAULT ''"],
    ["forum_profile_verified_at", "TEXT"],
    ["forum_profile_verified_by", "INTEGER REFERENCES users(id)"],
    ["member_since", "TEXT NOT NULL DEFAULT ''"],
    ["discord_linked_at", "TEXT"],
    ["profile_bio", "TEXT NOT NULL DEFAULT ''"],
    ["profile_pinned_cases", "TEXT NOT NULL DEFAULT '[]'"],
    ["profile_effect", "TEXT NOT NULL DEFAULT 'snow'"],
    ["profile_quote", "TEXT NOT NULL DEFAULT ''"],
    ["manual_lawsuits", "INTEGER NOT NULL DEFAULT 0"]
  ]) {
    if (!userColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
    }
    db.prepare(`INSERT OR IGNORE INTO achievements (slug,title,description,icon,metric,threshold) VALUES
      ('first-case','Первое дело','Первое подтверждённое судебное дело.','§','approved_lawsuits',1),
      ('citizen-helper','Помощник граждан','10 закрытых обращений, взятых в работу.','✚','closed_requests',10),
      ('experienced-lawyer','Опытный юрист','25 одобренных документов.','▤','approved_documents',25),
      ('professional','Профессионал','5 оценок граждан на 4 или 5 баллов.','★','high_reviews',5),
      ('collegium-veteran','Ветеран Коллегии','Год службы с датой вступления, подтверждённой руководством.','◆','service_days',365),
      ('manual-thanks','Благодарность руководства','Ручная награда за особый вклад в работу Коллегии.','★','manual',1),
      ('manual-honor','Почётная грамота','Ручная награда за значимые достижения и профессионализм.','◆','manual',1),
      ('manual-service','Особая награда','Ручная награда за исключительную службу Коллегии.','§','manual',1),
      ('manual-merit','Индивидуальное поощрение','Ручная награда по решению руководства.','✦','manual',1)`).run();
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id_idx ON users(discord_id)");
  const staleNicknameWarnings = db.prepare(`SELECT id, discord_sync_error FROM users
    WHERE discord_sync_error LIKE '%не удалось изменить ник:%'`).all();
  for (const row of staleNicknameWarnings) {
    const marker = "не удалось изменить ник: ";
    const start = row.discord_sync_error.indexOf(marker);
    const separator = row.discord_sync_error.indexOf(" · ", start);
    const end = separator < 0 ? row.discord_sync_error.length : separator;
    const nicknameWarning = row.discord_sync_error.slice(start, end).trim();
    const remaining = `${row.discord_sync_error.slice(0, start)}${separator < 0 ? "" : row.discord_sync_error.slice(separator + 3)}`
      .replace(/^Не удалось синхронизировать Discord:\s*/, "").trim();
    db.prepare("UPDATE users SET discord_sync_error = ?, discord_nickname_error = ? WHERE id = ?")
      .run(remaining, nicknameWarning, row.id);
  }
  return db;
}

function getWeeklyResetPreview(db, now = new Date()) {
  const cutoff = now.toISOString();
  const count = (sql, ...parameters) => Number(db.prepare(sql).get(...(parameters.length ? parameters : [cutoff])).count || 0);
  return {
    calendar: count(`SELECT COUNT(*) AS count FROM calendar_events
      WHERE archived_at IS NULL AND status IN ('completed','cancelled') AND datetime(starts_at) < datetime(?)`),
    applications: count(`SELECT COUNT(*) AS count FROM applications
      WHERE archived_at IS NULL AND type NOT IN ('citizen_help','citizen_complaint')
        AND status IN ('approved','rejected') AND datetime(created_at) < datetime(?)`),
    absences: count(`SELECT COUNT(*) AS count FROM absence_requests
      WHERE archived_at IS NULL AND (status = 'rejected' OR (status = 'approved' AND date(end_date) < date(?)))
        AND datetime(created_at) < datetime(?)`, cutoff, cutoff),
    reprimands: count(`SELECT COUNT(*) AS count FROM reprimands
      WHERE archived_at IS NULL AND datetime(created_at) < datetime(?)`)
  };
}

function buildWeeklyActivitySummary(db, periodStart, periodEnd) {
  const rows = db.prepare(`SELECT u.id, u.display_name, u.role,
      (SELECT COUNT(*) FROM activity_reports ar
        WHERE ar.user_id = u.id AND ar.report_type = 'call' AND ar.status = 'approved'
          AND julianday(ar.created_at) >= julianday(?) AND julianday(ar.created_at) < julianday(?)) AS calls,
      (SELECT COUNT(*) FROM lawsuits l JOIN documents d ON d.id = l.document_id
        WHERE l.user_id = u.id AND d.forum_status = 'approved'
          AND julianday(d.forum_reviewed_at) >= julianday(?) AND julianday(d.forum_reviewed_at) < julianday(?)) AS lawsuits,
      (SELECT COUNT(*) FROM activity_reports ar
        WHERE ar.user_id = u.id AND ar.report_type = 'bail' AND ar.status = 'approved'
          AND julianday(ar.created_at) >= julianday(?) AND julianday(ar.created_at) < julianday(?)) AS bails
    FROM users u WHERE u.role != ?
    ORDER BY u.role, u.display_name`).all(
    periodStart, periodEnd, periodStart, periodEnd, periodStart, periodEnd, citizenRole
  ).map((row) => ({
    userId: Number(row.id),
    displayName: row.display_name,
    role: row.role,
    calls: Number(row.calls),
    lawsuits: Number(row.lawsuits),
    bails: Number(row.bails)
  }));
  return {
    periodStart,
    periodEnd,
    rows,
    totals: rows.reduce((totals, row) => ({
      calls: totals.calls + row.calls,
      lawsuits: totals.lawsuits + row.lawsuits,
      bails: totals.bails + row.bails
    }), { calls: 0, lawsuits: 0, bails: 0 })
  };
}

function formatWeeklyActivitySummary(summary) {
  const escapeMarkdown = (value) => String(value || "").replace(/[\\*_`~|]/g, "\\$&");
  const header = [
    `Период: ${summary.periodStart.slice(0, 10)} — ${summary.periodEnd.slice(0, 10)}`,
    `Всего: вызовов — ${summary.totals.calls}, исков — ${summary.totals.lawsuits}, залогов — ${summary.totals.bails}`,
    ""
  ].join("\n");
  const staffLines = summary.rows.map((row) =>
    `**${escapeMarkdown(row.displayName)} · ${escapeMarkdown(row.role)}**\nВызовы: ${row.calls} · Иски: ${row.lawsuits} · Залоги: ${row.bails}`
  );
  if (!staffLines.length) staffLines.push("Сотрудников в отчёте нет.");

  const chunks = [];
  let chunk = header;
  for (const line of staffLines) {
    if (chunk.length + line.length + 2 > 2800 && chunk !== header) {
      chunks.push(chunk);
      chunk = `${header}(продолжение)\n`;
    }
    chunk += `${line}\n\n`;
  }
  chunks.push(chunk.trim());
  return chunks;
}

function createWeeklyReset(db, actorId, now = new Date()) {
  const archivedAt = now.toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const previousRun = db.prepare(`SELECT archived_at FROM weekly_reset_runs
      WHERE restored_at IS NULL ORDER BY archived_at DESC, id DESC LIMIT 1`).get();
    const periodStart = previousRun?.archived_at
      || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const activitySummary = buildWeeklyActivitySummary(db, periodStart, archivedAt);
    const run = db.prepare(`INSERT INTO weekly_reset_runs (created_by, archived_at)
      VALUES (?, ?)`).run(actorId, archivedAt);
    const runId = Number(run.lastInsertRowid);
    const updates = {
      calendar: db.prepare(`UPDATE calendar_events SET archived_at = ?, archive_run_id = ?
        WHERE archived_at IS NULL AND status IN ('completed','cancelled') AND datetime(starts_at) < datetime(?)`)
        .run(archivedAt, runId, archivedAt).changes,
      applications: db.prepare(`UPDATE applications SET archived_at = ?, archive_run_id = ?
        WHERE archived_at IS NULL AND type NOT IN ('citizen_help','citizen_complaint')
          AND status IN ('approved','rejected') AND datetime(created_at) < datetime(?)`)
        .run(archivedAt, runId, archivedAt).changes,
      absences: db.prepare(`UPDATE absence_requests SET archived_at = ?, archive_run_id = ?
        WHERE archived_at IS NULL AND (status = 'rejected' OR (status = 'approved' AND date(end_date) < date(?)))
          AND datetime(created_at) < datetime(?)`)
        .run(archivedAt, runId, archivedAt, archivedAt).changes,
      reprimands: db.prepare(`UPDATE reprimands SET archived_at = ?, archive_run_id = ?
        WHERE archived_at IS NULL AND datetime(created_at) < datetime(?)`)
        .run(archivedAt, runId, archivedAt).changes
    };
    db.prepare("UPDATE weekly_reset_runs SET counts_json = ? WHERE id = ?")
      .run(JSON.stringify(updates), runId);
    db.exec("COMMIT");
    return { id: runId, archivedAt, counts: updates, activitySummary };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Не удалось откатить недельный архив.");
    }
    throw error;
  }
}

function restoreWeeklyReset(db, runId, actorId, now = new Date()) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = db.prepare("SELECT id, restored_at FROM weekly_reset_runs WHERE id = ?").get(runId);
    if (!run) throw new HttpError(404, "Архив недели не найден.");
    if (run.restored_at) throw new HttpError(409, "Этот архив уже восстановлен.");
    const restoredAt = now.toISOString();
    const restoredCounts = {
      calendar: db.prepare("UPDATE calendar_events SET archived_at = NULL, archive_run_id = NULL WHERE archive_run_id = ?").run(runId).changes,
      applications: db.prepare("UPDATE applications SET archived_at = NULL, archive_run_id = NULL WHERE archive_run_id = ?").run(runId).changes,
      absences: db.prepare("UPDATE absence_requests SET archived_at = NULL, archive_run_id = NULL WHERE archive_run_id = ?").run(runId).changes,
      reprimands: db.prepare("UPDATE reprimands SET archived_at = NULL, archive_run_id = NULL WHERE archive_run_id = ?").run(runId).changes
    };
    db.prepare("UPDATE weekly_reset_runs SET restored_at = ?, restored_by = ? WHERE id = ?")
      .run(restoredAt, actorId, runId);
    db.exec("COMMIT");
    return { id: runId, restoredAt, counts: restoredCounts };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Не удалось откатить восстановление архива.");
    }
    throw error;
  }
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(body);
}

function readJson(req, maxCharacters = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxCharacters) {
        reject(new HttpError(413, "Слишком большой запрос."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, "Некорректный JSON."));
      }
    });
    req.on("error", reject);
  });
}

function publicUser(db, userId) {
  return db.prepare(`SELECT id, username, display_name, email, role, status, full_gka_access, created_at, reattest_due,
    discord_id, discord_username, discord_avatar_url, discord_sync_error, discord_nickname_error,
    (SELECT COUNT(*) FROM documents WHERE user_id = users.id AND forum_status = 'approved') AS document_count,
    COALESCE(users.manual_lawsuits, 0) + (SELECT COUNT(*) FROM lawsuits l JOIN documents d ON d.id = l.document_id
      WHERE l.user_id = users.id AND d.forum_status = 'approved') AS lawsuit_count
    FROM users WHERE id = ?`).get(userId);
}

function getAchievementMetrics(db, userId) {
  const member = db.prepare("SELECT role, member_since FROM users WHERE id = ? AND status = 'active'").get(userId);
  if (!member || member.role === citizenRole) return {};
  const metrics = {
    approved_lawsuits: Number(db.prepare(`SELECT COALESCE((SELECT manual_lawsuits FROM users WHERE id = ?), 0) +
      (SELECT COUNT(*) FROM lawsuits l
      JOIN documents d ON d.id = l.document_id
      WHERE l.user_id = ?) AS count`).get(userId, userId).count),
    closed_requests: Number(db.prepare(`SELECT COUNT(*) AS count FROM applications
      WHERE assigned_to = ? AND completed_at IS NOT NULL AND type IN ('citizen_help','citizen_complaint')`).get(userId).count),
    approved_documents: Number(db.prepare("SELECT COUNT(*) AS count FROM documents WHERE user_id = ? AND forum_status = 'approved'").get(userId).count),
    high_reviews: Number(db.prepare("SELECT COUNT(*) AS count FROM lawyer_reviews WHERE lawyer_id = ? AND rating >= 4").get(userId).count),
    service_days: 0
  };
  const memberSince = member.member_since ? Date.parse(`${member.member_since}T00:00:00Z`) : NaN;
  if (Number.isFinite(memberSince) && memberSince <= Date.now()) {
    metrics.service_days = Math.floor((Date.now() - memberSince) / 86400000);
  }
  return metrics;
}

function evaluateAchievements(db, userId) {
  const metrics = getAchievementMetrics(db, userId);
  const eligible = db.prepare("SELECT id, metric, threshold FROM achievements WHERE active = 1 AND metric != 'manual'").all();
  const insert = db.prepare("INSERT OR IGNORE INTO user_achievements (user_id, achievement_id) VALUES (?, ?)");
  for (const achievement of eligible) {
    if (Number(metrics[achievement.metric] || 0) >= Number(achievement.threshold)) {
      insert.run(userId, achievement.id);
    }
  }
  return metrics;
}

function validateForumUrl(value) {
  const raw = String(value || "").trim();
  if (raw.length < 12 || raw.length > 500) throw new HttpError(400, "Укажите ссылку на опубликованную тему форума.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Ссылка на форум должна быть корректным URL.");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
      (url.pathname === "/" && !url.search)) {
    throw new HttpError(400, "Укажите публичную ссылку на конкретную тему форума.");
  }
  return url.toString();
}

function validateForumProfileUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length > 500) throw new HttpError(400, "Ссылка на профиль форума слишком длинная.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Укажите корректную ссылку на профиль форума.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "forum.gta5rp.com" ||
      !url.pathname.toLowerCase().startsWith("/members/") || url.username || url.password) {
    throw new HttpError(400, "Используйте HTTPS-ссылку на профиль участника forum.gta5rp.com.");
  }
  return url.toString();
}

function normalizeLawText(text, markdown = false) {
  let normalized = text
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*!\[[^\]]*\]\([^)]*\)\s*$/gim, "")
    .split("\n")
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!markdown) return trimmed;
      if (/^\s*[-*_]{3,}\s*$/.test(trimmed)) return "";
      const clean = trimmed.replace(/^\s*\*{3,}/, "");
      const heading = clean.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (heading) return heading[1].replace(/\*\*(.+?)\*\*/g, "$1").trim().toLocaleUpperCase("ru");
      return clean.replace(/\*\*(.+?)\*\*/g, "$1");
    })
    .filter((line) => !/^\s*divider\.png\s*$/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized;
}

function currentReportPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function validateReportPeriod(value) {
  const period = String(value || currentReportPeriod()).trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new HttpError(400, "Период отчёта должен быть в формате ГГГГ-ММ.");
  }
  return period;
}

function buildMonthlyReport(db, period) {
  const metricKeys = [
    "documentsCreated", "documentsApproved", "lawsuitsFiled", "callsReported", "bailReports",
    "casesTaken", "casesClosed", "examsPassed", "attestationsPassed", "reprimands"
  ];
  const allRows = db.prepare(`SELECT u.id, u.display_name, u.role, u.status,
      (SELECT COUNT(*) FROM documents d
        WHERE d.user_id = u.id AND strftime('%Y-%m', d.created_at) = ?) AS documents_created,
      (SELECT COUNT(*) FROM documents d
        WHERE d.user_id = u.id AND d.forum_status = 'approved'
          AND strftime('%Y-%m', d.forum_reviewed_at) = ?) AS documents_approved,
      (SELECT COUNT(*) FROM lawsuits l JOIN documents d ON d.id = l.document_id
        WHERE l.user_id = u.id AND d.forum_status = 'approved'
          AND strftime('%Y-%m', d.forum_reviewed_at) = ?) AS lawsuits_filed,
      (SELECT COUNT(*) FROM activity_reports ar
        WHERE ar.user_id = u.id AND ar.report_type = 'call' AND ar.status = 'approved'
          AND strftime('%Y-%m', ar.occurred_at) = ?) AS calls_reported,
      (SELECT COUNT(*) FROM activity_reports ar
        WHERE ar.user_id = u.id AND ar.report_type = 'bail' AND ar.status = 'approved'
          AND strftime('%Y-%m', ar.occurred_at) = ?) AS bail_reports,
      (SELECT COUNT(*) FROM applications a
        WHERE a.assigned_to = u.id AND a.type IN ('citizen_help', 'citizen_complaint')
          AND strftime('%Y-%m', a.created_at) = ?) AS cases_taken,
      (SELECT COUNT(*) FROM applications a
        WHERE a.assigned_to = u.id AND a.type IN ('citizen_help', 'citizen_complaint')
          AND a.completed_at IS NOT NULL AND strftime('%Y-%m', a.completed_at) = ?) AS cases_closed,
      (SELECT COUNT(*) FROM exam_results e
        WHERE e.user_id = u.id AND e.passed = 1 AND strftime('%Y-%m', e.created_at) = ?) AS exams_passed,
      (SELECT COUNT(*) FROM attestations a
        WHERE a.user_id = u.id AND a.status = 'passed'
          AND strftime('%Y-%m', a.completed_at) = ?) AS attestations_passed,
      (SELECT COUNT(*) FROM reprimands r
        WHERE r.user_id = u.id AND strftime('%Y-%m', r.created_at) = ?) AS reprimands
    FROM users u
    WHERE u.role != ?
    ORDER BY u.role, u.display_name`).all(
      period, period, period, period, period, period, period, period, period, period,
    citizenRole
  ).map((row) => ({
    userId: Number(row.id),
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    documentsCreated: Number(row.documents_created),
    documentsApproved: Number(row.documents_approved),
    lawsuitsFiled: Number(row.lawsuits_filed),
    callsReported: Number(row.calls_reported),
    bailReports: Number(row.bail_reports),
    casesTaken: Number(row.cases_taken),
    casesClosed: Number(row.cases_closed),
    examsPassed: Number(row.exams_passed),
    attestationsPassed: Number(row.attestations_passed),
    reprimands: Number(row.reprimands)
  }));
  const employees = allRows.filter((row) => row.status === "active")
    .map(({ userId, displayName, role }) => ({ userId, displayName, role }));
  const rows = allRows.filter((row) => row.status === "active" ||
    metricKeys.some((key) => row[key] > 0))
    .map(({ status, ...row }) => row);
  const totals = Object.fromEntries(metricKeys.map((key) =>
    [key, rows.reduce((sum, row) => sum + row[key], 0)]));
  return {
    period,
    generatedAt: new Date().toISOString(),
    employees,
    rows,
    totals
  };
}

function validateAnalyticsPeriod(value) {
  const period = String(value || "30").trim();
  if (!["7", "30", "90", "all"].includes(period)) {
    throw new HttpError(400, "Период аналитики должен быть 7, 30, 90 или all.");
  }
  return period;
}

function buildAnalyticsReport(db, period) {
  const days = period === "all" ? null : Number(period);
  const since = days === null ? null
    : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  const filter = (column) => since ? `datetime(${column}) >= datetime(?)` : "1 = 1";
  const args = since ? [since] : [];
  const count = (sql, values = args) => Number(db.prepare(sql).get(...values).count || 0);

  const compositionRows = db.prepare(`SELECT role, status, COUNT(*) AS count
    FROM users WHERE role != ? GROUP BY role, status`).all(citizenRole);
  const composition = {
    total: compositionRows.reduce((sum, row) => sum + Number(row.count), 0),
    active: compositionRows.filter((row) => row.status === "active")
      .reduce((sum, row) => sum + Number(row.count), 0),
    pending: compositionRows.filter((row) => row.status === "pending")
      .reduce((sum, row) => sum + Number(row.count), 0),
    suspended: compositionRows.filter((row) => row.status === "suspended")
      .reduce((sum, row) => sum + Number(row.count), 0),
    byRole: compositionRows.reduce((result, row) => {
      result[row.role] = (result[row.role] || 0) + Number(row.count);
      return result;
    }, {}),
    newAccounts: count(`SELECT COUNT(*) AS count FROM users
      WHERE role != ? AND ${filter("created_at")}`, since ? [citizenRole, since] : [citizenRole])
  };

  const lawsuitRows = db.prepare(`SELECT status, COUNT(*) AS count FROM lawsuits
    WHERE ${filter("created_at")} GROUP BY status`).all(...args);
  const lawsuits = {
    total: lawsuitRows.reduce((sum, row) => sum + Number(row.count), 0),
    byStatus: Object.fromEntries(lawsuitRows.map((row) => [row.status, Number(row.count)]))
  };

  const documentRows = db.prepare(`SELECT forum_status, COUNT(*) AS count FROM documents
    WHERE ${filter("created_at")} GROUP BY forum_status`).all(...args);
  const documentsByType = db.prepare(`SELECT template, COUNT(*) AS count FROM documents
    WHERE ${filter("created_at")} GROUP BY template ORDER BY count DESC`).all(...args);
  const documents = {
    total: documentRows.reduce((sum, row) => sum + Number(row.count), 0),
    byStatus: Object.fromEntries(documentRows.map((row) => [row.forum_status, Number(row.count)])),
    byType: documentsByType.map((row) => ({ template: row.template, count: Number(row.count) }))
  };

  const cases = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN completed_at IS NOT NULL OR status = 'rejected' THEN 1 ELSE 0 END) AS closed,
      SUM(CASE WHEN completed_at IS NULL AND status != 'rejected' THEN 1 ELSE 0 END) AS open
    FROM applications WHERE type IN ('citizen_help','citizen_complaint') AND ${filter("created_at")}`)
    .get(...args);
  const completedCases = db.prepare(`SELECT AVG((julianday(completed_at) - julianday(created_at)) * 24) AS average_hours,
      COUNT(*) AS count FROM applications
    WHERE type IN ('citizen_help','citizen_complaint') AND completed_at IS NOT NULL
      AND ${filter("completed_at")}`).get(...args);
  const reviews = db.prepare(`SELECT COUNT(*) AS count, AVG(rating) AS average
    FROM lawyer_reviews WHERE ${filter("created_at")}`).get(...args);
  const requests = {
    total: Number(cases.total || 0),
    closed: Number(cases.closed || 0),
    open: Number(cases.open || 0),
    averageResolutionHours: completedCases.average_hours === null
      ? null : Number(Number(completedCases.average_hours).toFixed(1)),
    resolvedCount: Number(completedCases.count || 0),
    reviewCount: Number(reviews.count || 0),
    averageRating: reviews.average === null ? null : Number(Number(reviews.average).toFixed(1))
  };

  const humanResources = {
    hires: count(`SELECT COUNT(*) AS count FROM member_employment_history
      WHERE event_type = 'hired' AND ${filter("created_at")}`),
    promotions: count(`SELECT COUNT(*) AS count FROM applications
      WHERE type = 'promotion' AND status = 'approved'
        AND ${filter("reviewed_at")}`),
    dismissals: count(`SELECT COUNT(*) AS count FROM member_employment_history
      WHERE event_type = 'dismissed' AND ${filter("created_at")}`),
    reinstatements: count(`SELECT COUNT(*) AS count FROM member_employment_history
      WHERE event_type = 'reinstated' AND ${filter("created_at")}`),
    reprimands: count(`SELECT COUNT(*) AS count FROM reprimands
      WHERE ${filter("created_at")}`),
    awards: count(`SELECT COUNT(*) AS count FROM user_awards
      WHERE ${filter("created_at")}`),
    attestationsPassed: count(`SELECT COUNT(*) AS count FROM attestations
      WHERE status = 'passed' AND ${filter("completed_at")}`),
    attestationsFailed: count(`SELECT COUNT(*) AS count FROM attestations
      WHERE status = 'failed' AND ${filter("completed_at")}`)
  };

  const bucket = period === "all" ? "strftime('%Y-%m', {column})" : "date({column})";
  const trendMetrics = [
    ["members", "users", "created_at", `role != '${citizenRole.replaceAll("'", "''")}'`],
    ["lawsuits", "lawsuits", "created_at", "1 = 1"],
    ["documents", "documents", "created_at", "1 = 1"],
    ["requests", "applications", "created_at", "type IN ('citizen_help','citizen_complaint')"],
    ["promotions", "applications", "reviewed_at", "type = 'promotion' AND status = 'approved'"],
    ["reprimands", "reprimands", "created_at", "1 = 1"],
    ["dismissals", "member_employment_history", "created_at", "event_type = 'dismissed'"]
  ];
  const trendMap = new Map();
  for (const [metric, table, column, condition] of trendMetrics) {
    const rows = db.prepare(`SELECT ${bucket.replace("{column}", column)} AS bucket, COUNT(*) AS count
      FROM ${table} WHERE ${condition} AND ${filter(column)} GROUP BY bucket ORDER BY bucket`).all(...args);
    for (const row of rows) {
      const current = trendMap.get(row.bucket) || { period: row.bucket };
      current[metric] = Number(row.count);
      trendMap.set(row.bucket, current);
    }
  }
  const trend = [...trendMap.values()].sort((left, right) => left.period.localeCompare(right.period));
  if (since) {
    const filledTrend = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      filledTrend.push(trendMap.get(date) || { period: date });
    }
    return {
      period, since, generatedAt: new Date().toISOString(), composition, lawsuits, documents,
      requests, humanResources, trend: filledTrend
    };
  }
  return {
    period, since: null, generatedAt: new Date().toISOString(), composition, lawsuits, documents,
    requests, humanResources, trend: trend.slice(-24)
  };
}

function getRatingWeights(db) {
  const saved = db.prepare("SELECT value FROM portal_settings WHERE key = 'attorney_rating_weights'").get();
  if (!saved) return { ...defaultRatingWeights };
  let weights;
  try {
    weights = JSON.parse(saved.value);
  } catch {
    throw new Error("Сохранённая формула рейтинга повреждена. Обратитесь к администратору базы данных.");
  }
  if (!weights || Object.keys(defaultRatingWeights).some((key) =>
    !Number.isInteger(weights[key]) || weights[key] < 0 || weights[key] > 100)) {
    throw new Error("Сохранённая формула рейтинга некорректна. Обратитесь к администратору базы данных.");
  }
  return Object.fromEntries(Object.keys(defaultRatingWeights).map((key) => [key, weights[key]]));
}

function buildAttorneyRanking(db, period) {
  const periodDays = { week: 7, month: 30, all: 0 };
  if (!Object.hasOwn(periodDays, period)) throw new HttpError(400, "Период рейтинга должен быть week, month или all.");
  const previousWeek = period === "week"
    ? db.prepare(`SELECT archived_at FROM weekly_reset_runs
      WHERE restored_at IS NULL ORDER BY archived_at DESC, id DESC LIMIT 1`).get()
    : null;
  const periodStart = periodDays[period]
    ? previousWeek?.archived_at
      || new Date(Date.now() - periodDays[period] * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ")
    : null;
  const weights = getRatingWeights(db);
  const attorneys = db.prepare(`SELECT u.id, u.display_name, u.role, u.discord_username, u.discord_avatar_url,
      (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id AND d.forum_status = 'approved'
        AND (? IS NULL OR julianday(d.forum_reviewed_at) >= julianday(?))) AS document_count,
      COALESCE(u.manual_lawsuits, 0) + (SELECT COUNT(*) FROM lawsuits l JOIN documents d ON d.id = l.document_id
        WHERE l.user_id = u.id AND d.forum_status = 'approved'
          AND (? IS NULL OR julianday(l.created_at) >= julianday(?))) AS lawsuit_count,
      (SELECT COUNT(*) FROM applications a WHERE a.assigned_to = u.id
        AND a.type IN ('citizen_help','citizen_complaint')
          AND (? IS NULL OR julianday(a.reviewed_at) >= julianday(?))) AS cases_handled,
      (SELECT COUNT(*) FROM applications a WHERE a.assigned_to = u.id
        AND a.type IN ('citizen_help','citizen_complaint') AND a.completed_at IS NOT NULL
          AND (? IS NULL OR julianday(a.completed_at) >= julianday(?))) AS cases_closed,
      (SELECT COUNT(*) FROM activity_reports ar WHERE ar.user_id = u.id
        AND ar.report_type = 'call' AND ar.status = 'approved'
          AND (? IS NULL OR julianday(ar.created_at) >= julianday(?))) AS call_count,
      (SELECT COUNT(*) FROM activity_reports ar WHERE ar.user_id = u.id
        AND ar.report_type = 'bail' AND ar.status = 'approved'
          AND (? IS NULL OR julianday(ar.created_at) >= julianday(?))) AS bail_count,
      (SELECT COUNT(DISTINCT h.task_id) FROM task_history h
        JOIN task_assignees ta ON ta.task_id = h.task_id
        WHERE ta.user_id = u.id AND h.to_status = 'completed'
          AND (? IS NULL OR julianday(h.created_at) >= julianday(?))) AS completed_tasks,
      COUNT(r.id) AS review_count, COALESCE(AVG(r.rating), 0) AS average_rating,
      COALESCE(SUM(r.rating), 0) AS review_points
    FROM users u LEFT JOIN lawyer_reviews r ON r.lawyer_id = u.id
      AND (? IS NULL OR julianday(r.created_at) >= julianday(?))
    WHERE u.status = 'active' AND u.role IN ('Адвокат', 'Ст.Адвокат')
    GROUP BY u.id`).all(...Array(16).fill(periodStart))
    .map((attorney) => {
      const metrics = {
        documentsApproved: Number(attorney.document_count),
        casesClosed: Number(attorney.cases_closed),
        lawsuitsFiled: Number(attorney.lawsuit_count),
        tasksCompleted: Number(attorney.completed_tasks),
        reviews: Number(attorney.review_points)
      };
      const score = Object.entries(weights).reduce((total, [key, weight]) => total + metrics[key] * weight, 0) +
        Number(attorney.call_count) * giveawayPointsPerReport.call +
        Number(attorney.bail_count) * giveawayPointsPerReport.bail;
      return {
        ...attorney, ...metrics, score,
        cases_handled: Number(attorney.cases_handled),
        document_count: Number(attorney.document_count),
        lawsuit_count: Number(attorney.lawsuit_count),
        calls: Number(attorney.call_count),
        bails: Number(attorney.bail_count),
        completed_task_count: Number(attorney.completed_tasks),
        average_rating: Number(Number(attorney.average_rating).toFixed(1))
      };
    }).sort((left, right) => right.score - left.score || right.average_rating - left.average_rating ||
      right.review_count - left.review_count || left.display_name.localeCompare(right.display_name, "ru"));
  return { period, weights, attorneys };
}

function getGiveawayWeekWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const part = (type) => Number(parts.find((item) => item.type === type)?.value);
  const start = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10)
  };
}

export function applyGiveawayCommand(db, action, discordUserId) {
  if (!["on", "off", "reset"].includes(action)) throw new Error("Команда конкурса не распознана.");
  const actorId = String(discordUserId || "");
  if (!/^\d{15,22}$/.test(actorId)) throw new Error("Discord вернул некорректный ID пользователя.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = db.prepare("SELECT enabled, campaign_epoch FROM giveaway_state WHERE id = 1").get();
    if (action === "reset") {
      db.prepare(`UPDATE giveaway_state SET campaign_epoch = campaign_epoch + 1,
        updated_by_discord_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run(actorId);
    } else {
      const nextEnabled = action === "on" ? 1 : 0;
      if (Number(state.enabled) === nextEnabled) {
        db.exec("COMMIT");
        return nextEnabled ? "Конкурс уже включён; накопленные баллы сохранены." : "Конкурс уже выключен.";
      }
      db.prepare(`UPDATE giveaway_state SET enabled = ?, updated_by_discord_id = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run(nextEnabled, actorId);
    }
    db.prepare("INSERT INTO giveaway_events (action, actor_discord_id) VALUES (?, ?)")
      .run(action, actorId);
    db.exec("COMMIT");
    if (action === "reset") {
      const enabled = Number(state.enabled) === 1;
      return `Баллы конкурса сброшены.${enabled ? " Начисление продолжится." : " Конкурс остаётся выключенным."}`;
    }
    return action === "on"
      ? "Конкурс включён. С этого момента новые отчёты будут участвовать в рейтинге; прежние баллы этой недели сохранены."
      : "Конкурс поставлен на паузу. Накопленные баллы сохранены; команда !giveway on возобновит начисление.";
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function awardGiveawayPoints(db, targetUserId, points, discordUserId) {
  if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) {
    throw new Error("Укажите корректный номер сотрудника из кадрового аудита.");
  }
  if (!Number.isSafeInteger(points) || points < 1) {
    throw new Error("Количество баллов должно быть положительным целым числом.");
  }
  const actorId = String(discordUserId || "");
  if (!/^\d{15,22}$/.test(actorId)) throw new Error("Discord вернул некорректный ID пользователя.");

  db.exec("BEGIN IMMEDIATE");
  try {
    const target = db.prepare(`SELECT id, display_name FROM users
      WHERE id = ? AND status = 'active' AND role != ?`).get(targetUserId, citizenRole);
    if (!target) throw new Error(`Активный сотрудник #${targetUserId} не найден.`);
    const state = db.prepare("SELECT campaign_epoch FROM giveaway_state WHERE id = 1").get();
    const week = getGiveawayWeekWindow();
    db.prepare(`INSERT INTO giveaway_manual_point_entries
      (user_id, points, campaign_epoch, week_start, awarded_by_discord_id)
      VALUES (?, ?, ?, ?, ?)`)
      .run(targetUserId, points, state.campaign_epoch, week.start, actorId);
    db.exec("COMMIT");
    return `Начислено ${points} баллов сотруднику ${target.display_name} (#${targetUserId}).`;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function backfillCurrentWeekGiveawayReports(db, state, week) {
  const markerKey = "giveaway_backfilled_week_start";
  const marker = db.prepare("SELECT value FROM portal_settings WHERE key = ?").get(markerKey);
  if (marker?.value === week.start) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT OR IGNORE INTO giveaway_report_eligibility (report_id,campaign_epoch,week_start)
      SELECT r.id, ?, ? FROM activity_reports r
      WHERE r.status = 'approved' AND r.report_type IN ('call','bail')
        AND r.occurred_at >= ? AND r.occurred_at <= ?
        AND NOT EXISTS (SELECT 1 FROM giveaway_report_eligibility e WHERE e.report_id = r.id)`)
      .run(state.campaign_epoch, week.start, week.start, week.end);
    db.prepare(`INSERT OR IGNORE INTO giveaway_point_entries
      (report_id,user_id,report_type,points,campaign_epoch,week_start)
      SELECT r.id,r.user_id,r.report_type,
        CASE r.report_type
          WHEN 'call' THEN ? + CASE WHEN r.lawyer_trip_status = 'approved' THEN 1 ELSE 0 END
          WHEN 'bail' THEN ?
        END, ?, ?
      FROM activity_reports r JOIN giveaway_report_eligibility e ON e.report_id = r.id
      WHERE r.status = 'approved' AND r.report_type IN ('call','bail')
        AND e.campaign_epoch = ? AND e.week_start = ?`)
      .run(giveawayPointsPerReport.call, giveawayPointsPerReport.bail,
        state.campaign_epoch, week.start, state.campaign_epoch, week.start);
    db.prepare(`INSERT INTO portal_settings (key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(markerKey, week.start);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getGiveawayLeaderboard(db) {
  const state = db.prepare("SELECT enabled, campaign_epoch, updated_at FROM giveaway_state WHERE id = 1").get();
  const week = getGiveawayWeekWindow();
  backfillCurrentWeekGiveawayReports(db, state, week);
  const standings = db.prepare(`SELECT u.id AS user_id, u.display_name, u.role,
      COALESCE(SUM(p.points), 0) + COALESCE(m.manual_points, 0) AS points,
      COALESCE(SUM(CASE WHEN p.report_type = 'call' THEN 1 ELSE 0 END), 0) AS calls,
      COALESCE(SUM(CASE WHEN p.report_type = 'bail' THEN 1 ELSE 0 END), 0) AS bails
    FROM users u
    LEFT JOIN giveaway_point_entries p
      ON p.user_id = u.id AND p.campaign_epoch = ? AND p.week_start = ?
    LEFT JOIN (
      SELECT user_id, SUM(points) AS manual_points FROM giveaway_manual_point_entries
      WHERE campaign_epoch = ? AND week_start = ? GROUP BY user_id
    ) m ON m.user_id = u.id
    WHERE u.status = 'active' AND u.role != ?
    GROUP BY u.id
    HAVING COALESCE(SUM(p.points), 0) > 0
      OR COALESCE(m.manual_points, 0) > 0
    ORDER BY points DESC, calls DESC, bails DESC, u.display_name COLLATE NOCASE`)
    .all(state.campaign_epoch, week.start, state.campaign_epoch, week.start, citizenRole)
    .map((row, index) => ({
      rank: index + 1,
      userId: Number(row.user_id),
      displayName: row.display_name,
      role: row.role,
      points: Number(row.points),
      calls: Number(row.calls),
      bails: Number(row.bails)
    }));
  return {
    enabled: Boolean(Number(state.enabled)),
    updatedAt: state.updated_at,
    weekStart: week.start,
    weekEnd: week.end,
    timeZone: "Europe/Moscow",
    prize: 300000,
    pointsPerReport: giveawayPointsPerReport,
    totalPoints: standings.reduce((total, item) => total + item.points, 0),
    participantCount: standings.length,
    standings
  };
}

export async function runDiscordPortalCommand({
  db, discordUserId, commandName, options = {}, memberRoleIds = [], roleIds = {}, notifyAbsence
}) {
  const requesterId = String(discordUserId || "");
  if (!/^\d{15,22}$/.test(requesterId)) throw new Error("Discord вернул некорректный ID пользователя.");
  const account = db.prepare(`SELECT id, display_name, role, status FROM users
    WHERE discord_id = ?`).get(requesterId);
  if (!account || account.status !== "active" || account.role === citizenRole) {
    throw new Error("Привяжите Discord к активному аккаунту сотрудника на портале.");
  }
  const expectedRoleId = roleIds[account.role];
  if (!expectedRoleId || !Array.isArray(memberRoleIds) || !memberRoleIds.includes(expectedRoleId)) {
    throw new Error("Роль Discord не совпадает с активной должностью аккаунта портала. Обратитесь к руководству.");
  }

  if (commandName === "profile") {
    const data = db.prepare(`SELECT
        (SELECT COUNT(*) FROM documents WHERE user_id = ? AND forum_status = 'approved') AS documents,
        (SELECT COUNT(*) FROM lawsuits WHERE user_id = ? AND status NOT IN ('decided','rejected')) AS active_lawsuits,
        (SELECT COUNT(*) FROM applications WHERE assigned_to = ? AND type IN ('citizen_help','citizen_complaint') AND completed_at IS NOT NULL) AS closed_cases,
        (SELECT COUNT(*) FROM tasks t JOIN task_assignees a ON a.task_id = t.id
          WHERE a.user_id = ? AND t.status = 'completed') AS completed_tasks`)
      .get(account.id, account.id, account.id, account.id);
    return `Профиль: ${account.display_name}\nДолжность: ${account.role}\nОдобрено документов: ${data.documents}\nАктивных судебных дел: ${data.active_lawsuits}\nЗакрытых обращений: ${data.closed_cases}\nВыполненных поручений: ${data.completed_tasks}`;
  }

  if (commandName === "cases") {
    if (!attorneyRoles.includes(account.role) && !managementRoles.includes(account.role)) {
      throw new Error("Просмотр судебных дел через Discord доступен адвокатам и руководству.");
    }
    const manager = managementRoles.includes(account.role);
    const cases = db.prepare(`SELECT l.id, l.title, l.court, l.status FROM lawsuits l
      WHERE l.status NOT IN ('decided','rejected') ${manager ? "" : "AND l.user_id = ?"}
      ORDER BY l.updated_at DESC, l.id DESC LIMIT 10`).all(...(manager ? [] : [account.id]));
    return cases.length
      ? `Активные судебные дела:\n${cases.map((item) =>
        `#${item.id} · ${item.title} · ${item.court} · ${item.status}`).join("\n")}`
      : "Активных судебных дел нет.";
  }

  if (commandName === "rating") {
    const ranking = buildAttorneyRanking(db, "month").attorneys.slice(0, 5);
    return ranking.length
      ? `Рейтинг адвокатов за 30 дней:\n${ranking.map((item, index) =>
        `${index + 1}. ${item.display_name} — ${item.score} баллов (${item.average_rating.toFixed(1)}/5, отзывов: ${item.review_count})`).join("\n")}`
      : "В рейтинге пока нет адвокатов.";
  }

  if (commandName === "report") {
    if (!managementRoles.includes(account.role)) throw new Error("Краткий отчёт доступен только руководству.");
    const report = buildAnalyticsReport(db, "30");
    return `Краткий отчёт за 30 дней:\nСотрудников активно: ${report.composition.active}\nНовых аккаунтов сотрудников: ${report.composition.newAccounts}\nСудебных дел: ${report.lawsuits.total}\nОбращений граждан: ${report.requests.total} (открыто ${report.requests.open}, закрыто ${report.requests.closed})\nОдобрено документов: ${report.documents.byStatus.approved || 0}\nПовышений: ${report.humanResources.promotions}\nВыговоров: ${report.humanResources.reprimands}`;
  }

  if (commandName === "isk") {
    if (!managementRoles.includes(account.role)) {
      throw new Error("Начислять иски через Discord может только руководство.");
    }
    const targetId = Number(options.lawsuitUserId);
    if (!Number.isSafeInteger(targetId) || targetId < 1) {
      throw new Error("Укажите номер сотрудника в формате `!isk #31`.");
    }
    const target = db.prepare(`SELECT id, display_name, role, status FROM users WHERE id = ?`).get(targetId);
    if (!target) throw new Error(`Сотрудник #${targetId} не найден.`);
    if (target.status !== "active" || target.role === citizenRole) {
      throw new Error(`Сотрудник #${targetId} не является активным сотрудником Коллегии.`);
    }
    db.prepare(`UPDATE users SET manual_lawsuits = manual_lawsuits + 1 WHERE id = ?`).run(targetId);
    const total = db.prepare(`SELECT COALESCE(manual_lawsuits, 0) AS manual,
      (SELECT COUNT(*) FROM lawsuits l JOIN documents d ON d.id = l.document_id
       WHERE l.user_id = users.id AND d.forum_status = 'approved') AS approved
      FROM users WHERE id = ?`).get(targetId);
    return `Сотруднику ${target.display_name} (#${targetId}) добавлен 1 иск. Всего в счётчике: ${Number(total.manual) + Number(total.approved)}.`;
  }

  if (commandName === "warn") {
    if (!managementRoles.includes(account.role)) {
      throw new Error("Снимать взыскания через Discord может только руководство.");
    }
    const reprimandId = Number(options.reprimandId);
    if (!Number.isSafeInteger(reprimandId) || reprimandId < 1) {
      throw new Error("Укажите корректный номер выговора, например `!warn #12`.");
    }
    const reprimand = db.prepare(`SELECT r.id, r.user_id, r.reason, r.revoked_at, target.display_name
      FROM reprimands r JOIN users target ON target.id = r.user_id WHERE r.id = ?`)
      .get(reprimandId);
    if (!reprimand) throw new Error(`Выговор #${reprimandId} не найден.`);
    if (reprimand.revoked_at) throw new Error(`Выговор #${reprimandId} уже снят.`);
    const update = db.prepare(`UPDATE reprimands SET revoked_at = CURRENT_TIMESTAMP,
      revoked_by = ?, revoked_by_name = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(account.id, account.display_name, reprimandId);
    if (update.changes !== 1) throw new Error(`Выговор #${reprimandId} уже обработан.`);
    return `Выговор #${reprimandId} для ${reprimand.display_name} снят. Запись сохранена в кадровом аудите.`;
  }

  if (commandName === "absence") {
    const startDate = String(options.startDate || "");
    const endDate = String(options.endDate || "");
    const reason = String(options.reason || "").trim();
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!validDate(startDate) || !validDate(endDate) || startDate > endDate ||
        reason.length < 4 || reason.length > 1000) {
      throw new Error("Укажите корректные даты и причину отсутствия (от 4 до 1000 символов).");
    }
    const overlap = db.prepare(`SELECT id FROM absence_requests WHERE user_id = ?
      AND status IN ('pending','approved') AND start_date <= ? AND end_date >= ? LIMIT 1`)
      .get(account.id, endDate, startDate);
    if (overlap) throw new Error("На этот период уже подана заявка на отсутствие.");
    db.prepare(`INSERT INTO absence_requests (user_id,start_date,end_date,reason)
      VALUES (?,?,?,?)`).run(account.id, startDate, endDate, reason);
    const warning = await notifyAbsence?.(account, startDate, endDate);
    return `Заявка на отсутствие с ${startDate} по ${endDate} сохранена.${warning ? `\n${warning}` : ""}`;
  }

  if (commandName === "tasks") {
    const manager = managementRoles.includes(account.role);
    const tasks = db.prepare(`SELECT DISTINCT t.id, t.title, t.status, t.due_at FROM tasks t
      LEFT JOIN task_assignees a ON a.task_id = t.id
      WHERE (a.user_id = ? AND t.status NOT IN ('completed','cancelled'))
        ${manager ? "OR t.status = 'review'" : ""}
      ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at LIMIT 10`).all(account.id);
    const content = tasks.length
      ? `${manager ? "Ваши поручения и задачи на проверке:" : "Ваши активные поручения:"}\n${tasks.map((task) =>
        `#${task.id} · ${task.title} · ${task.status}${task.due_at ? ` · срок ${task.due_at}` : ""}`).join("\n")}`
      : "Активных поручений у вас нет.";
    return {
      content,
      taskActions: manager ? tasks.filter((task) => task.status === "review").map(({ id, title }) => ({ id, title })) : []
    };
  }

  if (commandName === "calendar") {
    const events = db.prepare(`SELECT e.title, e.event_type, e.starts_at FROM calendar_events e
      WHERE e.status = 'scheduled' AND datetime(e.starts_at) >= datetime('now') AND (
        e.is_all_staff = 1 OR e.responsible_id = ? OR EXISTS (
          SELECT 1 FROM calendar_event_participants p WHERE p.event_id = e.id AND p.user_id = ?
        )
      ) ORDER BY e.starts_at LIMIT 8`).all(account.id, account.id);
    return events.length
      ? `Ближайшие мероприятия:\n${events.map((item) =>
        `${item.title} · ${item.event_type} · ${item.starts_at}`).join("\n")}`
      : "Ближайших мероприятий для вас нет.";
  }

  throw new Error("Команда портала не распознана.");
}

export function runDiscordPortalAction({ db, discordUserId, action, memberRoleIds = [], roleIds = {} }) {
  const requesterId = String(discordUserId || "");
  if (!/^\d{15,22}$/.test(requesterId)) throw new Error("Discord вернул некорректный ID пользователя.");
  const account = db.prepare("SELECT id, role, status FROM users WHERE discord_id = ?").get(requesterId);
  if (!account || account.status !== "active" || !managementRoles.includes(account.role)) {
    throw new Error("Это действие доступно только руководству с активным аккаунтом портала.");
  }
  const expectedRoleId = roleIds[account.role];
  if (!expectedRoleId || !Array.isArray(memberRoleIds) || !memberRoleIds.includes(expectedRoleId)) {
    throw new Error("Роль Discord не совпадает с активной должностью аккаунта портала.");
  }
  const match = String(action || "").match(/^task-complete:(\d+)$/);
  if (!match) throw new Error("Действие Discord не распознано.");
  const taskId = Number(match[1]);
  const task = db.prepare("SELECT id, status FROM tasks WHERE id = ?").get(taskId);
  if (!task) throw new Error("Поручение не найдено.");
  if (task.status !== "review") throw new Error("Поручение уже рассмотрено или не ожидает проверки.");
  const comment = "Выполнение подтверждено руководством через Discord.";
  db.exec("BEGIN IMMEDIATE");
  try {
    const updated = db.prepare(`UPDATE tasks SET status = 'completed', reviewer_id = ?,
      review_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'review'`)
      .run(account.id, comment, taskId);
    if (updated.changes !== 1) throw new Error("Поручение уже обработано другим руководителем.");
    db.prepare(`INSERT INTO task_history (task_id,actor_id,action,from_status,to_status,comment)
      VALUES (?,?,'status','review','completed',?)`).run(taskId, account.id, comment);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return `Поручение #${taskId} подтверждено как выполненное.`;
}

function validateGoogleSheetsWebAppUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("GOOGLE_SHEETS_WEB_APP_URL должен быть корректным HTTPS-адресом Apps Script.");
  }
  if (url.protocol !== "https:" || url.hostname !== "script.google.com" ||
      !/^\/macros\/s\/[^/]+\/exec\/?$/.test(url.pathname) || url.username || url.password) {
    throw new Error("GOOGLE_SHEETS_WEB_APP_URL должен указывать на HTTPS-развёртывание Google Apps Script.");
  }
  return url.toString();
}

function parseApplicationAttachments(value, { maxFileBytes = 2 * 1024 * 1024, maxTotalBytes = 5 * 1024 * 1024 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) {
    throw new HttpError(400, "Можно приложить не более пяти файлов.");
  }
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
  let totalSize = 0;
  return value.map((file) => {
    if (!file || typeof file !== "object") throw new HttpError(400, "Некорректный файл-вложение.");
    const name = String(file.name || "").replace(/[\\/\u0000-\u001f]/g, "").trim().slice(0, 120);
    const contentType = String(file.type || "").toLowerCase();
    const encoded = String(file.data || "").replace(/^data:[^;]+;base64,/i, "");
    if (!name || !allowedTypes.has(contentType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new HttpError(400, "Допустимы только изображения JPG, PNG, WebP и PDF.");
    }
    const content = Buffer.from(encoded, "base64");
    if (!content.length || content.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
      throw new HttpError(400, "Файл-вложение повреждён или имеет неверный формат.");
    }
    const signatureMatches = contentType === "image/jpeg"
      ? content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
      : contentType === "image/png"
        ? content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : contentType === "image/webp"
          ? content.length >= 12 && content.toString("ascii", 0, 4) === "RIFF" && content.toString("ascii", 8, 12) === "WEBP"
          : content.length >= 5 && content.toString("ascii", 0, 5) === "%PDF-";
    if (!signatureMatches) throw new HttpError(400, "Содержимое файла не соответствует его формату.");
    if (content.length > maxFileBytes) {
      throw new HttpError(413, `Размер одного файла не должен превышать ${Math.floor(maxFileBytes / (1024 * 1024))} МБ.`);
    }
    totalSize += content.length;
    if (totalSize > maxTotalBytes) {
      throw new HttpError(413, `Общий размер вложений не должен превышать ${Math.floor(maxTotalBytes / (1024 * 1024))} МБ.`);
    }
    return { name, contentType, content };
  });
}

function getPhotoZoneGroup(fileName) {
  const stem = fileName
    .replace(/\.(png|jpe?g|webp)$/iu, "")
    .replace(/^\d+/u, "")
    .replace(/\d+$/u, "")
    .toLocaleLowerCase("ru");
  if (stem.includes("лспд")) return { key: "lspd", label: "LSPD" };
  if (stem.includes("федеральной тюрьмы") || stem.includes("боллингброук") || stem.includes("федеральная тюрьма")) {
    return { key: "ft", label: "Федеральная тюрьма" };
  }
  if (stem.includes("фрб") || stem.includes("federal investigation bureau")) return { key: "fib", label: "ФРБ" };
  if (stem.includes("шерифским департаментом") || stem.includes("lssd")) {
    return { key: "lssd", label: "Шерифский департамент (LSSD)" };
  }
  if (stem.includes("национальной гвардией") || stem.includes("(ng)") || stem === "ng") {
    return { key: "ng", label: "Национальная гвардия (NG)" };
  }
  if (stem.includes("экстренной медицинской службой") || stem.includes("(ems)") || stem === "ems") {
    return { key: "ems", label: "Медицинская служба (EMS)" };
  }
  if (stem.includes("мэрии") || stem.includes("мерия")) return { key: "gov", label: "Мэрия" };
  if (stem.includes("аэропорт") || stem.includes("lsia")) return { key: "lsia", label: "Аэропорт (LSIA)" };
  if (stem.includes("зал заседания") || stem.includes("зал суда") || stem.includes("кабинеты суда")) {
    return { key: "court", label: "Суды" };
  }
  return { key: "other", label: "Прочее" };
}

function parseStaffIds(db, value, { required = true, maximum = 100 } = {}) {
  if (!Array.isArray(value) || value.length > maximum || (required && value.length === 0)) {
    throw new HttpError(400, `Укажите от ${required ? 1 : 0} до ${maximum} сотрудников.`);
  }
  const ids = [...new Set(value.map(Number))];
  if (ids.length !== value.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new HttpError(400, "Список сотрудников содержит некорректные или повторяющиеся ID.");
  }
  if (!ids.length) return ids;
  const active = db.prepare(`SELECT id FROM users WHERE status = 'active' AND role <> ?
    AND id IN (${ids.map(() => "?").join(",")})`).all(citizenRole, ...ids);
  if (active.length !== ids.length) {
    throw new HttpError(400, "В списке есть неактивный сотрудник или аккаунт гражданина.");
  }
  return ids;
}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Ожидается JSON-объект.");
  }
  return value;
}

function normalizeDateTime(value, label, { optional = false } = {}) {
  if ((value === undefined || value === null || value === "") && optional) return null;
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${label}: укажите дату и время.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new HttpError(400, `${label}: некорректная дата и время.`);
  return new Date(timestamp).toISOString();
}

function parseStoredJson(value, label) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    throw new Error(`Повреждены сохранённые данные: ${label}.`);
  }
}

const promotionPracticeStages = ["Стажер КА", "Юрист"];

function isCareerPracticeApplication(item) {
  return item?.type === "exam" && promotionPracticeStages.includes(item.stage_role);
}

function careerPracticeSubmitted(item) {
  const data = parseStoredJson(item?.promotion_data_json, "отчёт о повышении");
  return Boolean(data && typeof data === "object" && data.practiceSubmittedAt);
}

function hasCareerLawBundle(data) {
  return Array.isArray(data?.lawTests) &&
    careerLawExamSubjects.every((subject) => data.lawTests.includes(subject));
}

function isLawyerCareerPromotion(item, data = parseStoredJson(item?.promotion_data_json, "отчёт о повышении")) {
  return item?.stage_role === "Юрист" &&
    (Number(item.career_flow) === 1 || data?.careerPathVersion === 2);
}

function findLawyerCareerPromotionApplication(db, userId) {
  const rows = db.prepare(`SELECT * FROM applications
    WHERE user_id = ? AND type = 'exam' AND stage_role = 'Юрист' AND career_flow = 1
      AND status = 'pending'
    ORDER BY id DESC`).all(userId);
  return rows.find((item) => isLawyerCareerPromotion(item)) || null;
}

function interviewLockState(db, userId) {
  const rows = db.prepare(`SELECT id, stage_role, career_flow, promotion_data_json FROM applications
    WHERE user_id = ? AND type = 'exam' AND status = 'pending' AND interview_status = 'ready'`)
    .all(userId);
  const item = rows.find((row) => {
    const data = parseStoredJson(row.promotion_data_json, "отчёт о повышении");
    return isLawyerCareerPromotion(row, data) &&
      !["passed", "failed"].includes(data.interviewDecision);
  });
  return item ? { applicationId: Number(item.id) } : null;
}

function ensureLawyerCareerPromotionApplication(db, user) {
  let item = findLawyerCareerPromotionApplication(db, user.id);
  if (item) {
    const data = parseStoredJson(item.promotion_data_json, "отчёт о повышении");
    if (data.careerPathVersion !== 2) {
      if (data.practiceSubmittedAt) data.legacyPracticeSubmittedAt = data.practiceSubmittedAt;
      delete data.practiceSubmittedAt;
      delete data.offerDeclinedAt;
      data.careerPathVersion = 2;
      db.prepare(`UPDATE applications SET requested_role = ?, interview_status = 'waiting',
        interview_ready_at = NULL, promotion_data_json = ? WHERE id = ?`)
        .run(nextRank["Юрист"], JSON.stringify(data), item.id);
      item = db.prepare("SELECT * FROM applications WHERE id = ?").get(item.id);
    }
    return item;
  }
  const data = { careerPathVersion: 2 };
  const result = db.prepare(`INSERT INTO applications
    (user_id, type, requested_role, stage_role, study_read_at, interview_status,
      interview_ready_at, career_flow, details, promotion_data_json)
    VALUES (?, 'exam', ?, 'Юрист', CURRENT_TIMESTAMP, 'waiting', NULL, 1, ?, ?)`)
    .run(user.id, nextRank["Юрист"],
      "Карьерный путь юриста: ситуационные кейсы, совместные вызовы и обзвон.",
      JSON.stringify(data));
  return db.prepare("SELECT * FROM applications WHERE id = ?").get(Number(result.lastInsertRowid));
}

function getCareerPathProgressRow(db, userId, stageRole) {
  db.prepare(`INSERT OR IGNORE INTO career_path_progress (user_id, stage_role)
    VALUES (?, ?)`).run(userId, stageRole);
  return db.prepare(`SELECT started_at, tutorial_seen_at, laws_reviewed_at,
      interview_prompt_dismissed_at, interview_ready_at
    FROM career_path_progress WHERE user_id = ? AND stage_role = ?`)
    .get(userId, stageRole);
}

function getCareerLawPasses(db, userId, stageRole) {
  return db.prepare(`SELECT subject FROM career_law_exam_passes
    WHERE user_id = ? AND stage_role = ?`).all(userId, stageRole).map((item) => item.subject);
}

function requireNextCareerLawExam(db, user, subject) {
  if (!promotionPracticeStages.includes(user.role)) return;
  const path = getCareerPathProgressRow(db, user.id, user.role);
  if (user.role === "Юрист" && !path.laws_reviewed_at) {
    throw new HttpError(409, "Сначала изучите законодательство и отметьте это в разделе «Мой путь».");
  }
  const passedSubjects = getCareerLawPasses(db, user.id, user.role);
  if (passedSubjects.includes(subject)) {
    throw new HttpError(409, "Этот тест уже сдан на текущей ступени.");
  }
  const nextSubject = careerLawExamSubjects.find((item) => !passedSubjects.includes(item));
  if (subject !== nextSubject) {
    const labels = { ak: "АК", uk: "УК", pk: "ПК" };
    throw new HttpError(409, `Сначала завершите следующий доступный тест: ${labels[nextSubject] || "по порядку"}.`);
  }
}

function requireCareerPracticeUnlocked(db, user) {
  if (!promotionPracticeStages.includes(user.role)) return;
  if (user.role === "Юрист") return;
  const path = getCareerPathProgressRow(db, user.id, user.role);
  const passedSubjects = getCareerLawPasses(db, user.id, user.role);
  if (!careerLawExamSubjects.every((subject) => passedSubjects.includes(subject))) {
    throw new HttpError(409, "Сначала последовательно сдайте тесты по АК, УК и ПК.");
  }
}

function getCareerRpPracticeState(db, userId, stageRole) {
  const caseIds = careerRpPracticeCases.map((item) => item.id);
  const completedCaseIds = db.prepare(`SELECT case_id FROM rp_career_practice_completions
    WHERE user_id = ? AND stage_role = ?`).all(userId, stageRole)
    .map((item) => item.case_id).filter((caseId) => caseIds.includes(caseId));
  return {
    cases: careerRpPracticeCases.map(({ id, title, subtitle }) => ({ id, title, subtitle })),
    caseIds,
    completedCaseIds,
    requiredCount: careerRpPracticeCases.length
  };
}

function getGeneralRpPracticeState(db, userId) {
  const caseIds = rpPracticeCases.map((item) => item.id);
  const completedCaseIds = db.prepare(`SELECT case_id FROM rp_practice_completions
    WHERE user_id = ?`).all(userId)
    .map((item) => item.case_id).filter((caseId) => caseIds.includes(caseId));
  return {
    cases: rpPracticeCases.map((item, index) => ({
      id: item.id,
      title: `Кейс ${String(index + 1).padStart(2, "0")}`,
      subtitle: item.category
    })),
    completedCaseIds,
    requiredCount: caseIds.length
  };
}

function getApprovedCareerJointCallReports(db, userId) {
  return db.prepare(`SELECT r.id AS report_id, r.occurred_at, r.details,
      caller.display_name AS partner_name, attachment.file_name AS image_name
    FROM activity_report_lawyer_participants participant
    JOIN activity_reports r ON r.id = participant.report_id
    JOIN users caller ON caller.id = r.user_id
    JOIN activity_report_attachments attachment ON attachment.report_id = r.id
    WHERE participant.user_id = ? AND r.report_type = 'call' AND r.status = 'approved'
      AND r.lawyer_trip_claimed = 1 AND r.lawyer_trip_status = 'approved'
    ORDER BY r.occurred_at, r.id LIMIT ${careerLawyerJointCallsRequired}`).all(userId);
}

function getPromotionPracticeSlots(db, userId, stageRole, applicationId = 0, { lawBundle = false } = {}) {
  if (lawBundle && stageRole === "Юрист") {
    return getApprovedCareerJointCallReports(db, userId).map((report, index) => ({
      slotNo: index + 1,
      reportId: Number(report.report_id),
      occurredAt: report.occurred_at,
      partnerName: report.partner_name,
      imageName: report.image_name,
      hasImage: true,
      photoUrl: `/api/activity-reports/${Number(report.report_id)}/photo`,
      evidenceUrl: "",
      skipped: false
    }));
  }
  const saved = new Map(db.prepare(`SELECT slot_no, partner_name, evidence_url, image_name,
      image_type, image_content IS NOT NULL AS has_image, skipped, updated_at
    FROM promotion_practice_slots WHERE user_id = ? AND stage_role = ?`)
    .all(userId, stageRole).map((slot) => [Number(slot.slot_no), slot]));
  const slotCount = stageRole === "Стажер КА"
    ? 0
    : lawBundle ? careerLawyerJointCallsRequired : 6;
  return Array.from({ length: slotCount }, (_, index) => {
    const slotNo = index + 1;
    const slot = saved.get(slotNo);
    const hasImage = Boolean(Number(slot?.has_image));
    return {
      slotNo,
      partnerName: slot?.partner_name || "",
      evidenceUrl: slot?.evidence_url || "",
      imageName: slot?.image_name || "",
      hasImage,
      photoUrl: hasImage
        ? applicationId
          ? `/api/applications/${applicationId}/promotion-practice/${slotNo}/image`
          : `/api/promotion-practice/slots/${slotNo}/image`
        : "",
      skipped: Boolean(Number(slot?.skipped)),
      updatedAt: slot?.updated_at || ""
    };
  });
}

function promotionPracticeIsComplete(db, userId, stageRole, { lawBundle = false } = {}) {
  if (!promotionPracticeStages.includes(stageRole)) return false;
  if (stageRole === "Стажер КА") return true;
  if (lawBundle) {
    return getApprovedCareerJointCallReports(db, userId).length >= careerLawyerJointCallsRequired;
  }
  return getPromotionPracticeSlots(db, userId, stageRole, 0, { lawBundle }).every((slot, index) => {
    if (slot.skipped) return index >= 3;
    return slot.partnerName.trim().length >= 2 && slot.hasImage;
  });
}

function getCareerPromotionReadiness(db, item) {
  if (!item || !isCareerPracticeApplication(item) || item.status !== "pending") {
    return { ready: false, reason: "Сначала выполните обязательные условия текущего этапа." };
  }
  const data = parseStoredJson(item.promotion_data_json, "отчёт о повышении");
  const lawBundle = hasCareerLawBundle(data);
  const lawyerCareerPromotion = isLawyerCareerPromotion(item, data);
  if (lawyerCareerPromotion) {
    const generalPractice = getGeneralRpPracticeState(db, item.user_id);
    if (generalPractice.completedCaseIds.length < generalPractice.requiredCount) {
      return {
        ready: false,
        reason: `Пройдите все кейсы «Разбора ситуационных кейсов»: ${generalPractice.completedCaseIds.length}/${generalPractice.requiredCount}.`
      };
    }
    const evidenceCount = getPromotionPracticeSlots(db, item.user_id, item.stage_role, 0, { lawBundle: true })
      .filter((slot) => !slot.skipped && slot.partnerName.trim().length >= 2 &&
        slot.hasImage).length;
    if (evidenceCount < careerLawyerJointCallsRequired) {
      return {
        ready: false,
        reason: `Дождитесь одобрения двух отчётов адвокатов, где вы отмечены участником: ${evidenceCount}/${careerLawyerJointCallsRequired}.`
      };
    }
    if (item.interview_status !== "ready") {
      return { ready: false, reason: "Отметьте готовность к обзвону." };
    }
    return { ready: true, reason: "" };
  }
  const testsPassed = lawBundle
    ? careerLawExamSubjects.every((subject) => db.prepare(`SELECT 1 FROM career_law_exam_passes
        WHERE user_id = ? AND stage_role = ? AND subject = ?`).get(item.user_id, item.stage_role, subject))
    : Boolean(db.prepare(`SELECT passed FROM exam_results WHERE application_id = ?
        ORDER BY id DESC LIMIT 1`).get(item.id)?.passed);
  if (!testsPassed) return { ready: false, reason: "Сначала сдайте обязательные тесты текущего этапа." };
  if (!lawBundle && item.stage_role === "Стажер КА" && !data.lectureAttended) {
    return { ready: false, reason: "Сначала подтвердите прохождение обязательной лекции." };
  }
  if (item.stage_role === "Юрист") {
    if (lawBundle) {
      const practice = getCareerRpPracticeState(db, item.user_id, item.stage_role);
      if (practice.completedCaseIds.length < practice.requiredCount) {
        return { ready: false, reason: `Пройдите три базовых AI Case: ${practice.completedCaseIds.length}/3.` };
      }
      const generalPractice = getGeneralRpPracticeState(db, item.user_id);
      if (generalPractice.completedCaseIds.length < generalPractice.requiredCount) {
        return {
          ready: false,
          reason: `Пройдите все кейсы «Разбора ситуационных кейсов»: ${generalPractice.completedCaseIds.length}/${generalPractice.requiredCount}.`
        };
      }
      const evidenceCount = getPromotionPracticeSlots(db, item.user_id, item.stage_role, 0, { lawBundle })
        .filter((slot) => !slot.skipped && slot.partnerName.trim().length >= 2 &&
          slot.hasImage).length;
      if (evidenceCount < careerLawyerJointCallsRequired) {
        return {
          ready: false,
          reason: `Дождитесь одобрения двух отчётов адвокатов, где вы отмечены участником: ${evidenceCount}/${careerLawyerJointCallsRequired}.`
        };
      }
      return { ready: true, reason: "" };
    }
    const requiredCalls = Number(db.prepare("SELECT lawyer_calls_required FROM promotion_settings WHERE id = 1")
      .get()?.lawyer_calls_required || 0);
    if (Number(item.career_flow) === 1 && item.interview_status !== "ready") {
      return { ready: false, reason: "Сначала заполните отчёт и отметьте готовность к обзвону." };
    }
    if (!requiredCalls || Number(data.completedCalls) < requiredCalls || !data.trialLawsuitReference) {
      return { ready: false, reason: "Сначала выполните норму вызовов и укажите пробный иск." };
    }
  } else if (item.stage_role === "Стажер КА" && lawBundle) {
    const practice = getCareerRpPracticeState(db, item.user_id, item.stage_role);
    if (practice.completedCaseIds.length < practice.requiredCount) {
      return { ready: false, reason: `Пройдите три базовых AI Case: ${practice.completedCaseIds.length}/3.` };
    }
  }
  return { ready: true, reason: "" };
}

const promotionDecreeRoleTitles = Object.freeze({
  "Стажер КА": "Стажёр Коллегии адвокатов",
  "Юрист": "Юрист Коллегии адвокатов",
  "Адвокат": "Адвокат Коллегии адвокатов",
  "Ст.Адвокат": "Старший адвокат Коллегии адвокатов",
  "ЗГКА": "Заместитель главы Коллегии адвокатов"
});
const promotionDecreeRoles = Object.keys(promotionDecreeRoleTitles);

function escapeDecreeText(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ")
    .trim().replaceAll("&", "&amp;").replaceAll("[", "&#91;").replaceAll("]", "&#93;");
}

function buildPromotionDecree(entries, decreeNumber, date = new Date()) {
  const dateParts = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
  }).formatToParts(date);
  const dateValue = (type) => dateParts.find((part) => part.type === type)?.value || "";
  const dateText = `${dateValue("day")} ${dateValue("month")} ${dateValue("year")} г.`;
  const numberText = String(decreeNumber).padStart(3, "0");
  const appointments = entries.map((entry, index) =>
    `[INDENT][SIZE=5][FONT=times new roman]${index + 1}. Повысить ${escapeDecreeText(entry.characterName)} ` +
    `(н.п.${escapeDecreeText(entry.passportId)}) с должности ` +
    `${escapeDecreeText(promotionDecreeRoleTitles[entry.fromRole] || entry.fromRole)} на должность ` +
    `${escapeDecreeText(promotionDecreeRoleTitles[entry.toRole] || entry.toRole)}, ` +
    `Коллегия адвокатов штата Сан-Андреас.[/FONT][/SIZE][/INDENT]`
  );
  return `[TABLE width="100%"]
[TR]
[td][CENTER][SIZE=5][FONT=times new roman]
[ATTACH type="full" alt="Frame 250.png"]3315458[/ATTACH][/FONT][/SIZE]
[B][SIZE=5]ГУБЕРНАТОР ШТАТА САН-АНДРЕАС
[ATTACH type="full" alt="gov.png"]3315459[/ATTACH][/SIZE][/B]
[SIZE=5][FONT=times new roman]
[B]У К А З[/B][/FONT][/SIZE][/CENTER]
[FONT=times new roman][CENTER][SIZE=5]от ${dateText} №${numberText}
г. Лос-Сантос[/SIZE][/CENTER][/FONT]
[INDENT=2][/INDENT]
[INDENT=2][FONT=times new roman][SIZE=5]Руководствуясь своими полномочиями и действующим законодательством штата Сан-Андреас,[/SIZE][/FONT]

[B]п о с т а н о в л я ю:[/B][/INDENT]
${appointments.join("\n")}
[INDENT][SIZE=5][FONT=times new roman]${appointments.length + 1}. Настоящий указ вступает в законную силу с момента его подписания и публикации на портале штата.[/FONT][/SIZE][/INDENT]

[CENTER][ATTACH type="full" alt="gov.png"]3315460[/ATTACH][SIZE=5][FONT=times new roman]
Губернатор штата Сан-Андреас
[B]Haru Ness[/B]
[IMG width="297px" size="272x58"]https://imgur.com/xYtykp4.png[/IMG][/FONT][/SIZE][/CENTER][/td]
[/TR]
[/TABLE]`;
}

function extractLawContext(query, lawFiles) {
  const terms = [...new Set(String(query).toLocaleLowerCase("ru")
    .replace(/[^\p{L}\p{N}\s.]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 2))]
    .slice(0, 25);
  const chunks = [];
  for (const law of lawFiles) {
    const text = law.text.replace(/\r\n?/g, "\n").trim();
    if (!text) continue;
    const paragraphs = text.split(/\n{2,}|\n(?=\s*(?:Статья\s+)?\d+(?:[.)]|\s))/i);
    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index].trim();
      if (paragraph.length < 20) continue;
      const lower = paragraph.toLocaleLowerCase("ru");
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? term.length : 0), 0);
      chunks.push({ law: law.name, text: paragraph.slice(0, 2400), score });
    }
  }
  chunks.sort((left, right) => right.score - left.score);
  const selected = [];
  let length = 0;
  for (const chunk of chunks) {
    if (chunk.score === 0 && selected.length >= 8) break;
    if (length + chunk.text.length > 90000) break;
    selected.push(chunk);
    length += chunk.text.length;
  }
  return selected.map((chunk) => `### ${chunk.law}\n${chunk.text}`).join("\n\n");
}

export function isAssistantRequestAllowed(question) {
  const text = String(question || "").trim();
  return text.length >= 3;
}

export function isAssistantRefusal(answer) {
  const text = String(answer || "").trim();
  if (!text || text.length > 500) return false;
  return /(?:запрос\s+(?:отклонен|отклонён)|^отказ(?:[.\s]|$)|исключительно\s+по\s+законодатель|не могу\s+(?:ответить|помочь)|не консультир)/iu.test(text);
}

export function isLikelyLegalQuestion(question) {
  const text = String(question || "").trim();
  if (!text) return false;
  if (/(?:подать\s+иск|созда(?:й|ть)\s+иск|состав(?:ь|ить)\s+иск|подготов(?:ь|ить)\s+(?:проект\s+)?ис(?:к|ка)|оформ(?:и|ить)\s+иск|иск\s+против|прошу\s+(?:подготовить|составить|создать))/iu.test(text)) return false;
  if (/[?？]/u.test(text)) return true;
  return /(?:\b(?:можно|нужно|надо|обязан|обязаны|имеет\s+ли|имею\s+ли|сколько|какая\s+статья|какой\s+срок|что\s+(?:делать|говорить)|как\s+поступить)\b|задерж|кафнули|кафнул|закрыт\w+\s+террит|адвокат|пк|ук|ак\s+sa)/iu.test(text);
}

function parseGeneratedRpCustomCase(answer, expectedQuestionCount) {
  const jsonText = String(answer || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let generated;
  try {
    generated = JSON.parse(jsonText);
  } catch {
    throw new HttpError(502, "ИИ вернул кейс в некорректном формате. Попробуйте создать его ещё раз.");
  }
  const text = (value, min, max) => typeof value === "string" && value.trim().length >= min &&
    value.trim().length <= max ? value.trim() : "";
  const title = text(generated.title, 3, 100);
  const subtitle = text(generated.subtitle, 3, 240);
  const copName = text(generated.copName, 2, 80);
  const copDept = text(generated.copDept, 1, 16);
  if (!title || !subtitle || !copName || !rpCaseOfficerDepartments.has(copDept) ||
      !Array.isArray(generated.questions) || generated.questions.length !== expectedQuestionCount) {
    throw new HttpError(502, "ИИ вернул неполный кейс. Проверьте запрос и попробуйте ещё раз.");
  }

  const questions = generated.questions.map((question) => {
    const prompt = text(question?.text, 5, 600);
    const explanation = text(question?.explanation, 5, 600);
    if (!prompt || !explanation || !Array.isArray(question.options) || question.options.length !== 3 ||
        !Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex > 2) {
      throw new HttpError(502, "ИИ вернул вопрос с некорректными вариантами ответа.");
    }
    const options = question.options.map((option) => text(option, 2, 300));
    if (options.some((option) => !option)) {
      throw new HttpError(502, "ИИ вернул пустой вариант ответа.");
    }
    return { text: prompt, explanation, options, correctIndex: question.correctIndex };
  });
  const correctPositions = Array.from({ length: questions.length }, (_, index) => index % 3);
  for (let index = correctPositions.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [correctPositions[index], correctPositions[swapIndex]] =
      [correctPositions[swapIndex], correctPositions[index]];
  }
  const randomizedQuestions = questions.map((question, index) => {
    const correctIndex = correctPositions[index];
    const incorrectOptions = question.options.filter((_, optionIndex) =>
      optionIndex !== question.correctIndex);
    for (let optionIndex = incorrectOptions.length - 1; optionIndex > 0; optionIndex -= 1) {
      const swapIndex = randomInt(optionIndex + 1);
      [incorrectOptions[optionIndex], incorrectOptions[swapIndex]] =
        [incorrectOptions[swapIndex], incorrectOptions[optionIndex]];
    }
    const options = new Array(3);
    options[correctIndex] = question.options[question.correctIndex];
    let incorrectIndex = 0;
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      if (optionIndex !== correctIndex) options[optionIndex] = incorrectOptions[incorrectIndex++];
    }
    return { ...question, options, correctIndex };
  });
  const nodes = {};
  randomizedQuestions.forEach((question, index) => {
    const next = index === randomizedQuestions.length - 1 ? "result" : `question-${index + 1}`;
    nodes[`question-${index}`] = {
      copText: question.text,
      choices: question.options.map((option, answerIndex) => ({
        text: option,
        delta: answerIndex === question.correctIndex ? 5 : -4,
        debrief: answerIndex === question.correctIndex
          ? question.explanation
          : `Ответ неверный. ${question.explanation}`,
        next
      }))
    };
  });
  nodes.result = {
    copText: "Разговор завершён. Оцените результат по тому, удалось ли защитить доверителя.",
    isEnd: true,
    won: true
  };
  return {
    title,
    subtitle,
    copName,
    copDept,
    startNode: "question-0",
    nodes,
    questions
  };
}

function presentRpCustomCase(row) {
  let stored;
  try {
    stored = JSON.parse(row.scenario_json);
  } catch {
    throw new Error(`Сохранённый AI Case №${row.id} повреждён.`);
  }
  const { questions, ...scenario } = stored;
  return {
    id: `custom-${Number(row.id)}`,
    ...scenario,
    custom: true,
    ownerId: Number(row.user_id),
    status: row.status,
    completed: Boolean(row.completed_at),
    questions
  };
}

function reviewRpCustomCaseFromDiscord(db, discordUserId, memberRoleIds, roleIds, caseId, status) {
  const reviewer = db.prepare(`SELECT id, role, status, full_gka_access FROM users
    WHERE discord_id = ?`).get(String(discordUserId || ""));
  if (!reviewer || reviewer.status !== "active") {
    throw new Error("Привяжите Discord к активному аккаунту руководства на портале.");
  }
  const expectedRoleId = roleIds[reviewer.role];
  if (!expectedRoleId || !memberRoleIds.includes(expectedRoleId)) {
    throw new Error("Роль Discord не совпадает с должностью аккаунта портала.");
  }
  if (!hasGkaAccess(reviewer)) throw new Error("Публикации AI Case может одобрять только ГКА.");
  if (!["approved", "rejected"].includes(status)) throw new Error("Некорректное решение по AI Case.");
  throw new Error("Публикация личных AI Case отключена; кейс доступен только его автору.");
}

export function parseGeneratedLawsuitDocument(answer) {
  if (typeof answer !== "string") return null;
  const jsonText = answer
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(jsonText.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const allowedTemplates = new Set(["lawsuit-supreme", "lawsuit-federal", "motion-supreme", "motion-federal", "rehabilitation", "appeal"]);
  const stringField = (key) => typeof parsed[key] === "string" ? parsed[key] : "";
  return {
    template: allowedTemplates.has(parsed.template) ? parsed.template : "lawsuit-supreme",
    title: stringField("title").slice(0, 150),
    motionType: stringField("motionType"),
    motionSubject: stringField("motionSubject"),
    claimant: stringField("claimant"),
    claimantId: stringField("claimantId"),
    claimantPhone: stringField("claimantPhone"),
    claimantEmail: stringField("claimantEmail"),
    passport: stringField("passport"),
    repName: stringField("repName"),
    repId: stringField("repId"),
    repLicense: stringField("repLicense"),
    defendant: stringField("defendant"),
    organization: stringField("organization"),
    badge: stringField("badge"),
    facts: stringField("facts"),
    claims: stringField("claims"),
    evidence: stringField("evidence"),
    feeProof: stringField("feeProof"),
    convictionDate: stringField("convictionDate"),
    articles: stringField("articles"),
    feeReady: stringField("feeReady"),
    passportCopy: stringField("passportCopy"),
    otherDocs: stringField("otherDocs"),
    filingDate: stringField("filingDate"),
    signature: stringField("signature")
  };
}

const lawsuitAssistantRedirect = "Система исков предназначена только для подготовки исковых документов. По вопросам законодательства и юридической консультации используйте ИИ-помощник в разделе «Законодательство».";

export function createPortalServer(options = {}) {
  const dbPath = options.dbPath || process.env.DB_PATH || path.join(root, "data", "portal.sqlite");
  const db = options.db || createDatabase(dbPath);
  const permanentlyDeleteUser = createPermanentUserDeletion(db);
  const webhooks = options.discordWebhooks || {};
  webhooks.applications ??= options.webhookApplications ?? process.env.DISCORD_WEBHOOK_APPLICATIONS ?? "";
  webhooks.help ??= options.webhookHelp ?? process.env.DISCORD_WEBHOOK_HELP ?? "";
  webhooks.exams ??= options.webhookExams ?? process.env.DISCORD_WEBHOOK_EXAMS ?? "";
  webhooks.lawyerTest ??= options.webhookLawyerTest ?? process.env.DISCORD_WEBHOOK_LAWYER_TEST ?? "";
  webhooks.attorneyInterview ??= options.webhookAttorneyInterview
    ?? process.env.DISCORD_WEBHOOK_ATTORNEY_INTERVIEW
    ?? "";
  webhooks.careerInterviewReady ??= options.webhookCareerInterviewReady
    ?? process.env.DISCORD_WEBHOOK_CAREER_INTERVIEW_READY
    ?? "";
  webhooks.careerInterviews ??= options.webhookCareerInterviews
    ?? process.env.DISCORD_WEBHOOK_CAREER_INTERVIEWS
    ?? "";
  webhooks.warnings ??= options.webhookWarnings ?? process.env.DISCORD_WEBHOOK_WARNINGS ?? "";
  webhooks.calls ??= options.webhookCalls ?? process.env.DISCORD_WEBHOOK_CALLS ?? "";
  webhooks.bails ??= options.webhookBails ?? process.env.DISCORD_WEBHOOK_BAILS ?? "";
  webhooks.casePublication ??= options.webhookCasePublication ?? process.env.DISCORD_WEBHOOK_CASE_PUBLICATION ?? "";
  webhooks.weeklyReports ??= options.webhookWeeklyReports ?? process.env.DISCORD_WEBHOOK_WEEKLY_REPORTS ?? "";
  webhooks.logs ??= options.webhookLogs ?? process.env.DISCORD_WEBHOOK_LOGS ?? "";
  webhooks.health ??= options.webhookHealth ?? process.env.DISCORD_WEBHOOK_HEALTH ?? "";
  const webhookFetch = options.webhookFetch || globalThis.fetch;
  /**
   * Все исходящие уведомления в Discord идут через один диспетчер:
   * он держит очередь на канал, повторяет отправку при сбоях и умеет
   * отдавать состояние для панели управления.
   */
  const webhookDispatcher = createWebhookDispatcher({
    webhooks,
    fetchImpl: webhookFetch,
    logger: console,
    maxAttempts: options.webhookMaxAttempts ?? 4,
    baseDelayMs: options.webhookBaseDelayMs ?? 400,
    timeoutMs: options.webhookTimeoutMs ?? 8000
  });
  const deliverWebhook = async (url, title, description, fields = [], file = null, payloadOptions = {}) => {
    const result = await webhookDispatcher.deliverToUrl(url, {
      title, description, fields, file, ...payloadOptions
    });
    return result.warning || "";
  };
  const discordFetch = options.discordFetch || options.fetchImpl || globalThis.fetch;
  const discord = {
    clientId: options.discordClientId ?? process.env.DISCORD_CLIENT_ID ?? "",
    clientSecret: options.discordClientSecret ?? process.env.DISCORD_CLIENT_SECRET ?? "",
    redirectUri: options.discordRedirectUri ?? process.env.DISCORD_REDIRECT_URI ?? "",
    botToken: options.discordBotToken ?? process.env.DISCORD_BOT_TOKEN ?? "",
    guildId: options.discordGuildId ?? process.env.DISCORD_GUILD_ID ?? ""
  };
  const discordPresenceProvider = options.discordPresenceProvider || (() => "offline");
  const discordRoleIds = options.discordRoleIds || {
    "Стажер КА": process.env.DISCORD_ROLE_TRAINEE || "",
    "Юрист": process.env.DISCORD_ROLE_LAWYER || "",
    "Адвокат": process.env.DISCORD_ROLE_ATTORNEY || "",
    "Ст.Адвокат": process.env.DISCORD_ROLE_SENIOR_ATTORNEY || "",
    "ЗГКА": process.env.DISCORD_ROLE_DEPUTY_HEAD || "",
    "ГКА": process.env.DISCORD_ROLE_HEAD || "",
    [governorRole]: process.env.DISCORD_ROLE_GOVERNOR || "",
    [citizenRole]: process.env.DISCORD_ROLE_CITIZEN || ""
  };
  const cookieSecure = options.cookieSecure ?? (process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production");
  const googleSheetsUrl = validateGoogleSheetsWebAppUrl(
    options.googleSheetsUrl ?? process.env.GOOGLE_SHEETS_WEB_APP_URL ?? ""
  );
  const googleSheetsToken = String(
    options.googleSheetsToken ?? process.env.GOOGLE_SHEETS_SYNC_TOKEN ?? ""
  );
  const googleSheetsFetch = options.googleSheetsFetch || globalThis.fetch;
  const googleSheetsConfigured = Boolean(googleSheetsUrl && googleSheetsToken.length >= 32);

  /**
   * Простое ограничение частоты запросов в памяти процесса.
   * Нужно, чтобы перебор паролей и массовая регистрация аккаунтов не могли
   * незаметно нагружать сервер. Возвращает 0, если запрос разрешён, иначе —
   * число секунд до сброса окна.
   */
  const rateBuckets = new Map();
  const aiCooldowns = new Map();
  function consumeAiCooldown(userId) {
    const now = Date.now();
    const activeUntil = aiCooldowns.get(userId) || 0;
    if (activeUntil > now) return Math.ceil((activeUntil - now) / 1000);
    aiCooldowns.delete(userId);
    return 0;
  }
  function applyAiCooldown(userId) {
    aiCooldowns.set(userId, Date.now() + 60 * 1000);
  }
  function consumeRateLimit(key, limit, windowMs) {
    const now = Date.now();
    if (rateBuckets.size > 5000) {
      for (const [bucketKey, bucket] of rateBuckets) {
        if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
      }
    }
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return 0;
    }
    bucket.count += 1;
    return bucket.count > limit ? Math.ceil((bucket.resetAt - now) / 1000) : 0;
  }

  const clientAddress = (req) => String(req.socket?.remoteAddress || "local");

  function assertRateLimit(key, limit, windowMs, message) {
    const retryAfter = consumeRateLimit(key, limit, windowMs);
    if (retryAfter) {
      throw new HttpError(429, `${message} Повторите попытку через ${retryAfter} с.`);
    }
  }

  async function syncMonthlyReport(periodValue) {
    if (!googleSheetsConfigured) {
      throw new HttpError(503, "Синхронизация не настроена: проверьте GOOGLE_SHEETS_WEB_APP_URL и GOOGLE_SHEETS_SYNC_TOKEN в .env.");
    }
    const report = buildMonthlyReport(db, validateReportPeriod(periodValue));
    let response;
    try {
      response = await googleSheetsFetch(googleSheetsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: googleSheetsToken, report }),
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      throw new HttpError(502, `Не удалось связаться с Google Sheets: ${error.message}`);
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new HttpError(502, `Google Sheets вернул некорректный ответ (HTTP ${response.status}).`);
    }
    if (!response.ok || result?.ok !== true) {
      throw new HttpError(502, result?.error
        ? `Google Sheets: ${String(result.error).slice(0, 300)}`
        : `Синхронизация с Google Sheets завершилась с HTTP ${response.status}.`);
    }
    return { report, syncedAt: new Date().toISOString() };
  }

  async function discordBotRequest(method, route, body) {
    const response = await discordFetch(`https://discord.com/api/v10${route}`, {
      method,
      headers: {
        authorization: `Bot ${discord.botToken}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (error.code === 50013) {
        throw new Error("Discord отказал в доступе (Missing Permissions). Проверь право «Управлять ролями/никнеймами» и положение роли бота.");
      }
      if (error.code === 50001) {
        throw new Error("Discord не дал боту доступ к серверу. Проверь, что бот добавлен на сервер.");
      }
      throw new Error(`Discord API вернул HTTP ${response.status}${error.code ? ` (${error.code})` : ""}${error.message ? `: ${error.message}` : "."}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async function notifyPortalUser({ userId, type, title, body, href = "", sendDiscord = true }) {
    const inserted = db.prepare(`INSERT INTO portal_notifications
      (user_id, notification_type, title, body, href) VALUES (?, ?, ?, ?, ?)`)
      .run(userId, type, title, body, href);
    const notificationId = Number(inserted.lastInsertRowid);
    const preferences = db.prepare(`SELECT u.discord_id, p.discord_dm_enabled
      FROM users u LEFT JOIN notification_preferences p ON p.user_id = u.id
      WHERE u.id = ?`).get(userId);
    if (!sendDiscord || preferences?.discord_dm_enabled === 0 || !preferences?.discord_id) {
      return { id: notificationId, discordWarning: "" };
    }

    let warning = "";
    if (!discord.botToken) {
      warning = "Discord-бот не настроен на сервере.";
    } else {
      try {
        const channel = await discordBotRequest("POST", "/users/@me/channels", {
          recipient_id: preferences.discord_id
        });
        if (!channel?.id || !/^\d{15,22}$/.test(channel.id)) {
          throw new Error("Discord не вернул канал личных сообщений.");
        }
        await discordBotRequest("POST", `/channels/${channel.id}/messages`, {
          content: `${title}\n${body}`.slice(0, 1900),
          allowed_mentions: { parse: [] }
        });
        db.prepare("UPDATE portal_notifications SET discord_sent_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(notificationId);
      } catch (error) {
        warning = error.message;
      }
    }

    if (warning) {
      db.prepare("UPDATE portal_notifications SET discord_error = ? WHERE id = ?")
        .run(warning.slice(0, 500), notificationId);
      console.error(`Discord notification delivery failed for portal user ${userId}:`, warning);
    }
    return { id: notificationId, discordWarning: warning };
  }

  async function sendPortalDirectMessage(userId, account, avatarUrl, title, description) {
    const preference = db.prepare("SELECT discord_dm_enabled FROM notification_preferences WHERE user_id = ?")
      .get(userId);
    if (preference?.discord_dm_enabled === 0) return "";
    return sendDiscordDirectMessage(account.discord_id, account, avatarUrl, title, description, {
      token: discord.botToken,
      fetchImpl: discordFetch
    });
  }

  async function notifyPortalRoles(targetRoles, payload, excludeUserId = 0) {
    const recipients = db.prepare(`SELECT id FROM users
      WHERE status = 'active' AND role IN (${targetRoles.map(() => "?").join(",")}) AND id != ?`)
      .all(...targetRoles, excludeUserId);
    return Promise.all(recipients.map(({ id }) => notifyPortalUser({ userId: id, ...payload })));
  }

  let promotionDecreeSending = false;
  function getPromotionDecreeCandidates() {
    const state = db.prepare("SELECT first_application_id, next_number FROM promotion_decree_state WHERE id = 1").get();
    const rows = db.prepare(`SELECT a.*, u.display_name
      FROM applications a JOIN users u ON u.id = a.user_id
      WHERE a.id > ? AND (
        a.status = 'approved' OR
        (a.status = 'pending' AND a.type = 'exam' AND a.stage_role = 'Юрист')
      )
        AND NOT EXISTS (
          SELECT 1 FROM promotion_decree_items i WHERE i.application_id = a.id
        )
      ORDER BY a.reviewed_at, a.id`)
      .all(state.first_application_id);
    const admissions = new Map();
    for (const admission of db.prepare(`SELECT user_id, passport_id, promotion_data_json
      FROM applications WHERE type = 'employment' AND status = 'approved'
      ORDER BY reviewed_at DESC, id DESC`).all()) {
      if (!admissions.has(Number(admission.user_id))) admissions.set(Number(admission.user_id), admission);
    }
    const candidates = [];
    for (const item of rows) {
      const promotionData = parseStoredJson(item.promotion_data_json, "отчёт о повышении");
      let fromRole = "";
      if (isLawyerCareerPromotion(item, promotionData) && promotionData.interviewDecision === "passed") {
        fromRole = item.stage_role;
      } else if (isCareerPracticeApplication(item) && careerPracticeSubmitted(item)) {
        fromRole = item.stage_role;
      } else if (item.type === "promotion" && ["Ст.Адвокат", "ЗГКА"].includes(item.requested_role)) {
        fromRole = item.requested_role === "ЗГКА" ? "Ст.Адвокат" : "Адвокат";
      } else {
        continue;
      }
      const admission = admissions.get(Number(item.user_id));
      const admissionData = admission
        ? parseStoredJson(admission.promotion_data_json, "заявка на вступление")
        : {};
      candidates.push({
        applicationId: Number(item.id),
        userId: Number(item.user_id),
        characterName: String(admissionData.gtaName || item.display_name || "").trim(),
        passportId: String(admission?.passport_id || item.passport_id || "").trim(),
        fromRole,
        toRole: item.requested_role || nextRank[item.stage_role],
        approvedForDecree: item.status === "approved",
        reviewedAt: item.reviewed_at || ""
      });
    }
    return { nextNumber: Number(state.next_number), candidates };
  }

  function getPromotionDecreeMembers() {
    const admissions = new Map();
    for (const admission of db.prepare(`SELECT user_id, passport_id, promotion_data_json
      FROM applications WHERE type = 'employment' AND status = 'approved'
      ORDER BY reviewed_at DESC, id DESC`).all()) {
      if (!admissions.has(Number(admission.user_id))) {
        admissions.set(Number(admission.user_id), admission);
      }
    }
    return db.prepare(`SELECT id, display_name, role FROM users
      WHERE status = 'active' AND role IN (${Object.keys(nextRank).map(() => "?").join(",")})
      ORDER BY display_name COLLATE NOCASE`).all(...Object.keys(nextRank)).map((member) => {
      const admission = admissions.get(Number(member.id));
      const admissionData = admission
        ? parseStoredJson(admission.promotion_data_json, "заявка на вступление")
        : {};
      return {
        userId: Number(member.id),
        displayName: member.display_name,
        role: member.role,
        characterName: String(admissionData.gtaName || member.display_name || "").trim(),
        passportId: String(admission?.passport_id || "").trim()
      };
    });
  }

  function resolvePromotionDecreeSelection(rawIds, rawPassports = {}, rawManualEntries = []) {
    if (!Array.isArray(rawIds) || !Array.isArray(rawManualEntries) ||
        rawIds.length + rawManualEntries.length < 1 || rawIds.length + rawManualEntries.length > 100) {
      throw new HttpError(400, "Выберите или добавьте от 1 до 100 сотрудников для указа.");
    }
    const ids = rawIds.map(Number);
    if (ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
      throw new HttpError(400, "Список повышений содержит некорректные или повторяющиеся заявки.");
    }
    if (!rawPassports || typeof rawPassports !== "object" || Array.isArray(rawPassports)) {
      throw new HttpError(400, "Некорректные номера паспортов указа.");
    }
    const available = new Map(getPromotionDecreeCandidates().candidates.map((entry) => [entry.applicationId, entry]));
    const selected = ids.map((id) => {
      const entry = available.get(id);
      if (!entry) throw new HttpError(409, `Повышение по заявке #${id} уже недоступно для указа.`);
      if (!entry.approvedForDecree) {
        throw new HttpError(409, `Повышение по заявке #${id} ещё не одобрено.`);
      }
      const passportId = Object.hasOwn(rawPassports, String(id))
        ? String(rawPassports[String(id)] || "").trim()
        : entry.passportId;
      if (passportId.length > 40) throw new HttpError(400, "Номер паспорта не должен превышать 40 символов.");
      if (!entry.characterName || !passportId) {
        throw new HttpError(409, `Укажите имя персонажа и номер паспорта для заявки #${id}.`);
      }
      return { ...entry, passportId };
    });
    const selectedUsers = new Set(selected.map((entry) => entry.userId));
    if (selectedUsers.size !== selected.length) {
      throw new HttpError(400, "В одном указе нельзя дважды повысить одного сотрудника.");
    }
    const manualUsers = new Set();
    const manual = rawManualEntries.map((rawEntry) => {
      const entry = requireObject(rawEntry);
      const userId = Number(entry.userId);
      if (!Number.isSafeInteger(userId) || userId < 1 || manualUsers.has(userId)) {
        throw new HttpError(400, "Укажите каждого сотрудника в указе только один раз.");
      }
      manualUsers.add(userId);
      const member = db.prepare(`SELECT id FROM users
        WHERE id = ? AND status = 'active' AND role IN (${Object.keys(nextRank).map(() => "?").join(",")})`)
        .get(userId, ...Object.keys(nextRank));
      if (!member) throw new HttpError(409, "Выберите действующего сотрудника Коллегии.");
      const fromRole = String(entry.fromRole || "").trim();
      const toRole = String(entry.toRole || "").trim();
      const fromRoleIndex = promotionDecreeRoles.indexOf(fromRole);
      const toRoleIndex = promotionDecreeRoles.indexOf(toRole);
      if (fromRoleIndex < 0 || toRoleIndex <= fromRoleIndex) {
        throw new HttpError(400, "Выберите повышение на должность выше текущей.");
      }
      const characterName = String(entry.characterName || "").trim();
      const passportId = String(entry.passportId || "").trim();
      if (characterName.length < 2 || characterName.length > 100) {
        throw new HttpError(400, "Имя персонажа должно содержать от 2 до 100 символов.");
      }
      if (!passportId || passportId.length > 40) {
        throw new HttpError(400, "Укажите номер паспорта длиной не более 40 символов.");
      }
      return {
        applicationId: null,
        userId,
        characterName,
        passportId,
        fromRole,
        toRole
      };
    });
    return [...selected.filter((entry) => !manualUsers.has(entry.userId)), ...manual];
  }

  let calendarReminderInProgress = false;
  async function sendDueCalendarReminders(now = Date.now()) {
    if (!discord.botToken) return { sent: 0, configured: false };
    if (calendarReminderInProgress) return { sent: 0, skipped: true };
    calendarReminderInProgress = true;
    let sent = 0;
    try {
      const events = db.prepare(`SELECT id, title, starts_at, responsible_id, is_all_staff
        FROM calendar_events WHERE status = 'scheduled'`).all();
      for (const event of events) {
        const startsAt = Date.parse(event.starts_at);
        const minutesUntil = (startsAt - now) / 60000;
        if (!Number.isFinite(minutesUntil) || minutesUntil <= 0 || minutesUntil > 1440) continue;
        const leadMinutes = minutesUntil <= 60 ? 60 : 1440;
        const recipients = event.is_all_staff
          ? db.prepare(`SELECT id, display_name, discord_id FROM users
              WHERE status = 'active' AND role != ? AND discord_id != ''`).all(citizenRole)
          : db.prepare(`SELECT DISTINCT u.id, u.display_name, u.discord_id FROM users u
              WHERE u.status = 'active' AND u.role != ? AND u.discord_id != '' AND (
                u.id = ? OR EXISTS (SELECT 1 FROM calendar_event_participants p
                  WHERE p.event_id = ? AND p.user_id = u.id)
              )`).all(citizenRole, event.responsible_id, event.id);
        for (const recipient of recipients) {
          if (!/^\d{15,22}$/.test(recipient.discord_id)) continue;
          const preference = db.prepare("SELECT discord_dm_enabled FROM notification_preferences WHERE user_id = ?")
            .get(recipient.id);
          if (preference?.discord_dm_enabled === 0) continue;
          const previous = db.prepare(`SELECT last_attempt_at, sent_at FROM calendar_reminder_deliveries
            WHERE event_id = ? AND user_id = ? AND lead_minutes = ?`)
            .get(event.id, recipient.id, leadMinutes);
          if (previous?.sent_at) continue;
          if (previous && now - Date.parse(previous.last_attempt_at) < 15 * 60 * 1000) continue;
          const attemptedAt = new Date(now).toISOString();
          db.prepare(`INSERT INTO calendar_reminder_deliveries
            (event_id,user_id,lead_minutes,last_attempt_at) VALUES (?,?,?,?)
            ON CONFLICT(event_id,user_id,lead_minutes) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`)
            .run(event.id, recipient.id, leadMinutes, attemptedAt);
          try {
            const channel = await discordBotRequest("POST", "/users/@me/channels", {
              recipient_id: recipient.discord_id
            });
            if (!channel?.id || !/^\d{15,22}$/.test(channel.id)) {
              throw new Error("Discord не вернул канал личных сообщений.");
            }
            const currentMinutes = Math.max(1, Math.ceil(minutesUntil));
            const duration = currentMinutes >= 60
              ? `примерно через ${Math.ceil(currentMinutes / 60)} ч.`
              : `примерно через ${currentMinutes} мин.`;
            await discordBotRequest("POST", `/channels/${channel.id}/messages`, {
              content: `Напоминание о мероприятии Коллегии ${duration}\n**${event.title}**\n${new Date(startsAt).toLocaleString("ru-RU")}`,
              allowed_mentions: { parse: [] }
            });
            db.prepare(`UPDATE calendar_reminder_deliveries SET sent_at = ?
              WHERE event_id = ? AND user_id = ? AND lead_minutes = ?`)
              .run(new Date(now).toISOString(), event.id, recipient.id, leadMinutes);
            sent += 1;
          } catch (error) {
            console.error(`Discord calendar reminder failed for event ${event.id}:`, error.message);
          }
        }
      }
      return { sent, configured: true };
    } finally {
      calendarReminderInProgress = false;
    }
  }

  async function notifyReprimandByDm(target, id, reason, photo, fields) {
    const suppressAttachment = Number(target.id) === governorUserId;
    const preference = db.prepare("SELECT discord_dm_enabled FROM notification_preferences WHERE user_id = ?")
      .get(target.id);
    if (preference?.discord_dm_enabled === 0) return "Личные уведомления Discord выключены в профиле.";
    if (!target.discord_id) return "Discord не привязан: личное уведомление не отправлено.";
    if (!discord.botToken) return "Личное уведомление не отправлено: не настроен DISCORD_BOT_TOKEN.";
    if (!/^\d{15,22}$/.test(target.discord_id)) return "Личное уведомление не отправлено: некорректный Discord ID.";
    try {
      const channel = await discordBotRequest("POST", "/users/@me/channels", {
        recipient_id: target.discord_id
      });
      if (!channel?.id || !/^\d{15,22}$/.test(channel.id)) {
        throw new Error("Discord не вернул канал личных сообщений.");
      }
      const payload = {
        embeds: [{
          title: `⚠️ Выговор №${id}`,
          description: `${target.display_name} получил(а) дисциплинарное взыскание.`,
          color: 15158332,
          timestamp: new Date().toISOString(),
          footer: { text: "Mirror GTA 5 RP · Коллегия адвокатов" },
          fields: fields.slice(0, 25).map((field) => ({
            name: String(field.name).slice(0, 256),
            value: String(suppressAttachment && field.name === "📷 Фото"
              ? "Сохранено в кадровом аудите; файл в ЛС не отправляется."
              : field.value || "—").slice(0, 1024),
            inline: Boolean(field.inline)
          })),
          ...(suppressAttachment ? {} : { image: { url: `attachment://${photo.name}` } })
        }],
        allowed_mentions: { parse: [] }
      };
      const request = {
        method: "POST",
        headers: { authorization: `Bot ${discord.botToken}` },
        signal: AbortSignal.timeout(8000)
      };
      if (suppressAttachment) {
        request.headers["content-type"] = "application/json";
        request.body = JSON.stringify(payload);
      } else {
        const form = new FormData();
        form.set("payload_json", JSON.stringify(payload));
        form.set("files[0]", new Blob([photo.content], { type: photo.contentType }), photo.name);
        request.body = form;
      }
      const response = await discordFetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
        ...request
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || `Discord API ответил HTTP ${response.status}.`);
      }
      return suppressAttachment
        ? "Личное уведомление отправлено без файла; доказательство сохранено в кадровом аудите."
        : "";
    } catch (error) {
      console.error("Discord reprimand DM failed:", error.message);
      return `Выговор сохранён, но личное сообщение Discord не отправлено: ${error.message}`;
    }
  }

  async function syncDiscordMember(memberId) {
    const member = db.prepare("SELECT * FROM users WHERE id = ?").get(memberId);
    if (!member?.discord_id) return { syncError: "", nicknameWarning: "" };
    if (!discord.botToken || !discord.guildId) {
      const warning = "Discord привязан, но для выдачи ролей не настроены DISCORD_BOT_TOKEN и DISCORD_GUILD_ID.";
      db.prepare("UPDATE users SET discord_sync_error = ?, discord_nickname_error = '' WHERE id = ?").run(warning, memberId);
      return { syncError: warning, nicknameWarning: "" };
    }
    if (!/^\d{15,22}$/.test(discord.guildId) || !/^\d{15,22}$/.test(member.discord_id)) {
      const warning = "Discord не синхронизирован: проверьте Discord Guild ID и ID аккаунта.";
      db.prepare("UPDATE users SET discord_sync_error = ?, discord_nickname_error = '' WHERE id = ?").run(warning, memberId);
      return { syncError: warning, nicknameWarning: "" };
    }
    const prefix = member.status === "pending" ? "Заявка"
      : member.status === "suspended" ? "Доступ закрыт"
        : member.role;
    const nickname = Array.from(`[${prefix}] ${member.display_name}`).slice(0, 32).join("");
    const targetRole = member.status === "active" ? discordRoleIds[member.role] : "";
    if (member.status === "active" && (!targetRole || !/^\d{15,22}$/.test(targetRole))) {
      const warning = `Discord не синхронизирован: не задан корректный Discord role ID для роли «${member.role}».`;
      db.prepare("UPDATE users SET discord_sync_error = ?, discord_nickname_error = '' WHERE id = ?").run(warning, memberId);
      return { syncError: warning, nicknameWarning: "" };
    }
    const route = `/guilds/${discord.guildId}/members/${member.discord_id}`;
    let discordMember;
    try {
      discordMember = await discordBotRequest("GET", route);
    } catch (error) {
      const warning = `Не удалось прочитать участника Discord: ${error.message}`;
      db.prepare("UPDATE users SET discord_sync_error = ?, discord_nickname_error = '' WHERE id = ?").run(warning, memberId);
      console.error("Discord role synchronization failed:", warning);
      return { syncError: warning, nicknameWarning: "" };
    }
    if (!Array.isArray(discordMember?.roles)) {
      const warning = "Discord вернул некорректный список ролей участника.";
      db.prepare("UPDATE users SET discord_sync_error = ?, discord_nickname_error = '' WHERE id = ?").run(warning, memberId);
      return { syncError: warning, nicknameWarning: "" };
    }

    const failures = [];
    const attempt = async (label, operation) => {
      try {
        await operation();
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
      }
    };
    let nicknameWarning = "";
    try {
      await discordBotRequest("PATCH", route, { nick: nickname });
    } catch (error) {
      nicknameWarning = `Не удалось изменить ник: ${error.message}`;
      console.warn("Discord nickname synchronization warning:", nicknameWarning);
    }
    const managedRoleIds = [...new Set(Object.values(discordRoleIds).filter((id) => /^\d{15,22}$/.test(id)))];
    for (const roleId of managedRoleIds) {
      if (roleId !== targetRole && discordMember.roles.includes(roleId)) {
        await attempt("не удалось снять старую роль", () => discordBotRequest("DELETE", `${route}/roles/${roleId}`));
      }
    }
    if (targetRole && !discordMember.roles.includes(targetRole)) {
      await attempt(`не удалось выдать роль «${member.role}»`, () => discordBotRequest("PUT", `${route}/roles/${targetRole}`));
    }
    const syncError = failures.length ? `Не удалось синхронизировать Discord: ${failures.join(" · ")}` : "";
    db.prepare("UPDATE users SET discord_sync_error = ?, discord_nickname_error = ? WHERE id = ?")
      .run(syncError, nicknameWarning, memberId);
    if (syncError) console.error("Discord role synchronization failed:", syncError);
    return { syncError, nicknameWarning };
  }

  async function revokeDiscordAccess(member) {
    if (!member.discord_id) return "";
    if (!discord.botToken || !discord.guildId) {
      return "Аккаунт удалён, но роли Discord не сняты: бот или сервер не настроены.";
    }
    if (!/^\d{15,22}$/.test(discord.guildId) || !/^\d{15,22}$/.test(member.discord_id)) {
      return "Аккаунт удалён, но роли Discord не сняты: некорректный ID сервера или пользователя.";
    }

    const route = `/guilds/${discord.guildId}/members/${member.discord_id}`;
    let discordMember;
    try {
      discordMember = await discordBotRequest("GET", route);
    } catch (error) {
      return `Аккаунт удалён, но не удалось снять роли Discord: ${error.message}`;
    }
    if (!Array.isArray(discordMember?.roles)) {
      return "Аккаунт удалён, но Discord вернул некорректный список ролей.";
    }

    const warnings = [];
    const managedRoleIds = [...new Set(Object.values(discordRoleIds)
      .filter((id) => /^\d{15,22}$/.test(id)))];
    for (const roleId of managedRoleIds) {
      if (!discordMember.roles.includes(roleId)) continue;
      try {
        await discordBotRequest("DELETE", `${route}/roles/${roleId}`);
      } catch (error) {
        warnings.push(error.message);
      }
    }
    try {
      await discordBotRequest("PATCH", route, { nick: member.display_name });
    } catch (error) {
      warnings.push(`не удалось очистить ник: ${error.message}`);
    }
    return warnings.length ? `Аккаунт удалён, но синхронизация Discord не полностью выполнена: ${warnings.join(" · ")}` : "";
  }

  const canAccessTask = (user, taskId) => managementRoles.includes(user.role) ||
    Boolean(db.prepare(`SELECT 1 FROM tasks t WHERE t.id = ? AND (
      t.created_by = ? OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?)
    )`).get(taskId, user.id, user.id));
  const taskPayload = (task) => ({
    ...task,
    assignees: db.prepare(`SELECT u.id, u.display_name, u.role FROM task_assignees a
      JOIN users u ON u.id = a.user_id WHERE a.task_id = ? ORDER BY u.display_name COLLATE NOCASE`).all(task.id),
    attachments: db.prepare(`SELECT id, file_name, content_type, length(content) AS size, uploaded_by, created_at
      FROM task_attachments WHERE task_id = ? ORDER BY id`).all(task.id)
  });
  const taskListPayload = (tasks) => {
    if (!tasks.length) return [];
    const ids = tasks.map((task) => task.id);
    const placeholders = ids.map(() => "?").join(",");
    const assignees = new Map(ids.map((id) => [id, []]));
    const attachments = new Map(ids.map((id) => [id, []]));
    for (const item of db.prepare(`SELECT a.task_id,u.id,u.display_name,u.role FROM task_assignees a
      JOIN users u ON u.id = a.user_id WHERE a.task_id IN (${placeholders})
      ORDER BY u.display_name COLLATE NOCASE`).all(...ids)) {
      assignees.get(item.task_id).push({ id: item.id, display_name: item.display_name, role: item.role });
    }
    for (const item of db.prepare(`SELECT id,task_id,file_name,content_type,length(content) AS size,uploaded_by,created_at
      FROM task_attachments WHERE task_id IN (${placeholders}) ORDER BY id`).all(...ids)) {
      const { task_id: taskId, ...attachment } = item;
      attachments.get(taskId).push(attachment);
    }
    return tasks.map((task) => ({
      ...task,
      assignees: assignees.get(task.id),
      attachments: attachments.get(task.id)
    }));
  };
  const canAccessCalendarEvent = (user, eventId) => managementRoles.includes(user.role) ||
    Boolean(db.prepare(`SELECT 1 FROM calendar_events e WHERE e.id = ? AND (
      e.is_all_staff = 1 OR e.created_by = ? OR e.responsible_id = ? OR EXISTS (
        SELECT 1 FROM calendar_event_participants p WHERE p.event_id = e.id AND p.user_id = ?
      )
    )`).get(eventId, user.id, user.id, user.id));
  const calendarEventPayload = (event) => ({
    ...event,
    participants: db.prepare(`SELECT u.id, u.display_name, u.role FROM calendar_event_participants p
      JOIN users u ON u.id = p.user_id WHERE p.event_id = ? ORDER BY u.display_name COLLATE NOCASE`).all(event.id)
  });
  const calendarEventListPayload = (events) => {
    if (!events.length) return [];
    const ids = events.map((event) => event.id);
    const placeholders = ids.map(() => "?").join(",");
    const participants = new Map(ids.map((id) => [id, []]));
    for (const item of db.prepare(`SELECT p.event_id,u.id,u.display_name,u.role FROM calendar_event_participants p
      JOIN users u ON u.id = p.user_id WHERE p.event_id IN (${placeholders})
      ORDER BY u.display_name COLLATE NOCASE`).all(...ids)) {
      participants.get(item.event_id).push({ id: item.id, display_name: item.display_name, role: item.role });
    }
    return events.map((event) => ({ ...event, participants: participants.get(event.id) }));
  };

  const server = createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.discordapp.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const pathname = requestUrl.pathname;
      const maintenanceMode = db.prepare("SELECT value FROM portal_settings WHERE key = 'maintenance_mode'").get()?.value === "on";
      if (maintenanceMode && !(pathname === "/api/health" && req.method === "GET")) {
        res.writeHead(503, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": "300"
        });
        return res.end(maintenancePage);
      }

      if (pathname === "/api/discord/callback" && req.method === "GET") {
        let targetUserId = 0;
        try {
          if (!discord.clientId || !discord.clientSecret || !discord.redirectUri) {
            throw new HttpError(503, "Discord OAuth не настроен.");
          }
          const state = String(requestUrl.searchParams.get("state") || "");
          const code = String(requestUrl.searchParams.get("code") || "");
          const session = getSession(db, req);
          const stateRecord = state && db.prepare("SELECT * FROM discord_link_states WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?")
            .get(hashToken(state), Date.now());
          if (!stateRecord || !session || session.user_id !== stateRecord.user_id || !code) {
            throw new HttpError(400, "Ссылка Discord истекла или сессия портала изменилась. Начните привязку заново.");
          }
          targetUserId = stateRecord.user_id;
          const tokenResponse = await discordFetch("https://discord.com/api/v10/oauth2/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: discord.clientId,
              client_secret: discord.clientSecret,
              grant_type: "authorization_code",
              code,
              redirect_uri: discord.redirectUri
            }),
            signal: AbortSignal.timeout(8000)
          });
          if (!tokenResponse.ok) throw new HttpError(502, `Discord OAuth не выдал токен (HTTP ${tokenResponse.status}).`);
          const token = await tokenResponse.json();
          if (!token.access_token) throw new HttpError(502, "Discord OAuth вернул пустой токен.");
          const identityResponse = await discordFetch("https://discord.com/api/v10/users/@me", {
            headers: { authorization: `Bearer ${token.access_token}` },
            signal: AbortSignal.timeout(8000)
          });
          if (!identityResponse.ok) throw new HttpError(502, `Не удалось получить профиль Discord (HTTP ${identityResponse.status}).`);
          const identity = await identityResponse.json();
          if (!/^\d{15,22}$/.test(String(identity.id || "")) || !identity.username) {
            throw new HttpError(502, "Discord вернул некорректный профиль.");
          }
          const existingLink = db.prepare("SELECT id FROM users WHERE discord_id = ?").get(String(identity.id));
          if (existingLink && existingLink.id !== targetUserId) {
            throw new HttpError(409, "Этот Discord уже привязан к другому аккаунту портала.");
          }
          const targetAccount = db.prepare("SELECT id, discord_id FROM users WHERE id = ?").get(targetUserId);
          if (targetAccount?.discord_id && targetAccount.discord_id !== String(identity.id)) {
            throw new HttpError(409, "К аккаунту уже привязан другой Discord. Сменить привязку может только ГКА.");
          }
          const avatarUrl = identity.avatar
            ? `https://cdn.discordapp.com/avatars/${identity.id}/${identity.avatar}.png?size=128`
            : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(identity.id) >> 22n) % 6n)}.png`;
          db.prepare(`UPDATE users SET discord_id = ?, discord_username = ?, discord_avatar_url = ?,
            discord_linked_at = COALESCE(discord_linked_at, CURRENT_TIMESTAMP),
            discord_sync_error = '', discord_nickname_error = '' WHERE id = ?`)
            .run(String(identity.id), String(identity.username).slice(0, 100), avatarUrl, targetUserId);
          const consumed = db.prepare("UPDATE discord_link_states SET used_at = CURRENT_TIMESTAMP WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?")
            .run(hashToken(state), Date.now());
          if (consumed.changes !== 1) throw new HttpError(400, "Ссылка Discord уже использована.");
          await syncDiscordMember(targetUserId);
          const user = publicUser(db, targetUserId);
          const welcomeWarning = await sendPortalDirectMessage(targetUserId, user, avatarUrl,
            "Добро пожаловать в Коллегию!",
            `Привет, ${user.display_name}! Ваш Discord подключён к аккаунту портала Коллегии адвокатов. Теперь вы можете получать личные уведомления бота. Настройки сообщений доступны в профиле.`);
          if (welcomeWarning) console.error("Discord link welcome DM failed:", welcomeWarning);
          await deliverWebhook(webhooks.logs, "Discord привязан к аккаунту", `${user.display_name} (${user.role}) привязал Discord ${identity.username}.`);
          res.statusCode = 303;
          res.setHeader("location", "/?discord=linked");
          return res.end();
        } catch (error) {
          if (targetUserId) db.prepare("UPDATE users SET discord_sync_error = ? WHERE id = ?")
            .run(error.message, targetUserId);
          console.error("Discord OAuth callback failed:", error.message);
          res.statusCode = 303;
          res.setHeader("location", "/?discord=error");
          return res.end();
        }
      }

      if (pathname.startsWith("/api/")) {
        if (pathname === "/api/frontend/loader" && req.method === "GET") {
          const loader = await readFile(path.join(root, "web", "js", "loader.js"));
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "content-length": loader.length,
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff"
          });
          res.end(loader);
          return;
        }

        if (pathname === "/api/frontend/app-part" && req.method === "GET") {
          const partValue = requestUrl.searchParams.get("part");
          if (!/^(0|[1-9]\d*)$/.test(partValue || "")) {
            throw new HttpError(400, "Некорректный номер части приложения.");
          }
          const appSource = await readFile(path.join(root, "web", "js", "app.js"));
          const partIndex = Number(partValue);
          const partCount = Math.ceil(appSource.length / frontendAssetPartSize);
          if (!Number.isSafeInteger(partIndex) || partIndex >= partCount) {
            throw new HttpError(404, "Часть приложения не найдена.");
          }
          const start = partIndex * frontendAssetPartSize;
          const part = appSource.subarray(start, Math.min(start + frontendAssetPartSize, appSource.length));
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": part.length,
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
            "x-asset-part-count": String(partCount),
            "x-asset-total-length": String(appSource.length)
          });
          res.end(part);
          return;
        }

        const frontendModuleMatch = pathname.match(/^\/api\/frontend\/module\/(core\/dom|data\/config|data\/rp-practice|data\/rp-interviews|data\/rp-interviews-extra)\.js$/);
        if (frontendModuleMatch && req.method === "GET") {
          const modulePath = path.join(root, "web", "js", `${frontendModuleMatch[1]}.js`);
          const moduleSource = await readFile(modulePath);
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "content-length": moduleSource.length,
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff"
          });
          res.end(moduleSource);
          return;
        }

        if (pathname === "/api/health" && req.method === "GET") {
          return sendJson(res, 200, {
            ok: true,
            apiVersion: 4,
            maintenance: maintenanceMode,
            aiConfigured: Boolean(String(options.geminiApiKey ?? process.env.GEMINI_API_KEY ?? "").trim())
          });
        }

        if (pathname === "/api/auth/register" && req.method === "POST") {
          assertRateLimit(`register:${clientAddress(req)}`, 30, 60 * 60 * 1000,
            "Слишком много регистраций с этого адреса.");
          const body = await readJson(req);
          const username = String(body.username || "").trim().toLowerCase();
          const displayName = String(body.displayName || "").trim();
          const firstName = String(body.firstName || "").trim();
          const lastName = String(body.lastName || "").trim();
          const email = String(body.email || "").trim().slice(0, 160);
          const password = String(body.password || "");
          const accountType = String(body.accountType || "staff");
          if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, "Логин: от 3 до 32 символов, латиница, цифры, точка, дефис или подчёркивание.");
          if (displayName.length < 2 || displayName.length > 80) throw new HttpError(400, "Укажите игровое имя длиной от 2 до 80 символов.");
          if (firstName || lastName) {
            if (!/^[A-Za-zА-Яа-яЁё]{2,40}$/.test(firstName) || !/^[A-Za-zА-Яа-яЁё]{2,40}$/.test(lastName)) {
              throw new HttpError(400, "При регистрации обязательно укажите Имя и Фамилия отдельными полями.");
            }
          }
          if (password.length < 12 || password.length > 128) throw new HttpError(400, "Пароль должен содержать от 12 до 128 символов.");
          if (!["staff", "citizen"].includes(accountType)) throw new HttpError(400, "Выберите регистрацию гражданина или сотрудника.");
          const salt = randomBytes(16);
          const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
          const role = accountType === "citizen" ? citizenRole : roles[0];
          const status = accountType === "citizen" ? "active" : "pending";
          let result;
          try {
            result = db.prepare("INSERT INTO users (username, password_hash, display_name, email, role, status) VALUES (?, ?, ?, ?, ?, ?)")
              .run(username, `scrypt$${salt.toString("base64")}$${Buffer.from(key).toString("base64")}`, displayName, email, role, status);
          } catch (error) {
            if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "Этот логин уже занят.");
            throw error;
          }
          const session = createSession(db, Number(result.lastInsertRowid));
          setSessionCookie(res, session.token, cookieSecure);
          if (accountType === "staff") {
            const applicant = publicUser(db, Number(result.lastInsertRowid));
            const webhookWarning = await deliverWebhook(webhooks.applications, "Новая заявка на вступление",
              `${applicant.display_name} зарегистрировался и ожидает решения ГКА.`,
              [
                { name: "Участник", value: applicant.display_name, inline: true },
                { name: "Логин портала", value: applicant.username, inline: true },
                { name: "Статус", value: "Ожидает принятия в состав", inline: true }
              ]);
            return sendJson(res, 201, {
              user: cleanUser(applicant),
              csrfToken: session.csrf,
              webhookWarning
            });
          }
          return sendJson(res, 201, { user: cleanUser(publicUser(db, Number(result.lastInsertRowid))), csrfToken: session.csrf });
        }

        if (pathname === "/api/auth/reset-password" && req.method === "POST") {
          assertRateLimit(`reset:${clientAddress(req)}`, 15, 60 * 60 * 1000,
            "Слишком много попыток восстановления пароля.");
          const body = await readJson(req);
          const username = String(body.username || "").trim().toLowerCase();
          const code = String(body.code || "").trim();
          const password = String(body.password || "");
          if (!/^[a-z0-9._-]{3,32}$/.test(username) || code.length < 20 || code.length > 100) {
            throw new HttpError(400, "Укажите логин и действующий код восстановления от руководителя.");
          }
          if (password.length < 12 || password.length > 128) {
            throw new HttpError(400, "Пароль должен содержать от 12 до 128 символов.");
          }
          const reset = db.prepare(`SELECT r.token_hash, r.user_id FROM password_resets r
            JOIN users u ON u.id = r.user_id
            WHERE u.username = ? AND r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?`)
            .get(username, hashToken(code), Date.now());
          if (!reset) throw new HttpError(400, "Код восстановления неверен, уже использован или истёк.");
          const salt = randomBytes(16);
          const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
          db.exec("BEGIN IMMEDIATE");
          try {
            const consumed = db.prepare("UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
              .run(reset.token_hash, Date.now());
            if (consumed.changes !== 1) throw new HttpError(400, "Код восстановления уже использован или истёк.");
            db.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
              .run(`scrypt$${salt.toString("base64")}$${Buffer.from(key).toString("base64")}`, reset.user_id);
            db.prepare("DELETE FROM sessions WHERE user_id = ?").run(reset.user_id);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          return sendJson(res, 200, { ok: true });
        }

        if (pathname === "/api/auth/login" && req.method === "POST") {
          const body = await readJson(req);
          const username = String(body.username || "").trim().toLowerCase();
          const password = String(body.password || "");
          assertRateLimit(`login:${clientAddress(req)}:${username}`, 40, 5 * 60 * 1000,
            "Слишком много попыток входа. Подождите немного.");
          const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
          let valid = false;
          if (user && user.password_hash.startsWith("scrypt$")) {
            const [, saltBase64, keyBase64] = user.password_hash.split("$");
            const expected = Buffer.from(keyBase64, "base64");
            const actual = Buffer.from(await scrypt(password, Buffer.from(saltBase64, "base64"), expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
            valid = safeEqual(actual, expected);
          }
          if (!valid) throw new HttpError(401, "Неверный логин или пароль.");
          db.prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
          const session = createSession(db, user.id);
          setSessionCookie(res, session.token, cookieSecure);
          return sendJson(res, 200, {
            user: cleanUser(publicUser(db, user.id)),
            csrfToken: session.csrf,
            interviewLock: interviewLockState(db, user.id)
          });
        }

        if (pathname === "/api/auth/me" && req.method === "GET") {
          const session = getSession(db, req);
          return sendJson(res, 200, session
            ? {
              user: cleanUser(publicUser(db, session.user_id)),
              csrfToken: session.csrf_token,
              interviewLock: interviewLockState(db, session.user_id)
            }
            : { user: null, csrfToken: null });
        }

        if (pathname === "/api/auth/logout" && req.method === "POST") {
          const session = getSession(db, req);
          if (session) {
            assertCsrf(req, session);
            db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.token_hash);
          }
          clearSessionCookie(res, cookieSecure);
          return sendJson(res, 200, { ok: true });
        }

        const session = getSession(db, req);
        if (!session) throw new HttpError(401, "Войдите в аккаунт, чтобы продолжить.");
        const user = publicUser(db, session.user_id);
        if (req.method !== "GET") assertCsrf(req, session);
        if (user.status !== "active") throw new HttpError(403, "Аккаунт ожидает одобрения ГКА или приостановлен.");
        if (interviewLockState(db, user.id)) {
          throw new HttpError(423, "Вы проходите обзвон. Портал временно недоступен до решения ГКА или ЗГКА.");
        }

        if (pathname === "/api/ai-assistant" && req.method === "POST") {
          const geminiKey = String(options.geminiApiKey ?? process.env.GEMINI_API_KEY ?? "").trim();
          if (!geminiKey) throw new HttpError(503, "ИИ-сервис не настроен. Добавьте ключ сервера.");
          const body = await readJson(req);
          const question = String(body.question || "").trim();
          const mode = ["laws", "lawsuit", "answer"].includes(body.mode) ? body.mode : "answer";
          if (question.length < 3) throw new HttpError(400, "Опишите ситуацию подробнее.");
          if (question.length > 8000) throw new HttpError(400, "Запрос слишком длинный. Укажите не более 8000 символов.");
          if (!isAssistantRequestAllowed(question)) throw new HttpError(400, "Опишите ситуацию подробнее.");
          const aiCooldownSeconds = consumeAiCooldown(session.user_id);
          if (aiCooldownSeconds) throw new HttpError(429, `Повторный запрос доступен через ${aiCooldownSeconds} с.`);
          if (mode === "lawsuit" && isLikelyLegalQuestion(question)) {
            applyAiCooldown(session.user_id);
            return sendJson(res, 200, {
              answer: lawsuitAssistantRedirect,
              mode,
              document: null,
              cooldownSeconds: 60
            });
          }
          const lawFiles = [];
          const lawDir = path.join(root, "data", "laws");
          const files = await readdir(lawDir, { withFileTypes: true });
          for (const file of files) {
            if (!file.isFile() || path.extname(file.name).toLowerCase() !== ".txt") continue;
            try {
              lawFiles.push({
                name: file.name,
                text: normalizeLawText(await readFile(path.join(lawDir, file.name), "utf8"))
              });
            } catch {}
          }
          const context = lawFiles
            .sort((left, right) => left.name.localeCompare(right.name, "ru"))
            .map((law) => `### ПОЛНЫЙ ТЕКСТ: ${law.name}\n${law.text}`)
            .join("\n\n");
          const systemInstruction = mode === "lawsuit"
            ? `Ты — помощник только для составления исковых документов в системе исков Коллегии Адвокатов.
Не отвечай на юридические вопросы и не давай консультаций, объяснений законов, статей или действий. Если пользователь задаёт вопрос или просит консультацию, не анализируй и не отвечай по существу: верни только эту фразу без JSON и дополнительных пояснений: «${lawsuitAssistantRedirect}»
Если пользователь описывает обстоятельства дела, воспринимай это как просьбу подготовить проект иска. Составляй документ только по предоставленным фактам. Используй исключительно приложенную законодательную базу; не придумывай факты, статьи, части и пункты. Неизвестные данные оставляй пустыми. Если точной нормы нет, укажи это в правовой оценке без выдуманной ссылки.
Для запроса на подготовку документа верни СТРОГО JSON без Markdown и пояснений. JSON должен содержать: template (lawsuit-supreme, lawsuit-federal, motion-supreme, motion-federal, rehabilitation или appeal), title, motionType, motionSubject, claimant, claimantId, claimantPhone, claimantEmail, passport, repName, repId, repLicense, defendant, organization, badge, facts, claims, evidence, feeProof, convictionDate, articles, feeReady, passportCopy, otherDocs, filingDate, signature. Определи подходящий шаблон по ситуации: иск — lawsuit, ходатайство или возражение — motion, реабилитация — rehabilitation, апелляция — appeal. Для Верховного суда используй supreme, для окружного — federal. В поле facts напиши официальный текст описательной части от первого лица заявителя/истца («Я…»), затем правовую оценку с проверенными ссылками на нормы и связью каждой нормы с фактами. Различай Уголовный, Процессуальный и Административный кодексы. В поле articles перечисли только подтверждённые базой нормы и их названия. В поле claims укажи только требования к суду, каждое с новой строки. Тайм-коды сохраняй в evidence или facts.`
            : `Ты — юридический консультант Коллегии Адвокатов штата San Andreas (сервер Mirror).
Отвечай только на вопросы о законодательстве штата San Andreas и процессуальных действиях. На оффтоп ответь кратким отказом.
Разговорные RP-формулировки типа «кавулили», «задержали», «под статью», «что говорить» считай юридическим описанием ситуации.
Перед ответом последовательно проверь факты, определения, полномочия, условия, исключения и порядок действий по всей приложенной базе, в том числе по смежным законам. Сопоставляй нормы разных актов и объясняй, как они применяются к описанным фактам. Различай право, обязанность, запрет и условие; из наличия права не выводи автоматически обязанность, а из общего описания ситуации — отсутствующее в законе требование.
Если термин или предмет прямо не назван, найди его определение и проверь, относится ли он к общей категории. Например, если в вопросе названа катана, а такого слова в законе нет, сопоставь предмет с определением холодного оружия и перечисленными в статье 1 пункте 3 Закона об оружии клинками, саблями и мечами. Обозначь такую классификацию как вывод по признакам, а не как прямое упоминание катаны; отдельно проверь норму, устанавливающую конкретное ограничение или ответственность.
При вопросах о доставлении в Федеральную тюрьму различай помещение в СИЗО и перевод в Федеральную тюрьму. Сопоставляй пункты 7.10–7.12 Закона о пенитенциарных учреждениях, пункт 6.4 Процессуального кодекса и статью 38 Закона о закрытых и охраняемых территориях: проверь основание и полномочия, а также завершена ли передача уполномоченному сотруднику и сообщены ли ему необходимые сведения. Не считай один факт прибытия доказательством завершенной передачи. Не утверждай, что доставивший сотрудник обязан оставаться до конкретного события или срока, если такая обязанность прямо не установлена; отделяй практический вывод о необходимости завершить передачу от прямого текста закона.
Не показывай внутренние рассуждения. В ответе кратко укажи применимые нормы и практический вывод; явно обозначай, где закон говорит прямо, а где приводится толкование или вывод по аналогии. Если точной нормы нет, не выдумывай ее и не отказывайся от анализа: изложи наиболее обоснованное толкование смежных норм с оговоркой о его пределах. Если база не позволяет сделать надежный вывод или содержит противоречия, скажи об этом и посоветуй уточнить вопрос у Руководства Коллегии Адвокатов (ГКА/ЗГКА).
Не придумывай факты, номера статей, части или пункты и не заявляй о приоритете одного акта над другим без основания в базе. Не показывай Markdown-маркеры, не используй таблицы и блоки кода.
Ниже передана полная загруженная законодательная база штата.`;
          const model = String(options.geminiModel ?? process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite").trim();
          const fallbackModel = String(options.geminiFallbackModel ?? process.env.GEMINI_FALLBACK_MODEL ?? "gemini-2.5-flash").trim();
          const modelCandidates = [...new Set([
            model,
            fallbackModel,
            "gemini-3.5-flash-lite",
            "gemini-2.5-flash"
          ])].filter(Boolean);
          let geminiResponse;
          let responseBody = {};
          for (const candidate of modelCandidates) {
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidate)}:generateContent`;
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 60000);
              try {
                geminiResponse = await (options.geminiFetch || globalThis.fetch)(endpoint, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-goog-api-key": geminiKey
                  },
                  body: JSON.stringify({
                    systemInstruction: { parts: [{ text: systemInstruction }] },
                    contents: [{ role: "user", parts: [{ text: `${context ? `ЗАКОНОДАТЕЛЬНАЯ БАЗА:\n${context}\n\n` : ""}ВОПРОС ИЛИ СИТУАЦИЯ:\n${question}` }] }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 1800 }
                  }),
                  signal: controller.signal
                });
              } catch (error) {
                if (error.name === "AbortError" || error instanceof TypeError) {
                  await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
                  continue;
                }
                continue;
              } finally {
                clearTimeout(timeout);
              }
              responseBody = await geminiResponse.json().catch(() => ({}));
              if (geminiResponse.ok) break;
              if (![429, 503].includes(geminiResponse.status)) break;
              await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
            }
            if (geminiResponse?.ok) break;
          }
          if (!geminiResponse || !geminiResponse.ok) {
            const detail = String(responseBody.error?.message || "");
            if (/no longer available to new users|is no longer available/i.test(detail)) {
              throw new HttpError(503, "Модель ИИ устарела или недоступна для этого ключа. Сервер переключён на актуальную модель; повторите запрос.");
            }
            if (/high demand|перегруз|unavailable|temporarily/i.test(detail)) {
              throw new HttpError(503, "ИИ-сервис временно перегружен. Сервер уже попробовал запасные модели. Повторите запрос через минуту.");
            }
            throw new HttpError(502, detail ? `ИИ-сервис отклонил запрос: ${detail.slice(0, 300)}` : "ИИ-сервис отклонил запрос.");
          }
          const answer = (responseBody.candidates?.[0]?.content?.parts || [])
            .map((part) => typeof part.text === "string" ? part.text : "")
            .filter(Boolean)
            .join("\n")
            .trim();
          if (!answer) throw new HttpError(502, "ИИ-сервис не вернул текст ответа.");
          const exactRefusal = "Запрос отклонен. Я консультирую исключительно по законодательной базе штата San Andreas и составлению адвокатских документов.";
          if (mode !== "lawsuit" && (answer === exactRefusal || isAssistantRefusal(answer))) {
            const legalHint = /(?:стать[ияеию]|ук|пк|ак|закон|адвокат|прокуратур|суд|задерж|кавул|кинули|подозре|обвин|иск|жалоб|дорожн|трудов)/iu.test(question);
            if (legalHint) {
              const retryModel = modelCandidates.find((candidate) => candidate !== model) || model;
              const retryEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(retryModel)}:generateContent`;
              const retryResponse = await (options.geminiFetch || globalThis.fetch)(retryEndpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
                body: JSON.stringify({
                  systemInstruction: { parts: [{ text: `${systemInstruction}\nЭто безусловно юридический RP-запрос штата. Проанализируй вопрос и дай конкретный практический ответ.` }] },
                  contents: [{ role: "user", parts: [{ text: `Вопрос пользователя с бытовой RP-речью:\n${question}\n\nИспользуй всю полную базу законов и ответь по существу с применимыми статьями.` }] }],
                  generationConfig: { temperature: 0.1, maxOutputTokens: 1800 }
                })
              }).catch(() => null);
              if (retryResponse?.ok) {
                const retryBody = await retryResponse.json().catch(() => ({}));
                const retryAnswer = (retryBody.candidates?.[0]?.content?.parts || [])
                  .map((part) => typeof part.text === "string" ? part.text : "")
                  .filter(Boolean)
                  .join("\n")
                  .trim();
                if (retryAnswer && retryAnswer !== exactRefusal && !isAssistantRefusal(retryAnswer)) {
                  applyAiCooldown(session.user_id);
                  return sendJson(res, 200, { answer: retryAnswer, mode, document: null, cooldownSeconds: 60 });
                }
              }
            }
          }
          let document = null;
          if (mode === "lawsuit") {
            document = parseGeneratedLawsuitDocument(answer);
            if (!document?.title.trim() || !document?.facts.trim() || !document?.claims.trim()) {
              document = null;
              applyAiCooldown(session.user_id);
              return sendJson(res, 200, {
                answer: lawsuitAssistantRedirect,
                mode,
                document: null,
                cooldownSeconds: 60
              });
            }
          }
          applyAiCooldown(session.user_id);
          return sendJson(res, 200, { answer, mode, document, cooldownSeconds: 60 });
        }

        if (pathname === "/api/rp-career-practice" && req.method === "GET") {
          if (!promotionPracticeStages.includes(user.role)) {
            throw new HttpError(403, "Карьерная AI-практика доступна стажёрам КА и юристам.");
          }
          requireCareerPracticeUnlocked(db, user);
          const progress = getCareerRpPracticeState(db, user.id, user.role);
          return sendJson(res, 200, {
            stageRole: user.role,
            ...progress
          });
        }

        if (pathname === "/api/rp-career-practice/start" && req.method === "POST") {
          if (!promotionPracticeStages.includes(user.role)) {
            throw new HttpError(403, "Карьерная AI-практика доступна стажёрам КА и юристам.");
          }
          requireCareerPracticeUnlocked(db, user);
          const body = requireObject(await readJson(req));
          const caseId = String(body.caseId || "");
          const scenario = careerRpPracticeCases.find((item) => item.id === caseId);
          if (!scenario) throw new HttpError(404, "Карьерный RP-кейс не найден.");
          if (user.role !== "Юрист" &&
              getCareerRpPracticeState(db, user.id, user.role).completedCaseIds.includes(caseId)) {
            throw new HttpError(409, "Этот карьерный RP-кейс уже пройден.");
          }
          db.prepare(`INSERT INTO rp_career_practice_sessions (user_id, stage_role, case_id, node_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET stage_role = excluded.stage_role,
              case_id = excluded.case_id, node_id = excluded.node_id, updated_at = CURRENT_TIMESTAMP`)
            .run(user.id, user.role, caseId, scenario.startNode);
          return sendJson(res, 200, { started: true });
        }

        if (pathname === "/api/rp-career-practice/answer" && req.method === "POST") {
          if (!promotionPracticeStages.includes(user.role)) {
            throw new HttpError(403, "Карьерная AI-практика доступна стажёрам КА и юристам.");
          }
          requireCareerPracticeUnlocked(db, user);
          const body = requireObject(await readJson(req));
          const caseId = String(body.caseId || "");
          const choiceIndex = body.choiceIndex;
          const session = db.prepare(`SELECT stage_role, case_id, node_id FROM rp_career_practice_sessions
            WHERE user_id = ?`).get(user.id);
          if (!session || session.stage_role !== user.role || session.case_id !== caseId) {
            throw new HttpError(409, "Сначала начните этот карьерный RP-кейс.");
          }
          const scenario = careerRpPracticeCases.find((item) => item.id === caseId);
          const currentNode = scenario?.nodes?.[session.node_id];
          const choice = currentNode?.choices?.[choiceIndex];
          const nextNode = choice ? scenario.nodes[choice.next] : null;
          if (!Number.isInteger(choiceIndex) || !nextNode) {
            throw new HttpError(400, "Выберите доступный ответ в карьерном RP-кейсе.");
          }
          const finished = Boolean(nextNode.isEnd);
          const completed = finished && nextNode.won === true;
          if (finished) {
            db.prepare("DELETE FROM rp_career_practice_sessions WHERE user_id = ?").run(user.id);
            if (completed) {
              db.prepare(`INSERT OR IGNORE INTO rp_career_practice_completions
                (user_id, stage_role, case_id) VALUES (?, ?, ?)`).run(user.id, user.role, caseId);
            }
          } else {
            db.prepare(`UPDATE rp_career_practice_sessions SET node_id = ?, updated_at = CURRENT_TIMESTAMP
              WHERE user_id = ?`).run(choice.next, user.id);
          }
          const progress = getCareerRpPracticeState(db, user.id, user.role);
          return sendJson(res, 200, {
            finished,
            completed,
            completedCaseIds: progress.completedCaseIds
          });
        }

        if (pathname === "/api/rp-practice/completions" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "RP-практика доступна только сотрудникам Коллегии.");
          if (user.role === "Стажер КА") {
            throw new HttpError(403, "Разбор ситуационных кейсов откроется после повышения до юриста.");
          }
          const completedCaseIds = db.prepare(
            "SELECT case_id FROM rp_practice_completions WHERE user_id = ? ORDER BY completed_at"
          ).all(user.id).map((row) => row.case_id);
          return sendJson(res, 200, { completedCaseIds });
        }

        if (pathname === "/api/rp-practice/answer" && req.method === "POST") {
          if (user.role === citizenRole) throw new HttpError(403, "RP-практика доступна только сотрудникам Коллегии.");
          if (user.role === "Стажер КА") {
            throw new HttpError(403, "Разбор ситуационных кейсов откроется после повышения до юриста.");
          }
          const body = requireObject(await readJson(req));
          const caseId = String(body.caseId || "").trim();
          const answerIndex = body.answerIndex;
          const question = rpPracticeCases.find((item) => item.id === caseId);
          if (!question) throw new HttpError(404, "RP-кейс не найден.");
          if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= question.options.length) {
            throw new HttpError(400, "Выберите вариант ответа из кейса.");
          }
          const completed = Boolean(db.prepare(
            "SELECT 1 FROM rp_practice_completions WHERE user_id = ? AND case_id = ?"
          ).get(user.id, caseId));
          const correctIndex = question.options.findIndex((option) => option.startsWith(`${question.correct})`));
          const correct = answerIndex === correctIndex;
          if (correct && !completed) {
            db.prepare("INSERT OR IGNORE INTO rp_practice_completions (user_id,case_id) VALUES (?,?)")
              .run(user.id, caseId);
          }
          return sendJson(res, 200, {
            correct,
            completed: completed || correct,
            explanation: correct ? question.explanation : "Ответ неверный. Попробуйте выбрать другой вариант."
          });
        }

        if (pathname === "/api/rp-custom-cases" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "AI Case доступен только сотрудникам Коллегии.");
          if (promotionPracticeStages.includes(user.role)) {
            throw new HttpError(403, "Сначала завершите карьерный путь; пользовательские AI Case откроются после повышения до адвоката.");
          }
          const cases = db.prepare(`SELECT c.*, u.display_name AS owner_name
            FROM rp_custom_cases c JOIN users u ON u.id = c.user_id
            WHERE c.user_id = ?
            ORDER BY c.id DESC`)
            .all(user.id)
            .map((row) => ({ ...presentRpCustomCase(row), ownerName: row.owner_name }));
          return sendJson(res, 200, { cases });
        }

        if (pathname === "/api/rp-custom-cases" && req.method === "POST") {
          if (user.role === citizenRole) throw new HttpError(403, "Создавать AI Case могут только сотрудники Коллегии.");
          if (promotionPracticeStages.includes(user.role)) {
            throw new HttpError(403, "Стажёрам КА и юристам доступны только базовые карьерные AI-практики.");
          }
          const body = requireObject(await readJson(req));
          const sourceDetails = String(body.details || "").trim();
          const difficulty = Number(body.difficulty);
          const officerKindness = Number(body.officerKindness);
          const depth = Number(body.depth);
          if (sourceDetails.length < 10 || sourceDetails.length > 1500 ||
              !Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5 ||
              !Number.isInteger(officerKindness) || officerKindness < 1 || officerKindness > 5 ||
              !Number.isInteger(depth) || depth < 1 || depth > 5) {
            throw new HttpError(400, "Опишите ситуацию (10–1500 символов) и задайте три уровня от 1 до 5.");
          }
          const geminiKey = String(options.geminiApiKey ?? process.env.GEMINI_API_KEY ?? "").trim();
          if (!geminiKey) throw new HttpError(503, "ИИ-сервис не настроен. Добавьте ключ сервера.");
          const cooldownSeconds = consumeAiCooldown(session.user_id);
          if (cooldownSeconds) throw new HttpError(429, `Повторный запрос доступен через ${cooldownSeconds} с.`);
          const expectedQuestionCount = rpCaseQuestionCounts[depth];
          const examples = [...rpInterviewCases, ...rpInterviewExtraCases].slice(0, 8).map((scenario) => {
            const first = scenario.nodes[scenario.startNode];
            return `${scenario.title}: ${first?.copText || scenario.subtitle}`;
          }).join("\n");
          const prompt = `Составь один игровой AI Case для тренировки адвоката в RP.
Основа ситуации пользователя: ${sourceDetails}
Сложность: ${difficulty}/5; задаёт сложность ситуации и правильных решений.
Доброта сотрудника: ${officerKindness}/5 (1 — грубый и несговорчивый, 5 — доброжелательный).
Углублённое понимание дела: ${depth}/5; по нему определяется число вопросов — строго ${expectedQuestionCount}. Учитывай также тонкость вопросов и юридических деталей.
Выбери ведомство строго из LSDP, FIB, LSSD, USSS. Не придумывай ссылки и номера статей.
Примеры тона существующей базы:
${examples}
Верни только JSON: {"title":"...","subtitle":"...","copName":"...","copDept":"LSDP|FIB|LSSD|USSS","questions":[{"text":"реплика госслужащего","options":["ответ 1","ответ 2","ответ 3"],"correctIndex":2,"explanation":"почему правильный вариант лучше"}]}.
Нужно ровно ${expectedQuestionCount} вопросов, ровно 3 ответа в каждом, один лучший ответ; correctIndex указывает его позицию от 0 до 2. Не ставь правильный ответ постоянно в одну позицию и не используй шаблонную последовательность.
Все три варианта должны звучать правдоподобно и быть сопоставимы по длине и детализации. Ошибочные варианты — реалистичные юридические заблуждения, а не очевидная нелепость; правильный не должен выделяться более официальным или подробным стилем.
Вопросы должны образовывать последовательный разговор, не повторяться. Все строки на русском языке.`;
          const model = String(options.geminiModel ?? process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite").trim();
          let generationResponse;
          try {
            generationResponse = await (options.geminiFetch || globalThis.fetch)(
              `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
              {
                method: "POST",
                headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
                body: JSON.stringify({
                  systemInstruction: {
                    parts: [{ text: "Ты создаёшь только безопасные учебные RP-диалоги. Никогда не выходи за заданную JSON-схему." }]
                  },
                  contents: [{ role: "user", parts: [{ text: prompt }] }],
                  generationConfig: { temperature: 0.6, maxOutputTokens: Math.min(16000, expectedQuestionCount * 320) }
                }),
                signal: AbortSignal.timeout(60000)
              }
            );
          } catch {
            throw new HttpError(502, "Не удалось связаться с ИИ-сервисом. Попробуйте позже.");
          }
          const responseBody = await generationResponse.json().catch(() => ({}));
          if (!generationResponse.ok) {
            throw new HttpError(502, "ИИ-сервис не смог создать кейс. Попробуйте позже.");
          }
          const answer = (responseBody.candidates?.[0]?.content?.parts || [])
            .map((part) => typeof part.text === "string" ? part.text : "")
            .filter(Boolean)
            .join("\n")
            .trim();
          const scenario = parseGeneratedRpCustomCase(answer, expectedQuestionCount);
          scenario.difficulty = difficulty;
          scenario.officerKindness = officerKindness;
          scenario.depth = depth;
          const created = db.prepare(`INSERT INTO rp_custom_cases
            (user_id,title,source_details,difficulty,officer_kindness,depth,scenario_json)
            VALUES (?,?,?,?,?,?,?)`)
            .run(user.id, scenario.title, sourceDetails, difficulty, officerKindness, depth, JSON.stringify(scenario));
          applyAiCooldown(session.user_id);
          const row = db.prepare("SELECT * FROM rp_custom_cases WHERE id = ?").get(Number(created.lastInsertRowid));
          return sendJson(res, 201, { case: presentRpCustomCase(row) });
        }

        const rpCustomCaseRoute = pathname.match(/^\/api\/rp-custom-cases\/(\d+)\/(complete|publish)$/);
        if (rpCustomCaseRoute && req.method === "POST") {
          if (user.role === citizenRole) throw new HttpError(403, "AI Case доступен только сотрудникам Коллегии.");
          if (promotionPracticeStages.includes(user.role)) {
            throw new HttpError(403, "Сначала завершите карьерный путь; пользовательские AI Case откроются после повышения до адвоката.");
          }
          const caseId = Number(rpCustomCaseRoute[1]);
          const action = rpCustomCaseRoute[2];
          if (action === "publish") {
            throw new HttpError(410, "Публикация личных AI Case отключена. Каждый кейс доступен только его автору.");
          }
          const customCase = db.prepare("SELECT * FROM rp_custom_cases WHERE id = ?").get(caseId);
          if (!customCase) throw new HttpError(404, "Пользовательский AI Case не найден.");
          if (Number(customCase.user_id) !== Number(user.id)) {
            throw new HttpError(403, "Управлять своим AI Case может только его автор.");
          }
          if (action === "complete") {
            db.prepare(`UPDATE rp_custom_cases SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
              WHERE id = ?`).run(caseId);
            return sendJson(res, 200, { completed: true });
          }
        }

        if (pathname === "/api/discord/status" && req.method === "GET") {
          return sendJson(res, 200, {
            configured: Boolean(discord.clientId && discord.clientSecret && discord.redirectUri),
            botConfigured: Boolean(discord.botToken && discord.guildId),
            botCanDm: Boolean(discord.botToken),
            linkRequired: false,
            linked: Boolean(user.discord_id),
            username: user.discord_username || "",
            avatarUrl: user.discord_avatar_url || "",
            linkedAt: user.discord_linked_at || null,
            syncError: user.discord_sync_error || "",
            nicknameWarning: user.discord_nickname_error || "",
            presence: user.discord_id ? discordPresenceProvider(user.discord_id) : "offline"
          });
        }

        if (pathname === "/api/discord/unlink" && req.method === "POST") {
          if (!user.discord_id) return sendJson(res, 200, { ok: true, discordWarning: "" });
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare("DELETE FROM discord_link_states WHERE user_id = ?").run(user.id);
            db.prepare(`UPDATE users SET discord_id = NULL, discord_username = '', discord_avatar_url = '',
              discord_linked_at = NULL, discord_sync_error = '', discord_nickname_error = '' WHERE id = ?`)
              .run(user.id);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          const discordWarning = await revokeDiscordAccess(user);
          return sendJson(res, 200, { ok: true, discordWarning });
        }

        if (pathname === "/api/notifications" && req.method === "GET") {
          const preferences = db.prepare("SELECT discord_dm_enabled FROM notification_preferences WHERE user_id = ?")
            .get(user.id);
          const notifications = db.prepare(`SELECT id, notification_type, title, body, href, discord_error,
              discord_sent_at, read_at, created_at
            FROM portal_notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100`).all(user.id);
          return sendJson(res, 200, {
            notifications,
            unreadCount: notifications.filter((item) => !item.read_at).length,
            discordDmEnabled: preferences?.discord_dm_enabled !== 0
          });
        }

        if (pathname === "/api/notifications/read-all" && req.method === "POST") {
          db.prepare("UPDATE portal_notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL")
            .run(user.id);
          return sendJson(res, 200, { ok: true });
        }

        const notificationReadRoute = pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
        if (notificationReadRoute && req.method === "PATCH") {
          const notificationId = Number(notificationReadRoute[1]);
          const notification = db.prepare("SELECT id FROM portal_notifications WHERE id = ? AND user_id = ?")
            .get(notificationId, user.id);
          if (!notification) throw new HttpError(404, "Уведомление не найдено.");
          db.prepare(`UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
            WHERE id = ? AND user_id = ?`).run(notificationId, user.id);
          return sendJson(res, 200, { ok: true });
        }

        if (pathname === "/api/notifications/preferences" && req.method === "PATCH") {
          const body = await readJson(req);
          if (typeof body.discordDmEnabled !== "boolean") {
            throw new HttpError(400, "Укажите, включить ли личные уведомления Discord.");
          }
          if (body.discordDmEnabled && !user.discord_id) {
            throw new HttpError(409, "Сначала привяжите Discord в профиле.");
          }
          if (body.discordDmEnabled && !discord.botToken) {
            throw new HttpError(503, "Discord-бот пока не настроен на сервере.");
          }
          db.prepare(`INSERT INTO notification_preferences (user_id, discord_dm_enabled, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET discord_dm_enabled = excluded.discord_dm_enabled,
              updated_at = CURRENT_TIMESTAMP`)
            .run(user.id, body.discordDmEnabled ? 1 : 0);
          return sendJson(res, 200, { discordDmEnabled: body.discordDmEnabled });
        }

        if (pathname === "/api/notifications/test" && req.method === "POST") {
          if (user.username !== "yyte") {
            throw new HttpError(403, "Тестовые уведомления доступны только владельцу аккаунта.");
          }
          if (!user.discord_id) throw new HttpError(409, "Сначала привяжите Discord к аккаунту.");
          const body = requireObject(await readJson(req));
          const notification = auditTestNotificationTypes[String(body.type || "")];
          if (!notification) throw new HttpError(400, "Выберите тестовое уведомление кадрового аудита.");
          const result = await notifyPortalUser({
            userId: user.id,
            type: "audit_test",
            title: notification.title,
            body: notification.body,
            href: "/page/audit"
          });
          const delivery = db.prepare("SELECT discord_sent_at FROM portal_notifications WHERE id = ?")
            .get(result.id);
          return sendJson(res, 201, {
            id: result.id,
            discordSent: Boolean(delivery?.discord_sent_at),
            warning: result.discordWarning
          });
        }

        if (pathname === "/api/discord/diagnostics" && req.method === "GET") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Диагностика Discord доступна только ГКА.");
          let redirectHost = "";
          let redirectValid = false;
          try {
            const callback = new URL(discord.redirectUri);
            redirectHost = callback.host;
            redirectValid = callback.pathname === "/api/discord/callback" &&
              (callback.protocol === "https:" || ["localhost", "127.0.0.1"].includes(callback.hostname));
          } catch {
            redirectValid = false;
          }
          const webhookState = webhookDispatcher.status();
          return sendJson(res, 200, {
            oauth: {
              configured: Boolean(discord.clientId && discord.clientSecret && discord.redirectUri),
              clientIdSet: Boolean(discord.clientId),
              clientSecretSet: Boolean(discord.clientSecret),
              redirectValid,
              redirectHost
            },
            bot: {
              configured: Boolean(discord.botToken && discord.guildId),
              guildConfigured: Boolean(discord.guildId),
              rolesConfigured: Object.values(discordRoleIds).filter(Boolean).length
            },
            webhooks: publicWebhookChannels.map((kind) => ({
              kind,
              label: webhookChannelLabels[kind],
              url: describeWebhook(webhooks[kind] || "", kind),
              ...webhookState[kind]
            })),
            queue: { pending: webhookState.pending, queued: webhookState.queued }
          });
        }

        if (pathname === "/api/webhooks/status" && req.method === "GET") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Состояние уведомлений доступно только ГКА.");
          const state = webhookDispatcher.status();
          return sendJson(res, 200, {
            pending: state.pending,
            queued: state.queued,
            channels: publicWebhookChannels.map((kind) => ({
              kind,
              label: webhookChannelLabels[kind],
              url: describeWebhook(webhooks[kind] || "", kind),
              ...state[kind]
            }))
          });
        }

        if (pathname === "/api/webhooks/test" && req.method === "POST") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Проверку уведомлений может запускать только ГКА.");
          const body = await readJson(req);
          const kind = String(body.kind || "");
          if (!publicWebhookChannels.includes(kind)) {
            throw new HttpError(400, "Неизвестный канал.");
          }
          let result;
          try {
            result = await webhookDispatcher.test(kind);
          } catch (error) {
            throw new HttpError(400, error.message);
          }
          const payload = { channel: kind, label: webhookChannelLabels[kind], ...result };
          if (!result.ok) {
            throw new HttpError(502, result.warning || "Канал уведомлений не настроен.");
          }
          return sendJson(res, 200, payload);
        }

        if (pathname === "/api/discord/sync" && req.method === "POST") {
          if (!user.discord_id) throw new HttpError(409, "Сначала привяжите Discord к аккаунту.");
          const result = await syncDiscordMember(user.id);
          return sendJson(res, 200, { ok: !result.syncError, ...result });
        }

        if (pathname === "/api/discord/link" && req.method === "POST") {
          if (!discord.clientId || !discord.clientSecret || !discord.redirectUri) {
            throw new HttpError(503, "Владелец портала ещё не настроил Discord OAuth в .env.");
          }
          const callback = new URL(discord.redirectUri);
          if (callback.pathname !== "/api/discord/callback" ||
              (callback.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(callback.hostname))) {
            throw new HttpError(503, "DISCORD_REDIRECT_URI должен быть HTTPS URL маршрута /api/discord/callback.");
          }
          const state = randomBytes(32).toString("base64url");
          db.prepare("DELETE FROM discord_link_states WHERE expires_at <= ? OR used_at IS NOT NULL").run(Date.now());
          db.prepare("INSERT INTO discord_link_states (state_hash,user_id,expires_at) VALUES (?,?,?)")
            .run(hashToken(state), user.id, Date.now() + 5 * 60 * 1000);
          const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
          authorizeUrl.search = new URLSearchParams({
            client_id: discord.clientId,
            redirect_uri: discord.redirectUri,
            response_type: "code",
            scope: "identify",
            state
          }).toString();
          return sendJson(res, 200, { authorizeUrl: authorizeUrl.toString() });
        }

        if (pathname === "/api/tasks" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Поручения доступны только сотрудникам Коллегии.");
          const manager = managementRoles.includes(user.role);
          const rows = db.prepare(`SELECT t.*, creator.display_name AS creator_name,
              reviewer.display_name AS reviewer_name
            FROM tasks t
            JOIN users creator ON creator.id = t.created_by
            LEFT JOIN users reviewer ON reviewer.id = t.reviewer_id
            WHERE ? = 1 OR t.created_by = ? OR EXISTS (
              SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?
            )
            ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at, t.updated_at DESC, t.id DESC
            LIMIT 300`).all(manager ? 1 : 0, user.id, user.id);
          return sendJson(res, 200, { tasks: taskListPayload(rows) });
        }

        if (pathname === "/api/tasks" && req.method === "POST") {
          if (!managementRoles.includes(user.role)) throw new HttpError(403, "Создавать поручения может только руководство.");
          const body = requireObject(await readJson(req, 8 * 1024 * 1024));
          const title = String(body.title || "").trim();
          const description = String(body.description || "").trim();
          const priority = String(body.priority || "normal");
          const dueAt = normalizeDateTime(body.dueAt, "Срок выполнения", { optional: true });
          if (title.length < 3 || title.length > 150) throw new HttpError(400, "Название поручения должно содержать от 3 до 150 символов.");
          if (description.length < 4 || description.length > 3000) throw new HttpError(400, "Описание поручения должно содержать от 4 до 3000 символов.");
          if (!taskPriorities.includes(priority)) throw new HttpError(400, "Неизвестный приоритет поручения.");
          const assigneeIds = parseStaffIds(db, body.assigneeIds, { maximum: 25 });
          const attachments = parseApplicationAttachments(body.attachments);
          let taskId;
          db.exec("BEGIN IMMEDIATE");
          try {
            const result = db.prepare(`INSERT INTO tasks (title,description,priority,due_at,created_by)
              VALUES (?,?,?,?,?)`).run(title, description, priority, dueAt, user.id);
            taskId = Number(result.lastInsertRowid);
            const addAssignee = db.prepare("INSERT INTO task_assignees (task_id,user_id,assigned_by) VALUES (?,?,?)");
            for (const assigneeId of assigneeIds) addAssignee.run(taskId, assigneeId, user.id);
            db.prepare(`INSERT INTO task_history (task_id,actor_id,action,to_status,comment)
              VALUES (?,?,'created','new','Поручение создано.')`).run(taskId, user.id);
            const addAttachment = db.prepare(`INSERT INTO task_attachments
              (task_id,uploaded_by,file_name,content_type,content) VALUES (?,?,?,?,?)`);
            for (const attachment of attachments) {
              addAttachment.run(taskId, user.id, attachment.name, attachment.contentType, attachment.content);
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          for (const assigneeId of assigneeIds) {
            const assignee = db.prepare("SELECT discord_id, discord_avatar_url, display_name, role, username FROM users WHERE id = ?").get(assigneeId);
            if (assignee?.discord_id) {
              await sendPortalDirectMessage(
                assigneeId,
                assignee,
                assignee.discord_avatar_url,
                "Новое поручение",
                `Вам назначено поручение **${title}**.\nПриоритет: ${priority}${dueAt ? `\nСрок: ${dueAt}` : ""}`
              );
            }
          }
          return sendJson(res, 201, { task: taskPayload(db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId)) });
        }

        const taskAttachmentRoute = pathname.match(/^\/api\/tasks\/(\d+)\/attachments\/(\d+)$/);
        if (taskAttachmentRoute && req.method === "GET") {
          const taskId = Number(taskAttachmentRoute[1]);
          if (!canAccessTask(user, taskId)) throw new HttpError(404, "Поручение не найдено.");
          const attachment = db.prepare(`SELECT file_name,content_type,content FROM task_attachments
            WHERE task_id = ? AND id = ?`).get(taskId, Number(taskAttachmentRoute[2]));
          if (!attachment) throw new HttpError(404, "Вложение не найдено.");
          res.writeHead(200, {
            "content-type": attachment.content_type,
            "content-length": attachment.content.length,
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff"
          });
          return res.end(attachment.content);
        }

        const taskAttachmentUploadRoute = pathname.match(/^\/api\/tasks\/(\d+)\/attachments$/);
        if (taskAttachmentUploadRoute && req.method === "POST") {
          const taskId = Number(taskAttachmentUploadRoute[1]);
          if (!canAccessTask(user, taskId)) throw new HttpError(404, "Поручение не найдено.");
          const body = requireObject(await readJson(req, 8 * 1024 * 1024));
          const attachments = parseApplicationAttachments(body.attachments);
          if (!attachments.length) throw new HttpError(400, "Выберите хотя бы один файл.");
          const count = Number(db.prepare("SELECT COUNT(*) AS count FROM task_attachments WHERE task_id = ?").get(taskId).count);
          if (count + attachments.length > 5) throw new HttpError(400, "К одному поручению можно приложить не более пяти файлов.");
          const insert = db.prepare(`INSERT INTO task_attachments
            (task_id,uploaded_by,file_name,content_type,content) VALUES (?,?,?,?,?)`);
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const attachment of attachments) {
              insert.run(taskId, user.id, attachment.name, attachment.contentType, attachment.content);
            }
            db.prepare(`INSERT INTO task_history (task_id,actor_id,action,comment)
              VALUES (?,?,'attachment','Добавлены вложения.')`).run(taskId, user.id);
            db.prepare("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(taskId);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          return sendJson(res, 201, { task: taskPayload(db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId)) });
        }

        const taskRoute = pathname.match(/^\/api\/tasks\/(\d+)$/);
        if (taskRoute && req.method === "GET") {
          const taskId = Number(taskRoute[1]);
          if (!canAccessTask(user, taskId)) throw new HttpError(404, "Поручение не найдено.");
          const task = db.prepare(`SELECT t.*, creator.display_name AS creator_name,
              reviewer.display_name AS reviewer_name
            FROM tasks t JOIN users creator ON creator.id = t.created_by
            LEFT JOIN users reviewer ON reviewer.id = t.reviewer_id WHERE t.id = ?`).get(taskId);
          if (!task) throw new HttpError(404, "Поручение не найдено.");
          const history = db.prepare(`SELECT h.*, actor.display_name AS actor_name, actor.role AS actor_role
            FROM task_history h JOIN users actor ON actor.id = h.actor_id
            WHERE h.task_id = ? ORDER BY h.id DESC LIMIT 100`).all(taskId);
          return sendJson(res, 200, { task: taskPayload(task), history });
        }

        if (taskRoute && req.method === "PATCH") {
          const taskId = Number(taskRoute[1]);
          if (!canAccessTask(user, taskId)) throw new HttpError(404, "Поручение не найдено.");
          const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
          const manager = managementRoles.includes(user.role);
          const assignee = Boolean(db.prepare("SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?")
            .get(taskId, user.id));
          const body = requireObject(await readJson(req, 8 * 1024 * 1024));
          const comment = String(body.comment || "").trim();
          if (comment.length > 1000) throw new HttpError(400, "Комментарий не должен превышать 1000 символов.");
          let nextStatus = task.status;
          if (body.status !== undefined) {
            nextStatus = String(body.status);
            if (!taskStatuses.includes(nextStatus)) throw new HttpError(400, "Неизвестный статус поручения.");
            if (nextStatus !== task.status) {
              if (manager) {
                const reviewDecision = task.status === "review" && ["revision", "completed"].includes(nextStatus);
                const cancellation = nextStatus === "cancelled" && !["completed", "cancelled"].includes(task.status);
                if (!reviewDecision && !cancellation) throw new HttpError(409, "Руководство может принять поручение на проверке, вернуть его или отменить.");
                if (["revision", "completed"].includes(nextStatus) && comment.length < 3) {
                  throw new HttpError(400, "Для решения по проверке укажите комментарий.");
                }
              } else {
                const allowedTransitions = {
                  new: ["accepted"],
                  accepted: ["in_progress"],
                  in_progress: ["review"],
                  revision: ["in_progress"]
                };
                if (!assignee || !allowedTransitions[task.status]?.includes(nextStatus)) {
                  throw new HttpError(403, "На этом этапе изменить статус может только назначенный исполнитель.");
                }
              }
            }
          }
          let priority = task.priority;
          let dueAt = task.due_at;
          let title = task.title;
          let description = task.description;
          let assigneeIds;
          if (!manager && ["priority", "dueAt", "title", "description", "assigneeIds"].some((key) => body[key] !== undefined)) {
            throw new HttpError(403, "Редактировать параметры поручения может только руководство.");
          }
          if (body.priority !== undefined) {
            priority = String(body.priority);
            if (!taskPriorities.includes(priority)) throw new HttpError(400, "Неизвестный приоритет поручения.");
          }
          if (body.dueAt !== undefined) dueAt = normalizeDateTime(body.dueAt, "Срок выполнения", { optional: true });
          if (body.title !== undefined) {
            title = String(body.title).trim();
            if (title.length < 3 || title.length > 150) throw new HttpError(400, "Название поручения должно содержать от 3 до 150 символов.");
          }
          if (body.description !== undefined) {
            description = String(body.description).trim();
            if (description.length < 4 || description.length > 3000) throw new HttpError(400, "Описание поручения должно содержать от 4 до 3000 символов.");
          }
          if (body.assigneeIds !== undefined) assigneeIds = parseStaffIds(db, body.assigneeIds, { maximum: 25 });
          const attachments = parseApplicationAttachments(body.attachments);
          const attachmentCount = Number(db.prepare("SELECT COUNT(*) AS count FROM task_attachments WHERE task_id = ?").get(taskId).count);
          if (attachmentCount + attachments.length > 5) throw new HttpError(400, "К одному поручению можно приложить не более пяти файлов.");
          const hasChanges = nextStatus !== task.status || priority !== task.priority || dueAt !== task.due_at ||
            title !== task.title || description !== task.description || assigneeIds !== undefined ||
            Boolean(comment) || attachments.length > 0;
          if (!hasChanges) throw new HttpError(400, "Изменений для сохранения нет.");
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare(`UPDATE tasks SET title = ?, description = ?, priority = ?, due_at = ?, status = ?,
              reviewer_id = ?, review_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(title, description, priority, dueAt, nextStatus,
                manager && ["revision", "completed"].includes(nextStatus) ? user.id : task.reviewer_id,
                manager && ["revision", "completed"].includes(nextStatus) ? comment : task.review_note, taskId);
            if (nextStatus !== task.status) {
              db.prepare(`INSERT INTO task_history (task_id,actor_id,action,from_status,to_status,comment)
                VALUES (?,?,'status',?,?,?)`).run(taskId, user.id, task.status, nextStatus, comment);
            }
            if (comment && nextStatus === task.status) {
              db.prepare(`INSERT INTO task_history (task_id,actor_id,action,comment)
                VALUES (?,?,'comment',?)`).run(taskId, user.id, comment);
            }
            if (priority !== task.priority || dueAt !== task.due_at || title !== task.title || description !== task.description) {
              db.prepare(`INSERT INTO task_history (task_id,actor_id,action,comment)
                VALUES (?,?,'edited','Параметры поручения обновлены.')`).run(taskId, user.id);
            }
            if (assigneeIds !== undefined) {
              db.prepare("DELETE FROM task_assignees WHERE task_id = ?").run(taskId);
              const addAssignee = db.prepare("INSERT INTO task_assignees (task_id,user_id,assigned_by) VALUES (?,?,?)");
              for (const assigneeId of assigneeIds) addAssignee.run(taskId, assigneeId, user.id);
              db.prepare(`INSERT INTO task_history (task_id,actor_id,action,comment)
                VALUES (?,?,'assignees','Список исполнителей обновлён.')`).run(taskId, user.id);
            }
            if (attachments.length) {
              const addAttachment = db.prepare(`INSERT INTO task_attachments
                (task_id,uploaded_by,file_name,content_type,content) VALUES (?,?,?,?,?)`);
              for (const attachment of attachments) {
                addAttachment.run(taskId, user.id, attachment.name, attachment.contentType, attachment.content);
              }
              db.prepare(`INSERT INTO task_history (task_id,actor_id,action,comment)
                VALUES (?,?,'attachment','Добавлены вложения.')`).run(taskId, user.id);
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
          return sendJson(res, 200, { task: taskPayload(updated) });
        }

        if (pathname === "/api/calendar" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Календарь доступен только сотрудникам Коллегии.");
          const manager = managementRoles.includes(user.role);
          const includeArchived = requestUrl.searchParams.get("archived") === "1";
          if (includeArchived && !hasGkaAccess(user)) throw new HttpError(403, "Архив календаря доступен только ГКА.");
          const rows = db.prepare(`SELECT e.*, responsible.display_name AS responsible_name,
              creator.display_name AS creator_name
            FROM calendar_events e
            JOIN users responsible ON responsible.id = e.responsible_id
            JOIN users creator ON creator.id = e.created_by
            WHERE (? = 1 OR e.archived_at IS NULL) AND (? = 1 OR e.is_all_staff = 1 OR e.created_by = ? OR e.responsible_id = ?
              OR EXISTS (SELECT 1 FROM calendar_event_participants p WHERE p.event_id = e.id AND p.user_id = ?))
            ORDER BY CASE WHEN e.status = 'scheduled' THEN 0 ELSE 1 END, e.starts_at, e.id
            LIMIT 300`).all(includeArchived ? 1 : 0, manager ? 1 : 0, user.id, user.id, user.id);
          return sendJson(res, 200, { events: calendarEventListPayload(rows) });
        }

        if (pathname === "/api/calendar" && req.method === "POST") {
          if (!managementRoles.includes(user.role)) throw new HttpError(403, "Создавать мероприятия может только руководство.");
          const body = requireObject(await readJson(req));
          const eventType = String(body.eventType || "");
          const title = String(body.title || "").trim();
          const description = String(body.description || "").trim();
          const startsAt = normalizeDateTime(body.startsAt, "Дата мероприятия");
          const responsibleId = Number(body.responsibleId);
          if (body.isAllStaff !== undefined && typeof body.isAllStaff !== "boolean") {
            throw new HttpError(400, "Параметр показа всем сотрудникам должен быть логическим значением.");
          }
          const isAllStaff = body.isAllStaff === true;
          if (!calendarEventTypes.includes(eventType)) throw new HttpError(400, "Выберите тип мероприятия.");
          if (title.length < 3 || title.length > 150) throw new HttpError(400, "Название должно содержать от 3 до 150 символов.");
          if (description.length > 2000) throw new HttpError(400, "Описание не должно превышать 2000 символов.");
          const responsible = parseStaffIds(db, [responsibleId], { maximum: 1 })[0];
          const participantIds = parseStaffIds(db, body.participantIds ?? [], { required: false });
          const participants = [...new Set([responsible, ...participantIds])];
          let eventId;
          db.exec("BEGIN IMMEDIATE");
          try {
            const result = db.prepare(`INSERT INTO calendar_events
              (event_type,title,description,starts_at,is_all_staff,responsible_id,created_by)
              VALUES (?,?,?,?,?,?,?)`).run(eventType, title, description, startsAt, isAllStaff ? 1 : 0, responsible, user.id);
            eventId = Number(result.lastInsertRowid);
            const addParticipant = db.prepare("INSERT INTO calendar_event_participants (event_id,user_id,added_by) VALUES (?,?,?)");
            for (const participantId of participants) addParticipant.run(eventId, participantId, user.id);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          const event = db.prepare(`SELECT e.*, responsible.display_name AS responsible_name,
              creator.display_name AS creator_name FROM calendar_events e
            JOIN users responsible ON responsible.id = e.responsible_id
            JOIN users creator ON creator.id = e.created_by WHERE e.id = ?`).get(eventId);
          return sendJson(res, 201, { event: calendarEventPayload(event) });
        }

        const calendarRoute = pathname.match(/^\/api\/calendar\/(\d+)$/);
        if (calendarRoute && req.method === "GET") {
          const eventId = Number(calendarRoute[1]);
          if (!canAccessCalendarEvent(user, eventId)) throw new HttpError(404, "Мероприятие не найдено.");
          const event = db.prepare(`SELECT e.*, responsible.display_name AS responsible_name,
              creator.display_name AS creator_name FROM calendar_events e
            JOIN users responsible ON responsible.id = e.responsible_id
            JOIN users creator ON creator.id = e.created_by WHERE e.id = ?`).get(eventId);
          if (!event) throw new HttpError(404, "Мероприятие не найдено.");
          return sendJson(res, 200, { event: calendarEventPayload(event) });
        }

        if (calendarRoute && req.method === "PATCH") {
          if (!managementRoles.includes(user.role)) throw new HttpError(403, "Изменять мероприятия может только руководство.");
          const eventId = Number(calendarRoute[1]);
          const event = db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(eventId);
          if (!event) throw new HttpError(404, "Мероприятие не найдено.");
          const body = requireObject(await readJson(req));
          const eventType = body.eventType === undefined ? event.event_type : String(body.eventType);
          const title = body.title === undefined ? event.title : String(body.title).trim();
          const description = body.description === undefined ? event.description : String(body.description).trim();
          const startsAt = body.startsAt === undefined ? event.starts_at : normalizeDateTime(body.startsAt, "Дата мероприятия");
          const status = body.status === undefined ? event.status : String(body.status);
          if (body.isAllStaff !== undefined && typeof body.isAllStaff !== "boolean") {
            throw new HttpError(400, "Параметр показа всем сотрудникам должен быть логическим значением.");
          }
          const isAllStaff = body.isAllStaff === undefined ? Boolean(event.is_all_staff) : body.isAllStaff === true;
          let responsibleId = event.responsible_id;
          if (body.responsibleId !== undefined) responsibleId = parseStaffIds(db, [body.responsibleId], { maximum: 1 })[0];
          if (!calendarEventTypes.includes(eventType)) throw new HttpError(400, "Неизвестный тип мероприятия.");
          if (title.length < 3 || title.length > 150) throw new HttpError(400, "Название должно содержать от 3 до 150 символов.");
          if (description.length > 2000) throw new HttpError(400, "Описание не должно превышать 2000 символов.");
          if (!["scheduled", "completed", "cancelled"].includes(status)) throw new HttpError(400, "Неизвестный статус мероприятия.");
          let participantIds;
          if (body.participantIds !== undefined) {
            participantIds = parseStaffIds(db, body.participantIds, { required: false });
            participantIds = [...new Set([responsibleId, ...participantIds])];
          } else if (body.responsibleId !== undefined) {
            const currentParticipants = db.prepare("SELECT user_id FROM calendar_event_participants WHERE event_id = ?")
              .all(eventId).map((participant) => participant.user_id);
            participantIds = [...new Set([responsibleId, ...currentParticipants])];
          }
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare(`UPDATE calendar_events SET event_type=?,title=?,description=?,starts_at=?,status=?,
              is_all_staff=?,responsible_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
              .run(eventType, title, description, startsAt, status, isAllStaff ? 1 : 0, responsibleId, eventId);
            if (participantIds !== undefined) {
              db.prepare("DELETE FROM calendar_event_participants WHERE event_id = ?").run(eventId);
              const addParticipant = db.prepare("INSERT INTO calendar_event_participants (event_id,user_id,added_by) VALUES (?,?,?)");
              for (const participantId of participantIds) addParticipant.run(eventId, participantId, user.id);
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          const updated = db.prepare(`SELECT e.*, responsible.display_name AS responsible_name,
              creator.display_name AS creator_name FROM calendar_events e
            JOIN users responsible ON responsible.id = e.responsible_id
            JOIN users creator ON creator.id = e.created_by WHERE e.id = ?`).get(eventId);
          return sendJson(res, 200, { event: calendarEventPayload(updated) });
        }

        if (pathname === "/api/promotion-requirements" && req.method === "GET") {
          const settings = db.prepare("SELECT lawyer_calls_required, updated_at FROM promotion_settings WHERE id = 1").get();
          return sendJson(res, 200, {
            lawyerCallsRequired: Number(settings.lawyer_calls_required),
            updatedAt: settings.updated_at
          });
        }

        if (pathname === "/api/promotion-requirements" && req.method === "PATCH") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Менять норму вызовов может только руководство.");
          const body = await readJson(req);
          const lawyerCallsRequired = Number(body.lawyerCallsRequired);
          if (!Number.isInteger(lawyerCallsRequired) || lawyerCallsRequired < 1 || lawyerCallsRequired > 100) {
            throw new HttpError(400, "Укажите от 1 до 100 вызовов.");
          }
          db.prepare(`UPDATE promotion_settings SET lawyer_calls_required = ?, updated_by = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run(lawyerCallsRequired, user.id);
          return sendJson(res, 200, { lawyerCallsRequired });
        }

        if (pathname === "/api/career-path" && req.method === "GET") {
          if (!promotionPracticeStages.includes(user.role)) {
            throw new HttpError(403, "Пошаговый карьерный путь доступен стажёрам КА и юристам.");
          }
          const path = getCareerPathProgressRow(db, user.id, user.role);
          const lawyerPath = user.role === "Юрист";
          const passedSubjects = lawyerPath ? [] : getCareerLawPasses(db, user.id, user.role);
          const practice = getCareerRpPracticeState(db, user.id, user.role);
          const generalRpPractice = lawyerPath
            ? getGeneralRpPracticeState(db, user.id)
            : { cases: [], completedCaseIds: [], requiredCount: 0 };
          const slots = lawyerPath
            ? getPromotionPracticeSlots(db, user.id, user.role, 0, { lawBundle: true })
            : [];
          const application = lawyerPath
            ? findLawyerCareerPromotionApplication(db, user.id)
            : db.prepare(`SELECT status, promotion_data_json FROM applications
                WHERE user_id = ? AND type = 'exam' AND stage_role = ?
                ORDER BY id DESC LIMIT 1`).get(user.id, user.role);
          const promotionData = application
            ? parseStoredJson(application.promotion_data_json, "отчёт о повышении")
            : {};
          const completedEvidenceCount = slots.filter((slot) => !slot.skipped &&
            slot.partnerName.trim().length >= 2 && slot.hasImage).length;
          const practicesComplete = lawyerPath &&
            generalRpPractice.completedCaseIds.length >= generalRpPractice.requiredCount &&
            completedEvidenceCount >= careerLawyerJointCallsRequired;
          const interviewReady = Boolean(path.interview_ready_at);
          return sendJson(res, 200, {
            role: user.role,
            started: Boolean(path.started_at),
            tutorialSeen: Boolean(path.tutorial_seen_at),
            lawsReviewed: lawyerPath || Boolean(path.laws_reviewed_at),
            lawsReviewedAt: path.laws_reviewed_at || "",
            passedSubjects,
            allTestsPassed: lawyerPath || careerLawExamSubjects.every((subject) => passedSubjects.includes(subject)),
            completedCaseIds: practice.completedCaseIds,
            requiredCaseCount: lawyerPath ? 0 : practice.requiredCount,
            generalRpPracticeCases: generalRpPractice.cases.map((scenario) => ({
              ...scenario,
              completed: generalRpPractice.completedCaseIds.includes(scenario.id)
            })),
            generalRpPracticeCompletedCaseIds: generalRpPractice.completedCaseIds,
            generalRpPracticeRequiredCount: lawyerPath ? generalRpPractice.requiredCount : 0,
            completedEvidenceCount,
            requiredEvidenceCount: lawyerPath ? careerLawyerJointCallsRequired : 0,
            applicationStatus: application?.status || "",
            practiceSubmitted: Boolean(promotionData.practiceSubmittedAt),
            lawyerPromotionPath: lawyerPath,
            interviewReady,
            interviewPromptDismissed: Boolean(path.interview_prompt_dismissed_at),
            canRequestInterview: lawyerPath && practicesComplete && !interviewReady,
            interviewApplicationId: application?.id || null
          });
        }

        if (pathname === "/api/career-path/start" && req.method === "POST") {
          if (!promotionPracticeStages.includes(user.role)) {
            throw new HttpError(403, "Пошаговый карьерный путь доступен стажёрам КА и юристам.");
          }
          db.prepare(`INSERT INTO career_path_progress (user_id, stage_role, started_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, stage_role) DO UPDATE SET
              started_at = COALESCE(career_path_progress.started_at, CURRENT_TIMESTAMP)`)
            .run(user.id, user.role);
          return sendJson(res, 200, { started: true });
        }

        if (pathname === "/api/career-path/tutorial-seen" && req.method === "POST") {
          if (!promotionPracticeStages.includes(user.role)) {
            throw new HttpError(403, "Подсказки карьерного пути доступны стажёрам КА и юристам.");
          }
          db.prepare(`INSERT INTO career_path_progress (user_id, stage_role, tutorial_seen_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, stage_role) DO UPDATE SET
              tutorial_seen_at = COALESCE(career_path_progress.tutorial_seen_at, CURRENT_TIMESTAMP)`)
            .run(user.id, user.role);
          return sendJson(res, 200, { tutorialSeen: true });
        }

        if (pathname === "/api/career-path/study" && req.method === "POST") {
          if (user.role !== "Юрист") {
            throw new HttpError(403, "Отметка изучения законодательства предусмотрена для этапа юриста.");
          }
          db.prepare(`INSERT INTO career_path_progress (user_id, stage_role, laws_reviewed_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, stage_role) DO UPDATE SET
              laws_reviewed_at = COALESCE(career_path_progress.laws_reviewed_at, CURRENT_TIMESTAMP)`)
            .run(user.id, user.role);
          return sendJson(res, 200, { lawsReviewed: true });
        }

        if (pathname === "/api/career-path/interview-later" && req.method === "POST") {
          if (user.role !== "Юрист") {
            throw new HttpError(403, "Обзвон доступен только на этапе юриста.");
          }
          const generalPractice = getGeneralRpPracticeState(db, user.id);
          const slots = getPromotionPracticeSlots(db, user.id, user.role, 0, { lawBundle: true });
          const completedEvidenceCount = slots.filter((slot) => !slot.skipped &&
            slot.partnerName.trim().length >= 2 && slot.hasImage).length;
          if (generalPractice.completedCaseIds.length < generalPractice.requiredCount ||
              completedEvidenceCount < careerLawyerJointCallsRequired) {
            throw new HttpError(409, "Сначала пройдите 18 ситуационных кейсов и подтвердите два совместных вызова.");
          }
          const path = getCareerPathProgressRow(db, user.id, user.role);
          if (path.interview_ready_at) throw new HttpError(409, "Готовность к обзвону уже отмечена.");
          db.prepare(`UPDATE career_path_progress SET interview_prompt_dismissed_at = CURRENT_TIMESTAMP
            WHERE user_id = ? AND stage_role = ?`).run(user.id, user.role);
          return sendJson(res, 200, { dismissed: true });
        }

        if (pathname === "/api/career-path/interview-ready" && req.method === "POST") {
          if (user.role !== "Юрист") {
            throw new HttpError(403, "Обзвон доступен только на этапе юриста.");
          }
          const path = getCareerPathProgressRow(db, user.id, user.role);
          if (path.interview_ready_at) {
            return sendJson(res, 200, {
              ready: true,
              alreadyReady: true,
              applicationId: findLawyerCareerPromotionApplication(db, user.id)?.id || null
            });
          }
          const generalPractice = getGeneralRpPracticeState(db, user.id);
          const slots = getPromotionPracticeSlots(db, user.id, user.role, 0, { lawBundle: true });
          const completedEvidenceCount = slots.filter((slot) => !slot.skipped &&
            slot.partnerName.trim().length >= 2 && slot.hasImage).length;
          if (generalPractice.completedCaseIds.length < generalPractice.requiredCount ||
              completedEvidenceCount < careerLawyerJointCallsRequired) {
            throw new HttpError(409, "Сначала пройдите 18 ситуационных кейсов и подтвердите два совместных вызова.");
          }
          const interviewWebhook = webhooks.careerInterviews || webhooks.careerInterviewReady ||
            webhooks.attorneyInterview;
          if (!interviewWebhook) {
            throw new HttpError(503, "Не настроен Discord webhook для готовности к обзвону.");
          }
          const application = ensureLawyerCareerPromotionApplication(db, user);
          const candidateMention = user.discord_id ? `<@${user.discord_id}>` : user.display_name;
          const webhookWarning = await deliverWebhook(interviewWebhook, "Новая заявка на обзвон",
            `${candidateMention} готов(а) пройти обзвон перед повышением до адвоката.`,
            [
              { name: "Участник", value: user.display_name, inline: true },
              { name: "Переход", value: "Юрист → Адвокат", inline: true },
              { name: "Разбор ситуационных кейсов", value: `${generalPractice.completedCaseIds.length}/${generalPractice.requiredCount}`, inline: true },
              { name: "Совместные вызовы", value: `${completedEvidenceCount}/${careerLawyerJointCallsRequired}`, inline: true },
              { name: "Заявка", value: `#${application.id}`, inline: true },
              { name: "Канал обзвона", value: "[Открыть канал обзвона](https://discord.com/channels/1554369418186858586/1556226686201106432)", inline: false },
              { name: "Если не перенаправило", value: "Ожидайте в канале 🛎️Приёмная КА.", inline: false }
            ], null, {
              content: candidateMention,
              mentionUsers: user.discord_id ? [user.discord_id] : [],
              components: [{
                type: 1,
                components: [{
                  type: 2,
                  style: 5,
                  label: "Перейти в канал обзвона",
                  url: "https://discord.com/channels/1554369418186858586/1556226686201106432"
                }]
              }]
            });
          if (webhookWarning) {
            throw new HttpError(502, `Не удалось отправить уведомление в Discord: ${webhookWarning}`);
          }
          const readyAt = new Date().toISOString();
          const promotionData = parseStoredJson(application.promotion_data_json, "отчёт о повышении");
          promotionData.careerPathVersion = 2;
          promotionData.practiceSubmittedAt = readyAt;
          promotionData.interviewReadyAt = readyAt;
          delete promotionData.interviewDecision;
          delete promotionData.interviewAcceptedBy;
          delete promotionData.interviewAcceptedByName;
          delete promotionData.interviewAcceptedAt;
          delete promotionData.interviewResultBy;
          delete promotionData.interviewResultByName;
          delete promotionData.interviewResultAt;
          db.prepare(`UPDATE applications SET interview_status = 'ready', interview_ready_at = ?,
            promotion_data_json = ? WHERE id = ?`)
            .run(readyAt, JSON.stringify(promotionData), application.id);
          db.prepare(`UPDATE career_path_progress SET interview_ready_at = ?,
            interview_prompt_dismissed_at = NULL WHERE user_id = ? AND stage_role = 'Юрист'`)
            .run(readyAt, user.id);
          db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
            VALUES (?, ?, 'interview_ready', 'Участник отметил готовность к обзвону через карьерный путь.')`)
            .run(application.id, user.id);
          const notifications = await notifyPortalRoles(managementRoles, {
            type: "application",
            title: "Участник готов к обзвону",
            body: `${user.display_name} готов(а) к обзвону перед повышением до адвоката.`,
            href: "/page/appeals"
          }, user.id);
          const notificationWarning = notifications.map((notification) => notification.discordWarning)
            .filter(Boolean).join(" ");
          return sendJson(res, 200, {
            ready: true,
            applicationId: application.id,
            readyAt,
            webhookWarning: "",
            notificationWarning
          });
        }

        if (pathname === "/api/exams/start" && req.method === "POST") {
          if (user.role === "Юрист") {
            throw new HttpError(403, "Для перехода юриста в адвокаты тест не требуется. Выполните ситуационные кейсы, совместные вызовы и отметьте готовность к обзвону.");
          }
          if (!examBank[user.role] || !nextRank[user.role]) {
            throw new HttpError(403, "Для вашей роли нет программы повышения на портале.");
          }
          const body = await readJson(req);
          if (body.studyConfirmed !== true) throw new HttpError(400, "Сначала ознакомьтесь с материалами подготовки.");
          let application = db.prepare(`SELECT id FROM applications
            WHERE user_id = ? AND type = 'exam' AND stage_role = ? AND status = 'pending'
            ORDER BY id DESC LIMIT 1`).get(user.id, user.role);
          if (application) {
            const result = db.prepare("SELECT passed FROM exam_results WHERE application_id = ? ORDER BY id DESC LIMIT 1")
              .get(application.id);
            if (result?.passed) throw new HttpError(409, "Тест уже сдан. Продолжите следующий шаг заявки.");
            db.prepare("UPDATE applications SET study_read_at = COALESCE(study_read_at, CURRENT_TIMESTAMP) WHERE id = ?")
              .run(application.id);
            return sendJson(res, 200, { applicationId: application.id });
          }
          const promotionData = user.role === "Стажер КА" ? { lectureAttended: true } : {};
          const created = db.prepare(`INSERT INTO applications
            (user_id, type, requested_role, stage_role, study_read_at, interview_status, career_flow, details, promotion_data_json)
            VALUES (?, 'exam', ?, ?, CURRENT_TIMESTAMP, ?, 1, ?, ?)`)
            .run(user.id, nextRank[user.role], user.role,
              user.role === "Стажер КА" ? "not_required" : "waiting",
              `Самостоятельный экзамен: ${user.role} → ${nextRank[user.role]}.`, JSON.stringify(promotionData));
          const applicationId = Number(created.lastInsertRowid);
          const webhookWarning = await deliverWebhook(webhooks.applications, "Начат этап повышения",
            `${user.display_name} (${user.role}) открыл материалы и начал подготовку к тесту.`,
            [
              { name: "Участник", value: user.display_name, inline: true },
              { name: "Этап", value: `${user.role} → ${nextRank[user.role]}`, inline: true },
              { name: "Заявка", value: `#${applicationId}`, inline: true }
            ]);
          return sendJson(res, 201, { applicationId, webhookWarning });
        }

        if (pathname === "/api/promotion-practice" && req.method === "GET") {
          if (!promotionPracticeStages.includes(user.role)) {
            throw new HttpError(403, "Практика повышения доступна стажёрам КА и юристам.");
          }
          const application = db.prepare(`SELECT * FROM applications
            WHERE user_id = ? AND type = 'exam' AND stage_role = ? AND status = 'pending'
            ORDER BY id DESC LIMIT 1`).get(user.id, user.role);
          const readiness = getCareerPromotionReadiness(db, application);
          const promotionData = application
            ? parseStoredJson(application.promotion_data_json, "отчёт о повышении")
            : {};
          const lawyerPromotionPath = user.role === "Юрист" &&
            (!application || isLawyerCareerPromotion(application, promotionData));
          const lawBundle = user.role === "Стажер КА"
            ? application ? hasCareerLawBundle(promotionData) : true
            : lawyerPromotionPath;
          const practiceComplete = promotionPracticeIsComplete(db, user.id, user.role, { lawBundle });
          const rpPractice = getCareerRpPracticeState(db, user.id, user.role);
          const generalRpPractice = getGeneralRpPracticeState(db, user.id);
          const slots = getPromotionPracticeSlots(db, user.id, user.role, application?.id || 0, { lawBundle });
          const completedEvidence = slots.filter((slot) => !slot.skipped && slot.partnerName.trim().length >= 2 &&
            slot.hasImage).length;
          const path = user.role === "Юрист"
            ? getCareerPathProgressRow(db, user.id, user.role)
            : null;
          return sendJson(res, 200, {
            eligible: true,
            stageRole: user.role,
            slots,
            applicationId: application?.id || null,
            applicationStatus: application?.status || "",
            submittedAt: promotionData.practiceSubmittedAt || "",
            offerDeclinedAt: promotionData.offerDeclinedAt || "",
            lawBundle,
            lawyerPromotionPath,
            passedLawSubjects: getCareerLawPasses(db, user.id, user.role),
            rpPracticeCompletedCaseIds: rpPractice.completedCaseIds,
            rpPracticeCases: rpPractice.cases.map((scenario) => ({
              ...scenario,
              completed: rpPractice.completedCaseIds.includes(scenario.id)
            })),
            rpPracticeRequiredCount: user.role === "Стажер КА" && lawBundle ? rpPractice.requiredCount : 0,
            evidenceCompletedCount: completedEvidence,
            evidenceRequiredCount: lawBundle && user.role === "Юрист" ? careerLawyerJointCallsRequired : 0,
            practiceComplete,
            canSubmit: Boolean(user.role === "Стажер КА" && application &&
              readiness.ready && practiceComplete && !promotionData.practiceSubmittedAt),
            readinessMessage: readiness.reason,
            generalRpPracticeCases: generalRpPractice.cases.map((scenario) => ({
              ...scenario,
              completed: generalRpPractice.completedCaseIds.includes(scenario.id)
            })),
            generalRpPracticeCompletedCaseIds: generalRpPractice.completedCaseIds,
            generalRpPracticeRequiredCount: lawyerPromotionPath ? generalRpPractice.requiredCount : 0,
            canRequestInterview: Boolean(lawyerPromotionPath && !path?.interview_ready_at &&
              generalRpPractice.completedCaseIds.length >= generalRpPractice.requiredCount &&
              completedEvidence >= careerLawyerJointCallsRequired),
            interviewReady: Boolean(path?.interview_ready_at)
          });
        }

        if (pathname === "/api/promotion-practice/slots" && req.method === "POST") {
          if (!promotionPracticeStages.includes(user.role)) {
            throw new HttpError(403, "Практика повышения доступна стажёрам КА и юристам.");
          }
          if (user.role === "Стажер КА") {
            throw new HttpError(403, "Стажёру не нужно прикладывать задержания с адвокатом.");
          }
          requireCareerPracticeUnlocked(db, user);
          if (user.role === "Юрист") {
            const generalPractice = getGeneralRpPracticeState(db, user.id);
            if (generalPractice.completedCaseIds.length < generalPractice.requiredCount) {
              throw new HttpError(409, `Сначала пройдите все ${generalPractice.requiredCount} кейсов «Разбора ситуационных кейсов».`);
            }
          }
          const submittedApplication = db.prepare(`SELECT * FROM applications
            WHERE user_id = ? AND type = 'exam' AND stage_role = ? AND status = 'pending'
            ORDER BY id DESC LIMIT 1`).get(user.id, user.role);
          if (submittedApplication && careerPracticeSubmitted(submittedApplication)) {
            throw new HttpError(409, "Практика уже отправлена и закрыта для редактирования.");
          }
          const submittedData = submittedApplication
            ? parseStoredJson(submittedApplication.promotion_data_json, "отчёт о повышении")
            : {};
          const careerBundle = user.role === "Юрист"
            ? !submittedApplication || isLawyerCareerPromotion(submittedApplication, submittedData)
            : submittedApplication ? hasCareerLawBundle(submittedData) : true;
          if (careerBundle && user.role === "Стажер КА") {
            throw new HttpError(403, "Стажёру не нужно прикладывать задержания с адвокатом.");
          }
          if (careerBundle && user.role === "Юрист") {
            throw new HttpError(410, "Совместные вызовы подтверждаются одобренными отчётами адвокатов. Заполнять слоты вручную не нужно.");
          }
          const body = await readJson(req, 3 * 1024 * 1024);
          const slotNo = Number(body.slotNo);
          const maxSlot = careerBundle ? careerLawyerJointCallsRequired : 6;
          if (!Number.isInteger(slotNo) || slotNo < 1 || slotNo > maxSlot) {
            throw new HttpError(400, `Выберите один из ${maxSlot} слотов практики.`);
          }
          if (body.skip === true) {
            if (careerBundle) throw new HttpError(400, "Оба подтверждения вызовов с адвокатом обязательны.");
            if (slotNo <= 3) throw new HttpError(400, "Три обязательных слота нельзя пропустить.");
            db.prepare(`INSERT INTO promotion_practice_slots
              (user_id, stage_role, slot_no, partner_name, evidence_url, image_name, image_type, image_content, skipped)
              VALUES (?, ?, ?, '', '', '', '', NULL, 1)
              ON CONFLICT(user_id, stage_role, slot_no) DO UPDATE SET
                partner_name = '', evidence_url = '', image_name = '', image_type = '',
                image_content = NULL, skipped = 1, updated_at = CURRENT_TIMESTAMP`)
              .run(user.id, user.role, slotNo);
            return sendJson(res, 200, { ok: true, skipped: true, slotNo });
          }
          const partnerName = String(body.partnerName || "").trim();
          const evidenceUrl = String(body.evidenceUrl || "").trim();
          if (partnerName.length < 2 || partnerName.length > 80) {
            throw new HttpError(400, "Укажите имя другого адвоката (от 2 до 80 символов).");
          }
          if (evidenceUrl) throw new HttpError(400, "Ссылки на доказательства больше не принимаются — прикрепите фото.");
          let image = null;
          if (body.image !== undefined && body.image !== null) {
            image = parseApplicationAttachments([body.image], {
              maxFileBytes: 2 * 1024 * 1024,
              maxTotalBytes: 2 * 1024 * 1024
            })[0];
            if (!["image/jpeg", "image/png", "image/webp"].includes(image.contentType)) {
              throw new HttpError(400, "Скриншот должен быть в формате JPG, PNG или WebP.");
            }
          }
          const previous = db.prepare(`SELECT image_name, image_type, image_content
            FROM promotion_practice_slots WHERE user_id = ? AND stage_role = ? AND slot_no = ?`)
            .get(user.id, user.role, slotNo);
          const imageName = image?.name || previous?.image_name || "";
          const imageType = image?.contentType || previous?.image_type || "";
          const imageContent = image?.content || previous?.image_content || null;
          if (!imageContent) throw new HttpError(400, "Прикрепите фото-доказательство вызова.");
          db.prepare(`INSERT INTO promotion_practice_slots
            (user_id, stage_role, slot_no, partner_name, evidence_url, image_name, image_type, image_content, skipped)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(user_id, stage_role, slot_no) DO UPDATE SET
              partner_name = excluded.partner_name, evidence_url = excluded.evidence_url,
              image_name = excluded.image_name, image_type = excluded.image_type,
              image_content = excluded.image_content, skipped = 0, updated_at = CURRENT_TIMESTAMP`)
            .run(user.id, user.role, slotNo, partnerName, "", imageName, imageType, imageContent);
          return sendJson(res, 200, { ok: true, slotNo });
        }

        const submitPracticeRoute = pathname.match(/^\/api\/applications\/(\d+)\/promotion-practice\/submit$/);
        if (submitPracticeRoute && req.method === "POST") {
          const item = db.prepare("SELECT * FROM applications WHERE id = ?")
            .get(Number(submitPracticeRoute[1]));
          if (!item || item.user_id !== user.id || !isCareerPracticeApplication(item) ||
              item.stage_role !== user.role || item.status !== "pending") {
            throw new HttpError(404, "Заявка на повышение не найдена.");
          }
          const promotionData = parseStoredJson(item.promotion_data_json, "отчёт о повышении");
          if (promotionData.practiceSubmittedAt) throw new HttpError(409, "Заявка на повышение уже отправлена.");
          const lawBundle = hasCareerLawBundle(promotionData);
          if (isLawyerCareerPromotion(item, promotionData)) {
            throw new HttpError(409, "Для этапа юриста отметьте готовность к обзвону в разделе «Мой путь».");
          }
          if (!promotionPracticeIsComplete(db, user.id, item.stage_role, { lawBundle })) {
            throw new HttpError(409, lawBundle && item.stage_role === "Юрист"
              ? "Заполните оба обязательных подтверждения вызовов с адвокатом."
              : "Заполните практику текущего этапа.");
          }
          const readiness = getCareerPromotionReadiness(db, item);
          if (!readiness.ready) throw new HttpError(409, readiness.reason);
          promotionData.practiceSubmittedAt = new Date().toISOString();
          delete promotionData.offerDeclinedAt;
          db.prepare("UPDATE applications SET promotion_data_json = ? WHERE id = ?")
            .run(JSON.stringify(promotionData), item.id);
          db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
            VALUES (?, ?, 'practice_submitted', 'Практика задержаний приложена к заявке на повышение.')`)
            .run(item.id, user.id);
          const reviewerRoles = lawBundle
            ? managementRoles
            : item.stage_role === "Стажер КА"
              ? ["Ст.Адвокат", "ЗГКА", "ГКА"]
              : ["ЗГКА", "ГКА"];
          const webhookWarning = await deliverWebhook(webhooks.applications, "Заявка на повышение",
            `${user.display_name} (${item.stage_role}) отправил заявку на переход ${item.stage_role} → ${item.requested_role || nextRank[item.stage_role]}. Проверьте практику задержаний в портале.`,
            [
              { name: "Участник", value: user.display_name, inline: true },
              { name: "Переход", value: `${item.stage_role} → ${item.requested_role || nextRank[item.stage_role]}`, inline: true },
              { name: "Заявка", value: `#${item.id}`, inline: true },
              { name: "Практика", value: lawBundle
                ? item.stage_role === "Стажер КА"
                  ? "Один базовый AI Case пройден."
                  : "Три базовых AI Case пройдены; приложены подтверждения двух совместных вызовов с адвокатом."
                : "Практика задержаний приложена.", inline: false }
            ]);
          const notifications = await notifyPortalRoles(reviewerRoles, {
            type: "application",
            title: "Заявка на повышение",
            body: `${user.display_name} отправил заявку ${item.stage_role} → ${item.requested_role}.`,
            href: "/page/appeals"
          }, user.id);
          const notificationWarning = notifications.map((notification) => notification.discordWarning)
            .filter(Boolean).join(" ");
          return sendJson(res, 200, {
            ok: true,
            submittedAt: promotionData.practiceSubmittedAt,
            webhookWarning,
            notificationWarning
          });
        }

        const declinePromotionOfferRoute = pathname.match(/^\/api\/applications\/(\d+)\/promotion-practice\/decline$/);
        if (declinePromotionOfferRoute && req.method === "POST") {
          const item = db.prepare("SELECT * FROM applications WHERE id = ?")
            .get(Number(declinePromotionOfferRoute[1]));
          if (!item || item.user_id !== user.id || !isCareerPracticeApplication(item) ||
              item.stage_role !== user.role || item.status !== "pending") {
            throw new HttpError(404, "Предложение о повышении не найдено.");
          }
          const promotionData = parseStoredJson(item.promotion_data_json, "отчёт о повышении");
          if (isLawyerCareerPromotion(item, promotionData)) {
            throw new HttpError(409, "Для этапа юриста отметьте готовность к обзвону в разделе «Мой путь».");
          }
          if (!hasCareerLawBundle(promotionData) || promotionData.practiceSubmittedAt) {
            throw new HttpError(409, "Предложение о подаче заявки недоступно.");
          }
          const readiness = getCareerPromotionReadiness(db, item);
          const practiceComplete = promotionPracticeIsComplete(db, user.id, item.stage_role, { lawBundle: true });
          if (!readiness.ready || !practiceComplete) {
            throw new HttpError(409, readiness.reason || "Сначала выполните все условия повышения.");
          }
          promotionData.offerDeclinedAt = new Date().toISOString();
          db.prepare("UPDATE applications SET promotion_data_json = ? WHERE id = ?")
            .run(JSON.stringify(promotionData), item.id);
          return sendJson(res, 200, { declined: true });
        }

        const selfPracticeImageRoute = pathname.match(/^\/api\/promotion-practice\/slots\/(\d+)\/image$/);
        const applicationPracticeImageRoute = pathname.match(/^\/api\/applications\/(\d+)\/promotion-practice\/(\d+)\/image$/);
        if ((selfPracticeImageRoute || applicationPracticeImageRoute) && req.method === "GET") {
          let userId = user.id;
          let stageRole = user.role;
          let slotNo = Number(selfPracticeImageRoute?.[1] || applicationPracticeImageRoute?.[2]);
          if (applicationPracticeImageRoute) {
            const application = db.prepare("SELECT * FROM applications WHERE id = ?")
              .get(Number(applicationPracticeImageRoute[1]));
            if (!application || !isCareerPracticeApplication(application)) {
              throw new HttpError(404, "Скриншот практики не найден.");
            }
            if (application.user_id !== user.id) {
              if (!careerPracticeSubmitted(application)) {
                throw new HttpError(404, "Скриншот практики не найден.");
              }
              assertCanReview(hasGkaAccess(user) ? "ГКА" : user.role, application);
            }
            userId = application.user_id;
            stageRole = application.stage_role;
          }
          if (!promotionPracticeStages.includes(stageRole) || slotNo < 1 || slotNo > 6) {
            throw new HttpError(404, "Скриншот практики не найден.");
          }
          const image = db.prepare(`SELECT image_name, image_type, image_content
            FROM promotion_practice_slots
            WHERE user_id = ? AND stage_role = ? AND slot_no = ? AND image_content IS NOT NULL`)
            .get(userId, stageRole, slotNo);
          if (!image) throw new HttpError(404, "Скриншот практики не найден.");
          const fallbackName = image.image_name.replace(/[^A-Za-z0-9._-]/g, "_") || "practice-proof";
          res.writeHead(200, {
            "content-type": image.image_type,
            "content-length": image.image_content.length,
            "content-disposition": `inline; filename="${fallbackName}"`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff"
          });
          return res.end(image.image_content);
        }

        if (pathname === "/api/promotion-decree" && req.method === "GET") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Указы может формировать только ГКА.");
          const { nextNumber, candidates } = getPromotionDecreeCandidates();
          const roleTransitions = promotionDecreeRoles.slice(0, -1).flatMap((fromRole, index) =>
            promotionDecreeRoles.slice(index + 1).map((toRole) => ({ fromRole, toRole })));
          const history = db.prepare(`SELECT d.id, d.decree_number, d.sent_at, COUNT(i.id) AS item_count
            FROM promotion_decrees d LEFT JOIN promotion_decree_items i ON i.decree_id = d.id
            GROUP BY d.id ORDER BY d.id DESC LIMIT 20`).all();
          return sendJson(res, 200, {
            nextNumber, candidates, members: getPromotionDecreeMembers(), roleTransitions, history
          });
        }

        if (pathname === "/api/promotion-decree/preview" && req.method === "POST") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Указы может формировать только ГКА.");
          const body = await readJson(req);
          const entries = resolvePromotionDecreeSelection(body.applicationIds, body.passports, body.manualEntries);
          const { nextNumber } = getPromotionDecreeCandidates();
          return sendJson(res, 200, {
            decreeNumber: nextNumber,
            count: entries.length,
            bbcode: buildPromotionDecree(entries, nextNumber),
            entries
          });
        }

        if (pathname === "/api/promotion-decree/send" && req.method === "POST") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Указы может формировать только ГКА.");
          if (promotionDecreeSending) throw new HttpError(409, "Указ уже отправляется. Подождите завершения.");
          if (!discord.botToken) throw new HttpError(503, "Discord-бот не настроен на сервере.");
          if (!/^\d{15,22}$/.test(user.discord_id || "")) {
            throw new HttpError(409, "Привяжите Discord в профиле, чтобы получить указ в личные сообщения.");
          }
          const body = await readJson(req);
          const entries = resolvePromotionDecreeSelection(body.applicationIds, body.passports, body.manualEntries);
          const { nextNumber } = getPromotionDecreeCandidates();
          const bbcode = buildPromotionDecree(entries, nextNumber);
          promotionDecreeSending = true;
          try {
            const decreeNumber = String(nextNumber).padStart(3, "0");
            const warning = await sendDiscordDirectMessage(
              user.discord_id,
              user,
              user.discord_avatar_url,
              `Указ №${decreeNumber} сформирован`,
              `В указ включено повышений: ${entries.length}. BBCode приложен файлом для копирования.`,
              {
                token: discord.botToken,
                fetchImpl: discordFetch,
                content: `Указ №${decreeNumber} · Коллегия адвокатов`,
                file: {
                  name: `ukaz-${decreeNumber}.txt`,
                  content: Buffer.from(bbcode, "utf8"),
                  contentType: "text/plain; charset=utf-8"
                }
              }
            );
            if (warning) throw new HttpError(502, warning);
            db.exec("BEGIN IMMEDIATE");
            try {
              const inserted = db.prepare(`INSERT INTO promotion_decrees
                (decree_number, bbcode, sent_by) VALUES (?, ?, ?)`)
                .run(nextNumber, bbcode, user.id);
              const decreeId = Number(inserted.lastInsertRowid);
              const insertItem = db.prepare(`INSERT INTO promotion_decree_items
                (decree_id, application_id, user_id, character_name, passport_id, from_role, to_role)
                VALUES (?, ?, ?, ?, ?, ?, ?)`);
              for (const entry of entries) {
                insertItem.run(decreeId, entry.applicationId || null, entry.userId || null,
                  entry.characterName, entry.passportId, entry.fromRole, entry.toRole);
              }
              db.prepare("UPDATE promotion_decree_state SET next_number = next_number + 1 WHERE id = 1")
                .run();
              db.exec("COMMIT");
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
            const logWarning = await deliverWebhook(webhooks.logs, `Указ №${decreeNumber} отправлен`,
              `${user.display_name} сформировал указ о повышении (${entries.length} записей).`);
            return sendJson(res, 200, { ok: true, decreeNumber, count: entries.length, logWarning });
          } finally {
            promotionDecreeSending = false;
          }
        }

        if (pathname === "/api/applications" && req.method === "GET") {
          const includeArchived = requestUrl.searchParams.get("archived") === "1";
          if (includeArchived && !hasGkaAccess(user)) throw new HttpError(403, "Архив заявок доступен только ГКА.");
          let rows = db.prepare(`SELECT a.*, u.display_name, u.username, u.role AS current_role,
              u.discord_username AS applicant_discord_username,
              assigned.id AS assigned_user_id,
              assigned.display_name AS assigned_name,
              assigned.discord_username AS assigned_discord_username,
              requested.display_name AS requested_lawyer_name,
              (SELECT rating FROM lawyer_reviews r WHERE r.application_id = a.id AND r.reviewer_id = ?) AS my_rating,
              (SELECT comment FROM lawyer_reviews r WHERE r.application_id = a.id AND r.reviewer_id = ?) AS my_review
            FROM applications a JOIN users u ON u.id = a.user_id
            LEFT JOIN users assigned ON assigned.id = a.assigned_to
            LEFT JOIN users requested ON requested.id = a.requested_lawyer_id
            WHERE (? = 1 OR a.archived_at IS NULL)
            ORDER BY a.created_at DESC LIMIT 300`).all(user.id, user.id, includeArchived ? 1 : 0);
          if (!["ГКА", "ЗГКА"].includes(user.role)) {
            const citizenCase = (item) => ["citizen_help", "citizen_complaint"].includes(item.type);
            if (user.role === "Ст.Адвокат") rows = rows.filter((item) =>
              item.type === "practice" || item.type === "training" || citizenCase(item) ||
              (isCareerPracticeApplication(item) && item.stage_role === "Стажер КА" &&
                careerPracticeSubmitted(item)) || item.user_id === user.id);
            else if (user.role === "Адвокат") rows = rows.filter((item) => item.type === "practice" || citizenCase(item) || item.user_id === user.id);
            else rows = rows.filter((item) => item.user_id === user.id);
          }
          rows = rows.map((item) => {
            const promotionData = parseStoredJson(item.promotion_data_json, "отчёт о повышении");
            const canSeePractice = isCareerPracticeApplication(item) &&
              (item.user_id === user.id || careerPracticeSubmitted(item));
            const lawBundle = hasCareerLawBundle(promotionData);
            const lawyerPromotionPath = canSeePractice && isLawyerCareerPromotion(item, promotionData);
            const careerPathBundle = canSeePractice && (lawBundle || lawyerPromotionPath);
            const careerRpProgress = canSeePractice && lawBundle && item.stage_role === "Стажер КА"
              ? getCareerRpPracticeState(db, item.user_id, item.stage_role)
              : null;
            const generalRpProgress = lawyerPromotionPath
              ? getGeneralRpPracticeState(db, item.user_id)
              : null;
            const careerLawPassedSubjects = canSeePractice && item.stage_role === "Стажер КА"
              ? getCareerLawPasses(db, item.user_id, item.stage_role)
              : [];
            const promotionPractice = canSeePractice
              ? getPromotionPracticeSlots(db, item.user_id, item.stage_role, item.id, {
                lawBundle: careerPathBundle
              })
              : [];
            const careerRequirementsComplete = canSeePractice && careerPathBundle
              ? lawyerPromotionPath
                ? generalRpProgress.completedCaseIds.length >= generalRpProgress.requiredCount &&
                  promotionPracticeIsComplete(db, item.user_id, item.stage_role, { lawBundle: true })
                : careerLawExamSubjects.every((subject) => careerLawPassedSubjects.includes(subject)) &&
                careerRpProgress.completedCaseIds.length >= careerRpProgress.requiredCount &&
                promotionPracticeIsComplete(db, item.user_id, item.stage_role, { lawBundle: true })
              : null;
            return {
              ...item,
              applicant_discord_username: item.user_id === user.id || item.assigned_to === user.id ||
                ["ГКА", "ЗГКА"].includes(user.role) ? item.applicant_discord_username : "",
              promotion_data: promotionData,
              career_path_type: lawyerPromotionPath
                ? "lawyer-interview"
                : lawBundle ? "trainee-law-bundle" : "",
              review_data: parseStoredJson(item.review_data_json, "проверка заявки"),
              promotion_practice: promotionPractice,
              career_law_passed_subjects: careerLawPassedSubjects,
              rp_practice_cases: careerRpProgress
                ? careerRpProgress.cases.map((scenario) => ({
                  ...scenario,
                  completed: careerRpProgress.completedCaseIds.includes(scenario.id)
                }))
                : [],
              career_requirements_complete: careerRequirementsComplete,
              rp_practice_completed_count: careerRpProgress?.completedCaseIds.length || 0,
              rp_practice_required_count: careerRpProgress?.requiredCount || 0,
              general_rp_practice_cases: generalRpProgress
                ? generalRpProgress.cases.map((scenario) => ({
                  ...scenario,
                  completed: generalRpProgress.completedCaseIds.includes(scenario.id)
                }))
                : [],
              general_rp_practice_completed_count: generalRpProgress?.completedCaseIds.length || 0,
              general_rp_practice_required_count: generalRpProgress?.requiredCount || 0,
              attachments: db.prepare(`SELECT id, file_name, content_type, length(content) AS size
                FROM application_attachments WHERE application_id = ? ORDER BY id`).all(item.id)
            };
          });
          return sendJson(res, 200, { applications: rows });
        }

        if (pathname === "/api/applications" && req.method === "POST") {
          const body = await readJson(req, 7 * 1024 * 1024);
          const type = String(body.type || "");
          const details = String(body.details || "").trim();
          if (!roleActions[user.role]?.includes(type)) throw new HttpError(403, "Этот тип заявки недоступен для вашей роли.");
          if (details.length < 4 || details.length > 2000) throw new HttpError(400, "Описание должно содержать от 4 до 2000 символов.");
          const passportId = String(body.passportId || "").trim();
          if (passportId.length > 40) throw new HttpError(400, "Номер паспорта не должен превышать 40 символов.");
          const requestedRole = type === "promotion" ? nextRank[user.role] : null;
          if (type === "promotion" && !requestedRole) throw new HttpError(403, "Для вашей роли повышение по заявке не предусмотрено.");
          const promotionData = {};
          if (type === "employment") {
            const discordUsername = String(body.discordUsername || "").trim();
            const gtaName = String(body.gtaName || "").trim();
            if (!/^[a-zA-Z0-9._]{2,32}$/.test(discordUsername)) {
              throw new HttpError(400, "Укажите Discord-ник: 2–32 символа, латиница, цифры, точка или подчёркивание.");
            }
            if (gtaName.length < 2 || gtaName.length > 80) {
              throw new HttpError(400, "Укажите игровое имя GTA 5 RP длиной от 2 до 80 символов.");
            }
            if (passportId.length < 1) throw new HttpError(400, "Укажите номер паспорта персонажа GTA 5 RP.");
            promotionData.discordUsername = discordUsername;
            promotionData.gtaName = gtaName;
          } else if (type === "exam" && user.role === "Стажер КА") {
            if (body.promotionData?.lectureAttended !== true) {
              throw new HttpError(400, "Перед заявкой подтвердите, что прослушали лекцию руководящего состава.");
            }
            promotionData.lectureAttended = true;
          } else if (type === "exam" && user.role === "Юрист") {
            const requiredCalls = Number(db.prepare("SELECT lawyer_calls_required FROM promotion_settings WHERE id = 1").get().lawyer_calls_required);
            if (!requiredCalls) throw new HttpError(409, "ГКА ещё не установил необходимое число вызовов для юриста.");
            const completedCalls = Number(body.promotionData?.completedCalls);
            const trialLawsuitReference = String(body.promotionData?.trialLawsuitReference || "").trim();
            if (!Number.isInteger(completedCalls) || completedCalls < requiredCalls) {
              throw new HttpError(400, `Для заявки нужно отработать не менее ${requiredCalls} вызовов.`);
            }
            if (trialLawsuitReference.length < 3 || trialLawsuitReference.length > 300) {
              throw new HttpError(400, "Укажите ссылку или номер пробного искового заявления.");
            }
            promotionData.completedCalls = completedCalls;
            promotionData.requiredCalls = requiredCalls;
            promotionData.trialLawsuitReference = trialLawsuitReference;
          } else if (type === "promotion" && user.role === "Адвокат") {
            const completedCalls = Number(body.promotionData?.completedCalls);
            const callsWithLawyer = Number(body.promotionData?.callsWithLawyer);
            const acceptedLawsuitReference = String(body.promotionData?.acceptedLawsuitReference || "").trim();
            if (!Number.isInteger(completedCalls) || completedCalls < 25) {
              throw new HttpError(400, "Для повышения до старшего адвоката требуется не менее 25 вызовов.");
            }
            if (!Number.isInteger(callsWithLawyer) || callsWithLawyer < 5 || callsWithLawyer > completedCalls) {
              throw new HttpError(400, "Укажите не менее 5 вызовов, отработанных совместно с юристом.");
            }
            if (acceptedLawsuitReference.length < 3 || acceptedLawsuitReference.length > 300) {
              throw new HttpError(400, "Укажите номер или ссылку на принятое исковое заявление.");
            }
            const approvedExam = db.prepare(`SELECT review_data_json FROM applications
              WHERE user_id = ? AND type = 'exam' AND status = 'approved' ORDER BY reviewed_at DESC`).all(user.id)
              .some((application) => parseStoredJson(application.review_data_json, "проверка экзамена").stage === "Адвокат");
            if (!approvedExam) throw new HttpError(409, "Сначала пройдите тест и получите одобрение проверки знаний.");
            promotionData.completedCalls = completedCalls;
            promotionData.callsWithLawyer = callsWithLawyer;
            promotionData.acceptedLawsuitReference = acceptedLawsuitReference;
          }
          const attachments = parseApplicationAttachments(body.attachments);
          let requestedLawyerId = null;
          if (["citizen_help", "citizen_complaint"].includes(type) && body.lawyerId !== undefined && body.lawyerId !== null && body.lawyerId !== "") {
            requestedLawyerId = Number(body.lawyerId);
            if (!Number.isSafeInteger(requestedLawyerId) ||
                !db.prepare("SELECT id FROM users WHERE id = ? AND status = 'active' AND role IN ('Адвокат','Ст.Адвокат')").get(requestedLawyerId)) {
              throw new HttpError(400, "Выбранный адвокат недоступен. Обновите список и выберите другого.");
            }
          }
          const pending = db.prepare("SELECT id FROM applications WHERE user_id = ? AND type = ? AND status = 'pending'").get(user.id, type);
          if (pending) throw new HttpError(409, "У вас уже есть такая заявка на рассмотрении.");
          const title = type === "promotion" ? `Заявка на повышение: ${requestedRole}` : applicationNames[type];
          db.exec("BEGIN");
          let created;
          try {
            created = db.prepare(`INSERT INTO applications
              (user_id, type, requested_role, stage_role, study_read_at, details, requested_lawyer_id, passport_id, promotion_data_json)
              VALUES (?, ?, ?, ?, CASE WHEN ? = 'exam' THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?, ?, ?)`)
              .run(user.id, type, requestedRole, type === "exam" ? user.role : "", type,
                details, requestedLawyerId, passportId, JSON.stringify(promotionData));
            const insertAttachment = db.prepare(`INSERT INTO application_attachments
              (application_id, file_name, content_type, content) VALUES (?, ?, ?, ?)`);
            for (const attachment of attachments) {
              insertAttachment.run(Number(created.lastInsertRowid), attachment.name, attachment.contentType, attachment.content);
            }
            db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
              VALUES (?, ?, 'created', ?)`)
              .run(Number(created.lastInsertRowid), user.id, `Заявка создана: ${title}.`);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          const appId = Number(created.lastInsertRowid);
          const webhookWarning = await deliverWebhook(
            webhooks.applications,
            `Новая заявка: ${title}`,
            `${user.display_name} (${user.role})\n${details}`,
            type === "promotion" ? [
              { name: "Участник", value: user.display_name, inline: true },
              { name: "Текущая роль", value: user.role, inline: true },
              { name: "Запрашиваемая роль", value: requestedRole, inline: true },
              { name: "Отчёт", value: details.slice(0, 1000), inline: false },
              { name: "Вызовы", value: `${promotionData.completedCalls} всего · ${promotionData.callsWithLawyer} с юристом`, inline: true },
              { name: "Принятый иск", value: promotionData.acceptedLawsuitReference, inline: false },
              { name: "Вложения", value: attachments.map((attachment) => attachment.name).join(", ") || "нет", inline: false }
            ] : type === "employment" ? [
              { name: "🎮 Discord", value: `@${promotionData.discordUsername}`, inline: true },
              { name: "👤 Имя в GTA 5 RP", value: promotionData.gtaName, inline: true },
              { name: "Аккаунт портала", value: `#${user.id}`, inline: true }
            ] : requestedLawyerId ? [
              { name: "Выбранный адвокат", value: db.prepare("SELECT display_name FROM users WHERE id = ?").get(requestedLawyerId).display_name, inline: true }
            ] : [
              { name: "Паспорт персонажа", value: passportId || "не указан", inline: true },
              { name: "Вложения", value: attachments.map((attachment) => attachment.name).join(", ") || "нет", inline: false }
            ]
          );
          await notifyPortalRoles(managementRoles, {
            type: "application",
            title: `Новая заявка: ${title}`,
            body: `${user.display_name} (${user.role}) отправил заявку на рассмотрение.`,
            href: "/page/appeals"
          }, user.id);
          return sendJson(res, 201, { id: appId, webhookWarning });
        }

        const interviewRoute = pathname.match(/^\/api\/applications\/(\d+)\/interview$/);
        if (interviewRoute && req.method === "PATCH") {
          const item = db.prepare("SELECT * FROM applications WHERE id = ?").get(Number(interviewRoute[1]));
          if (!item || item.user_id !== user.id || item.type !== "exam" || !item.career_flow) {
            throw new HttpError(404, "Этап повышения не найден.");
          }
          if (item.stage_role === "Стажер КА") throw new HttpError(409, "Стажёру не требуется обзвон.");
          const promotionData = parseStoredJson(item.promotion_data_json, "отчёт о повышении");
          const lawBundle = Array.isArray(promotionData.lawTests) &&
            careerLawExamSubjects.every((subject) => promotionData.lawTests.includes(subject));
          const careerTestsPassed = lawBundle
            ? careerLawExamSubjects.every((subject) =>
              db.prepare(`SELECT 1 FROM career_law_exam_passes
                WHERE user_id = ? AND stage_role = ? AND subject = ?`)
                .get(item.user_id, item.stage_role, subject))
            : Boolean(db.prepare("SELECT passed FROM exam_results WHERE application_id = ? ORDER BY id DESC LIMIT 1")
              .get(item.id)?.passed);
          if (item.status !== "pending" || !careerTestsPassed) {
            throw new HttpError(409, "Сначала успешно сдайте тест.");
          }
          const body = await readJson(req);
          if (!["ready", "waiting"].includes(body.status)) {
            throw new HttpError(400, "Выберите готовность к обзвону или ожидание.");
          }
          if (lawBundle && body.status === "ready") {
            const requiredCalls = Number(db.prepare("SELECT lawyer_calls_required FROM promotion_settings WHERE id = 1")
              .get().lawyer_calls_required);
            if (!requiredCalls || Number(promotionData.completedCalls) < requiredCalls ||
                !promotionData.trialLawsuitReference) {
              throw new HttpError(409, "Сначала сохраните норму вызовов и пробный иск в отчёте.");
            }
          }
          if (item.interview_status !== body.status) {
            db.prepare(`UPDATE applications SET interview_status = ?,
              interview_ready_at = CASE WHEN ? = 'ready' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?`)
              .run(body.status, body.status, item.id);
            const state = body.status === "ready" ? "готов к обзвону" : "пока не может пройти обзвон";
            const logWarning = await deliverWebhook(webhooks.logs, "Готовность к обзвону",
              `${user.display_name} (${item.stage_role}) ${state} на этапе повышения до ${item.requested_role}.`,
              [
                { name: "Участник", value: user.display_name, inline: true },
                { name: "Этап", value: `${item.stage_role} → ${item.requested_role || "следующий ранг"}`, inline: true },
                { name: "Состояние", value: body.status === "ready" ? "Готов сейчас" : "Ожидает удобного времени", inline: true },
                { name: "Заявка", value: `#${item.id}`, inline: true }
              ]);
            if (body.status === "ready") {
              await deliverWebhook(webhooks.attorneyInterview, "Вызов на обзвон",
                `${user.display_name} отмечен(а) готовым(ой) к обзвону.`,
                [
                  { name: "Участник", value: `${user.display_name} (${item.stage_role})`, inline: true },
                  { name: "Повышение", value: `${item.stage_role} → ${item.requested_role || "следующий ранг"}`, inline: true },
                  { name: "Заявка", value: `#${item.id}`, inline: true }
                ]);
            }
            return sendJson(res, 200, { ok: true, interviewStatus: body.status, logWarning });
          }
          return sendJson(res, 200, { ok: true, interviewStatus: item.interview_status });
        }

        const promotionDataRoute = pathname.match(/^\/api\/applications\/(\d+)\/promotion-data$/);
        if (promotionDataRoute && req.method === "PATCH") {
          const item = db.prepare("SELECT * FROM applications WHERE id = ?").get(Number(promotionDataRoute[1]));
          const itemPromotionData = item
            ? parseStoredJson(item.promotion_data_json, "отчёт по этапу повышения")
            : {};
          const lawBundle = Array.isArray(itemPromotionData.lawTests) &&
            careerLawExamSubjects.every((subject) => itemPromotionData.lawTests.includes(subject));
          if (!item || item.user_id !== user.id || item.type !== "exam" ||
              !item.career_flow || item.stage_role !== "Юрист" ||
              !(lawBundle || Number(item.career_flow) === 1)) {
            throw new HttpError(404, "Отчёт по этапу повышения не найден.");
          }
          const passedCurrentLawTests = lawBundle && careerLawExamSubjects.every((subject) =>
            db.prepare(`SELECT 1 FROM career_law_exam_passes
              WHERE user_id = ? AND stage_role = ? AND subject = ?`).get(item.user_id, item.stage_role, subject));
          const passedCareerTest = !lawBundle &&
            db.prepare("SELECT passed FROM exam_results WHERE application_id = ? ORDER BY id DESC LIMIT 1").get(item.id)?.passed;
          if (item.status !== "pending" || !(passedCurrentLawTests || passedCareerTest)) {
            throw new HttpError(409, "Сначала успешно сдайте тест.");
          }
          const body = await readJson(req);
          const requiredCalls = Number(db.prepare("SELECT lawyer_calls_required FROM promotion_settings WHERE id = 1")
            .get().lawyer_calls_required);
          const completedCalls = Number(body.completedCalls);
          const trialLawsuitReference = String(body.trialLawsuitReference || "").trim();
          if (!requiredCalls) throw new HttpError(409, "Руководство ещё не установило норму вызовов для юриста.");
          if (!Number.isInteger(completedCalls) || completedCalls < requiredCalls) {
            throw new HttpError(400, `Укажите не менее ${requiredCalls} отработанных вызовов.`);
          }
          if (trialLawsuitReference.length < 3 || trialLawsuitReference.length > 300) {
            throw new HttpError(400, "Укажите ссылку или номер пробного искового заявления.");
          }
          const promotionData = parseStoredJson(item.promotion_data_json, "отчёт о повышении");
          promotionData.completedCalls = completedCalls;
          promotionData.requiredCalls = requiredCalls;
          promotionData.trialLawsuitReference = trialLawsuitReference;
          db.prepare("UPDATE applications SET promotion_data_json = ? WHERE id = ?")
            .run(JSON.stringify(promotionData), item.id);
          return sendJson(res, 200, { ok: true });
        }

        const chatRoute = pathname.match(/^\/api\/applications\/(\d+)\/messages$/);
        if (chatRoute && req.method === "GET") {
          const item = db.prepare("SELECT id, user_id, assigned_to, completed_at FROM applications WHERE id = ?")
            .get(Number(chatRoute[1]));
          const manager = ["ГКА", "ЗГКА"].includes(user.role);
          if (!item || (item.user_id !== user.id && item.assigned_to !== user.id && !manager)) {
            throw new HttpError(404, "Чат обращения не найден.");
          }
          if (!item.assigned_to) throw new HttpError(409, "Чат откроется после того, как адвокат возьмёт обращение.");
          const messages = db.prepare(`SELECT m.id, m.kind, m.message, m.created_at,
              m.sender_id, sender.display_name AS sender_name, sender.role AS sender_role,
              sender.discord_username AS sender_discord_username
            FROM application_messages m JOIN users sender ON sender.id = m.sender_id
            WHERE m.application_id = ? ORDER BY m.id DESC LIMIT 200`).all(item.id).reverse();
          return sendJson(res, 200, {
            applicationId: item.id,
            completed: Boolean(item.completed_at),
            canClose: item.assigned_to === user.id && !item.completed_at,
            messages
          });
        }
        if (chatRoute && req.method === "POST") {
          const item = db.prepare("SELECT id, user_id, assigned_to, completed_at FROM applications WHERE id = ?")
            .get(Number(chatRoute[1]));
          if (!item || (item.user_id !== user.id && item.assigned_to !== user.id)) {
            throw new HttpError(404, "Чат обращения не найден.");
          }
          if (!item.assigned_to || item.completed_at) throw new HttpError(409, "Чат закрыт или ещё не назначен.");
          const body = await readJson(req);
          const message = String(body.message || "").trim();
          if (message.length < 1 || message.length > 2000) throw new HttpError(400, "Сообщение должно содержать от 1 до 2000 символов.");
          const result = db.prepare(`INSERT INTO application_messages
            (application_id, sender_id, kind, message) VALUES (?, ?, 'message', ?)`)
            .run(item.id, user.id, message);
          const recipient = item.user_id === user.id
            ? db.prepare("SELECT display_name FROM users WHERE id = ?").get(item.assigned_to).display_name
            : db.prepare("SELECT display_name FROM users WHERE id = ?").get(item.user_id).display_name;
          const recipientAccount = item.user_id === user.id
            ? db.prepare("SELECT discord_id, discord_avatar_url, display_name, role, username FROM users WHERE id = ?").get(item.assigned_to)
            : db.prepare("SELECT discord_id, discord_avatar_url, display_name, role, username FROM users WHERE id = ?").get(item.user_id);
          if (recipientAccount?.discord_id) {
            const recipientId = item.user_id === user.id ? item.assigned_to : item.user_id;
            await sendPortalDirectMessage(
              recipientId,
              recipientAccount,
              recipientAccount.discord_avatar_url,
              `Ответ по обращению #${item.id}`,
              `${user.display_name}: ${message}`
            );
          }
          const webhookWarning = await deliverWebhook(webhooks.applications, "Сообщение по обращению",
            `${user.display_name} отправил сообщение в обращении #${item.id}.`,
            [
              { name: "Отправитель", value: user.display_name, inline: true },
              { name: "Получатель", value: recipient, inline: true },
              { name: "Обращение", value: `#${item.id}`, inline: true }
            ]);
          return sendJson(res, 201, { id: Number(result.lastInsertRowid), webhookWarning });
        }

        const contactRoute = pathname.match(/^\/api\/applications\/(\d+)\/contact$/);
        if (contactRoute && req.method === "POST") {
          const item = db.prepare("SELECT id, user_id, assigned_to, completed_at FROM applications WHERE id = ?")
            .get(Number(contactRoute[1]));
          if (!item || (item.user_id !== user.id && item.assigned_to !== user.id)) {
            throw new HttpError(404, "Чат обращения не найден.");
          }
          if (!item.assigned_to || item.completed_at) throw new HttpError(409, "Передать контакт можно только в открытом обращении.");
          const body = await readJson(req);
          if (!["contact", "discord"].includes(body.type)) {
            throw new HttpError(400, "Выберите передачу контакта Discord.");
          }
          const discordUsername = String(user.discord_username || "").trim();
          const alias = discordUsername.toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 32);
          if (!user.discord_id || !alias) throw new HttpError(409, "Сначала привяжите Discord в профиле.");
          const message = `Контакт для связи: ${alias}@sa.com (Discord: ${discordUsername})`;
          const result = db.prepare(`INSERT INTO application_messages
            (application_id, sender_id, kind, message) VALUES (?, ?, 'contact', ?)`)
            .run(item.id, user.id, message);
          return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
        }

        const attachmentRoute = pathname.match(/^\/api\/applications\/(\d+)\/attachments\/(\d+)$/);
        if (attachmentRoute && req.method === "GET") {
          const applicationId = Number(attachmentRoute[1]);
          const attachmentId = Number(attachmentRoute[2]);
          const application = db.prepare("SELECT id, user_id, assigned_to FROM applications WHERE id = ?").get(applicationId);
          if (!application || (application.user_id !== user.id && application.assigned_to !== user.id &&
              !["ГКА", "ЗГКА"].includes(user.role))) {
            throw new HttpError(404, "Вложение не найдено.");
          }
          const attachment = db.prepare(`SELECT file_name, content_type, content
            FROM application_attachments WHERE id = ? AND application_id = ?`).get(attachmentId, applicationId);
          if (!attachment) throw new HttpError(404, "Вложение не найдено.");
          const fallbackName = attachment.file_name.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
          res.writeHead(200, {
            "content-type": attachment.content_type,
            "content-length": attachment.content.length,
            "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff"
          });
          return res.end(attachment.content);
        }

        const applicationHistoryRoute = pathname.match(/^\/api\/applications\/(\d+)\/history$/);
        if (applicationHistoryRoute && req.method === "GET") {
          const item = db.prepare("SELECT id, user_id, assigned_to FROM applications WHERE id = ?")
            .get(Number(applicationHistoryRoute[1]));
          if (!item || (item.user_id !== user.id && item.assigned_to !== user.id &&
              !["ГКА", "ЗГКА"].includes(user.role))) {
            throw new HttpError(404, "История обращения не найдена.");
          }
          const history = db.prepare(`SELECT h.id, h.event_type, h.details, h.created_at,
              actor.display_name AS actor_name, actor.role AS actor_role
            FROM application_history h LEFT JOIN users actor ON actor.id = h.actor_id
            WHERE h.application_id = ? ORDER BY h.id`).all(item.id);
          return sendJson(res, 200, { history });
        }

        const applicationWorkflowRoute = pathname.match(/^\/api\/applications\/(\d+)\/workflow$/);
        if (applicationWorkflowRoute && req.method === "PATCH") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) {
            throw new HttpError(403, "Менять приоритет и срок обращения может только руководство.");
          }
          const item = db.prepare("SELECT id, type, status, completed_at, priority, due_at FROM applications WHERE id = ?")
            .get(Number(applicationWorkflowRoute[1]));
          if (!item || !["citizen_help", "citizen_complaint"].includes(item.type)) {
            throw new HttpError(404, "Обращение гражданина не найдено.");
          }
          if (item.completed_at || item.status === "rejected") {
            throw new HttpError(409, "Срок и приоритет закрытого обращения нельзя менять.");
          }
          const body = await readJson(req);
          const priority = String(body.priority || "");
          const dueAt = body.dueAt === null || body.dueAt === "" ? null : String(body.dueAt || "");
          if (!["low", "normal", "high", "urgent"].includes(priority)) {
            throw new HttpError(400, "Выберите допустимый приоритет обращения.");
          }
          if (dueAt && (dueAt.length > 40 || Number.isNaN(Date.parse(dueAt)))) {
            throw new HttpError(400, "Укажите корректный срок рассмотрения.");
          }
          const changes = [];
          if (item.priority !== priority) changes.push(`Приоритет: ${item.priority} → ${priority}.`);
          if (item.due_at !== dueAt) changes.push(`Срок: ${item.due_at || "не установлен"} → ${dueAt || "снят"}.`);
          if (changes.length) {
            db.prepare("UPDATE applications SET priority = ?, due_at = ? WHERE id = ?")
              .run(priority, dueAt, item.id);
            db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
              VALUES (?, ?, 'workflow_updated', ?)`).run(item.id, user.id, changes.join(" "));
          }
          return sendJson(res, 200, { ok: true, changed: changes.length > 0 });
        }

        const assignmentRoute = pathname.match(/^\/api\/applications\/(\d+)\/assign$/);
        if (assignmentRoute && req.method === "PATCH") {
          if (!["Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"].includes(user.role)) {
            throw new HttpError(403, "Взять обращение гражданина может адвокат или руководство.");
          }
          const item = db.prepare("SELECT * FROM applications WHERE id = ?").get(Number(assignmentRoute[1]));
          if (!item || !["citizen_help", "citizen_complaint"].includes(item.type)) {
            throw new HttpError(404, "Обращение гражданина не найдено.");
          }
          const body = await readJson(req);
          if (Object.hasOwn(body, "userId")) {
            if (!["ГКА", "ЗГКА"].includes(user.role)) {
              throw new HttpError(403, "Переназначать обращения может только руководство.");
            }
            if (item.completed_at || !["pending", "approved"].includes(item.status)) {
              throw new HttpError(409, "Закрытое обращение нельзя переназначить.");
            }
            const targetId = body.userId === null || body.userId === "" ? null : Number(body.userId);
            if (targetId !== null && !Number.isSafeInteger(targetId)) throw new HttpError(400, "Выберите активного адвоката или руководителя.");
            const target = targetId === null ? null : db.prepare(`SELECT id, display_name, role, discord_id, discord_avatar_url FROM users
              WHERE id = ? AND status = 'active' AND role IN ('Адвокат','Ст.Адвокат','ЗГКА','ГКА')`).get(targetId);
            if (targetId !== null && !target) throw new HttpError(400, "Выберите активного адвоката или руководителя.");
            if (item.assigned_to === targetId) return sendJson(res, 200, { ok: true, unchanged: true });
            const previous = item.assigned_to
              ? db.prepare("SELECT display_name FROM users WHERE id = ?").get(item.assigned_to)?.display_name || "неизвестный сотрудник"
              : "";
            const nextStatus = targetId === null ? "pending" : "approved";
            const result = targetId
              ? `Обращение назначено: ${target.display_name}.`
              : "Обращение снято с назначения и возвращено в очередь.";
            db.prepare(`UPDATE applications SET status = ?, assigned_to = ?, reviewed_by = ?,
              reviewed_at = CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
              result = ? WHERE id = ?`)
              .run(nextStatus, targetId, targetId === null ? null : user.id, targetId, result, item.id);
            const historyText = targetId
              ? `Обращение переназначено: ${previous || "очередь"} → ${target.display_name}.`
              : `Назначение снято с ${previous}. Обращение возвращено в очередь.`;
            db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
              VALUES (?, ?, 'reassigned', ?)`).run(item.id, user.id, historyText);
            const warning = await deliverWebhook(webhooks.applications, "Переназначено обращение гражданина",
              `${user.display_name} изменил(а) назначение обращения #${item.id}.`,
              [
                { name: "Обращение", value: `#${item.id}`, inline: true },
                { name: "Предыдущий исполнитель", value: previous || "очередь", inline: true },
                { name: "Новый исполнитель", value: target?.display_name || "очередь", inline: true }
              ]);
            if (target?.discord_id) {
              await sendPortalDirectMessage(
                targetId,
                target,
                target.discord_avatar_url,
                "Вам назначено обращение",
                `Обращение #${item.id} назначено вам для работы.`
              );
            }
            if (options.discordCloseCaseChannel) await options.discordCloseCaseChannel(item.id);
            if (target?.discord_id && options.discordCreateCaseChannel) {
              const citizen = db.prepare("SELECT discord_id FROM users WHERE id = ?").get(item.user_id);
              await options.discordCreateCaseChannel(item.id, citizen?.discord_id || "", target.discord_id);
            }
            return sendJson(res, 200, { ok: true, webhookWarning: warning });
          }
          if (item.status !== "pending") throw new HttpError(409, "Обращение уже взято в работу или закрыто.");
          if (item.requested_lawyer_id && item.requested_lawyer_id !== user.id && !["ГКА", "ЗГКА"].includes(user.role)) {
            throw new HttpError(403, "Гражданин выбрал другого адвоката для этого обращения.");
          }
          db.prepare(`UPDATE applications SET status = 'approved', assigned_to = ?, reviewed_by = ?,
            reviewed_at = CURRENT_TIMESTAMP, result = ? WHERE id = ?`)
            .run(user.id, user.id, `Взял в работу: ${user.display_name}. Свяжитесь с гражданином через указанные им контакты.`, item.id);
          db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
            VALUES (?, ?, 'assigned', ?)`)
            .run(item.id, user.id, `Обращение взял(а) ${user.display_name}.`);
          const citizen = db.prepare("SELECT display_name,discord_username,discord_id FROM users WHERE id = ?").get(item.user_id);
          const webhookWarning = await deliverWebhook(webhooks.applications, "Адвокат назначен по обращению",
            `${user.display_name} взял обращение #${item.id} (${applicationNames[item.type]}).`,
            [
              { name: "Адвокат", value: `${user.display_name} · ${user.role}`, inline: true },
              { name: "Гражданин", value: citizen.display_name, inline: true },
              { name: "Discord гражданина", value: citizen.discord_username ? `@${citizen.discord_username}` : "не привязан", inline: true },
              { name: "Обращение", value: `#${item.id}`, inline: true }
            ]);
          if (options.discordCreateCaseChannel) {
            await options.discordCreateCaseChannel(item.id, citizen.discord_id || "", user.discord_id || "");
          }
          await sendPortalDirectMessage(
            user.id,
            user,
            user.discord_avatar_url,
            "Обращение принято в работу",
            `Вы приняли обращение #${item.id}. Откройте раздел «Обращения», чтобы начать работу.`
          );
          return sendJson(res, 200, { ok: true, webhookWarning });
        }

        const ratingRoute = pathname.match(/^\/api\/applications\/(\d+)\/rating$/);
        if (ratingRoute && req.method === "POST") {
          if (user.role !== citizenRole) throw new HttpError(403, "Оценить помощь может только гражданин, который подал обращение.");
          const body = await readJson(req);
          const rating = Number(body.rating);
          const comment = String(body.comment || "").trim();
          if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, "Оценка должна быть от 1 до 5.");
          if (comment.length > 500) throw new HttpError(400, "Отзыв не должен превышать 500 символов.");
          const item = db.prepare(`SELECT id, user_id, type, assigned_to, completed_at FROM applications WHERE id = ?`)
            .get(Number(ratingRoute[1]));
          if (!item || item.user_id !== user.id || !["citizen_help", "citizen_complaint"].includes(item.type)) {
            throw new HttpError(404, "Завершённое обращение не найдено.");
          }
          if (!item.assigned_to || !item.completed_at) throw new HttpError(409, "Поставить оценку можно после закрытия обращения адвокатом.");
          if (db.prepare("SELECT id FROM lawyer_reviews WHERE application_id = ?").get(item.id)) {
            throw new HttpError(409, "Для этого обращения оценка уже отправлена.");
          }
          const review = db.prepare(`INSERT OR IGNORE INTO lawyer_reviews
            (application_id, lawyer_id, reviewer_id, rating, comment) VALUES (?, ?, ?, ?, ?)`)
            .run(item.id, item.assigned_to, user.id, rating, comment);
          if (review.changes !== 1) throw new HttpError(409, "Для этого обращения оценка уже отправлена.");
          db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
            VALUES (?, ?, 'rated', ?)`).run(item.id, user.id, `Гражданин оставил оценку ${rating}/5.`);
          return sendJson(res, 201, { ok: true });
        }

        const closeCaseRoute = pathname.match(/^\/api\/applications\/(\d+)\/close$/);
        if (closeCaseRoute && req.method === "PATCH") {
          const item = db.prepare("SELECT * FROM applications WHERE id = ?").get(Number(closeCaseRoute[1]));
          if (!item || !["citizen_help", "citizen_complaint"].includes(item.type)) {
            throw new HttpError(404, "Обращение гражданина не найдено.");
          }
          if (item.assigned_to !== user.id) {
            throw new HttpError(403, "Закрыть обращение может только назначенный адвокат.");
          }
          if (item.status !== "approved" || item.completed_at) throw new HttpError(409, "Обращение уже закрыто или ещё не принято в работу.");
          db.prepare("UPDATE applications SET completed_at = CURRENT_TIMESTAMP, result = 'Обращение закрыто адвокатом.' WHERE id = ?")
            .run(item.id);
          db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
            VALUES (?, ?, 'closed', 'Обращение закрыто исполнителем.')`).run(item.id, user.id);
          const citizen = db.prepare("SELECT discord_id, discord_avatar_url, display_name, role, username FROM users WHERE id = ?").get(item.user_id);
          if (citizen?.discord_id) {
            await sendPortalDirectMessage(item.user_id, citizen, citizen.discord_avatar_url,
              "Обращение закрыто", `Ваше обращение #${item.id} закрыто адвокатом. Теперь можно оставить оценку в портале.`);
          }
          if (options.discordCloseCaseChannel) await options.discordCloseCaseChannel(item.id);
          const webhookWarning = await deliverWebhook(webhooks.applications, "Обращение гражданина закрыто", `${user.display_name} закрыл обращение #${item.id}.`);
          return sendJson(res, 200, { ok: true, webhookWarning });
        }

        const interviewDecisionRoute = pathname.match(/^\/api\/applications\/(\d+)\/interview-decision$/);
        if (interviewDecisionRoute && req.method === "PATCH") {
          if (!managementRoles.includes(user.role)) {
            throw new HttpError(403, "Рассматривать обзвон могут ГКА и ЗГКА.");
          }
          const item = db.prepare("SELECT * FROM applications WHERE id = ?")
            .get(Number(interviewDecisionRoute[1]));
          if (!item || item.type !== "exam" || item.stage_role !== "Юрист" ||
              !isLawyerCareerPromotion(item) || item.status !== "pending") {
            throw new HttpError(404, "Заявка на обзвон не найдена.");
          }
          const body = requireObject(await readJson(req));
          const decision = String(body.decision || "");
          if (!["accepted", "passed", "failed"].includes(decision)) {
            throw new HttpError(400, "Выберите принятие заявки, прохождение или непрохождение обзвона.");
          }
          const promotionData = parseStoredJson(item.promotion_data_json, "отчёт о повышении");
          const priorDecision = promotionData.interviewDecision || "";
          if (item.interview_status !== "ready") {
            throw new HttpError(409, "Участник ещё не отметил готовность к обзвону.");
          }
          if (decision === "accepted" && priorDecision) {
            throw new HttpError(409, "Заявка на обзвон уже принята или рассмотрена.");
          }
          if (decision !== "accepted" && priorDecision !== "accepted" &&
              !(decision === "passed" && priorDecision === "passed")) {
            throw new HttpError(409, "Сначала примите участника на обзвон.");
          }
          promotionData.interviewDecision = decision;
          if (decision === "accepted") {
            promotionData.interviewAcceptedBy = user.id;
            promotionData.interviewAcceptedByName = user.display_name;
            promotionData.interviewAcceptedAt = new Date().toISOString();
          } else {
            promotionData.interviewResultBy = user.id;
            promotionData.interviewResultByName = user.display_name;
            promotionData.interviewResultAt = new Date().toISOString();
          }
          let promotionApproved = false;
          let roleSyncWarning = "";
          if (decision === "failed") {
            delete promotionData.practiceSubmittedAt;
            delete promotionData.interviewReadyAt;
            db.prepare(`UPDATE applications SET interview_status = 'waiting', interview_ready_at = NULL,
              promotion_data_json = ? WHERE id = ?`).run(JSON.stringify(promotionData), item.id);
            db.prepare(`UPDATE career_path_progress SET interview_ready_at = NULL,
              interview_prompt_dismissed_at = NULL WHERE user_id = ? AND stage_role = 'Юрист'`)
              .run(item.user_id);
          } else if (decision === "passed") {
            const readiness = getCareerPromotionReadiness(db, item);
            const member = db.prepare("SELECT role FROM users WHERE id = ?").get(item.user_id);
            if (!readiness.ready || member?.role !== "Юрист" ||
                item.requested_role !== nextRank["Юрист"]) {
              throw new HttpError(409, readiness.reason || "Заявка больше не соответствует текущей ступени участника.");
            }
            const target = nextRank["Юрист"];
            const resultText = `Обзвон пройден. Повышение одобрено, роль изменена на ${target}; сотрудник добавлен в указ.`;
            db.exec("BEGIN IMMEDIATE");
            try {
              db.prepare("UPDATE users SET role = ? WHERE id = ?").run(target, item.user_id);
              recordEmploymentEvent(db, {
                userId: item.user_id, actorId: user.id, fromRole: member.role, toRole: target,
                fromStatus: "active", toStatus: "active", details: "Повышение после практик и обзвона."
              });
              db.prepare(`UPDATE applications SET status = 'approved', reviewed_by = ?,
                reviewed_at = CURRENT_TIMESTAMP, review_data_json = ?, result = ?,
                promotion_data_json = ? WHERE id = ?`)
                .run(user.id, JSON.stringify({ stage: "Юрист", interviewPassed: true }),
                  resultText, JSON.stringify(promotionData), item.id);
              db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
                VALUES (?, ?, 'approved', ?)`).run(item.id, user.id, resultText);
              db.exec("COMMIT");
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
            promotionApproved = true;
            const syncResult = await syncDiscordMember(item.user_id);
            roleSyncWarning = syncResult.syncError || syncResult.nicknameWarning || "";
          } else {
            db.prepare("UPDATE applications SET promotion_data_json = ? WHERE id = ?")
              .run(JSON.stringify(promotionData), item.id);
          }
          const candidate = db.prepare("SELECT display_name, discord_id FROM users WHERE id = ?")
            .get(item.user_id);
          const candidateMention = candidate.discord_id ? `<@${candidate.discord_id}>` : candidate.display_name;
          const actorMention = user.discord_id ? `<@${user.discord_id}>` : user.display_name;
          const decisionLabels = {
            accepted: "принят на обзвон",
            passed: "прошёл обзвон",
            failed: "не прошёл обзвон"
          };
          const webhookUrl = webhooks.careerInterviews || webhooks.careerInterviewReady ||
            webhooks.attorneyInterview;
          const webhookWarning = await deliverWebhook(webhookUrl, "Решение по обзвону",
            `${user.display_name} отметил: ${candidate.display_name} ${decisionLabels[decision]}.`,
            [
              { name: "Участник", value: candidate.display_name, inline: true },
              { name: "Кто проверяет", value: user.display_name, inline: true },
              { name: "Решение", value: decisionLabels[decision], inline: true },
              { name: "Заявка", value: `#${item.id}`, inline: true },
              ...(decision === "accepted" ? [{
                name: "Канал обзвона",
                value: "[Открыть канал обзвона](https://discord.com/channels/1554369418186858586/1556226686201106432)",
                inline: false
              }] : [])
            ], null, {
              content: `${candidateMention} ${actorMention}`,
              mentionUsers: [candidate.discord_id, user.discord_id].filter(Boolean),
              ...(decision === "accepted" ? {
                components: [{
                  type: 1,
                  components: [{
                    type: 2,
                    style: 5,
                    label: "Перейти в канал обзвона",
                    url: "https://discord.com/channels/1554369418186858586/1556226686201106432"
                  }]
                }]
              } : {})
            });
          db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
            VALUES (?, ?, 'interview_decision', ?)`)
            .run(item.id, user.id, `${decisionLabels[decision]}. Проверяющий: ${user.display_name}.`);
          await notifyPortalUser({
            userId: item.user_id,
            type: "career_interview_decision",
            title: decision === "accepted" ? "Вас приняли на обзвон" : "Результат обзвона",
            body: `${decisionLabels[decision]}.${promotionApproved ? " Повышение одобрено, вы добавлены в указ." : ""} Проверяющий: ${user.display_name}.`,
            href: "/page/career"
          });
          return sendJson(res, 200, {
            ok: true, decision, reviewer: user.display_name, webhookWarning,
            promotionApproved, roleSyncWarning
          });
        }

        const applicationReview = pathname.match(/^\/api\/applications\/(\d+)\/review$/);
        if (applicationReview && req.method === "PATCH") {
          const body = await readJson(req);
          if (!["approved", "rejected"].includes(body.status)) throw new HttpError(400, "Неизвестный статус решения.");
          const item = db.prepare("SELECT * FROM applications WHERE id = ?").get(Number(applicationReview[1]));
          if (!item) throw new HttpError(404, "Заявка не найдена.");
          assertCanReview(hasGkaAccess(user) ? "ГКА" : user.role, item);
          const reviewPromotionData = item.type === "exam"
            ? parseStoredJson(item.promotion_data_json, "отчёт о повышении")
            : {};
          const reviewUsesLawBundle = item.type === "exam" &&
            (hasCareerLawBundle(reviewPromotionData) || isLawyerCareerPromotion(item, reviewPromotionData));
          if (reviewUsesLawBundle && !managementRoles.includes(user.role)) {
            throw new HttpError(403, "Заявки по карьерному этапу рассматривают только ГКА и ЗГКА.");
          }
          if (item.status !== "pending") throw new HttpError(409, "По этой заявке уже вынесено решение.");
          if (body.status === "approved" && ["citizen_help", "citizen_complaint"].includes(item.type)) {
            throw new HttpError(409, "Назначьте адвоката кнопкой «Взять в работу».");
          }
          if (isCareerPracticeApplication(item)) {
            if (!careerPracticeSubmitted(item) ||
                !promotionPracticeIsComplete(db, item.user_id, item.stage_role, {
                  lawBundle: hasCareerLawBundle(parseStoredJson(item.promotion_data_json, "отчёт о повышении")) ||
                    isLawyerCareerPromotion(item)
                })) {
              throw new HttpError(409, "Практика задержаний не заполнена или ещё не отправлена.");
            }
            const currentRole = db.prepare("SELECT role FROM users WHERE id = ?").get(item.user_id)?.role;
            if (currentRole !== item.stage_role ||
                (item.requested_role && item.requested_role !== nextRank[item.stage_role])) {
              throw new HttpError(409, "Заявка больше не соответствует текущей ступени участника.");
            }
          }
          const criteria = body.criteria && typeof body.criteria === "object" && !Array.isArray(body.criteria)
            ? body.criteria : {};
          const itemPromotionData = parseStoredJson(item.promotion_data_json, "отчёт о повышении");
          const lawBundle = item.type === "exam" && hasCareerLawBundle(itemPromotionData);
          const lawyerCareerPath = item.type === "exam" && isLawyerCareerPromotion(item, itemPromotionData);
          const requireCriteria = (names) => {
            const missing = names.filter((name) => criteria[name] !== true);
            if (missing.length) throw new HttpError(400, "Перед одобрением подтвердите все пункты проверки.");
          };
          let reviewData = {};
          let resultText = "";
          let roleChanged = false;
          if (body.status === "approved" && item.type === "employment") {
            const applicant = db.prepare("SELECT role, status FROM users WHERE id = ?").get(item.user_id);
            if (applicant?.role !== citizenRole || applicant.status !== "active") {
              throw new HttpError(409, "Заявка на вступление больше не соответствует активному аккаунту гражданина.");
            }
            db.prepare("UPDATE users SET role = 'Стажер КА', status = 'active' WHERE id = ?").run(item.user_id);
            recordEmploymentEvent(db, {
              userId: item.user_id, actorId: user.id, fromRole: applicant.role, toRole: "Стажер КА",
              fromStatus: applicant.status, toStatus: "active", details: "Заявка на вступление одобрена."
            });
            roleChanged = true;
            resultText = "Заявка на вступление одобрена. Аккаунт принят в Коллегию в роли стажёра КА.";
          }
          if (body.status === "approved" && item.type === "exam") {
            const member = db.prepare("SELECT role FROM users WHERE id = ?").get(item.user_id);
            const stageRole = item.stage_role || member.role;
            if (lawyerCareerPath) {
              if (member.role !== "Юрист" || item.requested_role !== nextRank["Юрист"]) {
                throw new HttpError(409, "Заявка больше не соответствует текущей ступени участника.");
              }
              if (itemPromotionData.interviewDecision !== "passed") {
                throw new HttpError(409, "Сначала отметьте, что участник прошёл обзвон.");
              }
              const readiness = getCareerPromotionReadiness(db, item);
              const path = getCareerPathProgressRow(db, item.user_id, "Юрист");
              if (!readiness.ready || !path.interview_ready_at || item.interview_status !== "ready") {
                throw new HttpError(409, readiness.reason || "Участник ещё не прошёл обзвон.");
              }
              requireCriteria(["practiceVerified", "interviewPassed"]);
              const generalPractice = getGeneralRpPracticeState(db, item.user_id);
              if (generalPractice.completedCaseIds.length < generalPractice.requiredCount ||
                  !promotionPracticeIsComplete(db, item.user_id, "Юрист", { lawBundle: true })) {
                throw new HttpError(409, "Не выполнены ситуационные кейсы или два совместных вызова.");
              }
              const target = nextRank["Юрист"];
              db.prepare("UPDATE users SET role = ? WHERE id = ?").run(target, item.user_id);
              recordEmploymentEvent(db, {
                userId: item.user_id, actorId: user.id, fromRole: member.role, toRole: target,
                fromStatus: "active", toStatus: "active", details: "Повышение после практик и обзвона."
              });
              roleChanged = true;
              reviewData = { stage: "Юрист", criteria };
              resultText = `Повышение одобрено. Роль изменена на ${target}.`;
            } else if (lawBundle) {
              const stageTests = db.prepare(`SELECT subject FROM career_law_exam_passes
                WHERE user_id = ? AND stage_role = ?`).all(item.user_id, stageRole).map((entry) => entry.subject);
              if (member.role !== stageRole || careerLawExamSubjects.some((subject) => !stageTests.includes(subject)) ||
                  item.requested_role !== nextRank[stageRole]) {
                throw new HttpError(409, "Заявка больше не соответствует текущей ступени или не все три теста сданы.");
              }
              const readiness = getCareerPromotionReadiness(db, item);
              if (!readiness.ready) throw new HttpError(409, readiness.reason);
              if (stageRole === "Стажер КА") {
                requireCriteria(["headApproved"]);
              } else if (stageRole === "Юрист") {
                requireCriteria(["practiceVerified"]);
                const generalRpPractice = getGeneralRpPracticeState(db, item.user_id);
                if (getCareerRpPracticeState(db, item.user_id, stageRole).completedCaseIds.length < 3 ||
                    generalRpPractice.completedCaseIds.length < generalRpPractice.requiredCount ||
                    !promotionPracticeIsComplete(db, item.user_id, stageRole, { lawBundle: true })) {
                  throw new HttpError(409, "Не выполнены AI Case, ситуационные кейсы и совместные вызовы для перехода в адвокаты.");
                }
              } else {
                throw new HttpError(409, "Повышение по комплекту тестов доступно только со ступени стажёра или юриста.");
              }
              const target = nextRank[stageRole];
              db.prepare("UPDATE users SET role = ? WHERE id = ?").run(target, item.user_id);
              recordEmploymentEvent(db, {
                userId: item.user_id, actorId: user.id, fromRole: member.role, toRole: target,
                fromStatus: "active", toStatus: "active", details: "Повышение после сдачи АК, УК и ПК."
              });
              roleChanged = true;
              reviewData = { stage: stageRole, criteria };
              resultText = `Повышение одобрено. Роль изменена на ${target}.`;
            } else {
              const exam = db.prepare(`SELECT passed, score FROM exam_results
                WHERE user_id = ? AND track = ? AND application_id = ? ORDER BY id DESC LIMIT 1`)
                .get(item.user_id, stageRole, item.id);
              if (!exam?.passed) throw new HttpError(409, "Проверку знаний нельзя одобрить без успешно сданного теста.");
              const promotionData = itemPromotionData;
              if (item.career_flow && stageRole === "Юрист" && item.interview_status !== "ready") {
                throw new HttpError(409, "Перед одобрением участник должен отметить готовность и пройти обзвон.");
              }
              if (stageRole === "Стажер КА") {
                requireCriteria(item.career_flow ? ["headApproved"] : ["lectureVerified"]);
                if (item.career_flow && !promotionData.lectureAttended) {
                  throw new HttpError(409, "В заявке не подтверждено прохождение обязательного этапа.");
                }
                if (!item.career_flow) requireCriteria(["lectureVerified"]);
                const target = nextRank[stageRole];
                db.prepare("UPDATE users SET role = ? WHERE id = ?").run(target, item.user_id);
                recordEmploymentEvent(db, {
                  userId: item.user_id, actorId: user.id, fromRole: member.role, toRole: target,
                  fromStatus: "active", toStatus: "active", details: "Повышение после одобрения экзамена."
                });
                roleChanged = true;
                resultText = `Проверка знаний одобрена. Роль изменена на ${target}.`;
              } else if (stageRole === "Юрист") {
                requireCriteria(item.career_flow
                  ? ["callsVerified", "trialLawsuitVerified", "interviewPassed"]
                  : ["callsVerified", "trialLawsuitVerified"]);
                const currentRequiredCalls = Number(db.prepare("SELECT lawyer_calls_required FROM promotion_settings WHERE id = 1")
                  .get().lawyer_calls_required);
                if (!currentRequiredCalls || Number(promotionData.completedCalls) < currentRequiredCalls ||
                    !promotionData.trialLawsuitReference) {
                  throw new HttpError(409, "Не выполнены заявленные условия перехода юриста в адвокаты.");
                }
                const target = nextRank[member.role];
                db.prepare("UPDATE users SET role = ? WHERE id = ?").run(target, item.user_id);
                recordEmploymentEvent(db, {
                  userId: item.user_id, actorId: user.id, fromRole: member.role, toRole: target,
                  fromStatus: "active", toStatus: "active", details: "Повышение после одобрения экзамена."
                });
                roleChanged = true;
                resultText = `Экзамен и требования одобрены. Роль изменена на ${target}.`;
              } else {
                if (item.career_flow) requireCriteria(["interviewPassed"]);
                resultText = "Проверка знаний одобрена. Для повышения до старшего адвоката подайте отдельный отчёт с подтверждениями.";
              }
              reviewData = { stage: stageRole, criteria };
            }
          }
          if (body.status === "rejected" && lawBundle) {
            db.prepare("DELETE FROM career_law_exam_passes WHERE user_id = ? AND stage_role = ?")
              .run(item.user_id, item.stage_role);
            const note = String(body.note || "").trim();
            resultText = note
              ? `Заявка на повышение отклонена: ${note}`
              : "Заявка на повышение отклонена. Тесты текущей ступени снова доступны.";
          } else if (body.status === "rejected" && lawyerCareerPath) {
            db.prepare(`UPDATE career_path_progress SET interview_ready_at = NULL,
              interview_prompt_dismissed_at = NULL WHERE user_id = ? AND stage_role = 'Юрист'`)
              .run(item.user_id);
            const note = String(body.note || "").trim();
            resultText = note
              ? `Заявка на повышение отклонена: ${note}`
              : "Заявка отклонена. После исправлений можно снова отметить готовность к обзвону.";
          }
          if (body.status === "approved" && item.type === "promotion") {
            const target = item.requested_role;
            const member = db.prepare("SELECT role FROM users WHERE id = ?").get(item.user_id);
            const permitted = member.role;
            if (permitted !== "Адвокат" || target !== "Ст.Адвокат" || target !== nextRank[permitted]) {
              throw new HttpError(409, "Заявка больше не соответствует текущей ступени участника.");
            }
            requireCriteria([
              "callsVerified", "juniorCallsVerified", "acceptedLawsuitVerified",
              "interviewPassed", "vacancyAvailable", "headApproved"
            ]);
            const careerExam = db.prepare(`SELECT interview_status FROM applications
              WHERE user_id = ? AND type = 'exam' AND stage_role = 'Адвокат' AND career_flow = 1
                AND status = 'approved' ORDER BY id DESC LIMIT 1`).get(item.user_id);
            if (careerExam && careerExam.interview_status !== "ready") {
              throw new HttpError(409, "Сначала отметьте готовность и пройдите обзвон по результатам теста.");
            }
            const promotionData = parseStoredJson(item.promotion_data_json, "отчёт о повышении");
            if (Number(promotionData.completedCalls) < 25 || Number(promotionData.callsWithLawyer) < 5 ||
                !promotionData.acceptedLawsuitReference) {
              throw new HttpError(409, "Заявка не подтверждает обязательные показатели повышения.");
            }
            db.prepare("UPDATE users SET role = ? WHERE id = ?").run(target, item.user_id);
            recordEmploymentEvent(db, {
              userId: item.user_id, actorId: user.id, fromRole: member.role, toRole: target,
              fromStatus: "active", toStatus: "active", details: "Повышение до старшего адвоката одобрено."
            });
            roleChanged = true;
            reviewData = { stage: "Адвокат", criteria };
            resultText = `Отчёт одобрен. Роль изменена на ${target}.`;
          }
          db.prepare(`UPDATE applications SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
            review_data_json = ?, result = CASE WHEN ? = '' THEN result ELSE ? END WHERE id = ?`)
            .run(body.status, user.id, JSON.stringify(reviewData), resultText, resultText, item.id);
          db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
            VALUES (?, ?, ?, ?)`).run(item.id, user.id, body.status,
              resultText || `Заявка ${body.status === "approved" ? "одобрена" : "отклонена"}.`);
          let discordWarning = "";
          let nicknameWarning = "";
          if (body.status === "approved" && roleChanged) {
            const result = await syncDiscordMember(item.user_id);
            discordWarning = result.syncError;
            nicknameWarning = result.nicknameWarning;
          }
          const logWarning = await deliverWebhook(webhooks.logs, "Решение по заявке", `${user.display_name} ${body.status === "approved" ? "одобрил" : "отклонил"} заявку #${item.id} (${item.type}).`);
          await notifyPortalUser({
            userId: item.user_id,
            type: "application_review",
            title: body.status === "approved" ? "Заявка одобрена" : "Заявка отклонена",
            body: resultText || `По заявке #${item.id} принято решение: ${body.status === "approved" ? "одобрено" : "отклонено"}.`,
            href: item.type === "exam" ? "/page/exams" : "/page/appeals"
          });
          return sendJson(res, 200, { ok: true, discordWarning, nicknameWarning, logWarning });
        }

        if (pathname === "/api/exams/history" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "История экзаменов доступна только сотрудникам Коллегии.");
          const exams = db.prepare(`SELECT id, track, score, passed, answers_json, created_at
            FROM exam_results WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(user.id).map((exam) => {
            const storedAnswers = parseStoredJson(exam.answers_json, "ответы экзамена");
            const savedQuestions = Array.isArray(storedAnswers?.questions) ? storedAnswers.questions : null;
            const answers = Array.isArray(storedAnswers)
              ? storedAnswers
              : Array.isArray(storedAnswers?.answers) ? storedAnswers.answers : [];
            const subject = exam.track.startsWith("law:") ? exam.track.slice(4) : "";
            const bank = subject ? lawExamBank[subject] : examBank[exam.track];
            const questions = savedQuestions || (Array.isArray(bank)
              ? bank.map((question, index) => ({
                question: question.q,
                selectedAnswer: Number.isInteger(answers[index]) ? question.a[answers[index]] : "",
                correctAnswer: question.a[question.correct],
                correct: answers[index] === question.correct
              }))
              : []);
            const total = questions.length || (Array.isArray(bank) ? bank.length : answers.length);
            return {
              id: exam.id,
              track: exam.track,
              title: subject
                ? lawExamTitles[subject] || "Тест по законодательству"
                : `Проверка знаний · ${exam.track}`,
              score: exam.score,
              total,
              passed: Boolean(exam.passed),
              created_at: exam.created_at,
              questions
            };
          });
          return sendJson(res, 200, { exams });
        }

        if (pathname === "/api/exams/law-progress" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Тесты по законодательству доступны только сотрудникам Коллегии.");
          const available = careerLawExamRoles.includes(user.role);
          const passedSubjects = available ? getCareerLawPasses(db, user.id, user.role) : [];
          const path = promotionPracticeStages.includes(user.role)
            ? getCareerPathProgressRow(db, user.id, user.role)
            : null;
          const settings = db.prepare("SELECT lawyer_calls_required FROM promotion_settings WHERE id = 1").get();
          return sendJson(res, 200, {
            available,
            stageRole: user.role,
            passedSubjects,
            nextSubject: available && promotionPracticeStages.includes(user.role)
              ? careerLawExamSubjects.find((subject) => !passedSubjects.includes(subject)) || ""
              : "",
            lawsReviewed: user.role !== "Юрист" || Boolean(path?.laws_reviewed_at),
            lawyerCallsRequired: Number(settings.lawyer_calls_required),
            message: available ? "" : user.role === "Юрист"
              ? "На этапе юриста тесты АК, УК и ПК повторно не сдаются."
              : "Тесты по АК, УК и ПК доступны только стажёрам КА."
          });
        }

        if (pathname === "/api/exams/current" && req.method === "GET") {
          const attestationId = Number(requestUrl.searchParams.get("attestationId") || 0);
          const subject = String(requestUrl.searchParams.get("subject") || "");
          if (subject) {
            if (user.role === citizenRole) throw new HttpError(403, "Тесты по законодательству доступны только сотрудникам Коллегии.");
            const questions = Object.hasOwn(lawExamBank, subject) ? lawExamBank[subject] : null;
            if (!questions) throw new HttpError(400, "Выберите один из доступных тестов по законодательству.");
            if (careerLawExamSubjects.includes(subject)) {
              if (!careerLawExamRoles.includes(user.role)) {
                throw new HttpError(403, "На этапе юриста тесты АК, УК и ПК повторно не сдаются.");
              }
              if (db.prepare(`SELECT 1 FROM career_law_exam_passes
                  WHERE user_id = ? AND stage_role = ? AND subject = ?`).get(user.id, user.role, subject)) {
                throw new HttpError(409, "Этот тест уже сдан на текущей ступени.");
              }
              requireNextCareerLawExam(db, user, subject);
            }
            return sendJson(res, 200, {
              track: lawExamTitles[subject],
              subject,
              questions: questions.map(({ q, a }) => ({ q, answers: a }))
            });
          }
          let track = user.role;
          if (track === citizenRole) throw new HttpError(403, "Проверка знаний доступна только сотрудникам Коллегии.");
          let attestation = null;
          if (attestationId) {
            attestation = db.prepare("SELECT * FROM attestations WHERE id = ?").get(attestationId);
            if (!attestation || attestation.user_id !== user.id) {
              throw new HttpError(404, "Назначение на переаттестацию не найдено.");
            }
            track = attestation.track;
          } else if (!db.prepare(`SELECT id FROM applications WHERE user_id = ? AND type = 'exam'
            AND stage_role = ? AND status = 'pending'`).get(user.id, user.role)) {
            throw new HttpError(409, "Сначала подайте заявку на проверку знаний.");
          }
          const questions = examBank[track];
          if (!questions) throw new HttpError(403, "Для вашей ступени тест не предусмотрен.");
          const application = attestation ? null : db.prepare(`SELECT id, result, interview_status, study_read_at
            FROM applications WHERE user_id = ? AND type = 'exam' AND stage_role = ? AND status = 'pending'
            ORDER BY id DESC LIMIT 1`).get(user.id, user.role);
          if (application && !application.result.includes("пройдена")) {
            db.prepare("UPDATE applications SET study_read_at = COALESCE(study_read_at, CURRENT_TIMESTAMP) WHERE id = ?")
              .run(application.id);
          }
          return sendJson(res, 200, {
            track, applicationId: application?.id || null, result: application?.result || "",
            interviewStatus: application?.interview_status || "not_required",
            questions: questions.map(({ q, a }) => ({ q, answers: a }))
          });
        }

        if (pathname === "/api/exams" && req.method === "POST") {
          const body = await readJson(req);
          const answers = body.answers;
          const attestationId = Number(body.attestationId || 0);
          const subject = String(body.subject || "");
          const isCodeTest = Boolean(subject);
          let track = user.role;
          if (track === citizenRole) throw new HttpError(403, "Проверка знаний доступна только сотрудникам Коллегии.");
          let attestation = null;
          let application = null;
          let questions;
          if (isCodeTest) {
            if (attestationId) throw new HttpError(400, "Тест по законодательству нельзя привязать к переаттестации.");
            questions = Object.hasOwn(lawExamBank, subject) ? lawExamBank[subject] : null;
            if (!questions) throw new HttpError(400, "Выберите один из доступных тестов по законодательству.");
            if (careerLawExamSubjects.includes(subject)) {
              if (!careerLawExamRoles.includes(user.role)) {
                throw new HttpError(403, "На этапе юриста тесты АК, УК и ПК повторно не сдаются.");
              }
              if (db.prepare(`SELECT 1 FROM career_law_exam_passes
                  WHERE user_id = ? AND stage_role = ? AND subject = ?`).get(user.id, user.role, subject)) {
                throw new HttpError(409, "Этот тест уже сдан на текущей ступени.");
              }
              requireNextCareerLawExam(db, user, subject);
            }
            track = `law:${subject}`;
          } else if (attestationId) {
            attestation = db.prepare("SELECT * FROM attestations WHERE id = ?").get(attestationId);
            if (!attestation || attestation.user_id !== user.id) throw new HttpError(404, "Назначение не найдено.");
            track = attestation.track;
          } else {
            application = db.prepare(`SELECT id, stage_role, career_flow, promotion_data_json, interview_status, study_read_at
              FROM applications WHERE user_id = ? AND type = 'exam' AND stage_role = ? AND status = 'pending'
              ORDER BY id DESC LIMIT 1`).get(user.id, user.role);
            if (!application) throw new HttpError(409, "Сначала подайте заявку на проверку знаний.");
            if (!application.study_read_at && !attestation) {
              throw new HttpError(409, "Сначала ознакомьтесь с материалами подготовки.");
            }
          }
          if (application?.career_flow &&
              db.prepare("SELECT passed FROM exam_results WHERE application_id = ? ORDER BY id DESC LIMIT 1").get(application.id)?.passed) {
            throw new HttpError(409, "Тест по этому этапу уже сдан.");
          }
          if (!questions) questions = examBank[track];
          if (!questions || !Array.isArray(answers) || answers.length !== questions.length ||
              answers.some((answer, index) => !Number.isInteger(answer) || answer < 0 || answer >= questions[index].a.length)) {
            throw new HttpError(400, "Ответы теста заполнены некорректно.");
          }
          const score = answers.reduce((sum, answer, index) => sum + (answer === questions[index].correct ? 1 : 0), 0);
          const passed = score / questions.length >= 0.7;
          const answerReview = {
            questions: questions.map((question, index) => ({
              question: question.q,
              selectedAnswer: question.a[answers[index]],
              correctAnswer: question.a[question.correct],
              correct: answers[index] === question.correct
            }))
          };
          const savedExam = db.prepare(`INSERT INTO exam_results
            (user_id, application_id, track, score, passed, answers_json) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(attestation ? attestation.user_id : user.id, application ? application.id : null,
              track, score, passed ? 1 : 0, JSON.stringify(answerReview));
          let careerApplicationId = null;
          let careerApplicationCreated = false;
          if (isCodeTest && passed && careerLawExamSubjects.includes(subject)) {
            db.prepare(`INSERT INTO career_law_exam_passes
              (user_id, stage_role, subject, exam_result_id) VALUES (?, ?, ?, ?)`)
              .run(user.id, user.role, subject, Number(savedExam.lastInsertRowid));
            const completedSubjects = db.prepare(`SELECT subject FROM career_law_exam_passes
              WHERE user_id = ? AND stage_role = ?`).all(user.id, user.role).map((item) => item.subject);
            if (completedSubjects.length === careerLawExamSubjects.length &&
                ["Стажер КА", "Юрист"].includes(user.role)) {
              const existing = db.prepare(`SELECT id, promotion_data_json FROM applications
                WHERE user_id = ? AND type = 'exam' AND stage_role = ? AND career_flow = 1 AND status = 'pending'
                  ORDER BY id DESC`).all(user.id, user.role).find((item) =>
                  Array.isArray(parseStoredJson(item.promotion_data_json, "отчёт о повышении").lawTests));
              if (existing) {
                careerApplicationId = Number(existing.id);
              } else {
                const promotionData = { lawTests: careerLawExamSubjects };
                const created = db.prepare(`INSERT INTO applications
                  (user_id, type, requested_role, stage_role, study_read_at, interview_status,
                    career_flow, details, promotion_data_json)
                  VALUES (?, 'exam', ?, ?, CURRENT_TIMESTAMP, ?, 1, ?, ?)`)
                  .run(user.id, nextRank[user.role], user.role,
                    user.role === "Стажер КА" ? "not_required" : "waiting",
                    "Автоматическая заявка: сданы экзамены по АК, УК и ПК.",
                    JSON.stringify(promotionData));
                careerApplicationId = Number(created.lastInsertRowid);
                careerApplicationCreated = true;
                db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
                  VALUES (?, ?, 'created', ?)`)
                  .run(careerApplicationId, user.id, `Автоматическая заявка на повышение до ${nextRank[user.role]}: сданы АК, УК и ПК.`);
              }
            }
          }
          if (attestation) {
            db.prepare("UPDATE attestations SET score = ?, status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?")
              .run(score, passed ? "passed" : "failed", attestation.id);
          } else if (application && !isCodeTest) {
            db.prepare("UPDATE applications SET result = ? WHERE id = ?")
              .run(`Проверка знаний: ${score}/${questions.length}, ${passed ? "пройдена" : "не пройдена"}`, application.id);
          }
          const answerFields = questions.map((question, index) => ({
            name: `Вопрос ${index + 1}`,
            value: `${question.q}\nВаш ответ: ${question.a[answers[index]]}\nПравильный ответ: ${question.a[question.correct]}`,
            inline: false
          })).filter((_, index) => answers[index] !== questions[index].correct).slice(0, 20);
          await deliverWebhook(
            webhooks.exams,
            `Результат проверки знаний: ${score}/${questions.length}`,
            `${user.display_name} · ${track} · ${passed ? "тест пройден" : "тест не пройден"}`,
            [
              { name: "Участник", value: `${user.display_name} (${user.role})`, inline: true },
              { name: "Результат", value: `${score}/${questions.length}`, inline: true },
              ...answerFields
            ]
          );
          await deliverWebhook(
            webhooks.lawyerTest,
            passed ? "Проверка знаний пройдена" : "Проверка знаний не пройдена",
            `${user.display_name} · ${track} · ${score}/${questions.length}`,
            [
              { name: "Участник", value: `${user.display_name} (${user.role})`, inline: true },
              { name: "Результат", value: `${score}/${questions.length} · ${passed ? "пройдено" : "не пройдено"}`, inline: true },
              ...answerFields
            ]
          );
          let discordWarning = "";
          let nicknameWarning = "";
          let interviewStatus = "not_required";
          let promotedUser = null;
          if (application?.career_flow && passed) {
            if (application.stage_role === "Стажер КА") {
              interviewStatus = "waiting";
              db.prepare(`UPDATE applications SET interview_status = 'waiting',
                interview_ready_at = NULL, result = ? WHERE id = ?`)
                .run(`Тест пройден: ${score}/${questions.length}. Ожидается обзвон и одобрение ГКА/ЗГКА.`, application.id);
              await deliverWebhook(webhooks.logs, "Стажёр прошёл тест",
                `${user.display_name} сдал тест стажёра: ${score}/${questions.length}. Роль пока не изменена; нужен обзвон и одобрение.`,
                [
                  { name: "Участник", value: user.display_name, inline: true },
                  { name: "Результат", value: `${score}/${questions.length}`, inline: true },
                  { name: "Следующий этап", value: "Обзвон и одобрение ГКА/ЗГКА", inline: true }
                ]);
            } else {
              interviewStatus = "waiting";
              db.prepare(`UPDATE applications SET interview_status = 'waiting',
                interview_ready_at = NULL WHERE id = ?`).run(application.id);
            }
          }
          return sendJson(res, 200, {
            score, total: questions.length, passed, subject,
            applicationCreated: careerApplicationCreated,
            interviewRequired: Boolean(application?.career_flow && passed),
            interviewStatus, applicationId: careerApplicationId || application?.id || null,
            user: promotedUser, discordWarning, nicknameWarning
          });
        }

        if (pathname === "/api/rating-settings" && req.method === "GET") {
          if (!managementRoles.includes(user.role)) throw new HttpError(403, "Настройки рейтинга доступны только руководству.");
          const history = db.prepare(`SELECT h.id, h.weights_json, h.created_at, u.display_name AS updated_by
            FROM rating_settings_history h JOIN users u ON u.id = h.updated_by
            ORDER BY h.id DESC LIMIT 20`).all()
            .map((item) => ({ ...item, weights: JSON.parse(item.weights_json) }));
          return sendJson(res, 200, { weights: getRatingWeights(db), history });
        }

        if (pathname === "/api/rating-settings" && req.method === "PATCH") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Изменять формулу рейтинга может только ГКА.");
          const body = await readJson(req);
          const weights = body.weights;
          if (!weights || typeof weights !== "object" || Array.isArray(weights) ||
              Object.keys(weights).some((key) => !Object.hasOwn(defaultRatingWeights, key)) ||
              Object.keys(defaultRatingWeights).some((key) =>
                !Number.isInteger(weights[key]) || weights[key] < 0 || weights[key] > 100) ||
              Object.values(weights).every((weight) => weight === 0)) {
            throw new HttpError(400, "Для каждого показателя задайте целый вес от 0 до 100; хотя бы один вес должен быть больше нуля.");
          }
          const serialized = JSON.stringify(weights);
          db.prepare(`INSERT INTO portal_settings (key,value) VALUES ('attorney_rating_weights',?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(serialized);
          db.prepare("INSERT INTO rating_settings_history (updated_by,weights_json) VALUES (?,?)")
            .run(user.id, serialized);
          return sendJson(res, 200, { weights });
        }

        if (pathname === "/api/attorneys" && req.method === "GET") {
          const period = requestUrl.searchParams.get("period") || "all";
          return sendJson(res, 200, buildAttorneyRanking(db, period));
        }

        if (pathname === "/api/giveaway" && req.method === "GET") {
          return sendJson(res, 200, getGiveawayLeaderboard(db));
        }

        if (pathname === "/api/reserve" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Кадровый резерв доступен только сотрудникам.");
          const reserve = db.prepare(`SELECT r.user_id, r.status, r.note, r.created_at, r.updated_at,
              target.display_name, target.role, actor.display_name AS added_by_name
            FROM staff_reserve r JOIN users target ON target.id = r.user_id
            JOIN users actor ON actor.id = r.added_by
            ${["ГКА", "ЗГКА"].includes(user.role) ? "" : "WHERE r.user_id = ?"}
            ORDER BY CASE r.status WHEN 'ready' THEN 0 ELSE 1 END, target.display_name`)
            .all(...(["ГКА", "ЗГКА"].includes(user.role) ? [] : [user.id]));
          return sendJson(res, 200, { reserve });
        }

        if (pathname === "/api/reserve" && req.method === "POST") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Управлять кадровым резервом может только руководство.");
          const body = await readJson(req);
          const targetId = Number(body.userId);
          const status = String(body.status || "considering");
          const note = String(body.note || "").trim();
          const target = db.prepare("SELECT id, role, discord_id, discord_avatar_url, display_name, username FROM users WHERE id = ? AND status = 'active'").get(targetId);
          if (!target || target.role === citizenRole) throw new HttpError(404, "Активный сотрудник не найден.");
          if (!["considering", "ready"].includes(status) || note.length > 1000) {
            throw new HttpError(400, "Проверьте статус резерва и комментарий (до 1000 символов).");
          }
          db.prepare(`INSERT INTO staff_reserve (user_id, added_by, status, note)
            VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
              added_by = excluded.added_by, status = excluded.status, note = excluded.note,
              updated_at = CURRENT_TIMESTAMP`).run(targetId, user.id, status, note);
          return sendJson(res, 200, { saved: true });
        }

        const reserveRoute = pathname.match(/^\/api\/reserve\/(\d+)$/);
        if (reserveRoute && req.method === "DELETE") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Управлять кадровым резервом может только руководство.");
          const result = db.prepare("DELETE FROM staff_reserve WHERE user_id = ?").run(Number(reserveRoute[1]));
          if (!result.changes) throw new HttpError(404, "Запись кадрового резерва не найдена.");
          return sendJson(res, 200, { removed: true });
        }

        if (pathname === "/api/absences" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Заявки на отсутствие доступны только сотрудникам.");
          const manager = ["ГКА", "ЗГКА"].includes(user.role);
          const includeArchived = requestUrl.searchParams.get("archived") === "1";
          if (includeArchived && !hasGkaAccess(user)) throw new HttpError(403, "Архив отсутствий доступен только ГКА.");
          const absences = db.prepare(`SELECT a.id, a.user_id, a.start_date, a.end_date, a.reason, a.status,
              a.review_note, a.reviewed_at, a.created_at, target.display_name, target.role,
              reviewer.display_name AS reviewer_name
            FROM absence_requests a JOIN users target ON target.id = a.user_id
            LEFT JOIN users reviewer ON reviewer.id = a.reviewed_by
            WHERE (? = 1 OR a.archived_at IS NULL) ${manager ? "" : "AND a.user_id = ?"}
            ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.start_date DESC`)
            .all(includeArchived ? 1 : 0, ...(manager ? [] : [user.id]));
          return sendJson(res, 200, { absences });
        }

        if (pathname === "/api/absences" && req.method === "POST") {
          if (user.role === citizenRole) throw new HttpError(403, "Подавать заявку на отсутствие могут сотрудники.");
          const body = await readJson(req);
          const startDate = String(body.startDate || "");
          const endDate = String(body.endDate || "");
          const reason = String(body.reason || "").trim();
          const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
            !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
            new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
          if (!isDate(startDate) || !isDate(endDate) || startDate > endDate ||
              reason.length < 4 || reason.length > 1000) {
            throw new HttpError(400, "Укажите корректный период и причину отсутствия (от 4 до 1000 символов).");
          }
          const overlap = db.prepare(`SELECT id FROM absence_requests WHERE user_id = ?
            AND status IN ('pending','approved') AND start_date <= ? AND end_date >= ? LIMIT 1`)
            .get(user.id, endDate, startDate);
          if (overlap) throw new HttpError(409, "На этот период уже есть заявка на отсутствие.");
          const result = db.prepare(`INSERT INTO absence_requests (user_id, start_date, end_date, reason)
            VALUES (?, ?, ?, ?)`).run(user.id, startDate, endDate, reason);
          const warning = await deliverWebhook(webhooks.logs, "Заявка на отсутствие",
            `${user.display_name} подал(а) заявку на отсутствие с ${startDate} по ${endDate}.`);
          return sendJson(res, 201, { id: Number(result.lastInsertRowid), warning });
        }

        const absenceRoute = pathname.match(/^\/api\/absences\/(\d+)$/);
        if (absenceRoute && req.method === "PATCH") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Рассматривать отсутствие может только руководство.");
          const body = await readJson(req);
          if (!["approved", "rejected"].includes(body.status)) throw new HttpError(400, "Выберите решение по заявке.");
          const reviewNote = String(body.reviewNote || "").trim();
          if (reviewNote.length > 500) throw new HttpError(400, "Комментарий не должен превышать 500 символов.");
          const request = db.prepare("SELECT id, user_id, status FROM absence_requests WHERE id = ?")
            .get(Number(absenceRoute[1]));
          if (!request) throw new HttpError(404, "Заявка на отсутствие не найдена.");
          if (request.status !== "pending") throw new HttpError(409, "Заявка уже рассмотрена.");
          db.prepare(`UPDATE absence_requests SET status = ?, review_note = ?, reviewed_by = ?,
            reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(body.status, reviewNote, user.id, request.id);
          return sendJson(res, 200, { status: body.status });
        }

        if (pathname === "/api/characteristics" && req.method === "GET") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Внутренние характеристики доступны только руководству.");
          const characteristics = db.prepare(`SELECT c.id, c.user_id, c.criterion, c.score, c.note, c.created_at,
              target.display_name, target.role, evaluator.display_name AS evaluator_name
            FROM member_characteristics c JOIN users target ON target.id = c.user_id
            JOIN users evaluator ON evaluator.id = c.evaluator_id
            ORDER BY c.created_at DESC LIMIT 500`).all();
          return sendJson(res, 200, { characteristics });
        }

        if (pathname === "/api/characteristics" && req.method === "POST") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Добавлять внутренние характеристики может только руководство.");
          const body = await readJson(req);
          const targetId = Number(body.userId);
          const criterion = String(body.criterion || "");
          const score = Number(body.score);
          const note = String(body.note || "").trim();
          const allowedCriteria = ["law", "discipline", "activity", "professionalism", "citizens", "teamwork"];
          const target = db.prepare("SELECT id, role, discord_id, discord_avatar_url, display_name, username FROM users WHERE id = ? AND status = 'active'").get(targetId);
          if (!target || target.role === citizenRole) throw new HttpError(404, "Активный сотрудник не найден.");
          if (!allowedCriteria.includes(criterion) || !Number.isInteger(score) || score < 1 || score > 5 || note.length > 1000) {
            throw new HttpError(400, "Проверьте направление, оценку от 1 до 5 и комментарий (до 1000 символов).");
          }
          const result = db.prepare(`INSERT INTO member_characteristics
            (user_id, evaluator_id, criterion, score, note) VALUES (?, ?, ?, ?, ?)`)
            .run(targetId, user.id, criterion, score, note);
          return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
        }

        if (pathname === "/api/academy" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Академия доступна сотрудникам Коллегии.");
          const materials = db.prepare(`SELECT m.id, m.category, m.kind, m.title, m.body, m.created_at, m.updated_at,
              author.display_name AS author_name, editor.display_name AS editor_name
            FROM academy_materials m JOIN users author ON author.id = m.created_by
            JOIN users editor ON editor.id = m.updated_by
            ORDER BY m.category, m.updated_at DESC, m.id DESC`).all();
          return sendJson(res, 200, { materials });
        }

        if (pathname === "/api/academy" && req.method === "POST") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Добавлять материалы Академии может только руководство.");
          const body = await readJson(req);
          const category = String(body.category || "");
          const kind = String(body.kind || "");
          const title = String(body.title || "").trim();
          const content = String(body.body || "").trim();
          const categories = ["constitutional", "administrative", "criminal", "labor", "advocacy", "court", "documents", "internal"];
          if (!categories.includes(category) || !["lecture", "manual", "exercise"].includes(kind) ||
              title.length < 3 || title.length > 150 || content.length < 5 || content.length > 20000) {
            throw new HttpError(400, "Проверьте раздел, тип, название и содержимое материала.");
          }
          const result = db.prepare(`INSERT INTO academy_materials
            (category, kind, title, body, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(category, kind, title, content, user.id, user.id);
          return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
        }

        const academyRoute = pathname.match(/^\/api\/academy\/(\d+)$/);
        if (academyRoute && ["PATCH", "DELETE"].includes(req.method)) {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Управлять материалами Академии может только руководство.");
          const materialId = Number(academyRoute[1]);
          const existing = db.prepare("SELECT id FROM academy_materials WHERE id = ?").get(materialId);
          if (!existing) throw new HttpError(404, "Материал Академии не найден.");
          if (req.method === "DELETE") {
            db.prepare("DELETE FROM academy_materials WHERE id = ?").run(materialId);
            return sendJson(res, 200, { deleted: true });
          }
          const body = await readJson(req);
          const category = String(body.category || "");
          const kind = String(body.kind || "");
          const title = String(body.title || "").trim();
          const content = String(body.body || "").trim();
          const categories = ["constitutional", "administrative", "criminal", "labor", "advocacy", "court", "documents", "internal"];
          if (!categories.includes(category) || !["lecture", "manual", "exercise"].includes(kind) ||
              title.length < 3 || title.length > 150 || content.length < 5 || content.length > 20000) {
            throw new HttpError(400, "Проверьте раздел, тип, название и содержимое материала.");
          }
          db.prepare(`UPDATE academy_materials SET category = ?, kind = ?, title = ?, body = ?,
            updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(category, kind, title, content, user.id, materialId);
          return sendJson(res, 200, { updated: true });
        }

        if (pathname === "/api/profile" && req.method === "GET") {
          const metrics = evaluateAchievements(db, user.id);
          const profile = db.prepare(`SELECT id, display_name, role, discord_id, created_at, member_since, reattest_due,
              discord_username, discord_avatar_url, forum_profile_url, forum_profile_verified_at,
              profile_bio, profile_pinned_cases, profile_effect, profile_quote,
              (SELECT COUNT(*) FROM documents d WHERE d.user_id = users.id AND d.forum_status = 'approved') AS document_count,
              COALESCE(users.manual_lawsuits, 0) + (SELECT COUNT(*) FROM lawsuits l JOIN documents d ON d.id = l.document_id
                WHERE l.user_id = users.id AND d.forum_status = 'approved') AS lawsuit_count,
              (SELECT COUNT(*) FROM applications a WHERE a.assigned_to = users.id
                AND a.completed_at IS NOT NULL AND a.type IN ('citizen_help','citizen_complaint')) AS closed_request_count,
              (SELECT COUNT(*) FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
                WHERE ta.user_id = users.id AND t.status = 'completed') AS completed_task_count,
              (SELECT COUNT(*) FROM exam_results e WHERE e.user_id = users.id AND e.passed = 1) AS passed_exam_count,
              (SELECT COUNT(*) FROM lawyer_reviews r WHERE r.lawyer_id = users.id) AS review_count,
              (SELECT COALESCE(AVG(r.rating),0) FROM lawyer_reviews r WHERE r.lawyer_id = users.id) AS average_rating
            FROM users WHERE id = ? AND status = 'active'`).get(user.id);
          if (!profile) throw new HttpError(404, "Профиль пользователя не найден.");
          const promotionRows = db.prepare(`SELECT a.requested_role, a.stage_role, a.result, a.reviewed_at,
              reviewer.display_name AS reviewed_by
            FROM applications a LEFT JOIN users reviewer ON reviewer.id = a.reviewed_by
            WHERE a.user_id = ? AND a.type = 'promotion' AND a.status = 'approved'
            ORDER BY COALESCE(a.reviewed_at, a.created_at) DESC LIMIT 50`).all(user.id);
          const reportedCalls = db.prepare(`SELECT promotion_data_json FROM applications
            WHERE user_id = ? AND type = 'promotion' AND status = 'approved'`).all(user.id)
            .map((row) => Number(parseStoredJson(row.promotion_data_json, "отчёт о повышении").completedCalls) || 0);
          profile.approved_call_count = reportedCalls.length ? Math.max(...reportedCalls) : 0;
          profile.average_rating = Number(Number(profile.average_rating).toFixed(1));
          profile.profile_pinned_cases = parseStoredJson(profile.profile_pinned_cases, "закреплённые дела");
          profile.presence = profile.discord_id ? discordPresenceProvider(profile.discord_id) : "offline";
          const [exams, attestationsForProfile, reprimandsForProfile, tasksForProfile, achievements, awards, absencesForProfile, reserveForProfile] = [
            db.prepare(`SELECT track, score, passed, created_at FROM exam_results
              WHERE user_id = ? ORDER BY id DESC LIMIT 30`).all(user.id),
            db.prepare(`SELECT track, status, score, due_at, created_at, completed_at FROM attestations
              WHERE user_id = ? ORDER BY id DESC LIMIT 30`).all(user.id),
            db.prepare(`SELECT r.id, r.reason, r.created_at, issuer.display_name AS issuer_name FROM reprimands r
              JOIN users issuer ON issuer.id = r.issued_by
              WHERE r.user_id = ? AND r.revoked_at IS NULL ORDER BY r.id DESC LIMIT 30`).all(user.id),
            db.prepare(`SELECT t.id, t.title, t.status, t.updated_at FROM tasks t
              JOIN task_assignees ta ON ta.task_id = t.id
              WHERE ta.user_id = ? ORDER BY t.updated_at DESC LIMIT 30`).all(user.id),
            db.prepare(`SELECT a.id, a.slug, a.title, a.description, a.icon, a.metric, a.threshold, ua.awarded_at
              FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
              WHERE ua.user_id = ? ORDER BY ua.awarded_at DESC`).all(user.id),
            db.prepare(`SELECT w.kind, w.title, w.description, w.created_at, issuer.display_name AS granted_by_name
              FROM user_awards w JOIN users issuer ON issuer.id = w.granted_by
              WHERE w.user_id = ? ORDER BY w.id DESC LIMIT 50`).all(user.id),
            db.prepare(`SELECT a.start_date, a.end_date, a.status, a.review_note, a.created_at, a.reviewed_at,
                reviewer.display_name AS reviewer_name
              FROM absence_requests a LEFT JOIN users reviewer ON reviewer.id = a.reviewed_by
              WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 30`).all(user.id),
            db.prepare(`SELECT status, note, updated_at FROM staff_reserve WHERE user_id = ?`).all(user.id)
          ];
          const reviews = db.prepare(`SELECT rating, comment, created_at FROM lawyer_reviews
            WHERE lawyer_id = ? ORDER BY id DESC LIMIT 20`).all(user.id);
          const employmentHistory = db.prepare(`SELECT h.event_type, h.from_role, h.to_role, h.from_status,
              h.to_status, h.details, h.created_at, actor.display_name AS actor_name
            FROM member_employment_history h LEFT JOIN users actor ON actor.id = h.actor_id
            WHERE h.user_id = ? ORDER BY h.id DESC LIMIT 50`).all(user.id);
          return sendJson(res, 200, {
            profile, metrics, promotions: promotionRows, exams, attestations: attestationsForProfile,
            reprimands: reprimandsForProfile, tasks: tasksForProfile, achievements, awards, reviews, employmentHistory,
            absences: absencesForProfile, reserve: reserveForProfile
          });
        }

        if (pathname === "/api/profile" && req.method === "PATCH") {
          const body = await readJson(req);
          const hasForumProfileUpdate = Object.hasOwn(body, "forumProfileUrl");
          const forumProfileUrl = hasForumProfileUpdate
            ? validateForumProfileUrl(body.forumProfileUrl)
            : null;
          const profileBio = typeof body.profileBio === "string"
            ? body.profileBio.trim().slice(0, 700)
            : null;
          const pinnedCases = Array.isArray(body.pinnedCases)
            ? body.pinnedCases.slice(0, 3).map((item) => ({
              title: String(item?.title || "").trim().slice(0, 100),
              status: String(item?.status || "").trim().slice(0, 60)
            })).filter((item) => item.title)
            : null;
          const profileEffect = typeof body.profileEffect === "string"
            ? body.profileEffect
            : null;
          const profileQuote = typeof body.profileQuote === "string"
            ? body.profileQuote.trim().slice(0, 220)
            : null;
          if (profileEffect && !["none", "snow", "confetti", "snowman"].includes(profileEffect)) {
            throw new HttpError(400, "Неизвестный эффект профиля.");
          }
          const updates = [];
          const values = [];
          if (forumProfileUrl !== null) {
            updates.push("forum_profile_url = ?", "forum_profile_verified_at = NULL", "forum_profile_verified_by = NULL");
            values.push(forumProfileUrl);
          }
          if (profileBio !== null) {
            updates.push("profile_bio = ?");
            values.push(profileBio);
          }
          if (pinnedCases !== null) {
            updates.push("profile_pinned_cases = ?");
            values.push(JSON.stringify(pinnedCases));
          }
          if (profileEffect !== null) {
            updates.push("profile_effect = ?");
            values.push(profileEffect);
          }
          if (profileQuote !== null) {
            updates.push("profile_quote = ?");
            values.push(profileQuote);
          }
          if (updates.length) {
            db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values, user.id);
          }
          return sendJson(res, 200, {
            forumProfileUrl,
            profileBio: profileBio ?? user.profile_bio,
            pinnedCases: pinnedCases ?? parseStoredJson(user.profile_pinned_cases, "закреплённые дела"),
            profileEffect: profileEffect ?? user.profile_effect,
            profileQuote: profileQuote ?? user.profile_quote,
            verified: false
          });
        }

        if (pathname === "/api/achievements" && req.method === "GET") {
          const achievements = db.prepare(`SELECT a.id, a.slug, a.title, a.description, a.icon, a.metric,
              a.threshold, a.active, a.created_at,
              ua.awarded_at, ua.awarded_by
            FROM achievements a LEFT JOIN user_achievements ua
              ON ua.achievement_id = a.id AND ua.user_id = ?
            ${["ГКА", "ЗГКА"].includes(user.role) ? "" : "WHERE a.active = 1"}
            ORDER BY a.active DESC, a.id`).all(user.id);
          return sendJson(res, 200, { achievements });
        }

        if (pathname === "/api/achievements" && req.method === "POST") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Создавать достижения может только руководство.");
          const body = await readJson(req);
          const title = String(body.title || "").trim();
          const description = String(body.description || "").trim();
          const icon = String(body.icon || "★").trim();
          const metric = String(body.metric || "");
          const threshold = Number(body.threshold);
          if (title.length < 2 || title.length > 80 || description.length < 2 || description.length > 500 ||
              icon.length > 16 || !["approved_lawsuits", "closed_requests", "approved_documents", "high_reviews", "service_days", "manual"].includes(metric) ||
              !Number.isSafeInteger(threshold) || threshold < 1 || threshold > 100000) {
            throw new HttpError(400, "Проверьте название, описание, условие и порог достижения.");
          }
          const slug = `custom-${Date.now()}-${randomBytes(4).toString("hex")}`;
          const result = db.prepare(`INSERT INTO achievements
            (slug, title, description, icon, metric, threshold, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(slug, title, description, icon, metric, threshold, user.id);
          return sendJson(res, 201, { id: Number(result.lastInsertRowid), slug });
        }

        const achievementAwardRoute = pathname.match(/^\/api\/achievements\/(\d+)\/award$/);
        if (achievementAwardRoute && req.method === "POST") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Выдавать достижения может только руководство.");
          const body = await readJson(req);
          const targetId = Number(body.userId);
          if (!Number.isSafeInteger(targetId)) throw new HttpError(400, "Выберите сотрудника.");
          const achievement = db.prepare("SELECT id, title, metric FROM achievements WHERE id = ? AND active = 1")
            .get(Number(achievementAwardRoute[1]));
          const target = db.prepare("SELECT id, role, discord_id, discord_avatar_url, display_name, username FROM users WHERE id = ? AND status = 'active'").get(targetId);
          if (!achievement || achievement.metric !== "manual") throw new HttpError(404, "Ручное достижение не найдено.");
          if (!target || target.role === citizenRole) throw new HttpError(404, "Активный сотрудник не найден.");
          const result = db.prepare(`INSERT OR IGNORE INTO user_achievements
            (user_id, achievement_id, awarded_by) VALUES (?, ?, ?)`).run(targetId, achievement.id, user.id);
          if (!result.changes) throw new HttpError(409, "Это достижение уже есть у сотрудника.");
          const logWarning = await deliverWebhook(webhooks.logs, "Выдано достижение",
            `${user.display_name} выдал достижение «${achievement.title}» сотруднику ${targetId}.`);
          if (target.discord_id) {
            await sendPortalDirectMessage(targetId, target, target.discord_avatar_url,
              "Получено достижение", `Вам выдано достижение «${achievement.title}» руководством Коллегии.`);
          }
          return sendJson(res, 201, { awarded: true, logWarning });
        }

        if (pathname === "/api/awards" && req.method === "POST") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Вручать награды может только руководство.");
          const body = await readJson(req);
          const targetId = Number(body.userId);
          const kind = String(body.kind || "");
          const title = String(body.title || "").trim();
          const description = String(body.description || "").trim();
          if (!Number.isSafeInteger(targetId) || !["thanks", "certificate", "special", "individual"].includes(kind) ||
              title.length < 2 || title.length > 100 || description.length > 1000) {
            throw new HttpError(400, "Проверьте сотрудника, тип и описание награды.");
          }
          const target = db.prepare("SELECT id, role, discord_id, discord_avatar_url, display_name, username FROM users WHERE id = ? AND status = 'active'").get(targetId);
          if (!target || target.role === citizenRole) throw new HttpError(404, "Активный сотрудник не найден.");
          const result = db.prepare(`INSERT INTO user_awards (user_id, granted_by, kind, title, description)
            VALUES (?, ?, ?, ?, ?)`).run(targetId, user.id, kind, title, description);
          const logWarning = await deliverWebhook(webhooks.logs, "Вручена награда",
            `${user.display_name} вручил «${title}» сотруднику ${targetId}.`);
          if (target.discord_id) {
            await sendPortalDirectMessage(targetId, target, target.discord_avatar_url,
              "Вручена награда", `Вам вручена награда «${title}».\nОснование: ${description || "решение руководства"}`);
          }
          return sendJson(res, 201, { id: Number(result.lastInsertRowid), logWarning });
        }

        const profileRoute = pathname.match(/^\/api\/profiles\/(\d+)$/);
        if (profileRoute && req.method === "GET") {
          const profileId = Number(profileRoute[1]);
          const profile = db.prepare(`SELECT u.id, u.display_name, u.role, u.discord_id, u.discord_username, u.discord_avatar_url, u.created_at,
              u.member_since, u.forum_profile_url, u.forum_profile_verified_at,
              u.profile_bio, u.profile_pinned_cases, u.profile_effect, u.profile_quote,
              (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id AND d.forum_status = 'approved') AS document_count,
              COALESCE(u.manual_lawsuits, 0) + (SELECT COUNT(*) FROM lawsuits l JOIN documents d ON d.id = l.document_id
                WHERE l.user_id = u.id AND d.forum_status = 'approved') AS lawsuit_count,
              (SELECT COUNT(*) FROM activity_reports ar WHERE ar.user_id = u.id
                AND ar.report_type = 'call' AND ar.status = 'approved') AS approved_call_count,
              (SELECT COUNT(*) FROM activity_reports ar WHERE ar.user_id = u.id
                AND ar.report_type = 'bail' AND ar.status = 'approved') AS approved_bail_count,
              (SELECT COUNT(*) FROM applications a WHERE (a.assigned_to = u.id OR a.user_id = u.id) AND a.completed_at IS NOT NULL) AS closed_case_count,
              COUNT(r.id) AS review_count, COALESCE(AVG(r.rating), 0) AS average_rating
            FROM users u LEFT JOIN lawyer_reviews r ON r.lawyer_id = u.id
            WHERE u.id = ? AND u.status = 'active' AND (u.role != 'Гражданин' OR u.id = ?)
            GROUP BY u.id`).get(profileId, user.id);
          if (!profile) throw new HttpError(404, "Профиль участника не найден.");
          profile.average_rating = Number(Number(profile.average_rating).toFixed(1));
          profile.profile_pinned_cases = parseStoredJson(profile.profile_pinned_cases, "закреплённые дела");
          profile.presence = profile.discord_id ? discordPresenceProvider(profile.discord_id) : "offline";
          const reviews = db.prepare(`SELECT r.rating, r.comment, r.created_at, 'Гражданин' AS reviewer_name
            FROM lawyer_reviews r
            WHERE r.lawyer_id = ? ORDER BY r.created_at DESC LIMIT 20`).all(profile.id);
          evaluateAchievements(db, profile.id);
          const achievements = db.prepare(`SELECT a.title, a.description, a.icon, a.metric, a.threshold, ua.awarded_at
            FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
            WHERE ua.user_id = ? ORDER BY ua.awarded_at DESC`).all(profile.id);
          const awards = db.prepare(`SELECT w.kind, w.title, w.description, w.created_at, issuer.display_name AS granted_by_name
            FROM user_awards w JOIN users issuer ON issuer.id = w.granted_by
            WHERE w.user_id = ? ORDER BY w.id DESC LIMIT 50`).all(profile.id);
          return sendJson(res, 200, { profile, reviews, achievements, awards });
        }

        if (pathname === "/api/colleagues" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Список коллег доступен сотрудникам Коллегии.");
          const colleagues = db.prepare(`SELECT u.id, u.display_name, u.role, u.status, u.discord_id, u.discord_username,
              u.profile_bio, u.profile_pinned_cases, u.profile_effect, u.profile_quote, u.member_since,
              u.forum_profile_url, u.forum_profile_verified_at,
              (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id AND d.forum_status = 'approved') AS document_count,
              (SELECT COUNT(*) FROM applications a WHERE a.assigned_to = u.id AND a.completed_at IS NOT NULL
                AND a.type IN ('citizen_help','citizen_complaint')) AS closed_case_count,
              COALESCE(u.manual_lawsuits, 0) + (SELECT COUNT(*) FROM lawsuits l JOIN documents d ON d.id = l.document_id
                WHERE l.user_id = u.id AND d.forum_status = 'approved') AS lawsuit_count,
              (SELECT COUNT(*) FROM activity_reports ar WHERE ar.user_id = u.id
                AND ar.report_type = 'call' AND ar.status = 'approved') AS approved_call_count,
              (SELECT COUNT(*) FROM activity_reports ar WHERE ar.user_id = u.id
                AND ar.report_type = 'bail' AND ar.status = 'approved') AS approved_bail_count
            FROM users u
            WHERE u.role != 'Гражданин' AND u.status = 'active'
            ORDER BY CASE u.role
              WHEN 'Губернатор' THEN 0 WHEN 'ГКА' THEN 1 WHEN 'ЗГКА' THEN 2 WHEN 'Ст.Адвокат' THEN 3
              WHEN 'Адвокат' THEN 4 WHEN 'Юрист' THEN 5 ELSE 6 END, u.display_name`).all();
          return sendJson(res, 200, {
            colleagues: colleagues.map((item) => ({
              ...item,
              pinnedCases: parseStoredJson(item.profile_pinned_cases, "закреплённые дела"),
              achievements: db.prepare(`SELECT a.id, a.title, a.description, a.icon, a.metric, a.threshold, ua.awarded_at
                FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
                WHERE ua.user_id = ? ORDER BY ua.awarded_at DESC LIMIT 8`).all(item.id),
              presence: item.discord_id ? discordPresenceProvider(item.discord_id) : "offline"
            }))
          });
        }

        if (pathname === "/api/members" && req.method === "GET") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Нет доступа к составу.");
          const members = db.prepare(`SELECT id, username, display_name, email, role, status, created_at, reattest_due, last_login,
            discord_id, discord_username, discord_avatar_url, forum_profile_url, forum_profile_verified_at, member_since,
            (SELECT COUNT(*) FROM documents WHERE user_id = users.id AND forum_status = 'approved') AS document_count,
            COALESCE(users.manual_lawsuits, 0) + (SELECT COUNT(*) FROM lawsuits l JOIN documents d ON d.id = l.document_id
              WHERE l.user_id = users.id AND d.forum_status = 'approved') AS lawsuit_count
            FROM users
            ORDER BY CASE role
              WHEN 'Губернатор' THEN 0 WHEN 'ГКА' THEN 1 WHEN 'ЗГКА' THEN 2 WHEN 'Ст.Адвокат' THEN 3
              WHEN 'Адвокат' THEN 4 WHEN 'Юрист' THEN 5 WHEN 'Стажер КА' THEN 6 ELSE 7 END,
              CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
              display_name COLLATE NOCASE`).all();
          return sendJson(res, 200, { members });
        }

        const passwordResetRoute = pathname.match(/^\/api\/members\/(\d+)\/reset-password$/);
        if (passwordResetRoute && req.method === "POST") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Создать код восстановления может только ГКА.");
          const memberId = Number(passwordResetRoute[1]);
          const member = db.prepare("SELECT id, display_name FROM users WHERE id = ?").get(memberId);
          if (!member) throw new HttpError(404, "Участник не найден.");
          const code = randomBytes(32).toString("base64url");
          db.prepare("UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL")
            .run(memberId);
          db.prepare("INSERT INTO password_resets (token_hash,user_id,created_by,expires_at) VALUES (?,?,?,?)")
            .run(hashToken(code), memberId, user.id, Date.now() + 30 * 60 * 1000);
          const logWarning = await deliverWebhook(webhooks.logs, "Выдан код восстановления", `${user.display_name} подготовил одноразовый код восстановления для ${member.display_name}.`);
          return sendJson(res, 201, { code, expiresAt: Date.now() + 30 * 60 * 1000, logWarning });
        }

        if (pathname === "/api/invites" && req.method === "POST") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Создавать приглашения может только ГКА.");
          const code = randomBytes(24).toString("base64url");
          const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
          db.prepare("INSERT INTO invites (code_hash, created_by, expires_at) VALUES (?, ?, ?)")
            .run(hashToken(code), user.id, expiresAt);
          const logWarning = await deliverWebhook(webhooks.logs, "Создано приглашение в коллегию", `${user.display_name} создал одноразовое приглашение для нового стажера.`);
          return sendJson(res, 201, { code, expiresAt, logWarning });
        }

        const memberDismissRoute = pathname.match(/^\/api\/members\/(\d+)\/dismiss$/);
        if (memberDismissRoute && req.method === "POST") {
          if (!managementRoles.includes(user.role)) {
            throw new HttpError(403, "Увольнять сотрудников может только ГКА или ЗГКА.");
          }
          const body = requireObject(await readJson(req));
          const memberId = Number(memberDismissRoute[1]);
          if (memberId === governorUserId && !hasFullGkaAccess(user)) {
            throw new HttpError(403, "Уволить губернатора может только администратор сайта.");
          }
          const reason = String(body.reason || "").trim();
          if (reason.length < 4 || reason.length > 1000) {
            throw new HttpError(400, "Причина удаления должна содержать от 4 до 1000 символов.");
          }
          if (memberId === Number(user.id)) throw new HttpError(409, "Нельзя удалить текущий аккаунт.");
          const member = db.prepare("SELECT * FROM users WHERE id = ?").get(memberId);
          if (!member) throw new HttpError(404, "Аккаунт не найден.");
          if (member.role === "ГКА" && member.status === "active" && !hasGkaAccess(user) &&
              !db.prepare("SELECT 1 FROM users WHERE id != ? AND role = 'ГКА' AND status = 'active' LIMIT 1").get(memberId)) {
            throw new HttpError(409, "Нельзя удалить последнего активного ГКА без полного доступа управления.");
          }

          db.exec("BEGIN IMMEDIATE");
          try {
            permanentlyDeleteUser(memberId);
            if (db.prepare("SELECT 1 FROM users WHERE id = ?").get(memberId)) {
              throw new Error("Не удалось удалить аккаунт.");
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }

          const dmWarning = await sendDiscordDirectMessage(
            member.discord_id, member, member.discord_avatar_url, "Уведомление об увольнении",
            `Ваша учётная запись портала и связанные данные окончательно удалены.\nПричина: ${reason}`,
            { token: discord.botToken, fetchImpl: discordFetch }
          );
          const discordWarning = await revokeDiscordAccess(member);
          return sendJson(res, 200, { ok: true, dmWarning, discordWarning });
        }

        if (pathname === "/api/members/purge-all" && req.method === "POST") {
          if (!hasGkaAccess(user)) {
            throw new HttpError(403, "Массовое удаление доступно только ГКА или ЗГКА с полным доступом.");
          }
          const body = requireObject(await readJson(req));
          const reason = String(body.reason || "").trim();
          if (reason.length < 4 || reason.length > 1000) {
            throw new HttpError(400, "Укажите общую причину длиной от 4 до 1000 символов.");
          }
          if (body.confirmation !== "УДАЛИТЬ ВСЕ") {
            throw new HttpError(400, "Для подтверждения введите «УДАЛИТЬ ВСЕ».");
          }
          const canDismissGovernor = hasFullGkaAccess(user);
          const members = db.prepare(`SELECT * FROM users
            WHERE id != ? AND (? = 1 OR id != ?) ORDER BY id`)
            .all(user.id, canDismissGovernor ? 1 : 0, governorUserId);
          if (!members.length) return sendJson(res, 200, { deletedCount: 0, warnings: [] });

          db.exec("BEGIN IMMEDIATE");
          try {
            for (const member of members) permanentlyDeleteUser(member.id);
            const remaining = db.prepare(`SELECT COUNT(*) AS count FROM users
              WHERE id != ? AND (? = 1 OR id != ?)`)
              .get(user.id, canDismissGovernor ? 1 : 0, governorUserId).count;
            if (Number(remaining) !== 0) throw new Error("Не удалось удалить все выбранные аккаунты.");
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }

          const warnings = [];
          for (const member of members) {
            const dmWarning = await sendDiscordDirectMessage(
              member.discord_id, member, member.discord_avatar_url, "Уведомление об увольнении",
              `Ваша учётная запись портала и связанные данные окончательно удалены.\nПричина: ${reason}`,
              { token: discord.botToken, fetchImpl: discordFetch }
            );
            const discordWarning = await revokeDiscordAccess(member);
            if (dmWarning || discordWarning) {
              warnings.push({ displayName: member.display_name, dmWarning, discordWarning });
            }
          }
          return sendJson(res, 200, { deletedCount: members.length, warnings });
        }

        const memberRoute = pathname.match(/^\/api\/members\/(\d+)$/);
        if (memberRoute && req.method === "PATCH") {
          if (!managementRoles.includes(user.role)) {
            throw new HttpError(403, "Изменять роли и статус аккаунта могут ГКА и ЗГКА.");
          }
          const body = await readJson(req);
          const memberId = Number(memberRoute[1]);
          const member = db.prepare("SELECT * FROM users WHERE id = ?").get(memberId);
          if (!member) throw new HttpError(404, "Участник не найден.");
          if (member.role === "ГКА" && !hasGkaAccess(user) &&
              (body.role !== undefined || body.status !== undefined)) {
            throw new HttpError(403, "Изменять должность или статус ГКА может только ГКА с полным доступом.");
          }
          if (body.role !== undefined && !roles.includes(body.role)) throw new HttpError(400, "Неизвестная роль.");
          if (body.role === governorRole && memberId !== governorUserId) {
            throw new HttpError(400, "Роль «Губернатор» может быть назначена только аккаунту #43.");
          }
          if (body.status !== undefined && !["pending", "active", "suspended"].includes(body.status)) {
            throw new HttpError(400, "Неизвестный статус аккаунта.");
          }
          if (body.displayName !== undefined && typeof body.displayName !== "string") {
            throw new HttpError(400, "Имя должно быть текстом длиной от 2 до 80 символов.");
          }
          if (body.memberSince !== undefined && typeof body.memberSince !== "string") {
            throw new HttpError(400, "Дата вступления должна быть указана в формате ГГГГ-ММ-ДД.");
          }
          if (body.forumProfileVerified !== undefined && typeof body.forumProfileVerified !== "boolean") {
            throw new HttpError(400, "Статус привязки форума указан некорректно.");
          }
          if ((body.memberSince !== undefined || body.forumProfileVerified !== undefined) && !hasGkaAccess(user)) {
            throw new HttpError(403, "Дату вступления и проверку профиля форума может менять только ГКА.");
          }
          const displayName = body.displayName === undefined ? undefined : body.displayName.trim();
          if (displayName !== undefined && (displayName.length < 2 || displayName.length > 80)) {
            throw new HttpError(400, "Имя должно содержать от 2 до 80 символов.");
          }
          const memberSince = body.memberSince === undefined ? undefined : body.memberSince.trim();
          if (memberSince !== undefined && memberSince !== "" &&
              (!/^\d{4}-\d{2}-\d{2}$/.test(memberSince) || Number.isNaN(Date.parse(`${memberSince}T00:00:00Z`)) ||
               new Date(`${memberSince}T00:00:00Z`).toISOString().slice(0, 10) !== memberSince)) {
            throw new HttpError(400, "Укажите корректную дату вступления.");
          }
          if (body.forumProfileVerified === true && !member.forum_profile_url) {
            throw new HttpError(409, "Сначала участник должен сохранить ссылку на профиль форума.");
          }
          if (memberId === user.id && (body.role !== undefined || body.status === "suspended")) {
            throw new HttpError(409, "Нельзя лишить текущий аккаунт ГКА последнего доступа к управлению.");
          }
          db.exec("BEGIN IMMEDIATE");
          try {
          if (body.role !== undefined) {
            db.prepare("UPDATE users SET role = ? WHERE id = ?").run(body.role, memberId);
          }
          if (body.status !== undefined) {
            db.prepare("UPDATE users SET status = ? WHERE id = ?").run(body.status, memberId);
          }
          if (displayName !== undefined) {
            db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(displayName, memberId);
          }
          if (memberSince !== undefined) {
            db.prepare("UPDATE users SET member_since = ? WHERE id = ?").run(memberSince, memberId);
          }
          if (body.forumProfileVerified !== undefined) {
            db.prepare(`UPDATE users SET forum_profile_verified_at = ${body.forumProfileVerified ? "CURRENT_TIMESTAMP" : "NULL"},
              forum_profile_verified_by = ? WHERE id = ?`)
              .run(body.forumProfileVerified ? user.id : null, memberId);
          }
            recordEmploymentEvent(db, {
              userId: memberId, actorId: user.id,
              fromRole: member.role, toRole: body.role ?? member.role,
              fromStatus: member.status, toStatus: body.status ?? member.status,
              details: body.status === "suspended" ? "Доступ сотрудника приостановлен руководством."
                : body.status === "active" && member.status !== "active" ? "Доступ сотрудника восстановлен руководством."
                  : body.role !== undefined ? "Должность изменена руководством." : ""
            });
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          const changed = [
            body.role !== undefined ? `роль: ${member.role} → ${body.role}` : "",
            body.status !== undefined ? `статус: ${member.status} → ${body.status}` : "",
            memberSince !== undefined && memberSince !== member.member_since
              ? `дата вступления: ${member.member_since || "не указана"} → ${memberSince || "не указана"}` : "",
            body.forumProfileVerified !== undefined
              ? `профиль форума: ${body.forumProfileVerified ? "подтвержден" : "не подтвержден"}` : "",
            displayName !== undefined && displayName !== member.display_name
              ? `имя: ${member.display_name} → ${displayName}` : ""
          ].filter(Boolean).join("; ");
          const discordChanged = body.role !== undefined || body.status !== undefined ||
            (displayName !== undefined && displayName !== member.display_name);
          if (memberId !== user.id && (body.role !== undefined || body.status !== undefined)) {
            const approved = body.status === "active" && member.status !== "active";
            await notifyPortalUser({
              userId: memberId,
              type: "account_change",
              title: approved ? "Доступ одобрен" : body.status === "suspended" ? "Доступ приостановлен" : "Изменена должность",
              body: approved ? "ГКА одобрил вашу учётную запись. Теперь доступны разделы Коллегии."
                : body.status === "suspended" ? "Руководство приостановило доступ к аккаунту."
                  : `Ваша должность изменена на «${body.role ?? member.role}».`,
              href: "/page/home"
            });
          }
          const discordResult = discordChanged
            ? await syncDiscordMember(memberId)
            : { syncError: "", nicknameWarning: "" };
          const logWarning = changed
            ? await deliverWebhook(webhooks.logs, "Изменен состав коллегии", `${user.display_name} изменил ${member.display_name}: ${changed}.`)
            : "";
          return sendJson(res, 200, {
            user: cleanUser(publicUser(db, memberId)),
            discordWarning: discordResult.syncError,
            nicknameWarning: discordResult.nicknameWarning,
            logWarning
          });
        }

        if (pathname === "/api/reprimands" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Выговоры доступны только сотрудникам Коллегии.");
          const manager = ["ГКА", "ЗГКА"].includes(user.role);
          const includeArchived = requestUrl.searchParams.get("archived") === "1";
          if (includeArchived && !hasGkaAccess(user)) throw new HttpError(403, "Архив взысканий доступен только ГКА.");
          const rows = db.prepare(`SELECT r.id, r.user_id, r.issued_by, r.reason, r.photo_name, r.created_at,
              r.revoked_at, r.revoked_by, r.revoked_by_name,
              target.display_name, target.role, target.discord_id, target.discord_username,
              issuer.display_name AS issuer_name
            FROM reprimands r JOIN users target ON target.id = r.user_id
            JOIN users issuer ON issuer.id = r.issued_by
            WHERE (? = 1 OR r.archived_at IS NULL) ${manager ? "" : "AND r.user_id = ? AND r.revoked_at IS NULL"}
            ORDER BY r.id DESC LIMIT 200`)
            .all(includeArchived ? 1 : 0, ...(manager ? [] : [user.id]));
          return sendJson(res, 200, { reprimands: rows });
        }

        if (pathname === "/api/reprimands" && req.method === "POST") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Выдавать выговоры может только руководство.");
          const body = await readJson(req, 3 * 1024 * 1024);
          const targetId = Number(body.userId);
          const reason = String(body.reason || "").trim();
          if (!Number.isSafeInteger(targetId) || reason.length < 4 || reason.length > 1000) {
            throw new HttpError(400, "Выберите сотрудника и укажите основание длиной от 4 до 1000 символов.");
          }
          const target = db.prepare("SELECT id, display_name, role, discord_id, discord_username, status FROM users WHERE id = ?")
            .get(targetId);
          if (!target || target.role === citizenRole || target.status !== "active") {
            throw new HttpError(404, "Активный сотрудник не найден.");
          }
          if (target.role === "ГКА" && !hasGkaAccess(user)) {
            throw new HttpError(403, "ЗГКА не может выдать выговор Главе Коллегии.");
          }
          const [photo] = parseApplicationAttachments([body.photo]);
          if (!photo || !photo.contentType.startsWith("image/")) {
            throw new HttpError(400, "К выговору нужно приложить фотографию в формате JPG, PNG или WebP.");
          }
          const insert = db.prepare(`INSERT INTO reprimands
            (user_id, issued_by, reason, photo_name, photo_type, photo)
            VALUES (?, ?, ?, ?, ?, ?)`)
            .run(target.id, user.id, reason, photo.name, photo.contentType, photo.content);
          const id = Number(insert.lastInsertRowid);
          await notifyPortalUser({
            userId: target.id,
            type: "reprimand",
            title: `Выговор №${id}`,
            body: reason,
            href: "/page/audit",
            sendDiscord: false
          });
          const fields = [
            { name: "🔢 Кадровый аудит", value: `Выговор #${id}`, inline: true },
            { name: "👤 Сотрудник", value: `${target.display_name} · ${target.role}`, inline: true },
            { name: "🆔 ID портала", value: `#${target.id}`, inline: true },
            { name: "🆔 Discord ID", value: target.discord_id || "не привязан", inline: true },
            { name: "💬 Discord", value: target.discord_username ? `@${target.discord_username}` : "не привязан", inline: true },
            { name: "📌 Основание", value: reason },
            { name: "🖋️ Выдал", value: `${user.display_name} · ${user.role}`, inline: true },
            { name: "📷 Фото", value: `Прикреплено: ${photo.name}`, inline: true }
          ];
          const dmWarning = await notifyReprimandByDm(target, id, reason, photo, fields);
          const safeDisplayName = String(target.display_name)
            .replace(/[\r\n]/g, " ").replace(/```/g, "'''").trim() || "Имя не указано";
          const targetContent = target.discord_id
            ? `<@${target.discord_id}>`
            : `\`\`\`\n${safeDisplayName}\n\`\`\``;
          const warning = await deliverWebhook(webhooks.warnings || webhooks.logs, `⚠️ Выговор №${id}`,
            `${target.display_name} получил(а) дисциплинарное взыскание.`,
            fields,
            { name: photo.name, contentType: photo.contentType, content: photo.content },
            {
              content: targetContent,
              mentionUsers: target.discord_id ? [target.discord_id] : []
            });
          return sendJson(res, 201, { id, dmWarning, webhookWarning: warning });
        }

        const reprimandPhotoRoute = pathname.match(/^\/api\/reprimands\/(\d+)\/photo$/);
        if (reprimandPhotoRoute && req.method === "GET") {
          const item = db.prepare("SELECT * FROM reprimands WHERE id = ?").get(Number(reprimandPhotoRoute[1]));
          if (!item || (item.user_id !== user.id && !["ГКА", "ЗГКА"].includes(user.role))) {
            throw new HttpError(404, "Фотография выговора не найдена.");
          }
          res.writeHead(200, {
            "content-type": item.photo_type,
            "content-length": item.photo.length,
            "content-disposition": "inline",
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff"
          });
          return res.end(item.photo);
        }

        if (pathname === "/api/attestations" && req.method === "GET") {
          let rows = db.prepare(`SELECT a.*, u.display_name, u.username, creator.display_name AS assigned_by
            FROM attestations a JOIN users u ON u.id = a.user_id JOIN users creator ON creator.id = a.created_by
            ORDER BY a.due_at DESC LIMIT 300`).all();
          if (!["ГКА", "ЗГКА"].includes(user.role)) rows = rows.filter((item) => item.user_id === user.id);
          return sendJson(res, 200, { attestations: rows });
        }

        if (pathname === "/api/attestations" && req.method === "POST") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Назначать переаттестацию может руководство.");
          const body = await readJson(req);
          const memberId = Number(body.userId);
          const track = String(body.track || "");
          const dueAt = new Date(String(body.dueAt || ""));
          const member = db.prepare("SELECT id, role FROM users WHERE id = ? AND status = 'active'").get(memberId);
          if (!member) throw new HttpError(404, "Активный участник не найден.");
          if (!examBank[track]) throw new HttpError(400, "Для выбранной ступени нет учебного теста.");
          if (dueAt.toString() === "Invalid Date" || dueAt.getTime() < Date.now()) throw new HttpError(400, "Укажите будущий срок переаттестации.");
          const result = db.prepare("INSERT INTO attestations (user_id, track, due_at, created_by) VALUES (?, ?, ?, ?)")
            .run(memberId, track, dueAt.toISOString(), user.id);
          return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
        }

        if (pathname === "/api/documents" && req.method === "GET") {
          if (!documentRoles.includes(user.role)) throw new HttpError(403, "Документы доступны начиная с должности «Юрист».");
          const manager = ["ГКА", "ЗГКА"].includes(user.role);
          const documents = manager
            ? db.prepare(`SELECT d.id,d.user_id,d.template,d.title,d.created_at,d.forum_url,d.forum_status,
                d.forum_review_note,d.forum_reviewed_at,u.display_name
              FROM documents d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 200`).all()
            : db.prepare(`SELECT id,user_id,template,title,created_at,forum_url,forum_status,
                forum_review_note,forum_reviewed_at FROM documents WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`).all(user.id);
          const myCount = db.prepare("SELECT COUNT(*) AS count FROM documents WHERE user_id = ? AND forum_status = 'approved'").get(user.id).count;
          const approvedCount = manager
           ? db.prepare("SELECT COUNT(*) AS count FROM documents WHERE forum_status = 'approved'").get().count
           : myCount;
          return sendJson(res, 200, { documents, myCount, approvedCount });
        }

        const documentMatch = pathname.match(/^\/api\/documents\/(\d+)$/);
        if (documentMatch && req.method === "GET") {
          if (!documentRoles.includes(user.role)) throw new HttpError(403, "Документы доступны начиная с должности «Юрист».");
          const document = db.prepare("SELECT * FROM documents WHERE id = ?").get(Number(documentMatch[1]));
          if (!document || (document.user_id !== user.id && !["ГКА", "ЗГКА"].includes(user.role))) {
            throw new HttpError(404, "Документ не найден.");
          }
          return sendJson(res, 200, { document });
        }

        if (pathname === "/api/documents" && req.method === "POST") {
          if (!documentRoles.includes(user.role)) throw new HttpError(403, "Создавать документы можно начиная с должности «Юрист».");
          const body = await readJson(req);
          const template = String(body.template || "").slice(0, 60);
          const title = String(body.title || "").trim().slice(0, 150);
          const bbcode = String(body.bbcode || "");
          if (!template || title.length < 3 || bbcode.length < 30 || bbcode.length > 50000) {
            throw new HttpError(400, "Проверьте тип, название и содержимое документа.");
          }
          const result = db.prepare("INSERT INTO documents (user_id,template,title,bbcode) VALUES (?,?,?,?)")
            .run(user.id, template, title, bbcode);
          return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
        }

        const documentForumRoute = pathname.match(/^\/api\/documents\/(\d+)\/forum$/);
        if (documentForumRoute && req.method === "POST") {
          if (!documentRoles.includes(user.role)) throw new HttpError(403, "Публикации документов доступны начиная с должности «Юрист».");
          const body = await readJson(req);
          const forumUrl = validateForumUrl(body.forumUrl);
          const document = db.prepare("SELECT id,user_id,title,forum_status FROM documents WHERE id = ?")
            .get(Number(documentForumRoute[1]));
          if (!document || document.user_id !== user.id) throw new HttpError(404, "Документ не найден.");
          if (!["draft", "rejected"].includes(document.forum_status)) {
            throw new HttpError(409, "Эта публикация уже ожидает или получила решение руководства.");
          }
          db.prepare(`UPDATE documents SET forum_url = ?, forum_status = 'pending',
            forum_review_note = '', forum_reviewed_by = NULL, forum_reviewed_at = NULL WHERE id = ?`)
            .run(forumUrl, document.id);
          const warning = await deliverWebhook(webhooks.applications, "Документ отправлен на проверку",
            `${user.display_name} отправил публикацию на подтверждение.`,
            [
              { name: "Участник", value: user.display_name, inline: true },
              { name: "Документ", value: `#${document.id}`, inline: true },
              { name: "Ссылка на форум", value: forumUrl.slice(0, 1000), inline: false }
            ]);
          await notifyPortalRoles(managementRoles, {
            type: "document_forum_review",
            title: "Ссылка на документ ждёт одобрения",
            body: `${user.display_name} добавил ссылку на форум к документу «${document.title || `#${document.id}`}».`,
            href: "/page/iski"
          }, user.id);
          return sendJson(res, 200, { ok: true, warning });
        }
        if (documentForumRoute && req.method === "PATCH") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Подтверждать публикации может только руководство.");
          const body = await readJson(req);
          const status = String(body.status || "");
          const note = String(body.note || "").trim().slice(0, 500);
          if (!["approved", "rejected"].includes(status)) throw new HttpError(400, "Выберите одобрить или отклонить публикацию.");
          const document = db.prepare(`SELECT d.id,d.user_id,d.title,d.forum_status,u.display_name
            FROM documents d JOIN users u ON u.id = d.user_id WHERE d.id = ?`)
            .get(Number(documentForumRoute[1]));
          if (!document) throw new HttpError(404, "Документ не найден.");
          if (document.forum_status !== "pending") throw new HttpError(409, "Публикация уже рассмотрена или не отправлена.");
          if (status === "rejected" && note.length < 4) {
            throw new HttpError(400, "При отклонении укажите причину для автора.");
          }
          db.prepare(`UPDATE documents SET forum_status = ?, forum_review_note = ?,
            forum_reviewed_by = ?, forum_reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(status, note, user.id, document.id);
          const logWarning = await deliverWebhook(webhooks.logs, "Решение по публикации документа",
            `${user.display_name} ${status === "approved" ? "подтвердил" : "отклонил"} публикацию ${document.title} участника ${document.display_name}.`,
            [
              { name: "Документ", value: document.title, inline: true },
              { name: "Автор", value: document.display_name, inline: true },
              { name: "Решение", value: status === "approved" ? "Одобрено" : `Отклонено: ${note}`, inline: false }
            ]);
          await notifyPortalUser({
            userId: document.user_id,
            type: status === "approved" ? "document_forum_approved" : "document_forum_rejected",
            title: status === "approved" ? "Ссылка на форум одобрена" : "Ссылка на форум отклонена",
            body: `${document.title}${status === "rejected" ? ` — ${note}` : ""}`,
            href: "/page/iski"
          });
          return sendJson(res, 200, { ok: true, logWarning });
        }

        if (pathname === "/api/lawsuits" && req.method === "GET") {
          if (!documentRoles.includes(user.role)) throw new HttpError(403, "Судебные дела доступны начиная с должности «Юрист».");
          const manager = ["ГКА", "ЗГКА"].includes(user.role);
          const rows = db.prepare(`SELECT l.*, u.display_name, u.role AS filer_role,
              d.template, d.id AS document_id,d.forum_url,d.forum_status,d.forum_review_note,
              reviewer.display_name AS updated_by_name
            FROM lawsuits l JOIN users u ON u.id = l.user_id
            JOIN documents d ON d.id = l.document_id
            LEFT JOIN users reviewer ON reviewer.id = l.updated_by
            ${manager ? "" : "WHERE l.user_id = ?"}
            ORDER BY l.updated_at DESC, l.id DESC LIMIT 300`).all(...(manager ? [] : [user.id]));
          return sendJson(res, 200, { lawsuits: rows });
        }

        const lawsuitHistoryRoute = pathname.match(/^\/api\/lawsuits\/(\d+)\/history$/);
        if (lawsuitHistoryRoute && req.method === "GET") {
          const item = db.prepare("SELECT id, user_id FROM lawsuits WHERE id = ?")
            .get(Number(lawsuitHistoryRoute[1]));
          if (!item || (item.user_id !== user.id && !["ГКА", "ЗГКА"].includes(user.role))) {
            throw new HttpError(404, "История судебного дела не найдена.");
          }
          const history = db.prepare(`SELECT h.id, h.event_type, h.details, h.created_at,
              actor.display_name AS actor_name, actor.role AS actor_role
            FROM lawsuit_history h LEFT JOIN users actor ON actor.id = h.actor_id
            WHERE h.lawsuit_id = ? ORDER BY h.id`).all(item.id);
          return sendJson(res, 200, { history });
        }

        const lawsuitWorkflowRoute = pathname.match(/^\/api\/lawsuits\/(\d+)\/workflow$/);
        if (lawsuitWorkflowRoute && req.method === "PATCH") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) {
            throw new HttpError(403, "Менять срок и приоритет судебного дела может только руководство.");
          }
          const item = db.prepare("SELECT id, status, priority, due_at FROM lawsuits WHERE id = ?")
            .get(Number(lawsuitWorkflowRoute[1]));
          if (!item) throw new HttpError(404, "Судебное дело не найдено.");
          if (["decided", "rejected"].includes(item.status)) {
            throw new HttpError(409, "Срок и приоритет завершённого дела нельзя менять.");
          }
          const body = await readJson(req);
          const priority = String(body.priority || "");
          const dueAt = body.dueAt === null || body.dueAt === "" ? null : String(body.dueAt || "");
          if (!["low", "normal", "high", "urgent"].includes(priority)) {
            throw new HttpError(400, "Выберите допустимый приоритет дела.");
          }
          if (dueAt && (dueAt.length > 40 || Number.isNaN(Date.parse(dueAt)))) {
            throw new HttpError(400, "Укажите корректный срок судебного дела.");
          }
          const changes = [];
          if (item.priority !== priority) changes.push(`Приоритет: ${item.priority} → ${priority}.`);
          if (item.due_at !== dueAt) changes.push(`Срок: ${item.due_at || "не установлен"} → ${dueAt || "снят"}.`);
          if (changes.length) {
            db.prepare("UPDATE lawsuits SET priority = ?, due_at = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
              .run(priority, dueAt, user.id, item.id);
            db.prepare(`INSERT INTO lawsuit_history (lawsuit_id, actor_id, event_type, details)
              VALUES (?, ?, 'workflow_updated', ?)`).run(item.id, user.id, changes.join(" "));
          }
          return sendJson(res, 200, { ok: true, changed: changes.length > 0 });
        }

        if (pathname === "/api/lawsuits" && req.method === "POST") {
          if (!documentRoles.includes(user.role)) throw new HttpError(403, "Подавать исковые документы можно начиная с должности «Юрист».");
          const body = await readJson(req);
          const template = String(body.template || "");
          const title = String(body.title || "").trim().slice(0, 150);
          const bbcode = String(body.bbcode || "");
          const courtTemplates = {
            "lawsuit-supreme": "Верховный суд",
            "lawsuit-federal": "Федеральный суд",
            "motion-supreme": "Верховный суд · ходатайство",
            "motion-federal": "Окружной суд · ходатайство",
            "rehabilitation": "Верховный суд · реабилитация",
            appeal: "Верховный суд · апелляция"
          };
          if (!courtTemplates[template] || title.length < 3 || bbcode.length < 30 || bbcode.length > 50000) {
            throw new HttpError(400, "Проверьте вид, название и содержимое искового документа.");
          }
          db.exec("BEGIN IMMEDIATE");
          try {
            const document = db.prepare(`INSERT INTO documents
              (user_id,template,title,bbcode) VALUES (?,?,?,?)`)
              .run(user.id, template, title, bbcode);
            const created = db.prepare("INSERT INTO lawsuits (user_id,document_id,title,court) VALUES (?,?,?,?)")
              .run(user.id, Number(document.lastInsertRowid), title, courtTemplates[template]);
            db.prepare(`INSERT INTO lawsuit_history (lawsuit_id, actor_id, event_type, details)
              VALUES (?, ?, 'created', ?)`)
              .run(Number(created.lastInsertRowid), user.id, `Иск подан в ${courtTemplates[template]}.`);
            db.exec("COMMIT");
            const warning = await deliverWebhook(webhooks.applications, "Создан судебный документ",
              `${user.display_name} создал судебное дело. Ссылка на опубликованную тему будет добавлена отдельно.`,
              [
                { name: "Дело", value: `#${Number(created.lastInsertRowid)} · ${title}`, inline: false },
                { name: "Суд", value: courtTemplates[template], inline: true },
                { name: "Публикация", value: "Ссылка ещё не добавлена", inline: true }
              ]);
            await notifyPortalRoles(managementRoles, {
              type: "lawsuit_created",
              title: "Создан судебный документ",
              body: `${user.display_name} создал «${title}» в ${courtTemplates[template]}. Ссылка на форум будет добавлена отдельно.`,
              href: "/page/iski"
            }, user.id);
            return sendJson(res, 201, { id: Number(created.lastInsertRowid), documentId: Number(document.lastInsertRowid), warning });
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }

        const lawsuitRoute = pathname.match(/^\/api\/lawsuits\/(\d+)$/);
        if (lawsuitRoute && req.method === "PATCH") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Рассматривать иски может только руководство.");
          const body = await readJson(req);
          const status = String(body.status || "");
          const decision = String(body.decision || "").trim().slice(0, 2000);
          if (!["in_review", "hearing", "decided", "rejected"].includes(status)) {
            throw new HttpError(400, "Выберите допустимый статус рассмотрения.");
          }
          if (["decided", "rejected"].includes(status) && decision.length < 4) {
            throw new HttpError(400, "Для итогового решения укажите причину или результат рассмотрения.");
          }
          const item = db.prepare(`SELECT l.id,l.document_id,l.user_id,l.title,d.forum_status FROM lawsuits l
            JOIN documents d ON d.id = l.document_id WHERE l.id = ?`).get(Number(lawsuitRoute[1]));
          if (!item) throw new HttpError(404, "Иск не найден.");
          if (status !== "rejected" && item.forum_status !== "approved") {
            throw new HttpError(409, "Сначала подтвердите ссылку на опубликованное заявление.");
          }
          const current = db.prepare("SELECT status FROM lawsuits WHERE id = ?").get(item.id);
          const transitions = {
            submitted: ["in_review", "rejected"],
            in_review: ["hearing", "decided", "rejected"],
            hearing: ["decided", "rejected"]
          };
          if (!transitions[current.status]?.includes(status)) {
            throw new HttpError(409, "Нельзя перевести дело из текущего статуса на выбранный этап.");
          }
          db.prepare(`UPDATE lawsuits SET status = ?, decision = ?, updated_by = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(status, decision, user.id, item.id);
          db.prepare(`INSERT INTO lawsuit_history (lawsuit_id, actor_id, event_type, details)
            VALUES (?, ?, ?, ?)`).run(item.id, user.id, status,
              decision || `Статус изменён на ${status}.`);
          const lawsuitStatusLabels = {
            in_review: "Иск принят на рассмотрение",
            hearing: "По иску назначено заседание",
            decided: "По иску внесено решение",
            rejected: "Иск отклонён"
          };
          await notifyPortalUser({
            userId: item.user_id,
            type: "lawsuit_update",
            title: lawsuitStatusLabels[status],
            body: `${item.title}${decision ? ` — ${decision}` : ""}`,
            href: "/page/iski"
          });
          return sendJson(res, 200, { ok: true });
        }

        if (pathname === "/api/sequences/next" && req.method === "POST") {
          if (!documentRoles.includes(user.role)) throw new HttpError(403, "Конструкторы документов доступны начиная с должности «Юрист».");
          const body = await readJson(req);
          const sequence = body.type === "complaint" ? { key: "complaint", prefix: "CP", width: 4 }
            : body.type === "rehabilitation" ? { key: "rehabilitation", prefix: "", width: 3 }
              : null;
          if (!sequence) throw new HttpError(400, "Для этого документа сквозная нумерация не предусмотрена.");
          db.exec("BEGIN IMMEDIATE");
          let number;
          try {
            const current = db.prepare("SELECT value FROM document_sequences WHERE name = ?").get(sequence.key);
            const next = Number(current?.value || 0) + 1;
            db.prepare(`INSERT INTO document_sequences (name,value) VALUES (?,?)
              ON CONFLICT(name) DO UPDATE SET value=excluded.value`).run(sequence.key, next);
            db.exec("COMMIT");
            number = next;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          return sendJson(res, 200, { number: `${sequence.prefix}${String(number).padStart(sequence.width, "0")}` });
        }

        if (pathname === "/api/analytics" && req.method === "GET") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Аналитика доступна только руководству.");
          const period = validateAnalyticsPeriod(requestUrl.searchParams.get("period"));
          return sendJson(res, 200, buildAnalyticsReport(db, period));
        }

        if (pathname === "/api/weekly-reset/preview" && req.method === "GET") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Новую неделю может запускать только ГКА.");
          return sendJson(res, 200, { counts: getWeeklyResetPreview(db) });
        }
        if (pathname === "/api/weekly-reset/history" && req.method === "GET") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "История архивов доступна только ГКА.");
          const runs = db.prepare(`SELECT r.id, r.archived_at, r.counts_json, r.restored_at,
              creator.display_name AS created_by_name, restorer.display_name AS restored_by_name
            FROM weekly_reset_runs r
            JOIN users creator ON creator.id = r.created_by
            LEFT JOIN users restorer ON restorer.id = r.restored_by
            ORDER BY r.id DESC LIMIT 10`).all().map((run) => ({
            ...run,
            counts: parseStoredJson(run.counts_json, "счётчики архива")
          }));
          return sendJson(res, 200, { runs });
        }
        if (pathname === "/api/weekly-reset" && req.method === "POST") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Новую неделю может запускать только ГКА.");
          const body = requireObject(await readJson(req));
          if (body.confirmed !== true) throw new HttpError(400, "Подтвердите запуск новой недели.");
          const { activitySummary, ...run } = createWeeklyReset(db, user.id);
          const warnings = [];
          if (!webhooks.weeklyReports) {
            warnings.push("Webhook отчёта новой недели не настроен.");
          } else {
            const messages = formatWeeklyActivitySummary(activitySummary);
            for (const [index, description] of messages.entries()) {
              const suffix = messages.length > 1 ? ` · ${index + 1}/${messages.length}` : "";
              const warning = await deliverWebhook(webhooks.weeklyReports, `Итоги недели${suffix}`, description);
              if (warning) {
                warnings.push(warning);
                break;
              }
            }
            if (!warnings.length) {
              const warning = await deliverWebhook(
                webhooks.weeklyReports,
                "──── НОВАЯ НЕДЕЛЯ НАЧАТА ────",
                "В новом недельном периоде счётчики вызовов, исков и залогов начинаются с нуля. История и общий счёт сохранены в профилях на портале."
              );
              if (warning) warnings.push(warning);
            }
          }
          return sendJson(res, 201, { run, discordWarnings: warnings });
        }
        const weeklyResetRestore = pathname.match(/^\/api\/weekly-reset\/(\d+)\/restore$/);
        if (weeklyResetRestore && req.method === "POST") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Восстанавливать архив может только ГКА.");
          return sendJson(res, 200, {
            run: restoreWeeklyReset(db, Number(weeklyResetRestore[1]), user.id)
          });
        }

        if (pathname === "/api/reports" && req.method === "GET") {
          if (!["ГКА", "ЗГКА"].includes(user.role)) throw new HttpError(403, "Отчётность доступна только руководству.");
          const period = validateReportPeriod(requestUrl.searchParams.get("period"));
          return sendJson(res, 200, {
            ...buildMonthlyReport(db, period),
            googleSheetsConfigured
          });
        }

        if (pathname === "/api/activity-reports" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Сдавать отчёты могут только сотрудники Коллегии.");
          if (user.role === "Юрист") {
            throw new HttpError(403, "Отчёты по вызовам и залогам откроются после одобрения заявки на адвоката.");
          }
          const canReview = managementRoles.includes(user.role);
          const reports = canReview
            ? db.prepare(`SELECT r.*, a.file_name AS attachment_name, u.display_name AS reporter_name, u.role AS reporter_role,
                reviewer.display_name AS reviewer_name
              FROM activity_reports r JOIN users u ON u.id = r.user_id
              LEFT JOIN activity_report_attachments a ON a.report_id = r.id
              LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
              WHERE r.report_type IN ('call', 'bail') AND
                (r.status = 'pending' OR r.lawyer_trip_status = 'pending' OR r.id IN (
                  SELECT recent.id FROM activity_reports recent
                  WHERE recent.report_type IN ('call', 'bail') AND recent.status != 'pending'
                  ORDER BY recent.id DESC LIMIT 3
                ))
              ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC`).all()
            : db.prepare(`SELECT r.*, a.file_name AS attachment_name, u.display_name AS reporter_name, u.role AS reporter_role,
                reviewer.display_name AS reviewer_name
              FROM activity_reports r JOIN users u ON u.id = r.user_id
              LEFT JOIN activity_report_attachments a ON a.report_id = r.id
              LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
              WHERE r.user_id = ? AND r.report_type IN ('call', 'bail')
              ORDER BY r.id DESC LIMIT 3`).all(user.id);
          const availableLawyers = db.prepare(`SELECT id, display_name FROM users
            WHERE role = 'Юрист' AND status = 'active'
            ORDER BY display_name COLLATE NOCASE`).all()
            .map((item) => ({ id: Number(item.id), display_name: item.display_name }));
          return sendJson(res, 200, {
            reports: addActivityReportLawyerParticipants(db, reports),
            availableLawyers,
            canReview
          });
        }

        const activityReportPhotoRoute = pathname.match(/^\/api\/activity-reports\/(\d+)\/photo$/);
        if (activityReportPhotoRoute && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Фото отчётов доступны только сотрудникам Коллегии.");
          const reportId = Number(activityReportPhotoRoute[1]);
          const report = db.prepare(`SELECT user_id, status, lawyer_trip_claimed, lawyer_trip_status
            FROM activity_reports WHERE id = ?`).get(reportId);
          if (!report) throw new HttpError(404, "Отчёт не найден.");
          const approvedParticipant = Number(report.lawyer_trip_claimed) === 1 &&
            report.status === "approved" && report.lawyer_trip_status === "approved" &&
            Boolean(db.prepare(`SELECT 1 FROM activity_report_lawyer_participants
              WHERE report_id = ? AND user_id = ?`).get(reportId, user.id));
          if (user.role === "Юрист" && !approvedParticipant) {
            throw new HttpError(403, "Доступно только фото одобренного совместного вызова, где вы указаны участником.");
          }
          if (!managementRoles.includes(user.role) &&
              Number(report.user_id) !== Number(user.id) && !approvedParticipant) {
            throw new HttpError(403, "Фото доступно автору отчёта и руководству.");
          }
          const attachment = db.prepare(`SELECT content_type, content FROM activity_report_attachments
            WHERE report_id = ?`).get(reportId);
          if (!attachment) throw new HttpError(404, "Фото к отчёту не найдено.");
          res.writeHead(200, {
            "content-type": attachment.content_type,
            "content-length": attachment.content.length,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff"
          });
          return res.end(attachment.content);
        }

        if (pathname === "/api/activity-reports" && req.method === "POST") {
          if (user.role === citizenRole) throw new HttpError(403, "Сдавать отчёты могут только сотрудники Коллегии.");
          if (user.role === "Юрист") {
            throw new HttpError(403, "Отчёты по вызовам и залогам откроются после одобрения заявки на адвоката.");
          }
          const body = await readJson(req, 22 * 1024 * 1024);
          const reportType = String(body.reportType || "");
          const occurredAt = String(body.occurredAt || "");
          const details = String(body.details || "").trim();
          const lawyerTripClaimed = body.lawyerTripClaimed === true;
          const lawyerTripUserIds = body.lawyerTripUserIds || [];
          const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(occurredAt)
            ? new Date(`${occurredAt}T00:00:00Z`)
            : null;
          if (!Object.hasOwn(activityReportTypes, reportType)) {
            throw new HttpError(400, "Выберите тип отчёта.");
          }
          if (reportType === "call" && !activityReportCallRoles.has(user.role)) {
            throw new HttpError(403, "Отчёты о вызовах доступны начиная с должности «Юрист».");
          }
          if (Object.hasOwn(body, "lawyerTripClaimed") && typeof body.lawyerTripClaimed !== "boolean") {
            throw new HttpError(400, "Проверьте отметку о совместной поездке.");
          }
          if (lawyerTripClaimed && reportType !== "call") {
            throw new HttpError(400, "Отметка «Ездил с юристом» доступна только для отчёта о вызове.");
          }
          if (lawyerTripClaimed) {
            if (!Array.isArray(lawyerTripUserIds) || lawyerTripUserIds.length < 1 ||
                lawyerTripUserIds.length > 2 ||
                lawyerTripUserIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
                new Set(lawyerTripUserIds).size !== lawyerTripUserIds.length) {
              throw new HttpError(400, "Укажите одного или двух юристов, участвовавших в совместном вызове.");
            }
            const placeholders = lawyerTripUserIds.map(() => "?").join(",");
            const selectedLawyers = db.prepare(`SELECT id FROM users
              WHERE role = 'Юрист' AND status = 'active' AND id IN (${placeholders})`)
              .all(...lawyerTripUserIds);
            if (selectedLawyers.length !== lawyerTripUserIds.length) {
              throw new HttpError(400, "Выберите одного или двух действующих юристов из списка.");
            }
          } else if (!Array.isArray(lawyerTripUserIds) || lawyerTripUserIds.length > 0) {
            throw new HttpError(400, "Укажите юристов только при включённой отметке о совместном вызове.");
          }
          if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== occurredAt) {
            throw new HttpError(400, "Укажите корректную дату события.");
          }
          if (details.length > 2000 || (reportType === "call" && details.length < 4)) {
            throw new HttpError(400, "Для отчёта о вызове описание должно содержать от 4 до 2000 символов.");
          }
          if (!body.photo) {
            throw new HttpError(400, `Добавьте скриншот-доказательство к отчёту о ${reportType === "call" ? "вызове" : "залоге"}.`);
          }
          let photo = null;
          if (body.photo) {
            [photo] = parseApplicationAttachments([body.photo], {
              maxFileBytes: activityReportPhotoMaxBytes,
              maxTotalBytes: activityReportPhotoMaxBytes
            });
            if (!photo.contentType.startsWith("image/")) {
              throw new HttpError(400, "К отчёту можно приложить только изображение.");
            }
          }
          db.exec("BEGIN");
          let reportId;
          let reference;
          try {
            const created = db.prepare(`INSERT INTO activity_reports
              (user_id, report_type, occurred_at, reference, details, lawyer_trip_claimed, lawyer_trip_status)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(user.id, reportType, occurredAt, "", details, Number(lawyerTripClaimed),
                lawyerTripClaimed ? "pending" : "none");
            reportId = Number(created.lastInsertRowid);
            reference = `${reportType === "call" ? "Вызов" : "Залог"} №${reportId}`;
            db.prepare("UPDATE activity_reports SET reference = ? WHERE id = ?").run(reference, reportId);
            if (photo) {
              db.prepare(`INSERT INTO activity_report_attachments
                (report_id, file_name, content_type, content) VALUES (?, ?, ?, ?)`)
                .run(reportId, photo.name, photo.contentType, photo.content);
            }
            if (lawyerTripClaimed) {
              const addParticipant = db.prepare(`INSERT INTO activity_report_lawyer_participants
                (report_id, user_id) VALUES (?, ?)`);
              for (const lawyerId of lawyerTripUserIds) addParticipant.run(reportId, lawyerId);
            }
            const giveawayState = db.prepare("SELECT enabled, campaign_epoch FROM giveaway_state WHERE id = 1").get();
            if (Number(giveawayState.enabled) === 1) {
              db.prepare(`INSERT INTO giveaway_report_eligibility (report_id, campaign_epoch, week_start)
                VALUES (?, ?, ?)`).run(reportId, giveawayState.campaign_epoch, getGiveawayWeekWindow().start);
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          await notifyPortalRoles(managementRoles, {
            type: "activity_report",
            title: `Новый отчёт: ${activityReportTypes[reportType]}`,
            body: `${user.display_name} отправил отчёт «${reference}» на одобрение.${
              lawyerTripClaimed
                ? ` Совместный вызов с юристом: ${lawyerTripUserIds.map((id) =>
                  db.prepare("SELECT display_name FROM users WHERE id = ?").get(id).display_name).join(", ")}. Проверьте отметку для начисления дополнительного балла.`
                : ""
            }`,
            href: "/page/reports"
          }, user.id);
          return sendJson(res, 201, {
            id: reportId,
            status: "pending",
            lawyerTripStatus: lawyerTripClaimed ? "pending" : "none"
          });
        }

        const activityReportRoute = pathname.match(/^\/api\/activity-reports\/(\d+)$/);
        if (activityReportRoute && req.method === "PATCH") {
          if (!managementRoles.includes(user.role)) {
            throw new HttpError(403, "Одобрять отчёты могут ГКА и ЗГКА.");
          }
          const reportId = Number(activityReportRoute[1]);
          const report = db.prepare("SELECT * FROM activity_reports WHERE id = ?").get(reportId);
          if (!report) throw new HttpError(404, "Отчёт не найден.");
          const body = await readJson(req);
          if (Object.hasOwn(body, "lawyerTripStatus")) {
            const lawyerTripStatus = String(body.lawyerTripStatus || "");
            const decision = String(body.decision || "").trim().slice(0, 500);
            if (!["approved", "rejected"].includes(lawyerTripStatus)) {
              throw new HttpError(400, "Выберите решение по отметке о поездке с юристом.");
            }
            if (Number(report.lawyer_trip_claimed) !== 1) {
              throw new HttpError(409, "В этом отчёте нет отметки о поездке с юристом.");
            }
            if (report.lawyer_trip_status !== "pending") {
              throw new HttpError(409, "Отметка о поездке уже рассмотрена.");
            }
            if (lawyerTripStatus === "rejected" && decision.length < 4) {
              throw new HttpError(400, "Для отказа укажите причину длиной не менее 4 символов.");
            }
            db.exec("BEGIN IMMEDIATE");
            try {
              const review = db.prepare(`UPDATE activity_reports SET lawyer_trip_status = ?,
                lawyer_trip_decision = ?, lawyer_trip_reviewed_by = ?, lawyer_trip_reviewed_at = CURRENT_TIMESTAMP
                WHERE id = ? AND lawyer_trip_status = 'pending' AND lawyer_trip_claimed = 1`)
                .run(lawyerTripStatus, decision, user.id, reportId);
              if (review.changes !== 1) throw new HttpError(409, "Отметка о поездке уже рассмотрена.");
              if (report.status === "approved" && lawyerTripStatus === "approved") {
                recordGiveawayPointsForApprovedReport(db, report, lawyerTripStatus);
              }
              db.exec("COMMIT");
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
            await notifyPortalUser({
              userId: report.user_id,
              type: "activity_report_review",
              title: lawyerTripStatus === "approved" ? "Совместный вызов подтверждён" : "Совместный вызов не подтверждён",
              body: `${activityReportTypes[report.report_type]} «${report.reference}»: ${
                lawyerTripStatus === "approved"
                  ? `отметка одобрена ГКА/ЗГКА.${report.status === "approved" ? " Начислено 2 балла за вызов." : " Дополнительный балл будет начислен после одобрения отчёта."}`
                  : `отметка отклонена ГКА/ЗГКА. За одобренный вызов начислится 1 балл. ${decision}`
              }`,
              href: "/page/reports"
            });
            return sendJson(res, 200, { ok: true, lawyerTripStatus });
          }
          if (report.status !== "pending") throw new HttpError(409, "Этот отчёт уже рассмотрен.");
          const status = String(body.status || "");
          const decision = String(body.decision || "").trim().slice(0, 500);
          if (!["approved", "rejected"].includes(status)) {
            throw new HttpError(400, "Выберите одобрение или отказ.");
          }
          if (status === "rejected" && decision.length < 4) {
            throw new HttpError(400, "Для отказа укажите причину длиной не менее 4 символов.");
          }
          db.exec("BEGIN IMMEDIATE");
          try {
            const review = db.prepare(`UPDATE activity_reports SET status = ?, decision = ?, reviewed_by = ?,
              reviewed_at = CURRENT_TIMESTAMP,
              lawyer_trip_status = CASE WHEN ? = 'rejected' AND lawyer_trip_claimed = 1
                THEN 'rejected' ELSE lawyer_trip_status END,
              lawyer_trip_decision = CASE WHEN ? = 'rejected' AND lawyer_trip_claimed = 1
                THEN ? ELSE lawyer_trip_decision END,
              lawyer_trip_reviewed_by = CASE WHEN ? = 'rejected' AND lawyer_trip_claimed = 1
                THEN ? ELSE lawyer_trip_reviewed_by END,
              lawyer_trip_reviewed_at = CASE WHEN ? = 'rejected' AND lawyer_trip_claimed = 1
                THEN CURRENT_TIMESTAMP ELSE lawyer_trip_reviewed_at END
              WHERE id = ? AND status = 'pending'`)
              .run(status, decision, user.id, status, status, decision || "Отметка отклонена вместе с отчётом.",
                status, user.id, status, reportId);
            if (review.changes !== 1) throw new HttpError(409, "Этот отчёт уже рассмотрен.");
            if (status === "approved") {
              recordGiveawayPointsForApprovedReport(db, report);
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          await notifyPortalUser({
            userId: report.user_id,
            type: "activity_report_review",
            title: status === "approved" ? "Отчёт одобрен" : "Отчёт отклонён",
            body: `${activityReportTypes[report.report_type]} «${report.reference}»: ${
              status === "approved"               ? `одобрено ${user.role} (${user.display_name}).` : `отказ ${user.role} (${user.display_name}). ${decision}`
            }`,
            href: "/page/reports"
          });
          let webhookWarning = "";
          if (status === "approved") {
            const reportWebhook = report.report_type === "call" ? webhooks.calls : webhooks.bails;
            const reportWebhookLabel = report.report_type === "call" ? "вызовов" : "залогов";
            if (!reportWebhook) {
              webhookWarning = `Webhook отчётов о ${reportWebhookLabel} не настроен.`;
            } else {
              const reporter = db.prepare("SELECT display_name, role FROM users WHERE id = ?")
                .get(report.user_id);
              const tripParticipants = db.prepare(`SELECT user.display_name
                FROM activity_report_lawyer_participants participant
                JOIN users user ON user.id = participant.user_id
                WHERE participant.report_id = ? ORDER BY user.display_name COLLATE NOCASE`)
                .all(reportId).map((participant) => participant.display_name);
              const attachment = db.prepare(`SELECT file_name, content_type, content
                FROM activity_report_attachments WHERE report_id = ?`).get(reportId);
              webhookWarning = await deliverWebhook(
                reportWebhook,
                "Одобренный отчёт сотрудника",
                `${reporter.display_name} отправил отчёт «${report.reference}».${report.details ? `\n\n${report.details}` : ""}`,
                [
                  { name: "Статус", value: `Одобрено ${user.role}`, inline: true },
                  { name: "Тип", value: activityReportTypes[report.report_type], inline: true },
                  { name: "Дата события", value: report.occurred_at, inline: true },
                  { name: "Автор", value: `${reporter.display_name} · ${reporter.role}`, inline: true },
                  { name: "Проверил", value: user.display_name, inline: true },
                  { name: "Номер отчёта", value: report.reference },
                  ...(Number(report.lawyer_trip_claimed) === 1 ? [{
                    name: "Ездил с юристом",
                    value: report.lawyer_trip_status === "approved"
                      ? `Подтверждено ГКА/ЗГКА: ${tripParticipants.join(", ") || "юрист(ы)"} отмечены участниками; автору начислен бонусный балл`
                      : report.lawyer_trip_status === "rejected"
                        ? `Отклонено ГКА/ЗГКА: ${tripParticipants.join(", ") || "участие юриста"}`
                        : `Заявлено сотрудником; ожидает решения ГКА/ЗГКА. Участники: ${tripParticipants.join(", ") || "не указаны"}`
                  }] : [])
                ],
                attachment ? {
                  name: attachment.file_name,
                  contentType: attachment.content_type,
                  content: attachment.content
                } : null
              );
            }
          }
          return sendJson(res, 200, { ok: true, status, warning: webhookWarning });
        }

        if (pathname === "/api/activity-reports/approve-all" && req.method === "POST") {
          if (!managementRoles.includes(user.role)) {
            throw new HttpError(403, "Одобрять отчёты могут ГКА и ЗГКА.");
          }
          const pendingReports = db.prepare(`SELECT * FROM activity_reports
            WHERE report_type IN ('call', 'bail') AND status = 'pending'
            ORDER BY id`).all();
          if (!pendingReports.length) return sendJson(res, 200, { approvedCount: 0, warnings: [] });
          db.exec("BEGIN IMMEDIATE");
          try {
            const approve = db.prepare(`UPDATE activity_reports SET status = 'approved',
              decision = '', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'pending'`);
            for (const report of pendingReports) {
              const result = approve.run(user.id, report.id);
              if (result.changes !== 1) throw new HttpError(409, "Часть отчётов уже была рассмотрена. Обновите список.");
              recordGiveawayPointsForApprovedReport(db, report);
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          const warnings = [];
          for (const report of pendingReports) {
            await notifyPortalUser({
              userId: report.user_id,
              type: "activity_report_review",
              title: "Отчёт одобрен",
              body: `${activityReportTypes[report.report_type]} «${report.reference}»: одобрено ${user.role} (${user.display_name}).`,
              href: "/page/reports"
            });
            const reportWebhook = report.report_type === "call" ? webhooks.calls : webhooks.bails;
            if (!reportWebhook) {
              warnings.push(`Webhook отчётов о ${report.report_type === "call" ? "вызовах" : "залогах"} не настроен.`);
              continue;
            }
            const reporter = db.prepare("SELECT display_name, role FROM users WHERE id = ?")
              .get(report.user_id);
            const attachment = db.prepare(`SELECT file_name, content_type, content
              FROM activity_report_attachments WHERE report_id = ?`).get(report.id);
            const warning = await deliverWebhook(
              reportWebhook,
              "Одобренный отчёт сотрудника",
              `${reporter.display_name} отправил отчёт «${report.reference}».${report.details ? `\n\n${report.details}` : ""}`,
              [
                { name: "Статус", value: `Одобрено ${user.role}`, inline: true },
                { name: "Тип", value: activityReportTypes[report.report_type], inline: true },
                { name: "Дата события", value: report.occurred_at, inline: true },
                { name: "Автор", value: `${reporter.display_name} · ${reporter.role}`, inline: true },
                { name: "Проверил", value: user.display_name, inline: true },
                { name: "Номер отчёта", value: report.reference }
              ],
              attachment ? {
                name: attachment.file_name,
                contentType: attachment.content_type,
                content: attachment.content
              } : null
            );
            if (warning) warnings.push(`${report.reference}: ${warning}`);
          }
          return sendJson(res, 200, { approvedCount: pendingReports.length, warnings });
        }

        if (pathname === "/api/reports/sync" && req.method === "POST") {
          if (!hasGkaAccess(user)) throw new HttpError(403, "Синхронизацию Google Sheets может запускать только ГКА.");
          const body = await readJson(req);
          const result = await syncMonthlyReport(body.period);
          return sendJson(res, 200, { ...result, googleSheetsConfigured });
        }

        const lawRoute = pathname.match(/^\/api\/laws\/(.+)$/);
        if (lawRoute && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Законодательная база доступна только сотрудникам Коллегии.");
          const key = decodeURIComponent(lawRoute[1]);
          const lawAliases = {
            ak: "Административный Кодекс (Редакция от 14.11.2026).txt",
            uk: "Уголовный Кодекс (Редакция от 23.11.2026).txt",
            pk: "Процессуальный Кодекс (Редакция от 23.11.2026).txt",
            road: "Дорожный Кодекс (Редакция от 14.11.2026).txt",
            labor: "Трудовой Кодекс (Редакция от 23.11.2026).txt",
            ethics: "Этический Кодекс (Редакция от 01.10.2026).txt",
            zot: "Закон о закрытых и охраняемых территориях (Редакция от 23.11.2026).txt",
            advocacy: "Закон об адвокатуре и адвокатской деятельности (Редакция от 09.11.2026).txt"
          };
          const name = lawAliases[key] || key;
          try {
            const text = normalizeLawText(
              await readFile(path.join(root, "data", "laws", name), "utf8"),
              key === "charter" || suppliedLawKeys.has(key)
            );
            return sendJson(res, 200, {
              key,
              name,
              title: name.replace(/\.txt$/i, ""),
              sourceNote: suppliedLawKeys.has(key) ? "Источник: текст, предоставленный пользователем." : "",
              text
            });
          } catch (error) {
            if (error.code === "ENOENT") {
              const virtualTitles = {
                documents: "Закон о документообороте",
                justice: "ЗАКОН О ДЕПАРТАМЕНТЕ ЮСТИЦИИ",
                charter: "Устав Коллегии адвокатов"
              };
              const title = virtualTitles[key];
              if (title) return sendJson(res, 200, {
                key,
                name,
                title,
                sourceNote: "Источник: текст, предоставленный пользователем.",
                text: `${title}\n\nРаздел загружен в систему для ознакомления; актуальную редакцию уточняйте у руководства.`
              });
              throw new HttpError(404, "Файл закона не найден в data/laws.");
            }
            throw error;
          }
        }
        if (pathname === "/api/laws" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Законодательная база доступна только сотрудникам Коллегии.");
          const laws = {};
          const files = await readdir(path.join(root, "data", "laws"), { withFileTypes: true });
          for (const file of files) {
            if (!file.isFile() || path.extname(file.name).toLowerCase() !== ".txt") continue;
            const info = await readFile(path.join(root, "data", "laws", file.name));
            laws[file.name] = {
              name: file.name,
              bytes: info.length,
              available: true,
              sourceNote: "Источник: загруженная законодательная база."
            };
          }
          return sendJson(res, 200, { laws });
        }

        if (pathname === "/api/photozot" && req.method === "GET") {
          if (user.role === citizenRole) throw new HttpError(403, "Фото зон доступны только сотрудникам Коллегии.");
          const files = await readdir(path.join(root, "photozot"), { withFileTypes: true });
          const photoFiles = files
            .filter((file) => file.isFile() && [".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(file.name).toLowerCase()))
            .sort((a, b) => a.name.localeCompare(b.name, "ru"));
          const totals = new Map();
          for (const file of photoFiles) {
            const key = getPhotoZoneGroup(file.name).key;
            totals.set(key, (totals.get(key) || 0) + 1);
          }
          const counters = new Map();
          const photos = photoFiles.map((file) => {
            const group = getPhotoZoneGroup(file.name);
            const number = (counters.get(group.key) || 0) + 1;
            counters.set(group.key, number);
            return {
              label: totals.get(group.key) > 1 ? `${group.label} · фото ${number}` : group.label,
              group_key: group.key,
              group_label: group.label,
              url: `/photozot/${encodeURIComponent(file.name)}`
            };
          });
          return sendJson(res, 200, { photos });
        }

        throw new HttpError(404, "Маршрут API не найден.");
      }

      const photoRoute = pathname.match(/^\/photozot\/(.+)$/);
      if (photoRoute && req.method === "GET") {
        const session = getSession(db, req);
        if (!session) throw new HttpError(401, "Войдите в портал, чтобы открыть фото зон.");
        const photoUser = publicUser(db, session.user_id);
        if (!photoUser || photoUser.status !== "active" || photoUser.role === citizenRole) {
          throw new HttpError(403, "Фото зон доступны только сотрудникам Коллегии.");
        }
        let decodedName;
        try {
          decodedName = decodeURIComponent(photoRoute[1]);
        } catch {
          throw new HttpError(400, "Некорректное имя файла.");
        }
        const name = path.basename(decodedName);
        if (name !== decodedName) throw new HttpError(400, "Некорректное имя файла.");
        const type = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[path.extname(name).toLowerCase()];
        if (!type) throw new HttpError(404, "Формат фото не поддерживается.");
        let photo;
        try {
          photo = await readFile(path.join(root, "photozot", name));
        } catch (error) {
          if (error.code === "ENOENT") throw new HttpError(404, "Фото зоны не найдено.");
          throw error;
        }
        res.writeHead(200, {
          "content-type": type,
          "content-length": photo.length,
          "cache-control": "private, max-age=3600"
        });
        res.end(photo);
        return;
      }

      if (req.method === "GET" && await serveFrontendAsset(res, pathname, {
        searchParams: requestUrl.searchParams
      })) return;

      if (req.method === "GET" && pathname === "/pamyatka_advokata.html") {
        const html = await readFile(path.join(root, "pamyatka_advokata.html"));
        res.setHeader("x-frame-options", "SAMEORIGIN");
        res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store, max-age=0",
          "x-content-type-options": "nosniff"
        });
        res.end(html);
        return;
      }

      if (req.method === "GET" &&
          (pathname === "/" || pathname === "/advokate.html" || portalPageRoutes.has(pathname))) {
        const html = await readFile(path.join(root, "advokate.html"));
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store, max-age=0",
          "x-content-type-options": "nosniff"
        });
        res.end(html);
        return;
      }
      const publicImages = {
        "/assets/collegium-seal.png": "collegium-seal.png",
        "/assets/san-andreas-seal.png": "san-andreas-seal.png",
        "/assets/collegium-main-seal.png": "collegium-main-seal.png",
        "/assets/law-association-seal.png": "law-association-seal.png",
        "/assets/exam-passed-stamp.png": "exam-passed-stamp.png",
        "/assets/site-icon.png": "site-icon.png",
        "/assets/role-trainee.png": "role-trainee.png",
        "/assets/role-lawyer.png": "role-lawyer.png",
        "/assets/role-attorney.png": "role-attorney.png",
        "/assets/role-senior-attorney.png": "role-senior-attorney.png",
        "/assets/role-deputy-head.png": "role-deputy-head.png",
        "/assets/role-head.png": "role-head.png",
        "/favicon.ico": "portal.ico"
      };
      if (req.method === "GET" && Object.hasOwn(publicImages, pathname)) {
        const image = await readFile(path.join(root, "assets", publicImages[pathname]));
        res.writeHead(200, {
          "content-type": pathname.endsWith(".ico") ? "image/x-icon" : "image/png",
          "content-length": image.length,
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff"
        });
        res.end(image);
        return;
      }
      throw new HttpError(404, "Страница не найдена.");
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      console.error("Request failed:", error);
      if (!res.headersSent) sendJson(res, 500, { error: "Внутренняя ошибка сервера. Подробности записаны в журнал." });
      else res.destroy();
    }
  });
  server.googleSheetsConfigured = googleSheetsConfigured;
  server.syncMonthlyReport = syncMonthlyReport;
  server.sendDueCalendarReminders = sendDueCalendarReminders;
  server.syncDiscordMember = syncDiscordMember;
  server.portalDb = db;
  server.webhookDispatcher = webhookDispatcher;
  return server;
}

function createSession(db, userId) {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  db.prepare("INSERT INTO sessions (token_hash,csrf_token,user_id,expires_at) VALUES (?,?,?,?)")
    .run(hashToken(token), csrf, userId, expiresAt);
  return { token, csrf };
}

function getSession(db, req) {
  const token = getCookie(req, "mirror_ka_session");
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?").get(tokenHash, Date.now());
  if (!session) return null;
  return session;
}

function assertCsrf(req, session) {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Запрос отклонён: источник не совпадает с сайтом.");
  if (!safeEqual(req.headers["x-csrf-token"], session.csrf_token)) throw new HttpError(403, "CSRF-токен отсутствует или недействителен. Перезагрузите страницу и войдите снова.");
}

async function sendDiscordDirectMessage(discordUserId, account, avatarUrl, customTitle = "", customDescription = "", options = {}) {
  const token = options.token ?? process.env.DISCORD_BOT_TOKEN ?? "";
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const suppressAttachment = Number(account?.id) === governorUserId && Boolean(options.file);
  if (!/^[\w.-]+$/.test(token)) return "Discord-бот не настроен на сервере.";
  if (!/^\d{15,22}$/.test(discordUserId || "")) return "У аккаунта не привязан Discord.";
  try {
    const channelResponse = await fetchImpl("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ recipient_id: discordUserId }),
      signal: AbortSignal.timeout(8000)
    });
    if (!channelResponse.ok) {
      return `Discord отказал в создании ЛС (HTTP ${channelResponse.status}).`;
    }
    const channel = await channelResponse.json();
    if (!channel.id) return "Discord не вернул канал личных сообщений.";
    const payload = {
      content: options.content || undefined,
      embeds: [{
        title: customTitle || "Discord успешно привязан",
        description: customDescription || `Аккаунт **${account.display_name}** привязан к порталу Коллегии адвокатов.`,
        color: 0xB09A63,
        fields: [
          { name: "Должность", value: account.role, inline: true },
          { name: "Аккаунт портала", value: account.username || "не указан", inline: true }
        ],
        thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
        footer: { text: "Коллегия адвокатов · Mirror GTA 5 RP" },
        timestamp: new Date().toISOString()
      }],
      allowed_mentions: { parse: [] }
    };
    const messageRequest = {
      method: "POST",
      headers: { authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(8000)
    };
    if (options.file && !suppressAttachment) {
      const form = new FormData();
      form.set("payload_json", JSON.stringify(payload));
      form.set("files[0]", new Blob([options.file.content], {
        type: options.file.contentType || "text/plain"
      }), options.file.name);
      messageRequest.body = form;
    } else {
      messageRequest.headers["content-type"] = "application/json";
      messageRequest.body = JSON.stringify(payload);
    }
    const messageResponse = await fetchImpl(
      `https://discord.com/api/v10/channels/${channel.id}/messages`,
      messageRequest
    );
    if (!messageResponse.ok) return `Discord отказал в отправке ЛС (HTTP ${messageResponse.status}).`;
    return suppressAttachment
      ? "Личное сообщение отправлено без файла: вложения для губернатора отключены."
      : "";
  } catch (error) {
    console.error("Discord direct notification could not be delivered:", error.message);
    return `Не удалось отправить ЛС в Discord: ${error.message}`;
  }
}

function setSessionCookie(res, token, secure) {
  const secureText = secure ? "; Secure" : "";
  res.setHeader("set-cookie", `mirror_ka_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secureText}`);
}

function clearSessionCookie(res, secure) {
  const secureText = secure ? "; Secure" : "";
  res.setHeader("set-cookie", `mirror_ka_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureText}`);
}

function assertCanReview(role, item) {
  const allowed = item.type === "citizen_help" || item.type === "citizen_complaint"
    ? ["ЗГКА", "ГКА"].includes(role)
    : item.type === "employment"
    ? ["ГКА", "ЗГКА"].includes(role)
    : item.type === "promotion"
    ? (item.requested_role === "Ст.Адвокат" || item.requested_role === "ЗГКА"
      ? role === "ГКА" : ["ГКА", "ЗГКА"].includes(role))
    : isCareerPracticeApplication(item)
    ? item.stage_role === "Стажер КА"
      ? ["Ст.Адвокат", "ЗГКА", "ГКА"].includes(role)
      : ["ЗГКА", "ГКА"].includes(role)
    : item.type === "exam" || item.type === "admin"
      ? ["ГКА", "ЗГКА"].includes(role)
      : item.type === "practice"
        ? ["Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"].includes(role)
        : item.type === "training"
          ? ["Ст.Адвокат", "ЗГКА", "ГКА"].includes(role)
          : false;
  if (!allowed) throw new HttpError(403, "У вашей роли нет полномочий рассматривать эту заявку.");
}

const staticContentTypes = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};
const frontendAssetPartSize = 12 * 1024;
const chunkableFrontendAssets = new Set([
  "js/app.js",
  "css/base.css",
  "css/theme.css",
  "css/awards.css"
]);

const webhookChannelLabels = {
  applications: "Заявки и приём в Коллегию",
  exams: "Экзамены и повышения",
  careerInterviews: "Обзвоны",
  warnings: "Выговоры",
  logs: "Журнал руководства"
};
const publicWebhookChannels = ["applications", "exams", "careerInterviews", "warnings", "logs"];

/**
 * Отдача файлов фронтенда из каталога web/.
 * Возвращает false, если путь не относится к статике, чтобы маршрутизация
 * продолжилась обычным образом.
 */
async function serveFrontendAsset(res, pathname, {
  cacheControl = "public, max-age=300",
  searchParams
} = {}) {
  if (!pathname.startsWith("/web/")) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  // Защита от выхода за пределы каталога web/.
  const normalized = path.posix.normalize(decoded);
  if (!normalized.startsWith("/web/") || normalized.includes("\0")) return false;
  const relative = normalized.slice("/web/".length);
  if (!relative) return false;
  // Служебные файлы каталога web/ (манифест модулей, точечные файлы) не отдаём.
  if (relative.split("/").some((part) => part === ".." || part.startsWith(".") || part === "package.json")) return false;
  const filePath = path.join(root, "web", relative);
  const type = staticContentTypes[path.extname(filePath).toLowerCase()];
  if (!type) return false;
  let body;
  try {
    body = await readFile(filePath);
  } catch {
    return false;
  }
  const partValue = chunkableFrontendAssets.has(relative) ? searchParams?.get("part") : null;
  if (partValue !== null) {
    if (!/^(0|[1-9]\d*)$/.test(partValue)) return false;
    const partIndex = Number(partValue);
    const partCount = Math.ceil(body.length / frontendAssetPartSize);
    if (!Number.isSafeInteger(partIndex) || partIndex >= partCount) return false;
    // Keep each response below the transfer size where some client networks stall.
    const start = partIndex * frontendAssetPartSize;
    const part = body.subarray(start, Math.min(start + frontendAssetPartSize, body.length));
    res.writeHead(200, {
      "content-type": type,
      "content-length": part.length,
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      "x-asset-part-count": String(partCount),
      "x-asset-total-length": String(body.length)
    });
    res.end(part);
    return true;
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff"
  });
  res.end(body);
  return true;
}

/* Уведомления в Discord обслуживает модуль webhooks.mjs (очередь, повторы, 429). */

async function createInitialAdmin(db, credentials = null) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'ГКА'").get().count;
  if (count) throw new Error("ГКА уже создан. Команду первичной настройки повторно выполнить нельзя.");
  let username;
  let displayName;
  let password;
  if (credentials) {
    username = String(credentials.username || "").trim().toLowerCase();
    displayName = String(credentials.displayName || "").trim();
    password = String(credentials.password || "");
  } else {
    if (!process.stdin.isTTY) throw new Error("Запустите `npm run create-admin` из интерактивного терминала.");
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    username = (await readline.question("Логин первого ГКА: ")).trim().toLowerCase();
    displayName = (await readline.question("Игровое имя первого ГКА: ")).trim();
    readline.close();
  }
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error("Логин должен содержать 3–32 символа: латиница, цифры, точка, дефис или подчёркивание.");
  if (displayName.length < 2 || displayName.length > 80) throw new Error("Игровое имя должно содержать 2–80 символов.");
  if (!credentials) password = await readHiddenPassword();
  if (password.length < 12 || password.length > 128) throw new Error("Пароль должен содержать от 12 до 128 символов.");
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?, 'active')")
    .run(username, `scrypt$${salt.toString("base64")}$${Buffer.from(key).toString("base64")}`, displayName, "ГКА");
  console.log("Первый аккаунт ГКА создан.");
}

export function initialAdminExists(dbPath) {
  if (dbPath !== ":memory:" && !existsSync(dbPath)) return false;
  const db = createDatabase(dbPath);
  try {
    return db.prepare("SELECT 1 FROM users WHERE role = 'ГКА' LIMIT 1").get() !== undefined;
  } finally {
    db.close();
  }
}

export async function createInitialAdminAccount(dbPath, credentials) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = createDatabase(dbPath);
  try {
    await createInitialAdmin(db, credentials);
  } finally {
    db.close();
  }
}

function readHiddenPassword() {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== "function") return reject(new Error("Не удалось включить скрытый ввод пароля в этом терминале."));
    process.stdout.write("Пароль (12–128 символов): ");
    let value = "";
    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") return finish(new Error("Настройка отменена."));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export async function createDiscordCitizenRequest({
  db,
  discordId,
  discordUsername,
  displayName,
  details,
  webhookUrl = ""
}) {
  const discordUserId = String(discordId || "");
  if (!/^\d{15,22}$/.test(discordUserId)) throw new Error("Discord вернул некорректный ID пользователя.");
  const name = String(displayName || "").trim();
  const description = String(details || "").trim();
  if (name.length < 2 || name.length > 80) throw new Error("Введите имя персонажа от 2 до 80 символов.");
  if (description.length < 10 || description.length > 2000) throw new Error("Опишите ситуацию от 10 до 2000 символов.");

  let citizen = db.prepare("SELECT id, role, status FROM users WHERE discord_id = ?").get(discordUserId);
  if (citizen && citizen.role !== citizenRole) throw new Error("Этот Discord-аккаунт привязан к сотруднику Коллегии.");
  if (!citizen) {
    const existingUsername = db.prepare("SELECT id FROM users WHERE username = ?").get(`discord-${discordUserId}`);
    if (existingUsername) throw new Error("Не удалось связать обращение с аккаунтом Discord.");
    const salt = randomBytes(16);
    const key = await scrypt(randomBytes(32).toString("base64"), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const created = db.prepare(`INSERT INTO users
      (username,password_hash,display_name,email,role,status,discord_id,discord_username)
      VALUES (?, ?, ?, '', 'Гражданин', 'active', ?, ?)`)
      .run(`discord-${discordUserId}`, `scrypt$${salt.toString("base64")}$${Buffer.from(key).toString("base64")}`,
        name, discordUserId, String(discordUsername || "").trim());
    citizen = { id: Number(created.lastInsertRowid), role: citizenRole, status: "active" };
  } else {
    db.prepare("UPDATE users SET display_name = ?, discord_username = ? WHERE id = ?")
      .run(name, String(discordUsername || "").trim(), citizen.id);
  }

  const pending = db.prepare(`SELECT id FROM applications
    WHERE user_id = ? AND type = 'citizen_help' AND status = 'pending' LIMIT 1`).get(citizen.id);
  if (pending) throw new Error(`У вас уже есть активное обращение №${pending.id}. Дождитесь ответа адвоката.`);

  const created = db.prepare(`INSERT INTO applications
    (user_id,type,details,status,passport_id,promotion_data_json)
    VALUES (?, 'citizen_help', ?, 'pending', '', ?)`)
    .run(citizen.id, `Discord-обращение:\n${description}`, JSON.stringify({ source: "discord", discordId: discordUserId }));
  const applicationId = Number(created.lastInsertRowid);
  db.prepare(`INSERT INTO application_history (application_id, actor_id, event_type, details)
    VALUES (?, ?, 'created', 'Обращение создано гражданином через Discord.')`)
    .run(applicationId, citizen.id);

  await sendWebhook(
    webhookUrl,
    "Новое обращение гражданина из Discord",
    `${name} запросил помощь адвоката.`,
    [
      { name: "Обращение", value: `#${applicationId}`, inline: true },
      { name: "Гражданин", value: name, inline: true },
      { name: "Discord", value: discordUsername ? `@${discordUsername}` : "не указан", inline: true },
      { name: "Ситуация", value: description.slice(0, 1000), inline: false }
    ]
  );
  return { applicationId };
}

export async function issueDiscordInvite(db, discordUserId, sendCode, webhookUrl = process.env.DISCORD_WEBHOOK_APPLICATIONS || "") {
  const requesterId = String(discordUserId || "");
  if (!/^\d{15,22}$/.test(requesterId)) throw new Error("Discord вернул некорректный ID пользователя.");
  if (typeof sendCode !== "function") throw new Error("Не настроена отправка кода в личные сообщения.");

  const now = Date.now();
  const cooldown = 24 * 60 * 60 * 1000;
  const code = randomBytes(18).toString("base64url");
  const codeHash = hashToken(code);
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = db.prepare("SELECT issued_at FROM discord_invite_issuance WHERE discord_user_id = ?").get(requesterId);
    if (previous && now - previous.issued_at < cooldown) {
      const hours = Math.max(1, Math.ceil((cooldown - (now - previous.issued_at)) / (60 * 60 * 1000)));
      throw new Error(`Повторный код можно запросить через ${hours} ч.`);
    }
    const issuer = db.prepare("SELECT id FROM users WHERE role = 'ГКА' AND status = 'active' ORDER BY id LIMIT 1").get();
    if (!issuer) throw new Error("В портале ещё не настроен активный аккаунт ГКА.");
    db.prepare("INSERT INTO invites (code_hash, created_by, expires_at) VALUES (?, ?, ?)")
      .run(codeHash, issuer.id, expiresAt);
    db.prepare(`INSERT INTO discord_invite_issuance (discord_user_id, invite_hash, issued_at)
      VALUES (?, ?, ?) ON CONFLICT(discord_user_id) DO UPDATE SET invite_hash = excluded.invite_hash, issued_at = excluded.issued_at`)
      .run(requesterId, codeHash, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  try {
    await sendCode(code);
  } catch (error) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM invites WHERE code_hash = ? AND used_at IS NULL").run(codeHash);
      db.prepare("DELETE FROM discord_invite_issuance WHERE discord_user_id = ? AND invite_hash = ?")
        .run(requesterId, codeHash);
      db.exec("COMMIT");
    } catch (cleanupError) {
      db.exec("ROLLBACK");
      throw new Error(`Не удалось отправить код в Discord и очистить незавершённое приглашение: ${cleanupError.message}`);
    }
    throw new Error(`Не удалось отправить код в личные сообщения Discord: ${error.message}`);
  }

  const webhookWarning = await sendWebhook(
    webhookUrl,
    "Выдано приглашение в Коллегию",
    "Одноразовый код отправлен кандидату в личные сообщения Discord. Срок действия — 7 дней."
  );
  if (webhookWarning) console.warn(webhookWarning);
  return { expiresAt };
}

export async function startPortal(options = {}) {
  const sheetsUrl = options.googleSheetsUrl ?? process.env.GOOGLE_SHEETS_WEB_APP_URL ?? "";
  const sheetsToken = String(options.googleSheetsToken ?? process.env.GOOGLE_SHEETS_SYNC_TOKEN ?? "");
  const sheetsSyncIntervalMinutes = Number(process.env.GOOGLE_SHEETS_SYNC_INTERVAL_MINUTES || 60);
  if (sheetsUrl && sheetsToken.length >= 32 &&
      (!Number.isInteger(sheetsSyncIntervalMinutes) || sheetsSyncIntervalMinutes < 5 || sheetsSyncIntervalMinutes > 1440)) {
    throw new Error("GOOGLE_SHEETS_SYNC_INTERVAL_MINUTES должен быть целым числом от 5 до 1440.");
  }
  const dbPath = options.dbPath || process.env.DB_PATH || path.join(root, "data", "portal.sqlite");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = createDatabase(dbPath);
  const roleIds = {
    "Гражданин": process.env.DISCORD_ROLE_CITIZEN || "",
    "Стажер КА": process.env.DISCORD_ROLE_TRAINEE || "",
    "Юрист": process.env.DISCORD_ROLE_LAWYER || "",
    "Адвокат": process.env.DISCORD_ROLE_ATTORNEY || "",
    "Ст.Адвокат": process.env.DISCORD_ROLE_SENIOR_ATTORNEY || "",
    "ЗГКА": process.env.DISCORD_ROLE_DEPUTY_HEAD || "",
    "ГКА": process.env.DISCORD_ROLE_HEAD || "",
    [governorRole]: process.env.DISCORD_ROLE_GOVERNOR || ""
  };
  const webhooks = {
    applications: process.env.DISCORD_WEBHOOK_APPLICATIONS || "",
    help: process.env.DISCORD_WEBHOOK_HELP || "",
    exams: process.env.DISCORD_WEBHOOK_EXAMS || "",
    careerInterviews: process.env.DISCORD_WEBHOOK_CAREER_INTERVIEWS || "",
    warnings: process.env.DISCORD_WEBHOOK_WARNINGS || "",
    calls: process.env.DISCORD_WEBHOOK_CALLS || "",
    bails: process.env.DISCORD_WEBHOOK_BAILS || "",
    casePublication: process.env.DISCORD_WEBHOOK_CASE_PUBLICATION || "",
    logs: process.env.DISCORD_WEBHOOK_LOGS || "",
    health: process.env.DISCORD_WEBHOOK_HEALTH || ""
  };
  for (const roleName of Object.keys(roleIds)) {
    if (roleIds[roleName]) continue;
    const savedRole = db.prepare("SELECT value FROM portal_settings WHERE key = ?").get(`discord_role:${roleName}`);
    roleIds[roleName] = savedRole?.value || "";
  }
  for (const name of Object.keys(webhooks)) {
    if (webhooks[name]) continue;
    const savedWebhook = db.prepare("SELECT value FROM portal_settings WHERE key = ?").get(`discord_webhook:${name}`);
    webhooks[name] = savedWebhook?.value || "";
  }
  const discordPresenceMap = new Map();
  let discordCreateCaseChannel = async () => null;
  let discordCloseCaseChannel = async () => null;
  let server;
  try {
    server = createPortalServer({
      db,
      discordClientId: options.discordClientId,
      discordClientSecret: options.discordClientSecret,
      discordRoleIds: roleIds,
      discordWebhooks: webhooks,
      discordFetch: options.discordFetch,
      discordRedirectUri: options.discordRedirectUri,
      discordPresenceProvider: (discordId) => discordPresenceMap.get(String(discordId)) || "offline",
      discordCreateCaseChannel: (...args) => discordCreateCaseChannel(...args),
      discordCloseCaseChannel: (...args) => discordCloseCaseChannel(...args),
      googleSheetsUrl: options.googleSheetsUrl,
      googleSheetsToken: options.googleSheetsToken,
      googleSheetsFetch: options.googleSheetsFetch
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const host = options.host || process.env.HOST || "127.0.0.1";
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (port === 0 && options.port !== 0)) {
    db.close();
    throw new Error("PORT должен быть целым числом от 1 до 65535.");
  }
  const discordBot = options.startBot === false ? null : startDiscordBot({
    token: process.env.DISCORD_BOT_TOKEN || "",
    guildId: process.env.DISCORD_GUILD_ID || "",
    healthUrl: options.publicUrl || process.env.DISCORD_HEALTH_URL || "",
    roleIds,
    onRoleResolved: async (name, id) => {
      roleIds[name] = id;
      db.prepare("INSERT INTO portal_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(`discord_role:${name}`, id);
      if (name === governorRole) {
        const governor = db.prepare("SELECT discord_id FROM users WHERE id = ? AND role = ? AND status = 'active'")
          .get(governorUserId, governorRole);
        if (governor?.discord_id) {
          const result = await server.syncDiscordMember(governorUserId);
          if (result.syncError) console.error("Governor Discord role synchronization failed:", result.syncError);
        }
      }
    },
    onPresence: (discordId, status) => {
      discordPresenceMap.set(String(discordId), status);
    },
    onWebhookResolved: (name, url) => {
      webhooks[name] = url;
      db.prepare("INSERT INTO portal_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(`discord_webhook:${name}`, url);
    },
    onInviteRequest: (discordUserId, sendCode) => issueDiscordInvite(db, discordUserId, sendCode, webhooks.applications),
    onDiscordCitizenRequest: (request) => createDiscordCitizenRequest({
      db,
      ...request,
      webhookUrl: webhooks.applications
    }),
    onPortalCommand: (discordUserId, commandName, commandOptions, memberRoleIds) =>
      runDiscordPortalCommand({
        db, discordUserId, commandName, options: commandOptions, memberRoleIds, roleIds,
        notifyAbsence: async (account, startDate, endDate) => {
          if (!webhooks.logs) return "Заявка сохранена в портале; Discord-уведомление руководству не настроено.";
          try {
            const response = await (options.webhookFetch || globalThis.fetch)(webhooks.logs, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                content: `${account.display_name} подал(а) заявку на отсутствие с ${startDate} по ${endDate}.`,
                allowed_mentions: { parse: [] }
              }),
              signal: AbortSignal.timeout(10000)
            });
            return response.ok ? "" : `Заявка сохранена, но Discord уведомление не доставлено (HTTP ${response.status}).`;
          } catch (error) {
            return `Заявка сохранена, но Discord уведомление не доставлено: ${error.message}`;
          }
        }
      }),
    onRpCaseReview: (discordUserId, memberRoleIds, caseId, status) =>
      reviewRpCustomCaseFromDiscord(db, discordUserId, memberRoleIds, roleIds, caseId, status),
    onGiveawayCommand: (action, discordUserId) => applyGiveawayCommand(db, action, discordUserId),
    onPointCommand: (userId, points, discordUserId) =>
      awardGiveawayPoints(db, userId, points, discordUserId),
    onServiceCommand: (action) => {
      if (action === "restart") return "Перезапускаю портал и Discord-бота. Обычно это занимает около минуты.";
      if (action !== "on" && action !== "off") throw new Error("Неизвестная команда управления сервисом.");
      const value = action === "on" ? "on" : "off";
      db.prepare(`INSERT INTO portal_settings (key, value) VALUES ('maintenance_mode', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
      return action === "on"
        ? "Технические работы включены; команда !tech off вернёт сайт."
        : "Технические работы выключены; сайт снова доступен.";
    },
    onServiceRestart: () => {
      const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 1000);
      timer.unref?.();
    },
    onPortalAction: (discordUserId, action, memberRoleIds) =>
      runDiscordPortalAction({ db, discordUserId, action, memberRoleIds, roleIds })
  });
  discordCreateCaseChannel = async (applicationId, citizenId, attorneyId) =>
    discordBot?.createCaseChannel?.(applicationId, citizenId, attorneyId) || null;
  discordCloseCaseChannel = async (applicationId) =>
    discordBot?.closeCaseChannel?.(applicationId);
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  } catch (error) {
    discordBot?.destroy();
    db.close();
    if (error.code === "EADDRINUSE") {
      throw new Error(`Порт ${port} уже занят. Закройте другой сервер портала и повторите запуск.`);
    }
    throw error;
  }
  const listeningPort = server.address().port;
  const reportSyncTimer = server.googleSheetsConfigured
    ? setInterval(() => {
      server.syncMonthlyReport(currentReportPeriod()).catch((error) => {
        console.error("Google Sheets automatic sync failed:", error.message);
      });
    }, sheetsSyncIntervalMinutes * 60 * 1000)
    : null;
  reportSyncTimer?.unref();
  const calendarReminderTimer = discordBot
    ? setInterval(() => {
      server.sendDueCalendarReminders().catch((error) => {
        console.error("Calendar reminder scheduler failed:", error.message);
      });
    }, 5 * 60 * 1000)
    : null;
  calendarReminderTimer?.unref();
  if (calendarReminderTimer) {
    server.sendDueCalendarReminders().catch((error) => {
      console.error("Calendar reminder scheduler failed:", error.message);
    });
  }
  console.log(`Портал запущен: http://${host}:${listeningPort}`);
  return {
    server,
    host,
    port: listeningPort,
    close: () => {
      if (reportSyncTimer) clearInterval(reportSyncTimer);
      if (calendarReminderTimer) clearInterval(calendarReminderTimer);
      return new Promise((resolve, reject) => server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        discordBot?.destroy();
        db.close();
        resolve();
      }));
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.env.DB_PATH || path.join(root, "data", "portal.sqlite");
  await mkdir(path.dirname(dbPath), { recursive: true });
  if (process.argv[2] === "create-admin") {
    const db = createDatabase(dbPath);
    try {
      await createInitialAdmin(db);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  } else {
    const portal = await startPortal({
      dbPath,
      startBot: process.env.DISABLE_DISCORD_BOT !== "1"
    });
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      portal.webhookDispatcher?.stop();
      void portal.close().then(() => process.exit(0)).catch((error) => {
        console.error("Не удалось корректно остановить портал:", error.message);
        process.exitCode = 1;
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}
