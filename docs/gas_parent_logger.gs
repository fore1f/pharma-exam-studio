/**
 * 【お父さん専用・裏見守り機能】Googleスプレッドシート自動記録＆レポートAPI
 *
 * 設置手順（無料・約3分）:
 * 1. Googleドライブで新しい「Googleスプレッドシート」を作成（名前例：国試勉強ログ）
 * 2. 上部メニュー「拡張機能」→「Apps Script」を開く
 * 3. 元から入っているコードをすべて消して、このファイルの中身をそのまま貼り付けて保存
 * 4. 右上の「デプロイ」→「新しいデプロイ」をクリック
 * 5. 種類の歯車アイコンから「ウェブアプリ」を選択
 *    - 実行するユーザー：自分
 *    - アクセスできるユーザー：全員
 *    にして「デプロイ」を押す（初回のみGoogleの承認画面が出るので「詳細」→「移動」で許可）
 * 6. 表示された「ウェブアプリのURL（https://script.google.com/macros/s/.../exec）」をコピーし、
 *    docs/app.js の PARENT_WEBHOOK_URL に貼り付ければ完了！
 *
 * ※スプレッドシートの「ログ」シートに全記録、「日別サマリー」シートに毎日の勉強量が自動集計されます。
 * ※さらに、アプリのURL末尾に ?report=papa を付けて開くと、お父さんのスマホからも
 *   リアルタイムの勉強レポートを閲覧できます！
 */

function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = ss.getSheetByName("ログ");
    if (!logSheet) {
      logSheet = ss.insertSheet("ログ");
      logSheet.appendRow([
        "日時", "日付", "イベント", "問題ID", "科目", "正誤",
        "当日解答数", "累計解答数", "累計正答率(%)", "推定勉強時間(分)", "端末ID"
      ]);
      logSheet.setFrozenRows(1);
    }

    var data = JSON.parse(e.postData.contents);
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
          todayMinutes: Number(r[9]) || 0
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
      .createTextOutput(JSON.stringify({ ok: true, daily: daily, recentLogs: recentLogs }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
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
      if (String(dates[i][0]) === dateStr) {
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
    sheet.appendRow([dateStr, addAns, addCor, mins, nowStr]);
  } else {
    var curAns = Number(sheet.getRange(foundRow, 2).getValue()) || 0;
    var curCor = Number(sheet.getRange(foundRow, 3).getValue()) || 0;
    var curMin = Number(sheet.getRange(foundRow, 4).getValue()) || 0;
    sheet.getRange(foundRow, 2).setValue(curAns + addAns);
    sheet.getRange(foundRow, 3).setValue(curCor + addCor);
    sheet.getRange(foundRow, 4).setValue(Math.max(curMin, mins));
    sheet.getRange(foundRow, 5).setValue(nowStr);
  }
}
