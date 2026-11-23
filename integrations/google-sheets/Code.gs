function doPost(event) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ ok: false, error: "Another sync is running." });

  try {
    const request = JSON.parse(event.postData.contents);
    const properties = PropertiesService.getScriptProperties();
    const expectedToken = properties.getProperty("SYNC_TOKEN") || "";
    if (!expectedToken || request.token !== expectedToken) {
      return jsonResponse({ ok: false, error: "Invalid sync token." });
    }

    const report = request.report;
    if (!report || !/^\d{4}-(0[1-9]|1[0-2])$/.test(report.period) ||
        !Array.isArray(report.rows) || !Array.isArray(report.employees)) {
      return jsonResponse({ ok: false, error: "Invalid report payload." });
    }

    const spreadsheetId = properties.getProperty("SPREADSHEET_ID") || "";
    if (!spreadsheetId) return jsonResponse({ ok: false, error: "SPREADSHEET_ID is not configured." });
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);

    const employeeHeaders = ["ID", "Сотрудник", "Роль", "Обновлено"];
    const employeeRows = report.employees.map((employee) => [
      Number(employee.userId), safeText(employee.displayName), safeText(employee.role), safeText(report.generatedAt)
    ]);
    const employeeSheet = getSheet(spreadsheet, "Состав", employeeHeaders);
    employeeSheet.clearContents();
    employeeSheet.getRange(1, 1, 1, employeeHeaders.length).setValues([employeeHeaders]);
    if (employeeRows.length) {
      employeeSheet.getRange(2, 1, employeeRows.length, employeeHeaders.length).setValues(employeeRows);
    }

    const reportHeaders = [
      "Период", "ID", "Сотрудник", "Роль", "Документов создано", "Документов одобрено",
      "Исков подано", "Обращений взято", "Обращений закрыто", "Экзаменов сдано",
      "Переаттестаций пройдено", "Выговоров", "Отчётов о вызовах одобрено",
      "Отчётов об исках одобрено", "Жалоб в прокуратуру одобрено"
    ];
    const monthlySheet = getSheet(spreadsheet, "Отчётность", reportHeaders);
    upsertMonthlyRows(monthlySheet, reportHeaders, report);

    const historyHeaders = ["Время синхронизации", "Период", "Сотрудников", "Записей отчёта"];
    const historySheet = getSheet(spreadsheet, "Журнал синхронизации", historyHeaders);
    historySheet.appendRow([
      String(report.generatedAt), String(report.period), report.employees.length, report.rows.length
    ]);
    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message || error).slice(0, 300) });
  } finally {
    lock.releaseLock();
  }
}

function getSheet(spreadsheet, name, headers) {
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return sheet;
  }
  const lastColumn = sheet.getLastColumn();
  const currentHeaders = sheet.getRange(1, 1, 1, Math.max(lastColumn, headers.length)).getValues()[0].map(String);
  const comparedHeaders = Math.min(lastColumn, headers.length);
  if (headers.slice(0, comparedHeaders).some((header, index) => currentHeaders[index] !== header)) {
    throw new Error("Unexpected columns in sheet: " + name);
  }
  if (lastColumn < headers.length) {
    sheet.getRange(1, lastColumn + 1, 1, headers.length - lastColumn)
      .setValues([headers.slice(lastColumn)]);
  }
  return sheet;
}

function upsertMonthlyRows(sheet, headers, report) {
  const desiredKeys = new Set(report.rows.map((item) => String(report.period) + ":" + String(item.userId)));
  let lastRow = sheet.getLastRow();
  for (let rowNumber = lastRow; rowNumber > 1; rowNumber -= 1) {
    const [existingPeriod, existingUserId] = sheet.getRange(rowNumber, 1, 1, 2).getValues()[0];
    const key = String(existingPeriod) + ":" + String(existingUserId);
    if (String(existingPeriod) === String(report.period) && !desiredKeys.has(key)) {
      sheet.deleteRow(rowNumber);
    }
  }
  lastRow = sheet.getLastRow();
  const existing = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
    : [];
  const rowByKey = new Map();
  existing.forEach((row, index) => rowByKey.set(String(row[0]) + ":" + String(row[1]), index + 2));
  const additions = [];

  report.rows.forEach((item) => {
    const values = [
      String(report.period), Number(item.userId), safeText(item.displayName), safeText(item.role),
      Number(item.documentsCreated), Number(item.documentsApproved), Number(item.lawsuitsFiled),
      Number(item.casesTaken), Number(item.casesClosed), Number(item.examsPassed),
      Number(item.attestationsPassed), Number(item.reprimands), Number(item.callsReported)
    ];
    const key = String(report.period) + ":" + String(item.userId);
    const rowNumber = rowByKey.get(key);
    if (rowNumber) sheet.getRange(rowNumber, 1, 1, headers.length).setValues([values]);
    else additions.push(values);
  });

  if (additions.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, additions.length, headers.length).setValues(additions);
  }
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeText(value) {
  const text = String(value == null ? "" : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}
