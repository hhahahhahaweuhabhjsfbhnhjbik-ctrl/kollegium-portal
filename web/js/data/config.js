/* ============================================================================
   config.js — статические данные портала: роли, ступени карьеры, схемы
   документов, справочники экзаменов и названия разделов.

   Здесь нет ни одной функции, меняющей состояние: только константы, которые
   используются интерфейсом. Логика живёт в app.js.
   ========================================================================== */

export const roles = ["Стажер КА", "Юрист", "Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"];
export const promotion = {
  "Стажер КА": "Юрист",
  "Юрист": "Адвокат",
  "Адвокат": "Ст.Адвокат",
  "Ст.Адвокат": "ЗГКА"
};
export const examTracks = {
  "Стажер КА": "Юрист", "Юрист": "Адвокат",
  "Адвокат": "Ст.Адвокат"
};
export const careerGuides = {
  "Стажер КА": {
    title: "Стажёр → Юрист",
    summary: "На этом этапе нужен только тест. Обзвон и отчёт о вызовах для перехода стажёра не требуются.",
    points: [
      "Понимайте, когда задержанный вправе запросить адвоката и как сотрудник фиксирует вызов.",
      "Знайте сроки ожидания ответа и прибытия адвоката; не мешайте конфиденциальному разговору.",
      "Не раскрывайте сведения о доверителе и не публикуйте выводы по делу до проверки.",
      "Если по делу подан иск или жалоба, относящиеся к делу видеоматериалы нужно сохранить.",
      "В ситуационных вопросах действуйте по процедуре и уточняйте законность, а не угадывайте."
    ]
  },
  "Юрист": {
    title: "Юрист → Адвокат",
    summary: "Сначала изучите материалы и сдайте тест. После теста отметьте готовность к обзвону; руководство проверит вызовы и пробный иск.",
    points: [
      "Повторите нормы Процессуального кодекса о задержании, защите и видеозаписях.",
      "Для перехода требуется число вызовов, установленное руководством, и ссылка на пробный иск.",
      "После теста можно отметить «Готов сейчас» или отложить обзвон и вернуться к этому позже.",
      "Роль меняется после успешного теста, готовности к обзвону и проверки руководством."
    ]
  },
  "Адвокат": {
    title: "Адвокат → Старший адвокат",
    summary: "После теста нужен обзвон. Для повышения дополнительно подаётся отчёт с подтверждёнными условиями и решением ГКА.",
    points: [
      "Повторите Закон об адвокатуре, этические обязанности и правила встреч с доверителем.",
      "Для отчёта нужны 25 вызовов, не менее 5 совместно с юристом и один принятый иск.",
      "Обзвон, наличие места и одобрение ГКА подтверждаются отдельно.",
      "Шаблон документа считается черновиком: для зачёта нужна форумная ссылка и подтверждение руководства."
    ]
  }
};
export const applicationTypes = {
  "Стажер КА": [
    ["training", "Запрос на обучение у старшего адвоката"]
  ],
  "Юрист": [
    ["practice", "Запрос практики / сопровождения адвоката"],
    ["training", "Запрос на обучение у старшего адвоката"]
  ],
  "Адвокат": [
    ["promotion", "Отчёт на повышение до старшего адвоката"],
    ["practice", "Запрос помощи по делу / совместная практика"]
  ],
  "Ст.Адвокат": [],
  "ЗГКА": [],
  "ГКА": [],
  "Гражданин": [
    ["citizen_help", "Попросить адвоката помочь с вопросом"],
    ["citizen_complaint", "Подать жалобу и попросить консультацию"]
  ]
};
export const typeLabels = {
  ...Object.fromEntries(Object.values(applicationTypes).flat()),
  employment: "Заявка на вступление в Коллегию",
  admin: "Организационный вопрос (архивная заявка)"
};
export const lawExamSubjects = {
  ak: "АК", pk: "ПК", uk: "УК", zot: "Закон о ЗОТ", advocacy: "Закон об адвокатуре",
  road: "Дорожный кодекс", labor: "Трудовой кодекс", ethics: "Этический кодекс",
  documents: "Закон о документообороте", justice: "Закон о Департаменте юстиции"
};
export const lawMeta = {
  ak: "Административный кодекс", uk: "Уголовный кодекс", pk: "Процессуальный кодекс",
  zot: "Закон о закрытых и охраняемых территориях", advocacy: "Закон об адвокатуре",
  charter: "Устав Коллегии адвокатов", road: "Дорожный кодекс", labor: "Трудовой кодекс",
  ethics: "Этический кодекс", documents: "Закон о документообороте",
  justice: "Закон о Департаменте юстиции"
};
export const lawReferencePatterns = [
  { key: "ak", label: "АК", pattern: /(?:АК\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s*АК)/giu },
  { key: "uk", label: "УК", pattern: /(?:УК\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s*УК)/giu },
  { key: "pk", label: "ПК", pattern: /(?:ПК\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s*ПК)/giu },
  { key: "road", label: "ДК", pattern: /(?:ДК\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s*ДК)/giu },
  { key: "zot", label: "ЗОТ", pattern: /(?:ЗОТ\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s*ЗОТ)/giu },
  { key: "labor", label: "ТК", pattern: /(?:ТК\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s*ТК)/giu },
  { key: "ethics", label: "ЭК", pattern: /(?:ЭК\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s*ЭК)/giu },
  { key: "advocacy", label: "Закон об адвокатуре", pattern: /(?:Закон(?:а)?\s+об\s+адвокатуре\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s+Закона\s+об\s+адвокатуре)/giu },
  { key: "documents", label: "Закон о документообороте", pattern: /(?:Закон(?:а)?\s+о\s+документообороте\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s+Закона\s+о\s+документообороте)/giu },
  { key: "justice", label: "Закон о Департаменте юстиции", pattern: /(?:Закон(?:а)?\s+о\s+Департаменте\s+юстиции\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s+Закона\s+о\s+Департаменте\s+юстиции)/giu },
  { key: "labor", label: "Трудовой кодекс", pattern: /(?:Трудов(?:ый|ого)\s+кодекс(?:а)?\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s+Трудового\s+кодекса)/giu },
  { key: "ethics", label: "Этический кодекс", pattern: /(?:Этическ(?:ий|ого)\s+кодекс(?:а)?\s*(?:статья|статьи|ст\.?)?\s*(\d+(?:\.\d+)*)|(?:статья|статьи|ст\.?)\s*(\d+(?:\.\d+)*)\s+Этического\s+кодекса)/giu }
];
const field = (key, label, options = {}) => ({ key, label, ...options });
export const docSchemas = {
  complaint: {
    guidance: "Событие должно быть не старше 24 часов. Укажите дату и время в формате ДД.ММ.ГГГГ, ЧЧ:ММ, место, доказательства и запрос на изъятие с точным местом хранения. OOC-видео обязательно. Для видео длиннее минуты нужны тайм-коды; по травмам приложите заключение врача.",
    groups: [
      { title: "Заголовок и заявитель", fields: [
        field("cpNumber", "Номер жалобы CP", { value: "Будет выдан при формировании", readOnly: true }),
        field("organization", "Организация", { type: "select", options: ["LSPD", "LSSD", "FIB", "NG", "SASPA", "EMS", "GOV", "Неизвестно"], required: true }),
        field("complainant", "Имя и фамилия заявителя", { required: true }),
        field("target", "На кого подается жалоба (имя / жетон / нашивка)", { required: true }),
        field("eventDate", "Дата и время события (не старше 24 часов)", { placeholder: "ДД.ММ.ГГГГ, ЧЧ:ММ", required: true }),
        field("eventPlace", "Место события", { required: true })
      ]},
      { title: "События и доказательства", fields: [
        field("complaintFacts", "Подробное описание правонарушения", { type: "textarea", required: true, rows: 4 }),
        field("evidence", "Доказательства от лица заявителя (ссылка / описание)", { type: "textarea", required: true }),
        field("oocVideo", "Ссылка на OOC-видеозапись и описание места на записи", { type: "textarea", required: true }),
        field("videoMinutes", "Продолжительность видео в минутах", { type: "number", min: 0, step: "any", required: true }),
        field("timecodes", "Тайм-коды заявленных нарушений (обязательны, если видео длиннее 1 минуты)", { type: "textarea" }),
        field("seizureRequest", "Запрос на изъятие записи (какую запись и зачем нужно изъять)", { type: "textarea", required: true }),
        field("seizurePlace", "Точное место изъятия (номер магазина / служебный автомобиль / камеры и т. п.)", { required: true }),
        field("medicalReport", "Заключение врача при жалобе на травмы (ссылка или «не относится»)", { required: true })
      ]},
      { title: "Контактные данные и подтверждение", fields: [
        field("idCopy", "Электронная копия ID-карты (ссылка)", { required: true }),
        field("phone", "Номер телефона", { required: true }),
        field("email", "Электронная почта", { required: true }),
        field("workplace", "Место работы", { required: true }),
        field("position", "Должность", { required: true }),
        field("ownEvidence", "Подтверждаю, что доказательства записаны от моего лица", { type: "checkbox", required: true })
      ]}
    ]
  },
  "lawsuit-supreme": { court: "В ВЕРХОВНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ", title: "ИСКОВОЕ ЗАЯВЛЕНИЕ", groups: [
    { title: "Истец", fields: [field("claimant", "Имя и фамилия", { required: true }), field("claimantId", "Номер ID-карты", { required: true }), field("claimantPhone", "Номер телефона"), field("claimantEmail", "Электронная почта")] },
    { title: "Представитель истца", fields: [field("repName", "Имя и фамилия"), field("repId", "Номер ID-карты"), field("repLicense", "Данные о лицензии адвоката (государственный адвокат / номер лицензии частного адвоката)"), field("repPhone", "Номер телефона"), field("repEmail", "Электронная почта")] },
    { title: "Ответчик и суть иска", fields: [field("defendant", "Имя и фамилия ответчика", { required: true }), field("organization", "Организация ответчика"), field("badge", "Идентификационный знак"), field("facts", "Подробно опишите ситуацию, дату, время, нарушения и затронутые права", { type: "textarea", required: true }), field("claims", "Требования к суду (каждый пункт с новой строки)", { type: "textarea", required: true })] },
    { title: "Материалы и подача", fields: [field("claimantPassport", "Копия паспорта истца"), field("feeProof", "Доказательства уплаты государственной пошлины"), field("evidence", "Доказательства", { type: "textarea" }), field("otherDocs", "Иные документы", { type: "textarea" }), field("repPassport", "Копия паспорта представителя истца"), field("repCredential", "Удостоверение представителя (служебное удостоверение / копия лицензии частного адвоката)"), field("contract", "Копия заключенного договора"), field("contractProof", "Доказательства заключения договора"), field("filingDate", "Дата подачи заявления", { defaultToday: true }), field("signature", "Подпись истца или его представителя")] }
  ]},
  "lawsuit-federal": { court: "В ФЕДЕРАЛЬНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ", title: "ИСКОВОЕ ЗАЯВЛЕНИЕ", groups: [
    { title: "Истец", fields: [field("claimant", "Имя и фамилия", { required: true }), field("claimantId", "Номер ID-карты", { required: true }), field("claimantPhone", "Номер телефона"), field("claimantEmail", "Электронная почта")] },
    { title: "Представитель истца", fields: [field("repName", "Имя и фамилия"), field("repId", "Номер ID-карты"), field("repLicense", "Статус / номер лицензии адвоката"), field("repPhone", "Номер телефона"), field("repEmail", "Электронная почта")] },
    { title: "Ответчик и суть иска", fields: [field("defendant", "Имя и фамилия ответчика", { required: true }), field("organization", "Организация ответчика"), field("badge", "Идентификационный знак"), field("facts", "Описание ситуации, дата, время и нарушение прав", { type: "textarea", required: true }), field("claims", "Требования к суду", { type: "textarea", required: true })] },
    { title: "Материалы и подача", fields: [field("claimantPassport", "Копия паспорта истца (ссылка)"), field("feeProof", "Доказательства уплаты пошлины"), field("evidence", "Доказательства (ссылки)", { type: "textarea" }), field("otherDocs", "Иные документы", { type: "textarea" }), field("repPassport", "Копия паспорта представителя"), field("repCredential", "Удостоверение / лицензия представителя"), field("contract", "Копия договора"), field("contractProof", "Доказательства заключения договора"), field("filingDate", "Дата подачи", { defaultToday: true }), field("signature", "Подпись истца или представителя")] }
  ]},
  "indictment-supreme": { court: "В ВЕРХОВНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ", title: "ОБВИНИТЕЛЬНОЕ ЗАКЛЮЧЕНИЕ", groups: [
    { title: "Дело и представитель штата", fields: [field("caseNumber", "Номер дела", { required: true }), field("prosecutor", "Имя и фамилия представителя штата", { required: true }), field("prosecutorId", "Номер ID-карты"), field("prosecutorEmail", "Электронная почта"), field("prosecutorPosition", "Должность", { required: true })] },
    { title: "Обвиняемый и обвинение", fields: [field("accused", "Имя и фамилия обвиняемого", { required: true }), field("accusedId", "Номер ID-карты"), field("accusedWork", "Место работы и должность"), field("articles", "Статьи обвинения", { type: "textarea", required: true }), field("facts", "Краткое описание дела", { type: "textarea", required: true }), field("evidence", "Доказательства обвинения / передача дела", { type: "textarea", required: true }), field("requests", "Просьба прокуратуры к суду", { type: "textarea", required: true }), field("filingDate", "Дата", { defaultToday: true }), field("signature", "Должность, имя и подпись")] }
  ]},
  "indictment-district": { court: "В ОКРУЖНОЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ", title: "ОБВИНИТЕЛЬНОЕ ЗАКЛЮЧЕНИЕ", groups: [
    { title: "Дело и представитель штата", fields: [field("caseNumber", "Номер дела", { required: true }), field("prosecutor", "Имя и фамилия представителя штата", { required: true }), field("prosecutorId", "Номер ID-карты"), field("prosecutorEmail", "Электронная почта"), field("prosecutorPosition", "Должность", { required: true })] },
    { title: "Обвиняемый и обвинение", fields: [field("accused", "Имя и фамилия обвиняемого", { required: true }), field("accusedId", "Номер ID-карты"), field("accusedWork", "Место работы и должность"), field("articles", "Статьи обвинения", { type: "textarea", required: true }), field("facts", "Краткое описание дела", { type: "textarea", required: true }), field("evidence", "Доказательства обвинения / передача дела", { type: "textarea", required: true }), field("requests", "Просьба прокуратуры к суду", { type: "textarea", required: true }), field("filingDate", "Дата", { defaultToday: true }), field("signature", "Должность, имя и подпись")] }
  ]},
  appeal: { court: "В ВЕРХОВНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ", title: "АПЕЛЛЯЦИОННАЯ ЖАЛОБА", groups: [
    { title: "Апеллянт и представитель", fields: [field("claimant", "Имя и фамилия апеллянта", { required: true }), field("claimantId", "Номер ID-карты"), field("claimantPhone", "Номер телефона"), field("claimantEmail", "Электронная почта"), field("status", "Процессуальный статус в первой инстанции", { required: true }), field("repName", "Представитель апеллянта"), field("repId", "ID представителя"), field("repLicense", "Статус / лицензия адвоката"), field("repPhone", "Телефон представителя"), field("repEmail", "Почта представителя")] },
    { title: "Ответчик и оспариваемый акт", fields: [field("defendant", "Ответчик", { required: true }), field("organization", "Организация"), field("badge", "Идентификационный знак"), field("defendantStatus", "Процессуальный статус"), field("judge", "Судья, издавший акт"), field("judgePosition", "Должность судьи"), field("act", "Оспариваемый акт и номер дела", { required: true }), field("facts", "Почему вы не согласны с решением", { type: "textarea", required: true }), field("claims", "Требования апеллянта", { type: "textarea", required: true }), field("claimantPassport", "Копия паспорта"), field("feeProof", "Пошлина"), field("otherDocs", "Иные документы"), field("repPassport", "Паспорт представителя"), field("repCredential", "Удостоверение / лицензия представителя"), field("contract", "Договор и доказательства его заключения"), field("filingDate", "Дата подачи", { defaultToday: true }), field("signature", "Подпись апеллянта или представителя")] }
  ]},
  cassation: { court: "В ВЕРХОВНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ", title: "КАССАЦИОННАЯ ЖАЛОБА", groups: [
    { title: "Кассатор и представитель", fields: [field("claimant", "Имя и фамилия кассатора", { required: true }), field("claimantId", "Номер ID-карты"), field("claimantPhone", "Номер телефона"), field("claimantEmail", "Электронная почта"), field("status", "Процессуальный статус в первой инстанции", { required: true }), field("repName", "Представитель кассатора"), field("repId", "ID представителя"), field("repLicense", "Статус / лицензия адвоката"), field("repPhone", "Телефон представителя"), field("repEmail", "Почта представителя")] },
    { title: "Оспариваемый акт и требования", fields: [field("judge", "Судья, издавший акт"), field("judgePosition", "Должность судьи"), field("act", "Решение Верховного суда и номер дела", { required: true }), field("facts", "Почему не согласны с решениями и какие нормы нарушены", { type: "textarea", required: true }), field("claims", "Требования кассатора", { type: "textarea", required: true }), field("claimantPassport", "Копия паспорта"), field("feeProof", "Доказательства уплаты пошлины"), field("otherDocs", "Иные документы"), field("repPassport", "Паспорт представителя"), field("repCredential", "Удостоверение / лицензия представителя"), field("contract", "Договор и доказательства его заключения"), field("filingDate", "Дата подачи", { defaultToday: true }), field("signature", "Подпись кассатора или представителя")] }
  ]},
  constitutional: { court: "В ВЕРХОВНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ", title: "ИСКОВОЕ ЗАЯВЛЕНИЕ · КОНСТИТУЦИОННОЕ СУДОПРОИЗВОДСТВО", groups: [
    { title: "Заявитель и представитель", fields: [field("claimant", "Имя и фамилия заявителя", { required: true }), field("claimantId", "Номер ID-карты"), field("claimantPhone", "Номер телефона"), field("claimantEmail", "Электронная почта"), field("workplace", "Место работы"), field("repName", "Представитель заявителя"), field("repId", "ID представителя"), field("repLicense", "Статус / лицензия адвоката"), field("repPhone", "Телефон представителя"), field("repEmail", "Почта представителя")] },
    { title: "Оспариваемый акт", fields: [field("actAuthor", "Автор акта (если закон — штат Сан-Андреас)", { required: true }), field("actName", "Наименование оспариваемого акта", { required: true }), field("actPosition", "Должность и место работы автора"), field("facts", "Дата, норма/акт и причины несоответствия Конституции", { type: "textarea", required: true }), field("claims", "Требования заявителя", { type: "textarea", required: true }), field("claimantPassport", "Копия паспорта истца"), field("feeProof", "Доказательства уплаты пошлины"), field("otherDocs", "Иные документы"), field("repPassport", "Паспорт представителя"), field("repCredential", "Удостоверение / лицензия представителя"), field("contract", "Договор и доказательства заключения"), field("filingDate", "Дата подачи", { defaultToday: true }), field("signature", "Подпись истца или представителя")] }
  ]},
  "motion-citizen": { court: "В ФЕДЕРАЛЬНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ", title: "ХОДАТАЙСТВО / ВОЗРАЖЕНИЕ / ДОВОД", groups: [
    { title: "Заявление", fields: [field("motionType", "Тип документа (ходатайство / возражение / довод)", { required: true }), field("motionSubject", "О чем обращение", { required: true }), field("claimant", "Имя и фамилия заявителя", { required: true }), field("claimantId", "Номер ID-карты"), field("facts", "Суть обращения и обстоятельства", { type: "textarea", required: true }), field("email", "Электронная почта"), field("evidence", "Доказательства", { type: "textarea" }), field("otherDocs", "Иная информация / документы", { type: "textarea" }), field("filingDate", "Дата подачи", { defaultToday: true }), field("signature", "Подпись")] }
  ]},
  "motion-agency": { court: "ОТ [ОРГАН] ШТАТА САН-АНДРЕАС · В ФЕДЕРАЛЬНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ", title: "ХОДАТАЙСТВО / ВОЗРАЖЕНИЕ / ДОВОД / УВЕДОМЛЕНИЕ", groups: [
    { title: "Орган и обращение", fields: [field("organization", "Орган / организация", { required: true }), field("prosecutorPosition", "Должность представителя", { required: true }), field("prosecutor", "Имя и фамилия представителя", { required: true }), field("motionType", "Тип документа", { required: true }), field("motionSubject", "О чем обращение", { required: true }), field("facts", "Суть и обстоятельства обращения", { type: "textarea", required: true }), field("officialCredential", "Копия служебного удостоверения"), field("claimantId", "Копия ID-карты"), field("email", "Электронная почта"), field("evidence", "Доказательства", { type: "textarea" }), field("otherDocs", "Иная информация", { type: "textarea" }), field("filingDate", "Дата подачи", { defaultToday: true }), field("signature", "Подпись")] }
  ]},
  rehabilitation: {
    guidance: "Размер пошлины по присланному положению: без * — $25,000; * — $50,000; ** — $75,000; *** или **** — $100,000. Каждая судимость (отдельный эпизод/приговор) снимается отдельно. В форме предусмотрен один эпизод на одно заявление.",
    court: "В ВЕРХОВНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ", title: "ЗАЯВЛЕНИЕ НА ЮРИДИЧЕСКУЮ РЕАБИЛИТАЦИЮ", groups: [
      { title: "Заявитель и эпизод судимости", fields: [field("rehabNumber", "Номер заявления (выдается сервером)", { value: "Будет выдан при формировании", readOnly: true }), field("claimant", "Имя и фамилия", { required: true }), field("claimantId", "Номер паспорта", { required: true }), field("claimantEmail", "Электронная почта"), field("claimantPhone", "Номер телефона"), field("sentenceDate", "Дата осуждения", { required: true }), field("articles", "Статьи по этому эпизоду", { type: "textarea", required: true }), field("severity", "Тяжесть самой тяжкой статьи", { type: "select", options: ["Без звезды · $25,000", "* · $50,000", "** · $75,000", "*** / **** · $100,000"], required: true }), field("feeAgreement", "Готовность уплатить установленную пошлину", { type: "select", options: ["Да", "Нет"], required: true }), field("confession", "Подтверждение признания вины и раскаяния", { type: "textarea", required: true })] },
      { title: "Материалы и заключение", fields: [field("claimantPassport", "Копия паспорта (гиперссылка)", { required: true }), field("otherDocs", "Иные документы (ссылки)", { type: "textarea" }), field("filingDate", "Дата подачи", { defaultToday: true }), field("signature", "Подпись")] }
    ]
  }
};
