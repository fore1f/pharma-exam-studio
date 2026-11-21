/**
 * 【お父さん専用・裏見守り機能 ＋ 全デバイス成績・途中試験クラウド自動同期】
 * Google Apps Script（ウェブアプリ）
 */

function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var data = JSON.parse(e.postData.contents);

    // 1. 全デバイス成績・ブックマーク・メモ・模試履歴のクラウド同期
    if (data.event === "progress_sync") {
      saveChunkedSheet_(ss, "学習データ同期", data.progressJson || "", data.deviceId || "");
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, mode: "progress_saved" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 2. 別デバイス継続用：実践試験の途中経過クラウド保存
    if (data.event === "mock_draft_save") {
      saveChunkedSheet_(ss, "途中保存", data.draftJson || "", data.deviceId || "");
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, mode: "draft_saved" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. 別デバイス継続用：途中経過のクリア
    if (data.event === "mock_draft_clear") {
      clearChunkedSheet_(ss, "途中保存");
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, mode: "draft_cleared" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 4. 通常の学習ログ記録（お父さん見守り用）
    var logSheet = ss.getSheetByName("ログ");
    if (!logSheet) {
      logSheet = ss.insertSheet("ログ");
      logSheet.appendRow([
        "日時", "日付", "イベント", "問題ID", "科目", "正誤",
        "当日解答数", "累計解答数", "累計正答率(%)", "推定勉強時間(分)", "端末ID"
      ]);
      logSheet.setFrozenRows(1);
    }

    var now = new Date();
    var ts = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
    var dateStr = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd");

    logSheet.appendRow([
      "'" + ts,
      "'" + dateStr,
      data.event || "answer",
      data.qid || "",
      data.subject || "",
      data.correct === true ? "○" : (data.correct === false ? "×" : "-"),
      data.todayCount || 0,
      data.totalCount || 0,
      data.accuracy || 0,
      data.todayMinutes || 0,
      data.deviceId || ""
    ]);

    updateDailySummary_(ss, dateStr, data);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var mode = (e && e.parameter && e.parameter.mode) ? String(e.parameter.mode) : "";

    // お子さんの端末起動時：成績＋途中試験だけを1回で軽量取得（見守りログは返さない）
    if (mode === "sync" || mode === "draft") {
      return ContentService
        .createTextOutput(JSON.stringify({
          ok: true,
          mockDraft: readChunkedSheet_(ss, "途中保存"),
          progress: readChunkedSheet_(ss, "学習データ同期")
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // お父さん専用レポート取得
    var logSheet = ss.getSheetByName("ログ");
    var dailySheet = ss.getSheetByName("日別サマリー");

    var recentLogs = [];
    if (logSheet && logSheet.getLastRow() > 1) {
      var lastRow = logSheet.getLastRow();
      var startRow = Math.max(2, lastRow - 49);
      var values = logSheet.getRange(startRow, 1, lastRow - startRow + 1, 11).getValues();
      for (var i = values.length - 1; i >= 0; i--) {
        var r = values[i];
        recentLogs.push({
          ts: String(r[0]),
          date: String(r[1]),
          event: String(r[2]),
          qid: String(r[3]),
          subject: String(r[4]),
          result: String(r[5]),
          todayCount: Number(r[6]) || 0,
          totalCount: Number(r[7]) || 0,
          accuracy: Number(r[8]) || 0,
          todayMinutes: Number(r[9]) || 0,
          device: String(r[10] || "")
        });
      }
    }

    var daily = [];
    if (dailySheet && dailySheet.getLastRow() > 1) {
      var dLast = dailySheet.getLastRow();
      var dStart = Math.max(2, dLast - 29);
      var dVals = dailySheet.getRange(dStart, 1, dLast - dStart + 1, 5).getValues();
      for (var j = dVals.length - 1; j >= 0; j--) {
        daily.push({
          date: String(dVals[j][0]),
          answers: Number(dVals[j][1]) || 0,
          correct: Number(dVals[j][2]) || 0,
          minutes: Number(dVals[j][3]) || 0,
          lastActive: String(dVals[j][4])
        });
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        daily: daily,
        recentLogs: recentLogs,
        mockDraft: readChunkedSheet_(ss, "途中保存")
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 1セル上限(50,000文字)を超えないよう45,000文字ごとに自動分割保存
function saveChunkedSheet_(ss, sheetName, jsonStr, deviceId) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(["更新日時", "端末", "データ1", "データ2", "データ3", "データ4", "データ5", "データ6"]);
    sheet.setFrozenRows(1);
  }
  var ts = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
  var maxChunks = 6;
  var chunkSize = 45000;
  var row = ["'" + ts, deviceId];
  for (var i = 0; i < maxChunks; i++) {
    var start = i * chunkSize;
    row.push(start < jsonStr.length ? jsonStr.slice(start, start + chunkSize) : "");
  }
  sheet.getRange(2, 1, 1, row.length).setValues([row]);
}

function clearChunkedSheet_(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return;
  sheet.getRange(2, 1, 1, Math.max(8, sheet.getLastColumn())).clearContent();
}

function readChunkedSheet_(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var cols = Math.max(8, sheet.getLastColumn());
  var row = sheet.getRange(2, 1, 1, cols).getValues()[0];
  var combined = "";
  for (var i = 2; i < row.length; i++) {
    combined += String(row[i] || "");
  }
  combined = combined.trim();
  if (!combined) return null;
  try {
    var parsed = JSON.parse(combined);
    parsed._cloudUpdatedAt = String(row[0] || "");
    parsed._cloudDevice = String(row[1] || "");
    return parsed;
  } catch (e) {
    return null;
  }
}

function updateDailySummary_(ss, dateStr, data) {
  var sheet = ss.getSheetByName("日別サマリー");
  if (!sheet) {
    sheet = ss.insertSheet("日別サマリー");
    sheet.appendRow(["日付", "解答数", "正解数", "勉強時間(分)", "最終アクセス"]);
    sheet.setFrozenRows(1);
  }
  var nowStr = Utilities.formatDate(new Date(), "Asia/Tokyo", "HH:mm:ss");
  var lastRow = sheet.getLastRow();
  var foundRow = -1;
  if (lastRow > 1) {
    var dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = dates.length - 1; i >= 0; i--) {
      var cellVal = dates[i][0];
      var cellDateStr = (cellVal instanceof Date)
        ? Utilities.formatDate(cellVal, "Asia/Tokyo", "yyyy-MM-dd")
        : String(cellVal).trim();
      if (cellDateStr === dateStr) { foundRow = i + 2; break; }
    }
  }
  var isAnswer = (data.event === "answer" || data.event === "ox_answer");
  var addAns = isAnswer ? 1 : 0;
  var addCor = (isAnswer && data.correct === true) ? 1 : 0;
  var mins = Number(data.todayMinutes) || 0;
  if (foundRow === -1) {
    sheet.appendRow(["'" + dateStr, addAns, addCor, mins, "'" + nowStr]);
  } else {
    sheet.getRange(foundRow, 2).setValue((Number(sheet.getRange(foundRow, 2).getValue()) || 0) + addAns);
    sheet.getRange(foundRow, 3).setValue((Number(sheet.getRange(foundRow, 3).getValue()) || 0) + addCor);
    sheet.getRange(foundRow, 4).setValue(Math.max(Number(sheet.getRange(foundRow, 4).getValue()) || 0, mins));
    sheet.getRange(foundRow, 5).setValue("'" + nowStr);
  }
}
