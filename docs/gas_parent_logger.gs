/**
 * 【お父さん専用・裏見守り機能 ＋ 別デバイス途中試験クラウド同期】
 * Google Apps Script（ウェブアプリ）
 *
 * 更新手順（30秒・URLは変わりません！）:
 * 1. Apps Script画面のコードをすべて消して、下のコードを貼り付けて保存（Ctrl+S）
 * 2. 右上「デプロイ」→「デプロイを管理」→ 鉛筆アイコン（編集）
 * 3. 「バージョン」を「新バージョン」に変更して「デプロイ」を押すだけで完了！
 */

function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var data = JSON.parse(e.postData.contents);

    // 1. 別デバイス継続用：実践試験の途中経過クラウド保存
    if (data.event === "mock_draft_save") {
      saveMockDraftSheet_(ss, data.draftJson || "", data.deviceId || "");
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, mode: "draft_saved" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 2. 別デバイス継続用：途中経過のクリア（採点完了・中断・破棄時）
    if (data.event === "mock_draft_clear") {
      clearMockDraftSheet_(ss);
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, mode: "draft_cleared" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. 通常の学習ログ記録（お父さん見守り用）
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
      ts,
      dateStr,
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

    // お子さんの別デバイス起動時：途中保存データだけを軽量取得（見守りログは返さない）
    if (mode === "draft") {
      var draftObj = readMockDraftSheet_(ss);
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, mockDraft: draftObj }))
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
        mockDraft: readMockDraftSheet_(ss)
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function saveMockDraftSheet_(ss, draftJson, deviceId) {
  var sheet = ss.getSheetByName("途中保存");
  if (!sheet) {
    sheet = ss.insertSheet("途中保存");
    sheet.appendRow(["更新日時", "端末", "途中データJSON"]);
    sheet.setFrozenRows(1);
  }
  var ts = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
  sheet.getRange(2, 1, 1, 3).setValues([[ts, deviceId, draftJson]]);
}

function clearMockDraftSheet_(ss) {
  var sheet = ss.getSheetByName("途中保存");
  if (!sheet) return;
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, 1, 3).clearContent();
  }
}

function readMockDraftSheet_(ss) {
  var sheet = ss.getSheetByName("途中保存");
  if (!sheet || sheet.getLastRow() < 2) return null;
  var row = sheet.getRange(2, 1, 1, 3).getValues()[0];
  var raw = String(row[2] || "").trim();
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
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
      if (cellDateStr === dateStr) {
        foundRow = i + 2;
        break;
      }
    }
  }

  var isAnswer = (data.event === "answer" || data.event === "ox_answer");
  var addAns = isAnswer ? 1 : 0;
  var addCor = (isAnswer && data.correct === true) ? 1 : 0;
  var mins = Number(data.todayMinutes) || 0;

  if (foundRow === -1) {
    sheet.appendRow(["'" + dateStr, addAns, addCor, mins, "'" + nowStr]);
  } else {
    var curAns = Number(sheet.getRange(foundRow, 2).getValue()) || 0;
    var curCor = Number(sheet.getRange(foundRow, 3).getValue()) || 0;
    var curMin = Number(sheet.getRange(foundRow, 4).getValue()) || 0;
    sheet.getRange(foundRow, 2).setValue(curAns + addAns);
    sheet.getRange(foundRow, 3).setValue(curCor + addCor);
    sheet.getRange(foundRow, 4).setValue(Math.max(curMin, mins));
    sheet.getRange(foundRow, 5).setValue("'" + nowStr);
  }
}
