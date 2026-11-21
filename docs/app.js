/**
 * 薬剤師国家試験 過去問＆法令マスター - アプリ本体
 */

// =========================================================================
// 【お父さん専用・裏見守り設定】
// Google Apps Script（gas_parent_logger.gs）をデプロイしたウェブアプリURLを
// 下の "" の中に入れて公開すると、お子さんのスマホの勉強履歴が
// 裏側で静かにお父さんのGoogleスプレッドシートへ自動送信されます。
// （空欄のままでもアプリ自体は100%正常に動作します）
// =========================================================================
const PARENT_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbwBlhtH0KjJvQdi0pX54m_zjsKcoQjPqjqrFPaB5KDTDvU-QhdPOXYbf1I74SmZMPLEIw/exec";

// 起動パスワードのSHA-256ハッシュ（初期パスワード: yakugaku2026）
const AUTH_HASH = "6abed39429b147f70634cb1fc554069f2e53d6bbf03487daac82bead1a050af2";
const AUTH_SESSION_KEY = "pharma_exam_auth_ok_v1";
const PARENT_MUTE_KEY = "pharma_exam_parent_mute_v1";
const MOCK_DRAFT_KEY = "pharma_exam_mock_draft_v1";

const STORAGE_KEY = "pharma_exam_studio_v1";

const SUBJECT_LIST = [
  "法規・制度・倫理",
  "物理",
  "化学",
  "生物",
  "衛生",
  "薬理",
  "薬剤",
  "病態・薬物治療",
  "実務",
];

// アプリ状態
const state = {
  examCache: {},
  allLoadedExams: new Set(),
  filteredQuestions: [],
  currentIndex: 0,
  selectedChoices: new Set(),
  answeredCurrent: false,
  timerSec: 0,
  timerHandle: null,
  sessionStartMs: Date.now(),
  shuffleChoices: true,
  largeFont: true,
  pdfImgVisible: false,

  // 実践試験モード（本番模試）
  examMode: "practice", // "practice" | "mock"
  currentView: "exam",
  hasMockResult: false,
  cloudDraft: null,
  cloudDraftSaveTimer: null,
  cloudProgressSyncTimer: null,
  cloudSyncInitialized: false,
  mock: {
    active: false,
    title: "",
    isHissuFull: false,
    questions: [],
    shuffledMap: {}, // idx -> shuffled choices array
    answers: {}, // idx -> Set<number>
    flags: {}, // idx -> bool
    qSpentSec: {}, // idx -> elapsed seconds on that question
    qEnterMs: 0,
    index: 0,
    startMs: 0,
    limitSec: 0, // 0 = 無制限
    elapsedSec: 0,
    timerHandle: null,
    cdTimerHandle: null,
    pdfVisible: false,
    lastWrongQuestions: [],
  },

  // 法令・○×・比較表
  studyPack: null,
  activeLawIdx: 1, // デフォルトで薬機法を選択（-1 = 全法令横断）
  redSheetOn: true,
  lawSort: "order", // "order" | "freq"
  lawAudioRate: 1.0,
  lawAudioActive: false,
  lawShownList: [],
  lawReturnTarget: null, // { label, artIdx }
  oxCategory: "すべて",
  oxList: [],
  oxIndex: 0,
  oxAnswered: false,
  cmpMaskOn: false,

  // 永続化データ
  progress: loadProgress(),
};

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nowTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        deviceId: parsed.deviceId || "dev-" + Math.random().toString(36).slice(2, 10),
        answers: parsed.answers || {}, // { qid: { correct: bool, chosen: [], subject, ts } }
        bookmarks: parsed.bookmarks || {}, // { qid: true }
        memos: parsed.memos || {}, // { qid: "text" }
        daily: parsed.daily || {}, // { "YYYY-MM-DD": { count, correct, minutes, lastActive } }
        recent: parsed.recent || [], // [{ ts, event, qid, subject, result }]
        mockHistory: parsed.mockHistory || [], // [{ ts, title, correct, total, pct, elapsedSec, pass }]
      };
    }
  } catch (_) {}
  return {
    deviceId: "dev-" + Math.random().toString(36).slice(2, 10),
    answers: {},
    bookmarks: {},
    memos: {},
    daily: {},
    recent: [],
    mockHistory: [],
  };
}

function saveProgress(skipCloudPush = false) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
  } catch (_) {}
  updateSidebarStats();
  if (!skipCloudPush) {
    scheduleProgressCloudSync();
  }
}

function buildSyncableProgressPayload() {
  return {
    v: 1,
    updatedAt: Date.now(),
    answers: state.progress.answers || {},
    bookmarks: state.progress.bookmarks || {},
    memos: state.progress.memos || {},
    daily: state.progress.daily || {},
    mockHistory: (state.progress.mockHistory || []).slice(0, 30),
  };
}

function pushProgressToCloudNow() {
  if (!PARENT_WEBHOOK_URL || isParentMuted() || !state.cloudSyncInitialized) return;
  try {
    const payloadObj = buildSyncableProgressPayload();
    const hasAnyData =
      Object.keys(payloadObj.answers).length > 0 ||
      Object.keys(payloadObj.bookmarks).length > 0 ||
      Object.keys(payloadObj.memos).length > 0 ||
      Object.keys(payloadObj.daily).length > 0 ||
      payloadObj.mockHistory.length > 0;
    if (!hasAnyData) return;

    const body = JSON.stringify({
      event: "progress_sync",
      progressJson: JSON.stringify(payloadObj),
      deviceId: getDeviceLabel(),
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(PARENT_WEBHOOK_URL, new Blob([body], { type: "text/plain;charset=utf-8" }));
    } else {
      fetch(PARENT_WEBHOOK_URL, {
        method: "POST",
        mode: "no-cors",
        keepalive: true,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
      }).catch(() => {});
    }
  } catch (_) {}
}

function scheduleProgressCloudSync() {
  if (!PARENT_WEBHOOK_URL || isParentMuted() || !state.cloudSyncInitialized) return;
  clearTimeout(state.cloudProgressSyncTimer);
  state.cloudProgressSyncTimer = setTimeout(() => {
    pushProgressToCloudNow();
  }, 1600);
}

function mergeProgressData(local, cloud) {
  if (!cloud || typeof cloud !== "object") return { merged: local, localHadNewer: false };
  let localHadNewer = false;

  // 1. answers: 問題IDごとにタイムスタンプが新しい方を採用（両端末の解答が1問も消えない！）
  const mergedAnswers = { ...(cloud.answers || {}) };
  Object.entries(local.answers || {}).forEach(([qid, lVal]) => {
    const cVal = mergedAnswers[qid];
    if (!cVal || (lVal.ts || 0) > (cVal.ts || 0)) {
      mergedAnswers[qid] = lVal;
      if (!cVal || (lVal.ts || 0) > (cVal.ts || 0)) localHadNewer = true;
    }
  });

  // 2. bookmarks: 合体（クラウドとローカルの要復習マークを維持）
  const mergedBookmarks = { ...(cloud.bookmarks || {}), ...(local.bookmarks || {}) };
  if (Object.keys(local.bookmarks || {}).some((k) => !(cloud.bookmarks || {})[k])) {
    localHadNewer = true;
  }

  // 3. memos: 両方を統合
  const mergedMemos = { ...(cloud.memos || {}) };
  Object.entries(local.memos || {}).forEach(([qid, txt]) => {
    if (txt && (!mergedMemos[qid] || txt.length > mergedMemos[qid].length)) {
      mergedMemos[qid] = txt;
      localHadNewer = true;
    }
  });

  // 4. daily: 日付ごとに大きい方の解答数・正解数・学習時間＆新しい最終アクセス時刻を採用
  const mergedDaily = {};
  const allDates = new Set([...Object.keys(cloud.daily || {}), ...Object.keys(local.daily || {})]);
  allDates.forEach((dKey) => {
    const cD = (cloud.daily || {})[dKey];
    const lD = (local.daily || {})[dKey];
    if (cD && lD) {
      mergedDaily[dKey] = {
        count: Math.max(cD.count || 0, lD.count || 0),
        correct: Math.max(cD.correct || 0, lD.correct || 0),
        minutes: Math.max(cD.minutes || 0, lD.minutes || 0),
        lastActive: String(lD.lastActive || "") > String(cD.lastActive || "") ? lD.lastActive : cD.lastActive,
      };
      if ((lD.count || 0) > (cD.count || 0) || (lD.minutes || 0) > (cD.minutes || 0)) {
        localHadNewer = true;
      }
    } else if (cD) {
      mergedDaily[dKey] = cD;
    } else if (lD) {
      mergedDaily[dKey] = lD;
      localHadNewer = true;
    }
  });

  // 5. mockHistory: 重複除去して新しい順に最大30件
  const histMap = new Map();
  [...(cloud.mockHistory || []), ...(local.mockHistory || [])].forEach((h) => {
    const key = `${h.ts}|${h.title}|${h.correct}|${h.total}`;
    if (!histMap.has(key)) histMap.set(key, h);
  });
  const mergedMockHistory = [...histMap.values()].slice(0, 30);
  if ((local.mockHistory || []).length > (cloud.mockHistory || []).length) {
    localHadNewer = true;
  }

  return {
    merged: {
      ...local,
      answers: mergedAnswers,
      bookmarks: mergedBookmarks,
      memos: mergedMemos,
      daily: mergedDaily,
      mockHistory: mergedMockHistory,
    },
    localHadNewer,
  };
}

function getTodayMinutes() {
  const key = todayKey();
  const prev = state.progress.daily[key]?.minutes || 0;
  const elapsedMin = Math.max(1, Math.floor((Date.now() - state.sessionStartMs) / 60000));
  return Math.max(prev, elapsedMin);
}

function getOverallStats() {
  const entries = Object.values(state.progress.answers);
  const total = entries.length;
  const correct = entries.filter((e) => e.correct).length;
  const wrong = total - correct;
  const acc = total > 0 ? Math.round((correct / total) * 100) : 0;
  const todayCount = state.progress.daily[todayKey()]?.count || 0;
  const bookmarks = Object.keys(state.progress.bookmarks).filter((k) => state.progress.bookmarks[k]).length;
  return { total, correct, wrong, acc, todayCount, bookmarks };
}

function recordActivity(event, qid, subject, isCorrect) {
  const dKey = todayKey();
  if (!state.progress.daily[dKey]) {
    state.progress.daily[dKey] = { count: 0, correct: 0, minutes: 1, lastActive: nowTimeStr() };
  }
  const dayObj = state.progress.daily[dKey];
  if (event === "answer" || event === "ox_answer") {
    dayObj.count += 1;
    if (isCorrect === true) dayObj.correct += 1;
  }
  dayObj.minutes = getTodayMinutes();
  dayObj.lastActive = nowTimeStr();

  const tsFull = `${dKey} ${nowTimeStr()}`;
  state.progress.recent.unshift({
    ts: tsFull,
    device: getDeviceLabel(),
    event,
    qid: qid || "-",
    subject: subject || "-",
    result: isCorrect === true ? "○" : isCorrect === false ? "×" : "-",
  });
  if (state.progress.recent.length > 80) {
    state.progress.recent.length = 80;
  }

  saveProgress();
  sendSilentParentLog(event, qid, subject, isCorrect);
}

function detectDeviceType() {
  const ua = navigator.userAgent || "";
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Android" : "AndroidTab";
  if (/Windows/i.test(ua)) return "WinPC";
  if (/Macintosh/i.test(ua)) return "Mac";
  return "Web";
}

function getDeviceLabel() {
  const shortId = String(state.progress.deviceId || "0000").replace(/^dev-/, "").slice(0, 4);
  return `${detectDeviceType()}(${shortId})`;
}

function isParentMuted() {
  try {
    return localStorage.getItem(PARENT_MUTE_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function setParentMuted(flag) {
  try {
    if (flag) localStorage.setItem(PARENT_MUTE_KEY, "1");
    else localStorage.removeItem(PARENT_MUTE_KEY);
  } catch (_) {}
}

/**
 * 裏側で静かにGoogleスプレッドシートへ送信（エラー時も画面には一切出さない）
 */
function sendSilentParentLog(event, qid, subject, isCorrect, forceSend = false) {
  if (!PARENT_WEBHOOK_URL) return;
  if (!forceSend && isParentMuted()) return;
  try {
    const stats = getOverallStats();
    const devType = detectDeviceType();
    const subjectWithDev = subject ? `${subject} [${devType}]` : `[${devType}]`;
    const payload = {
      event,
      qid: qid || "",
      subject: subjectWithDev,
      correct: isCorrect,
      todayCount: stats.todayCount,
      totalCount: stats.total,
      accuracy: stats.acc,
      todayMinutes: getTodayMinutes(),
      deviceId: getDeviceLabel(),
    };
    fetch(PARENT_WEBHOOK_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch (_) {}
}

async function sha256Hex(str) {
  if (window.crypto && window.crypto.subtle) {
    const buf = new TextEncoder().encode(str);
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return "";
}

function setupAuthGate() {
  const gate = document.getElementById("authGate");
  if (!gate) return Promise.resolve();

  const saved = localStorage.getItem(AUTH_SESSION_KEY) || sessionStorage.getItem(AUTH_SESSION_KEY);
  if (saved === AUTH_HASH) {
    gate.style.display = "none";
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const form = document.getElementById("authForm");
    const input = document.getElementById("authInput");
    const remember = document.getElementById("authRemember");
    const err = document.getElementById("authError");
    setTimeout(() => input && input.focus(), 100);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const val = (input.value || "").trim();
      const h = await sha256Hex(val);
      if (h === AUTH_HASH) {
        if (remember && remember.checked) {
          localStorage.setItem(AUTH_SESSION_KEY, AUTH_HASH);
        } else {
          sessionStorage.setItem(AUTH_SESSION_KEY, AUTH_HASH);
        }
        gate.style.display = "none";
        resolve();
      } else {
        err.textContent = "パスワードが違います。もう一度入力してください。";
        input.value = "";
        input.focus();
      }
    });
  });
}

// =========================================================================
// 初期化
// =========================================================================
async function init() {
  await setupAuthGate();

  bindNavigation();
  bindExamControls();
  bindMockControls();
  bindLawControls();
  bindOxControls();
  bindCompareControls();
  bindDashboardControls();
  bindSecretParentTrigger();

  updateSidebarStats();

  // 第111回（最新）と法令パックを初期ロード
  await Promise.all([loadExamData(111), loadStudyPack()]);
  applyExamFilter();
  renderLawView();
  renderOxView();
  renderCompareView();
  renderDashboard();
  refreshMockDraftBanner();
  checkCloudMockDraft();

  // アプリ起動を静かに記録（URLに?report=papaがない通常利用時のみ）
  const params = new URLSearchParams(window.location.search);
  if (params.get("report") === "papa") {
    openParentModal();
  } else {
    recordActivity("open", "-", "アプリ起動", null);
  }
}

async function loadExamData(examNum) {
  if (state.examCache[examNum]) return state.examCache[examNum];
  const resp = await fetch(`./data/exams/exam_${examNum}.json?v=20261122b`);
  if (!resp.ok) throw new Error(`exam_${examNum}.json load failed`);
  const data = await resp.json();
  state.examCache[examNum] = data.questions || [];
  state.allLoadedExams.add(examNum);
  return state.examCache[examNum];
}

const ALL_EXAM_NUMS = [111, 110, 109, 108, 107, 106, 105, 104, 103, 102];

async function loadAllExams() {
  await Promise.all(ALL_EXAM_NUMS.map((n) => loadExamData(n)));
}

async function loadStudyPack() {
  if (state.studyPack) return state.studyPack;
  const resp = await fetch("./data/laws/study_pack.json?v=20261122m");
  if (!resp.ok) return null;
  state.studyPack = await resp.json();
  state.oxList = [...(state.studyPack.ox_questions || [])];
  return state.studyPack;
}

// =========================================================================
// ナビゲーション
// =========================================================================
function bindNavigation() {
  const allBtns = document.querySelectorAll("[data-view]");
  allBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-view");
      switchView(target);
    });
  });
}

function switchView(viewName) {
  if (viewName !== "law") stopLawAudio();
  state.currentView = viewName;
  document.querySelectorAll(".view-section").forEach((s) => s.classList.remove("active"));
  const el = document.getElementById(`view-${viewName}`);
  if (el) el.classList.add("active");

  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-view") === viewName);
  });

  if (viewName === "dashboard") {
    renderDashboard();
  }
  updateMockReturnBanners();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateSidebarStats() {
  const s = getOverallStats();
  document.getElementById("sideTodayCount").textContent = `${s.todayCount}問`;
  document.getElementById("sideAccuracy").textContent = s.total > 0 ? `${s.acc}%` : "-";
  document.getElementById("sideBookmarks").textContent = `${s.bookmarks}問`;
  document.getElementById("mobileTodayPill").textContent = `今日 ${s.todayCount}問`;
}

// =========================================================================
// 1. 過去問演習
// =========================================================================
function bindExamControls() {
  ["fExam", "fSection", "fSubject", "fStatus"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => applyExamFilter());
  });
  document.getElementById("fSearch").addEventListener("input", () => applyExamFilter());

  document.getElementById("btnShuffle").addEventListener("click", () => {
    shuffleArray(state.filteredQuestions);
    state.currentIndex = 0;
    renderCurrentQuestion();
  });

  document.getElementById("btnToggleChoiceShuffle").addEventListener("click", () => {
    state.shuffleChoices = !state.shuffleChoices;
    const btn = document.getElementById("btnToggleChoiceShuffle");
    btn.textContent = state.shuffleChoices ? "🔀 選択肢シャッフル：ON" : "🔀 選択肢シャッフル：OFF";
    btn.className = state.shuffleChoices ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm";
    renderCurrentQuestion();
  });

  document.getElementById("btnToggleFontSize").addEventListener("click", () => {
    state.largeFont = !state.largeFont;
    document.getElementById("questionCard").classList.toggle("font-large", state.largeFont);
    document.getElementById("btnToggleFontSize").textContent = state.largeFont ? "🔤 文字サイズ：大" : "🔤 文字サイズ：標準";
  });

  document.getElementById("btnTogglePdfImg").addEventListener("click", () => {
    state.pdfImgVisible = !state.pdfImgVisible;
    const imgBox = document.getElementById("qImages");
    const hasLead = imgBox.querySelectorAll(".js-lead-img").length > 0;
    imgBox.querySelectorAll(".js-body-img").forEach((el) => {
      el.style.display = state.pdfImgVisible ? "block" : "none";
    });
    imgBox.style.display = state.pdfImgVisible || hasLead ? "flex" : "none";
    document.getElementById("btnTogglePdfImg").textContent = state.pdfImgVisible ? "📄 試験用紙を隠す" : "📄 元の試験用紙を見る";
  });

  document.getElementById("btnResetFilter").addEventListener("click", () => {
    document.getElementById("fExam").value = "111";
    document.getElementById("fSection").value = "all";
    document.getElementById("fSubject").value = "all";
    document.getElementById("fStatus").value = "all";
    document.getElementById("fSearch").value = "";
    applyExamFilter();
  });

  // クイックスタート
  document.getElementById("qsHissu10").addEventListener("click", async () => {
    await loadAllExams();
    document.getElementById("fExam").value = "all";
    document.getElementById("fSection").value = "必須";
    document.getElementById("fSubject").value = "all";
    document.getElementById("fStatus").value = "all";
    document.getElementById("fSearch").value = "";
    await applyExamFilter();
    shuffleArray(state.filteredQuestions);
    state.filteredQuestions = state.filteredQuestions.slice(0, 10);
    state.currentIndex = 0;
    document.getElementById("examMatchCount").textContent = "必須ランダム10問チャレンジ中！";
    renderCurrentQuestion();
  });

  document.getElementById("qsLawAll").addEventListener("click", async () => {
    await loadAllExams();
    document.getElementById("fExam").value = "all";
    document.getElementById("fSection").value = "all";
    document.getElementById("fSubject").value = "法規・制度・倫理";
    document.getElementById("fStatus").value = "all";
    document.getElementById("fSearch").value = "";
    await applyExamFilter();
  });

  document.getElementById("qsWrongOnly").addEventListener("click", async () => {
    await loadAllExams();
    document.getElementById("fExam").value = "all";
    document.getElementById("fSection").value = "all";
    document.getElementById("fSubject").value = "all";
    document.getElementById("fStatus").value = "wrong";
    document.getElementById("fSearch").value = "";
    await applyExamFilter();
  });

  document.getElementById("qsLatest111").addEventListener("click", async () => {
    document.getElementById("fExam").value = "111";
    document.getElementById("fSection").value = "all";
    document.getElementById("fSubject").value = "all";
    document.getElementById("fStatus").value = "all";
    document.getElementById("fSearch").value = "";
    await applyExamFilter();
  });

  document.getElementById("btnSubmitAnswer").addEventListener("click", () => submitCurrentAnswer());
  document.getElementById("btnShowAnswer").addEventListener("click", () => revealCurrentAnswerOnly());

  document.getElementById("btnPrevQ").addEventListener("click", () => {
    if (state.currentIndex > 0) {
      state.currentIndex -= 1;
      renderCurrentQuestion();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  document.getElementById("btnNextQ").addEventListener("click", () => {
    if (state.currentIndex < state.filteredQuestions.length - 1) {
      state.currentIndex += 1;
      renderCurrentQuestion();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  document.getElementById("btnBookmark").addEventListener("click", () => {
    const q = state.filteredQuestions[state.currentIndex];
    if (!q) return;
    const next = !state.progress.bookmarks[q.id];
    if (next) state.progress.bookmarks[q.id] = true;
    else delete state.progress.bookmarks[q.id];
    saveProgress();
    updateBookmarkButton(q.id);
  });

  document.getElementById("qMemo").addEventListener("input", (e) => {
    const q = state.filteredQuestions[state.currentIndex];
    if (!q) return;
    const val = e.target.value;
    if (val.trim()) state.progress.memos[q.id] = val;
    else delete state.progress.memos[q.id];
    saveProgress();
  });

  // 画像拡大モーダル
  document.getElementById("btnCloseZoom").addEventListener("click", () => {
    document.getElementById("zoomModal").classList.remove("open");
  });
  document.getElementById("zoomModal").addEventListener("click", (e) => {
    if (e.target.id === "zoomModal") {
      document.getElementById("zoomModal").classList.remove("open");
    }
  });
}

async function applyExamFilter() {
  const fExam = document.getElementById("fExam").value;
  const fSection = document.getElementById("fSection").value;
  const fSubject = document.getElementById("fSubject").value;
  const fStatus = document.getElementById("fStatus").value;
  const keyword = document.getElementById("fSearch").value.trim().toLowerCase();

  let pool = [];
  if (fExam === "all") {
    await loadAllExams();
    pool = ALL_EXAM_NUMS.flatMap((n) => state.examCache[n] || []);
  } else {
    pool = await loadExamData(Number(fExam));
  }

  state.filteredQuestions = pool.filter((q) => {
    if (fSection !== "all" && q.section !== fSection) return false;
    if (fSubject !== "all" && q.subject !== fSubject) return false;
    if (fStatus === "unanswered" && state.progress.answers[q.id]) return false;
    if (fStatus === "wrong") {
      const a = state.progress.answers[q.id];
      if (!a || a.correct) return false;
    }
    if (fStatus === "bookmarked" && !state.progress.bookmarks[q.id]) return false;
    if (keyword) {
      const hay = `${q.text} ${q.subject} 第${q.exam}回 問${q.q_no}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });

  state.currentIndex = 0;
  document.getElementById("examMatchCount").textContent = `該当：${state.filteredQuestions.length} 問`;
  renderCurrentQuestion();
}

function renderCurrentQuestion() {
  clearInterval(state.timerHandle);
  state.selectedChoices.clear();
  state.answeredCurrent = false;

  const card = document.getElementById("questionCard");
  const q = state.filteredQuestions[state.currentIndex];

  if (!q) {
    document.getElementById("qBadges").innerHTML = "";
    document.getElementById("qImages").innerHTML =
      `<div style="text-align:center; padding:32px 12px; color:var(--text-sub);">
        条件に一致する問題がありません。<br>絞り込み条件をリセットしてお試しください。
      </div>`;
    document.getElementById("qChoices").innerHTML = "";
    document.getElementById("qSelectHint").textContent = "";
    document.getElementById("qJudgeBox").style.display = "none";
    document.getElementById("qPagerInfo").textContent = "0 / 0";
    return;
  }

  // タイマー開始
  state.timerSec = 0;
  updateTimerLabel();
  state.timerHandle = setInterval(() => {
    state.timerSec += 1;
    updateTimerLabel();
  }, 1000);

  // バッジ
  const prevAns = state.progress.answers[q.id];
  const prevBadge = prevAns
    ? prevAns.correct
      ? `<span class="badge" style="background:#d1fae5;color:#065f46;">前回 ○</span>`
      : `<span class="badge" style="background:#fee2e2;color:#991b1b;">前回 ×</span>`
    : "";

  document.getElementById("qBadges").innerHTML = `
    <span class="badge badge-exam">第${q.exam}回 問${q.q_no}</span>
    <span class="badge badge-sec">${q.section}問題</span>
    <span class="badge badge-subj">${q.subject}</span>
    ${q.select_count > 1 ? `<span class="badge badge-multi">${q.select_count}つ選択</span>` : ""}
    ${prevBadge}
  `;

  updateBookmarkButton(q.id);

  // 画像・テキスト表示モード切替
  // 問題本体に図表がある場合は二重表示を防ぐため画像モード(1〜5)に統一。
  // 連問の共通リード文(lead_*.jpg)のみの場合はリード文画像を上に表示し、問題本体はテキスト＋1〜5シャッフルでスッキリ表示！
  const leadImgs = (q.images || []).filter((src) => src.includes("lead_"));
  const bodyImgs = (q.images || []).filter((src) => !src.includes("lead_"));
  const hasNonLeadFigure = Boolean(q.show_img_alongside && !q.has_lead);
  const useTextMode = Boolean(q.can_shuffle && q.stem && q.choices && q.choices.length > 0 && !hasNonLeadFigure);
  const stemBox = document.getElementById("qStemBox");
  const imgBox = document.getElementById("qImages");
  const pdfToggleBtn = document.getElementById("btnTogglePdfImg");

  imgBox.innerHTML = "";
  const appendImgWrap = (src, isLead, extraClass = "") => {
    const wrap = document.createElement("div");
    wrap.className = `q-img-wrap ${extraClass}`.trim();
    if (isLead) {
      const tag = document.createElement("div");
      tag.className = "lead-tag";
      tag.textContent = "📌 共通の症例・処方箋・リード文（タップで拡大）";
      wrap.appendChild(tag);
    }
    const img = document.createElement("img");
    img.src = `./${src}`;
    img.alt = `第${q.exam}回 問${q.q_no}`;
    img.loading = "eager";
    img.addEventListener("click", () => {
      document.getElementById("zoomImgTarget").src = img.src;
      document.getElementById("zoomModal").classList.add("open");
    });
    wrap.appendChild(img);
    imgBox.appendChild(wrap);
  };

  if (useTextMode) {
    // 共通リード文は常に表示し、元の問題本体画像（選択肢が重複して写っている画像）はトグル表示
    leadImgs.forEach((src) => appendImgWrap(src, true, "js-lead-img"));
    bodyImgs.forEach((src) => appendImgWrap(src, false, "js-body-img"));
    stemBox.style.display = "block";
    stemBox.textContent = q.stem;
    state.pdfImgVisible = false;
    imgBox.querySelectorAll(".js-body-img").forEach((el) => (el.style.display = "none"));
    imgBox.style.display = leadImgs.length > 0 ? "flex" : "none";
    pdfToggleBtn.style.display = "inline-flex";
    pdfToggleBtn.textContent = "📄 元の試験用紙を見る";
  } else {
    (q.images || []).forEach((src) => appendImgWrap(src, src.includes("lead_")));
    stemBox.style.display = "none";
    state.pdfImgVisible = true;
    imgBox.style.display = "flex";
    pdfToggleBtn.style.display = "none";
  }

  // 選択肢ボタン（すべて 1〜5 に統一）
  const hint = document.getElementById("qSelectHint");
  if (q.multi_mode === "none") {
    hint.textContent = "※この問題は公式発表により「採点除外・解なし」となっています。";
  } else if (useTextMode) {
    const shufNote = state.shuffleChoices ? "（順番シャッフル中）" : "";
    hint.textContent =
      q.select_count > 1
        ? `選択肢から ${q.select_count}つ 選んで「解答を確定する」を押してください ${shufNote}`
        : `選択肢から 1つ 選んで「解答を確定する」を押してください ${shufNote}`;
  } else {
    hint.textContent =
      (q.select_count > 1
        ? `選択肢から ${q.select_count}つ 選んでください`
        : "選択肢から 1つ 選んでください") +
      " ※画像タップで拡大できます";
  }

  const choicesEl = document.getElementById("qChoices");
  choicesEl.innerHTML = "";
  if (useTextMode) {
    choicesEl.className = "choices-cards";
    const list = q.choices.map((c) => ({ ...c }));
    if (state.shuffleChoices) {
      shuffleArray(list);
    }
    list.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice-card-btn";
      btn.dataset.choice = String(item.orig);
      const label = state.shuffleChoices ? String(idx + 1) : String(item.orig);
      btn.innerHTML = `<span class="choice-label-badge">${label}</span><span>${escapeHtml(item.text)}</span>`;
      btn.addEventListener("click", () => toggleChoice(item.orig, q.select_count));
      choicesEl.appendChild(btn);
    });
  } else {
    choicesEl.className = "choices-bar";
    const numChoices = Math.max(5, q.max_choice || 5);
    for (let c = 1; c <= numChoices; c++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice-btn";
      btn.textContent = String(c);
      btn.dataset.choice = String(c);
      btn.addEventListener("click", () => toggleChoice(c, q.select_count));
      choicesEl.appendChild(btn);
    }
  }

  document.getElementById("qJudgeBox").style.display = "none";
  document.getElementById("qMemo").value = state.progress.memos[q.id] || "";
  document.getElementById("qPagerInfo").textContent = `${state.currentIndex + 1} / ${state.filteredQuestions.length}`;
}

function toggleChoice(choiceNum, maxSelect) {
  if (state.answeredCurrent) return;
  if (maxSelect === 1) {
    state.selectedChoices.clear();
    state.selectedChoices.add(choiceNum);
  } else {
    if (state.selectedChoices.has(choiceNum)) {
      state.selectedChoices.delete(choiceNum);
    } else {
      if (state.selectedChoices.size >= maxSelect) {
        const first = state.selectedChoices.values().next().value;
        state.selectedChoices.delete(first);
      }
      state.selectedChoices.add(choiceNum);
    }
  }
  document.querySelectorAll("#qChoices button[data-choice]").forEach((btn) => {
    const c = Number(btn.dataset.choice);
    btn.classList.toggle("selected", state.selectedChoices.has(c));
  });
}

function submitCurrentAnswer() {
  const q = state.filteredQuestions[state.currentIndex];
  if (!q) return;
  if (q.multi_mode === "none") {
    revealCurrentAnswerOnly();
    return;
  }
  if (state.selectedChoices.size === 0) {
    alert("選択肢を選んでください！");
    return;
  }
  if (q.select_count > 1 && state.selectedChoices.size < q.select_count) {
    alert(`この問題は ${q.select_count}つ 選択してください。`);
    return;
  }

  clearInterval(state.timerHandle);
  state.answeredCurrent = true;

  const chosen = [...state.selectedChoices].sort((a, b) => a - b);
  const official = [...(q.answers || [])].sort((a, b) => a - b);

  let isCorrect = false;
  if (q.multi_mode === "any") {
    isCorrect = chosen.every((c) => official.includes(c));
  } else {
    isCorrect = chosen.length === official.length && chosen.every((c, i) => c === official[i]);
  }

  // ボタン色付け
  document.querySelectorAll("#qChoices button[data-choice]").forEach((btn) => {
    const c = Number(btn.dataset.choice);
    btn.classList.remove("selected");
    if (official.includes(c)) btn.classList.add("correct");
    else if (chosen.includes(c)) btn.classList.add("wrong");
  });

  const box = document.getElementById("qJudgeBox");
  box.style.display = "block";
  box.className = `judge-box ${isCorrect ? "ok" : "ng"}`;
  box.innerHTML =
    (isCorrect
      ? `🎉 <strong>正解！</strong>（公式正答番号：${official.join("・")}）${q.note ? `<br><small>${q.note}</small>` : ""}`
      : `❌ <strong>不正解</strong>　<strong>公式正答番号：${official.join("・")}</strong>（緑色の選択肢が正解です）${q.note ? `<br><small>${q.note}</small>` : ""}`) +
    buildExplainHelperHtml(q, official);
  bindExplainHelperButtons(box, q, official);

  // 進捗保存＆裏ログ送信
  state.progress.answers[q.id] = {
    correct: isCorrect,
    chosen,
    subject: q.subject,
    ts: Date.now(),
  };
  recordActivity("answer", q.id, q.subject, isCorrect);
}

function revealCurrentAnswerOnly() {
  const q = state.filteredQuestions[state.currentIndex];
  if (!q) return;
  const official = [...(q.answers || [])].sort((a, b) => a - b);
  document.querySelectorAll("#qChoices button[data-choice]").forEach((btn) => {
    const c = Number(btn.dataset.choice);
    if (official.includes(c)) btn.classList.add("correct");
  });
  const box = document.getElementById("qJudgeBox");
  box.style.display = "block";
  box.className = "judge-box info";
  box.innerHTML =
    (q.multi_mode === "none"
      ? `ℹ️ <strong>${q.note || "採点除外・解なし"}</strong>`
      : `📖 <strong>公式正答：${official.join("・")}</strong>${q.note ? `<br><small>${q.note}</small>` : ""}`) +
    buildExplainHelperHtml(q, official);
  bindExplainHelperButtons(box, q, official);
}

function buildExplainHelperHtml(q, official) {
  const searchQuery = encodeURIComponent(`第${q.exam}回 薬剤師国家試験 問${q.q_no} 解説`);
  const searchUrl = `https://www.google.com/search?q=${searchQuery}`;
  const lawJumpBtn = q.subject.includes("法規")
    ? `<button type="button" class="btn btn-secondary btn-sm js-jump-law">⚖️ 関連する最新条文を確認</button>`
    : "";
  return `
    <div style="margin-top:10px; padding-top:10px; border-top:1px dashed rgba(0,0,0,0.15); display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
      <a href="${searchUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" style="text-decoration:none;">
        🔍 詳しい解説を見る（解説サイト検索）
      </a>
      <button type="button" class="btn btn-secondary btn-sm js-copy-ai-prompt">
        🤖 AI解説用の質問をコピー
      </button>
      ${lawJumpBtn}
    </div>
  `;
}

function bindExplainHelperButtons(container, q, official) {
  const copyBtn = container.querySelector(".js-copy-ai-prompt");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const promptText = `日本の薬剤師国家試験の先生として、以下の過去問をわかりやすく解説してください。\n・正解（${official.join("・")}）がなぜ正しいか\n・他の選択肢がなぜ誤りか\n・試験で覚えるべき重要ポイント\n\n【第${q.exam}回 問${q.q_no}（${q.subject}）】\n${q.text || q.snippet}`;
      try {
        await navigator.clipboard.writeText(promptText);
        copyBtn.textContent = "✅ コピーしました！（AIに貼り付けOK）";
        setTimeout(() => (copyBtn.textContent = "🤖 AI解説用の質問をコピー"), 2500);
      } catch (_) {
        prompt("以下をコピーしてAIに貼り付けてください：", promptText);
      }
    });
  }
  const lawBtn = container.querySelector(".js-jump-law");
  if (lawBtn) {
    lawBtn.addEventListener("click", () => {
      const txt = q.text || "";
      if (txt.includes("麻薬") || txt.includes("向精神薬")) state.activeLawIdx = 2;
      else if (txt.includes("毒物") || txt.includes("劇物")) state.activeLawIdx = 3;
      else if (txt.includes("薬剤師法") || txt.includes("調剤録")) state.activeLawIdx = 0;
      else state.activeLawIdx = 1;
      switchView("law");
      renderLawView();
    });
  }
}

function updateBookmarkButton(qid) {
  const btn = document.getElementById("btnBookmark");
  const active = Boolean(state.progress.bookmarks[qid]);
  btn.classList.toggle("active", active);
  btn.textContent = active ? "★ 要復習マーク中" : "☆ 要復習";
}

function updateTimerLabel() {
  const m = String(Math.floor(state.timerSec / 60)).padStart(2, "0");
  const s = String(state.timerSec % 60).padStart(2, "0");
  document.getElementById("qTimer").textContent = `⏱ ${m}:${s}`;
}

// =========================================================================
// 2. 法律・赤シート暗記
// =========================================================================
function bindLawControls() {
  document.getElementById("btnToggleRedSheet").addEventListener("click", () => {
    state.redSheetOn = !state.redSheetOn;
    const btn = document.getElementById("btnToggleRedSheet");
    const list = document.getElementById("lawArticlesList");
    btn.textContent = state.redSheetOn ? "赤シート：ON（暗記モード）" : "赤シート：OFF（閲覧モード）";
    btn.className = state.redSheetOn ? "btn btn-danger btn-sm" : "btn btn-secondary btn-sm";
    list.classList.toggle("redsheet-on", state.redSheetOn);
  });

  document.getElementById("btnResetCloze").addEventListener("click", () => {
    document.querySelectorAll("#lawArticlesList .cloze.revealed").forEach((el) => {
      el.classList.remove("revealed");
    });
    document.querySelectorAll("#lawArticlesList .article-point-box.point-open").forEach((el) => {
      el.classList.remove("point-open");
    });
    document.querySelectorAll("#lawArticlesList .js-point-toggle-btn").forEach((btn) => {
      btn.textContent = "💡 暗記ポイント・ひっかけを見る ▼";
    });
  });

  document.getElementById("lawSearch").addEventListener("input", () => {
    stopLawAudio();
    renderLawArticles();
  });

  const sortBtn = document.getElementById("btnLawSort");
  if (sortBtn) {
    sortBtn.addEventListener("click", () => {
      stopLawAudio();
      state.lawSort = state.lawSort === "order" ? "freq" : "order";
      sortBtn.textContent = state.lawSort === "freq" ? "🔥 よく出る順" : "📖 条文順";
      sortBtn.className = state.lawSort === "freq" ? "btn btn-accent btn-sm" : "btn btn-secondary btn-sm";
      renderLawArticles();
    });
  }

  const speedBtn = document.getElementById("btnLawSpeed");
  if (speedBtn) {
    const rates = [1.0, 1.25, 1.5, 0.85];
    speedBtn.addEventListener("click", () => {
      const nextIdx = (rates.indexOf(state.lawAudioRate) + 1) % rates.length;
      state.lawAudioRate = rates[nextIdx];
      speedBtn.textContent = `速度：${state.lawAudioRate.toFixed(2).replace(/\.00$/, ".0")}x`;
    });
  }

  const playAllBtn = document.getElementById("btnLawPlayAll");
  if (playAllBtn) {
    playAllBtn.addEventListener("click", () => startLawPlayAll());
  }

  const stopBtn = document.getElementById("btnLawStopAudio");
  if (stopBtn) {
    stopBtn.addEventListener("click", () => stopLawAudio());
  }

  const lawFontBtn = document.getElementById("btnLawFontSize");
  if (lawFontBtn) {
    lawFontBtn.addEventListener("click", () => {
      state.largeFont = !state.largeFont;
      document.getElementById("lawArticlesList").classList.toggle("law-font-large", state.largeFont);
      document.getElementById("questionCard").classList.toggle("font-large", state.largeFont);
      const mockCard = document.getElementById("mockQuestionCard");
      if (mockCard) mockCard.classList.toggle("font-large", state.largeFont);
      const lbl = state.largeFont ? "🔤 文字サイズ：大" : "🔤 文字サイズ：標準";
      lawFontBtn.textContent = lbl;
      document.getElementById("btnToggleFontSize").textContent = lbl;
      const mf = document.getElementById("btnMockFont");
      if (mf) mf.textContent = lbl;
    });
  }

  const backLawBtn = document.getElementById("btnBackToLawArticle");
  if (backLawBtn) {
    backLawBtn.addEventListener("click", () => {
      const target = state.lawReturnTarget;
      state.lawReturnTarget = null;
      const bar = document.getElementById("lawReturnBar");
      if (bar) bar.classList.remove("open");
      switchView("law");
      if (target && typeof target.artIdx === "number") {
        setTimeout(() => {
          const el = document.querySelector(`.article-card[data-law-idx="${target.artIdx}"]`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("speaking");
            setTimeout(() => el.classList.remove("speaking"), 1600);
          }
        }, 120);
      }
    });
  }
}

// 音声読み上げ専用の薬学・法令ふりがな辞書（画面表示は変えず、耳の読み上げだけを正確に補正）
const LAW_SPEECH_DICT = [
  ["薬機法", "やっきほう"],
  ["麻向法", "まこうほう"],
  ["毒劇法", "どくげきほう"],
  ["薬剤師法", "やくざいしほう"],
  ["医療法", "いりょうほう"],
  ["日本薬局方", "にほんやっきょくほう"],
  ["薬事衛生", "やくじえいせい"],
  ["薬事", "やくじ"],
  ["薬学的知見", "やくがくてきちけん"],
  ["薬局開設者", "やっきょくかいせつしゃ"],
  ["薬局医薬品", "やっきょくいやくひん"],
  ["要指導医薬品", "ようしどういやくひん"],
  ["一般用医薬品", "いっぱんよういやくひん"],
  ["処方箋医薬品", "しょほうせんいやくひん"],
  ["医薬部外品", "いやくぶがいひん"],
  ["特定生物由来製品", "とくていせいぶつゆらいせいひん"],
  ["生物由来製品", "せいぶつゆらいせいひん"],
  ["再生医療等製品", "さいせいいりょうとうせいひん"],
  ["地域連携薬局", "ちいきれんけいやっきょく"],
  ["専門医療機関連携薬局", "せんもんいりょうきかんれんけいやっきょく"],
  ["処方箋", "しょほうせん"],
  ["処方せん", "しょほうせん"],
  ["調剤録", "ちょうざいろく"],
  ["調剤済み", "ちょうざいずみ"],
  ["調剤", "ちょうざい"],
  ["被包", "ひほう"],
  ["施用", "しよう"],
  ["譲渡し", "ゆずりわたし"],
  ["譲受け", "ゆずりうけ"],
  ["譲渡証", "じょうとしょう"],
  ["譲受証", "じょうじゅしょう"],
  ["譲渡", "じょうと"],
  ["譲受", "じょうじゅ"],
  ["欠格事由", "けっかくじゆう"],
  ["欠格", "けっかく"],
  ["毒物劇物取扱責任者", "どくぶつげきぶつとりあつかいせきにんしゃ"],
  ["特定毒物", "とくていどくぶつ"],
  ["毒物", "どくぶつ"],
  ["劇物", "げきぶつ"],
  ["毒薬", "どくやく"],
  ["劇薬", "げきやく"],
  ["向精神薬", "こうせいしんやく"],
  ["覚醒剤", "かくせいざい"],
  ["麻薬元卸売業者", "まやくもとおろしうりぎょうしゃ"],
  ["麻薬卸売業者", "まやくおろしうりぎょうしゃ"],
  ["麻薬小売業者", "まやくこうりぎょうしゃ"],
  ["麻薬輸入業者", "まやくゆにゅうぎょうしゃ"],
  ["麻薬輸出業者", "まやくゆしゅつぎょうしゃ"],
  ["麻薬製造業者", "まやくせいぞうぎょうしゃ"],
  ["麻薬製剤業者", "まやくせいざいぎょうしゃ"],
  ["麻薬施用者", "まやくしようしゃ"],
  ["麻薬管理者", "まやくかんりしゃ"],
  ["麻薬研究者", "まやくけんきゅうしゃ"],
  ["麻薬取締員", "まやくとりしまりいん"],
  ["麻薬", "まやく"],
  ["記名押印", "きめいおういん"],
  ["疑義", "ぎぎ"],
  ["応需", "おうじゅ"],
  ["居宅", "きょたく"],
  ["専属", "せんぞく"],
  ["専任", "せんにん"],
  ["戒告", "かいこく"],
  ["滅失", "めっしつ"],
  ["盗取", "とうしゅ"],
  ["封かん証紙", "ふうかんしょうし"],
  ["公衆衛生", "こうしゅうえいせい"],
  ["保健衛生", "ほけんえいせい"],
  ["医療提供施設", "いりょうていきょうしせつ"],
  ["地域医療支援病院", "ちいきいりょうしえんびょういん"],
  ["特定機能病院", "とくていきのうびょういん"],
  ["臨床研究中核病院", "りんしょうけんきゅうちゅうかくびょういん"],
  ["介護老人保健施設", "かいごろうじんほけんしせつ"],
  ["前項", "ぜんこう"],
  ["前条", "ぜんじょう"],
  ["各号", "かくごう"],
  ["別表", "べっぴょう"],
  ["政令", "せいれい"],
  ["省令", "しょうれい"],
  ["厚生労働省令", "こうせいろうどうしょうれい"],
  // 法律文特有の大きい「つ」（促音）を読みやすく補正
  ["よつて", "よって"],
  ["あつて", "あって"],
  ["従つて", "したがって"],
  ["行つた", "おこなった"],
  ["行つて", "おこなって"],
  ["もつて", "もって"],
  ["限つて", "かぎって"],
  ["なつた", "なった"],
  ["なつて", "なって"],
  ["当たつて", "あたって"],
  ["当たつた", "あたった"],
  ["あたらず", "あたらず"],
];

function normalizeLawSpeechText(rawText) {
  let text = String(rawText || "");
  for (const [src, reading] of LAW_SPEECH_DICT) {
    text = text.split(src).join(reading);
  }
  // 改行を自然な一息に
  text = text.replace(/\n+/g, "。");
  return text;
}

function getJapaneseVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  // より自然な日本語音声を優先選択
  const jpVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("ja"));
  return (
    jpVoices.find((v) => /Nanami|Kyoko|O-Ren|Google 日本語/i.test(v.name)) ||
    jpVoices[0] ||
    null
  );
}

function stopLawAudio() {
  state.lawAudioActive = false;
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (_) {}
  }
  document.querySelectorAll(".article-card.speaking").forEach((el) => el.classList.remove("speaking"));
  const playBtn = document.getElementById("btnLawPlayAll");
  const stopBtn = document.getElementById("btnLawStopAudio");
  if (playBtn) playBtn.style.display = "inline-flex";
  if (stopBtn) stopBtn.style.display = "none";
}

function speakLawIndex(idx, continuous) {
  if (!("speechSynthesis" in window)) {
    alert("お使いのブラウザは音声読み上げに対応していません。");
    return;
  }
  const entry = state.lawShownList[idx];
  if (!entry) {
    stopLawAudio();
    return;
  }

  try {
    window.speechSynthesis.cancel();
  } catch (_) {}

  state.lawAudioActive = true;
  const playBtn = document.getElementById("btnLawPlayAll");
  const stopBtn = document.getElementById("btnLawStopAudio");
  if (playBtn) playBtn.style.display = "none";
  if (stopBtn) stopBtn.style.display = "inline-flex";

  document.querySelectorAll(".article-card.speaking").forEach((el) => el.classList.remove("speaking"));
  const cardEl = document.querySelector(`.article-card[data-law-idx="${idx}"]`);
  if (cardEl) {
    cardEl.classList.add("speaking");
    cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const { lawShort, art } = entry;
  const tagsSpoken = (art.point_tags || []).length ? `。暗記ワード。${art.point_tags.join("、")}` : "";
  const trapSpoken = art.point_trap ? `。注意。${art.point_trap}` : "";
  const rawSpeechText = `${lawShort}、${art.title}、${(art.caption || "").replace(/[（）()]/g, "")}。${art.body}${tagsSpoken}${trapSpoken}`;
  const speechText = normalizeLawSpeechText(rawSpeechText);
  const utter = new SpeechSynthesisUtterance(speechText);
  utter.lang = "ja-JP";
  utter.rate = state.lawAudioRate || 1.0;
  const jpVoice = getJapaneseVoice();
  if (jpVoice) utter.voice = jpVoice;

  utter.onend = () => {
    if (!state.lawAudioActive) return;
    if (continuous && idx + 1 < state.lawShownList.length) {
      speakLawIndex(idx + 1, true);
    } else {
      stopLawAudio();
    }
  };
  utter.onerror = () => {
    stopLawAudio();
  };
  window.speechSynthesis.speak(utter);
}

function startLawPlayAll() {
  if (!state.lawShownList || state.lawShownList.length === 0) return;
  speakLawIndex(0, true);
}

async function openRelatedPastQuestions(qids, label, artIdx) {
  if (!qids || qids.length === 0) return;
  stopLawAudio();
  await loadAllExams();
  const qSet = new Set(qids);
  const pool = ALL_EXAM_NUMS.flatMap((n) => state.examCache[n] || []);
  const matched = pool.filter((q) => qSet.has(q.id));
  if (!matched.length) {
    alert("該当する過去問が見つかりませんでした。");
    return;
  }
  state.filteredQuestions = matched;
  state.currentIndex = 0;
  state.lawReturnTarget = { label, artIdx };
  const bar = document.getElementById("lawReturnBar");
  const txt = document.getElementById("lawReturnText");
  if (txt) txt.textContent = `⚖️ 「${label}」の関連過去問（${matched.length}問）を学習中`;
  if (bar) bar.classList.add("open");
  document.getElementById("examMatchCount").textContent = `⚖️ ${label} の関連過去問（${matched.length}問）`;
  switchView("exam");
  switchExamSubMode("practice");
  renderCurrentQuestion();
}

function renderLawView() {
  stopLawAudio();
  const statutes = state.studyPack?.statutes || [];
  const tabs = document.getElementById("lawTabs");
  tabs.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.className = `tab-pill ${state.activeLawIdx === -1 ? "active" : ""}`;
  allBtn.textContent = `すべて（横断検索）`;
  allBtn.addEventListener("click", () => {
    state.activeLawIdx = -1;
    renderLawView();
  });
  tabs.appendChild(allBtn);

  statutes.forEach((law, idx) => {
    const btn = document.createElement("button");
    btn.className = `tab-pill ${idx === state.activeLawIdx ? "active" : ""}`;
    btn.textContent = `${law.short}（${law.articles.length}条）`;
    btn.addEventListener("click", () => {
      state.activeLawIdx = idx;
      renderLawView();
    });
    tabs.appendChild(btn);
  });
  renderLawArticles();
}

function renderLawArticles() {
  const statutes = state.studyPack?.statutes || [];
  const container = document.getElementById("lawArticlesList");
  if (!statutes.length) {
    container.innerHTML = "<p>法令データを読み込み中です...</p>";
    return;
  }

  const kw = document.getElementById("lawSearch").value.trim();
  const targetLaws = state.activeLawIdx === -1 ? statutes : [statutes[state.activeLawIdx]].filter(Boolean);

  const matched = [];
  targetLaws.forEach((law) => {
    law.articles.forEach((art) => {
      if (!kw || `${law.name} ${law.short} ${art.title} ${art.caption} ${art.body}`.includes(kw)) {
        matched.push({ lawShort: law.short, art });
      }
    });
  });

  if (state.lawSort === "freq") {
    matched.sort((a, b) => (b.art.exam_count || 0) - (a.art.exam_count || 0));
  }

  const shown = matched.slice(0, 90);
  state.lawShownList = shown;
  container.innerHTML = "";
  if (shown.length === 0) {
    container.innerHTML = `<div class="card">該当する条文が見つかりません。別のキーワードでお試しください。</div>`;
    return;
  }

  const countNote = document.createElement("div");
  countNote.style.cssText = "font-size:12px; font-weight:700; color:var(--text-sub); margin-bottom:10px;";
  countNote.textContent = `該当条文：${matched.length}件（${state.lawSort === "freq" ? "過去10年よく出る順" : "条文順"}）`;
  container.appendChild(countNote);

  shown.forEach(({ lawShort, art }, idx) => {
    const div = document.createElement("div");
    div.className = "article-card";
    div.dataset.lawIdx = String(idx);
    const bodyHtml = highlightClozeHtml(escapeHtml(art.body), art.keywords || []);
    const cnt = art.exam_count || 0;
    const freqBadge =
      cnt >= 5
        ? `<span class="badge badge-hot">🔥 過去10年で${cnt}問出題</span>`
        : cnt > 0
        ? `<span class="badge badge-seen">📌 過去10年で${cnt}問出題</span>`
        : "";
    const pastBtn =
      cnt > 0
        ? `<button type="button" class="btn btn-secondary btn-sm js-law-past-q">📝 関連過去問(${cnt}問)</button>`
        : "";

    const tags = art.point_tags || [];
    const trap = art.point_trap || "";
    const pointHtml =
      tags.length > 0 || trap
        ? `<div class="article-point-toggle">
            <button type="button" class="btn btn-secondary btn-sm js-point-toggle-btn">💡 暗記ポイント・ひっかけを見る ▼</button>
          </div>
          <div class="article-point-box">
            ${
              tags.length > 0
                ? `<div class="article-point-tags">
                    <span style="font-weight:800; color:#b45309; font-size:12px;">🎯 暗記ワード・数字</span>
                    ${tags.map((t) => `<span class="point-chip">${escapeHtml(t)}</span>`).join("")}
                  </div>`
                : ""
            }
            ${trap ? `<div class="article-point-trap">⚠️ ${escapeHtml(trap)}</div>` : ""}
          </div>`
        : "";

    div.innerHTML = `
      <div class="article-head">
        <div class="article-head-left">
          <span class="badge badge-subj">${escapeHtml(lawShort)}</span>
          <span class="article-title">${escapeHtml(art.title)}</span>
          <span class="article-caption">${escapeHtml(art.caption || "")}</span>
          ${freqBadge}
        </div>
        <div class="article-head-right">
          <button type="button" class="btn btn-secondary btn-sm js-law-speak">🔊 読む</button>
          ${pastBtn}
        </div>
      </div>
      <div class="article-body">${bodyHtml}</div>
      ${pointHtml}
    `;
    div.querySelectorAll(".cloze").forEach((span) => {
      span.addEventListener("click", () => span.classList.toggle("revealed"));
    });
    const ptBtn = div.querySelector(".js-point-toggle-btn");
    const ptBox = div.querySelector(".article-point-box");
    if (ptBtn && ptBox) {
      ptBtn.addEventListener("click", () => {
        const opened = ptBox.classList.toggle("point-open");
        ptBtn.textContent = opened ? "▲ 暗記ポイントを隠す" : "💡 暗記ポイント・ひっかけを見る ▼";
      });
    }
    div.querySelector(".js-law-speak").addEventListener("click", () => {
      speakLawIndex(idx, false);
    });
    const pastQBtn = div.querySelector(".js-law-past-q");
    if (pastQBtn) {
      pastQBtn.addEventListener("click", () => {
        openRelatedPastQuestions(art.related_qids || [], `${lawShort} ${art.title}`, idx);
      });
    }
    container.appendChild(div);
  });
}

function highlightClozeHtml(escapedText, keywords) {
  if (!keywords || keywords.length === 0) return escapedText;
  const sorted = [...keywords].sort((a, b) => b.length - a.length).map((k) => escapeRegExp(escapeHtml(k)));
  const re = new RegExp(`(${sorted.join("|")})`, "g");
  return escapedText.replace(re, `<span class="cloze" title="タップで表示">$1</span>`);
}

// =========================================================================
// 3. 一問一答・○×スピード演習
// =========================================================================
function bindOxControls() {
  document.getElementById("btnOxTrue").addEventListener("click", () => answerOx(true));
  document.getElementById("btnOxFalse").addEventListener("click", () => answerOx(false));

  document.getElementById("btnOxPrev").addEventListener("click", () => {
    if (state.oxIndex > 0) {
      state.oxIndex -= 1;
      renderOxCard();
    }
  });
  document.getElementById("btnOxNext").addEventListener("click", () => {
    if (state.oxIndex < state.oxList.length - 1) {
      state.oxIndex += 1;
      renderOxCard();
    }
  });
  document.getElementById("btnOxShuffle").addEventListener("click", () => {
    shuffleArray(state.oxList);
    state.oxIndex = 0;
    renderOxCard();
  });
}

function renderOxView() {
  const all = state.studyPack?.ox_questions || [];
  const cats = ["すべて", ...new Set(all.map((q) => q.category))];
  const tabs = document.getElementById("oxCategoryTabs");
  tabs.innerHTML = "";
  cats.forEach((cat) => {
    const btn = document.createElement("button");
    btn.className = `tab-pill ${cat === state.oxCategory ? "active" : ""}`;
    btn.textContent = cat;
    btn.addEventListener("click", () => {
      state.oxCategory = cat;
      state.oxList = cat === "すべて" ? [...all] : all.filter((q) => q.category === cat);
      state.oxIndex = 0;
      renderOxView();
    });
    tabs.appendChild(btn);
  });
  renderOxCard();
}

function renderOxCard() {
  state.oxAnswered = false;
  const q = state.oxList[state.oxIndex];
  if (!q) return;
  document.getElementById("oxCatBadge").textContent = q.category;
  document.getElementById("oxProgress").textContent = `${state.oxIndex + 1} / ${state.oxList.length}`;
  document.getElementById("oxStatement").textContent = q.statement;
  document.getElementById("oxResultBox").style.display = "none";
}

function answerOx(choiceBool) {
  const q = state.oxList[state.oxIndex];
  if (!q) return;
  const isCorrect = choiceBool === q.answer;
  const box = document.getElementById("oxResultBox");
  box.style.display = "block";
  box.className = `judge-box ${isCorrect ? "ok" : "ng"}`;
  box.innerHTML = `
    <div style="font-size:16px; margin-bottom:6px;">
      ${isCorrect ? "🎉 正解！" : "❌ 不正解…"}（答え：${q.answer ? "⭕ 正しい" : "❌ 誤り"}）
    </div>
    <div>${escapeHtml(q.explanation)}</div>
    <div style="margin-top:6px; font-size:12px; opacity:0.85;">根拠：${escapeHtml(q.ref)}</div>
  `;
  if (!state.oxAnswered) {
    state.oxAnswered = true;
    recordActivity("ox_answer", q.id, `○×:${q.category}`, isCorrect);
  }
}

// =========================================================================
// 4. 紛らわしい比較表
// =========================================================================
function bindCompareControls() {
  document.getElementById("btnToggleCmpMask").addEventListener("click", () => {
    state.cmpMaskOn = !state.cmpMaskOn;
    const btn = document.getElementById("btnToggleCmpMask");
    btn.textContent = state.cmpMaskOn ? "隠してテスト：ON" : "隠してテスト：OFF";
    btn.className = state.cmpMaskOn ? "btn btn-danger btn-sm" : "btn btn-secondary btn-sm";
    document.querySelectorAll(".cmp-table").forEach((t) => {
      t.classList.toggle("cmp-mask-on", state.cmpMaskOn);
      t.querySelectorAll("td.cell-open").forEach((td) => td.classList.remove("cell-open"));
    });
  });
}

function renderCompareView() {
  const tables = state.studyPack?.comparison_tables || [];
  const container = document.getElementById("compareContainer");
  container.innerHTML = "";
  tables.forEach((tbl) => {
    const card = document.createElement("div");
    card.className = "card";
    const ths = tbl.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
    const trs = tbl.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
      .join("");
    card.innerHTML = `
      <h3 style="margin:0 0 4px; font-size:16px;">${escapeHtml(tbl.title)}</h3>
      <p style="margin:0 0 10px; font-size:12px; color:var(--text-sub);">${escapeHtml(tbl.subtitle)}</p>
      <div class="cmp-table-wrap">
        <table class="cmp-table ${state.cmpMaskOn ? "cmp-mask-on" : ""}">
          <thead><tr>${ths}</tr></thead>
          <tbody>${trs}</tbody>
        </table>
      </div>
    `;
    card.querySelectorAll("td").forEach((td, idx) => {
      td.addEventListener("click", () => {
        if (state.cmpMaskOn) td.classList.toggle("cell-open");
      });
    });
    container.appendChild(card);
  });
}

// =========================================================================
// 5. ダッシュボード＆バックアップ
// =========================================================================
function bindDashboardControls() {
  document.getElementById("btnDashReviewWrong").addEventListener("click", async () => {
    switchView("exam");
    await loadAllExams();
    document.getElementById("fExam").value = "all";
    document.getElementById("fSection").value = "all";
    document.getElementById("fSubject").value = "all";
    document.getElementById("fStatus").value = "wrong";
    document.getElementById("fSearch").value = "";
    await applyExamFilter();
  });

  document.getElementById("btnExportBackup").addEventListener("click", async () => {
    const text = JSON.stringify(state.progress);
    try {
      await navigator.clipboard.writeText(text);
      alert("学習記録のバックアップをクリップボードにコピーしました！メモ帳やLINEに保存してください。");
    } catch (_) {
      prompt("以下の文字列をすべてコピーして保存してください：", text);
    }
  });

  document.getElementById("btnImportBackup").addEventListener("click", () => {
    const raw = prompt("バックアップ文字列を貼り付けてください：");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.answers) throw new Error("形式が不正です");
      state.progress = parsed;
      saveProgress();
      renderDashboard();
      applyExamFilter();
      alert("学習記録を復元しました！");
    } catch (e) {
      alert("復元に失敗しました。正しいバックアップ文字列か確認してください。");
    }
  });

  const syncNowBtn = document.getElementById("btnSyncProgressNow");
  if (syncNowBtn) {
    syncNowBtn.addEventListener("click", () => checkCloudMockDraft(true));
  }
}

function renderDashboard() {
  const s = getOverallStats();
  document.getElementById("kpiToday").textContent = `${s.todayCount}問`;
  document.getElementById("kpiTotal").textContent = `${s.total}問`;
  document.getElementById("kpiAcc").textContent = s.total > 0 ? `${s.acc}%` : "-";
  document.getElementById("kpiWrong").textContent = `${s.wrong}問`;

  // 科目別集計
  const bySubj = {};
  SUBJECT_LIST.forEach((sub) => (bySubj[sub] = { total: 0, correct: 0 }));
  Object.values(state.progress.answers).forEach((a) => {
    if (!bySubj[a.subject]) bySubj[a.subject] = { total: 0, correct: 0 };
    bySubj[a.subject].total += 1;
    if (a.correct) bySubj[a.subject].correct += 1;
  });

  const sb = document.getElementById("subjectBars");
  sb.innerHTML = "";
  SUBJECT_LIST.forEach((sub) => {
    const d = bySubj[sub];
    const pct = d.total > 0 ? Math.round((d.correct / d.total) * 100) : 0;
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span style="font-weight:700;">${sub}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;"></div></div>
      <span style="text-align:right; font-weight:700;">${d.total > 0 ? `${pct}% (${d.total})` : "未挑戦"}</span>
    `;
    sb.appendChild(row);
  });

  // 直近7日間
  const wb = document.getElementById("weeklyBars");
  wb.innerHTML = "";
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    days.push({ key: k, count: state.progress.daily[k]?.count || 0 });
  }
  const maxC = Math.max(10, ...days.map((d) => d.count));
  days.forEach((d) => {
    const pct = Math.round((d.count / maxC) * 100);
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span>${d.key.slice(5)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:linear-gradient(90deg,#d97706,#f59e0b);"></div></div>
      <span style="text-align:right; font-weight:700;">${d.count}問</span>
    `;
    wb.appendChild(row);
  });
}

// =========================================================================
// 裏機能：お父さん専用・こっそり見守りレポート
// =========================================================================
function bindSecretParentTrigger() {
  let taps = 0;
  let tapTimer = null;
  const onTap = () => {
    taps += 1;
    clearTimeout(tapTimer);
    if (taps >= 7) {
      taps = 0;
      openParentModal();
    } else {
      tapTimer = setTimeout(() => (taps = 0), 1800);
    }
  };
  document.getElementById("pcBrandTitle").addEventListener("click", onTap);
  document.getElementById("mobileBrandTitle").addEventListener("click", onTap);

  document.getElementById("btnCloseParent").addEventListener("click", () => {
    document.getElementById("parentModal").classList.remove("open");
  });
  document.getElementById("btnFetchCloudReport").addEventListener("click", () => fetchCloudParentReport());
  document.getElementById("btnSendTestPing").addEventListener("click", () => {
    if (!PARENT_WEBHOOK_URL) {
      alert("Googleスプレッドシート連携URL（PARENT_WEBHOOK_URL）が未設定です。");
      return;
    }
    sendSilentParentLog("test_ping", "TEST", "親テスト接続確認", true, true);
    alert("テスト記録を送信しました。数秒後に「クラウドから最新レポート取得」を押して確認してください。");
  });

  const muteBtn = document.getElementById("btnToggleParentMute");
  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      setParentMuted(!isParentMuted());
      updateParentMuteUI();
    });
  }

  const clearLocalBtn = document.getElementById("btnClearLocalProgress");
  if (clearLocalBtn) {
    clearLocalBtn.addEventListener("click", () => {
      if (!confirm("この端末（ブラウザ）に保存されている学習記録・模試履歴をすべて0にリセットしますか？\n※Googleスプレッドシートや他の端末の記録は消えません。")) {
        return;
      }
      state.progress = {
        deviceId: state.progress.deviceId || "dev-" + Math.random().toString(36).slice(2, 10),
        answers: {},
        bookmarks: {},
        memos: {},
        daily: {},
        recent: [],
        mockHistory: [],
      };
      saveProgress(true);
      renderDashboard();
      renderMockHistory();
      applyExamFilter();
      if (!PARENT_WEBHOOK_URL) renderParentTablesFromLocal();
      alert("この端末の学習記録を真っさらにリセットしました！");
    });
  }
}

function updateParentMuteUI() {
  const lbl = document.getElementById("parentDeviceTagLabel");
  if (lbl) lbl.textContent = getDeviceLabel();
  const btn = document.getElementById("btnToggleParentMute");
  if (!btn) return;
  const muted = isParentMuted();
  if (muted) {
    btn.textContent = "🔇 お父さん用（送信OFF・混ざらない）";
    btn.className = "btn btn-danger btn-sm";
  } else {
    btn.textContent = "📡 通常（この端末の学習を記録送信）";
    btn.className = "btn btn-secondary btn-sm";
  }
}

function openParentModal() {
  document.getElementById("parentModal").classList.add("open");
  updateParentMuteUI();
  const statusEl = document.getElementById("parentCloudStatus");
  if (PARENT_WEBHOOK_URL) {
    statusEl.innerHTML = "✅ <strong>クラウド遠隔見守り連携：ON</strong>（お子さんのスマホの学習履歴をリアルタイム取得できます）";
    fetchCloudParentReport();
  } else {
    statusEl.innerHTML =
      "ℹ️ <strong>現在は「この端末内の記録」を表示中</strong>です。<br>別端末（お子さんのスマホ）の勉強状況を遠隔で見るには、同梱の <code>gas_parent_logger.gs</code> をGoogleスプレッドシートに設置し、<code>app.js</code> の <code>PARENT_WEBHOOK_URL</code> にURLを貼るだけで完了します。";
    renderParentTablesFromLocal();
  }
}

async function fetchCloudParentReport() {
  if (!PARENT_WEBHOOK_URL) {
    renderParentTablesFromLocal();
    return;
  }
  const statusEl = document.getElementById("parentCloudStatus");
  statusEl.innerHTML = "🔄 クラウド（Googleスプレッドシート）から最新レポートを取得中...";
  try {
    const resp = await fetch(PARENT_WEBHOOK_URL);
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "API error");
    statusEl.innerHTML = `✅ <strong>クラウド最新レポート取得完了</strong>（取得時刻：${nowTimeStr()}）`;
    renderParentTables(data.daily || [], data.recentLogs || []);
  } catch (err) {
    statusEl.innerHTML = `⚠️ クラウド取得に失敗しました（ローカル記録を表示します）：${escapeHtml(String(err))}`;
    renderParentTablesFromLocal();
  }
}

function renderParentTablesFromLocal() {
  const daily = Object.entries(state.progress.daily)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, v]) => ({
      date,
      answers: v.count || 0,
      correct: v.correct || 0,
      minutes: v.minutes || 0,
      lastActive: v.lastActive || "-",
    }));
  renderParentTables(daily, state.progress.recent || []);
}

function formatCloudDate(val) {
  const s = String(val || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return s;
}

function formatCloudTime(val) {
  const s = String(val || "");
  if (/^\d{2}:\d{2}/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return s;
}

function formatCloudDateTime(val) {
  const s = String(val || "");
  if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${formatCloudDate(d)} ${formatCloudTime(d)}`;
  }
  return s;
}

function renderParentTables(daily, recent) {
  const dBody = document.querySelector("#parentDailyTable tbody");
  dBody.innerHTML = daily.length
    ? daily
        .map((d) => {
          const pct = d.answers > 0 ? Math.round((d.correct / d.answers) * 100) + "%" : "-";
          return `<tr>
            <td><strong>${escapeHtml(formatCloudDate(d.date))}</strong></td>
            <td>${d.answers}問</td>
            <td>${d.correct}問</td>
            <td>${pct}</td>
            <td>約${d.minutes}分</td>
            <td>${escapeHtml(formatCloudTime(d.lastActive))}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" style="text-align:center;color:var(--text-sub);">まだ記録がありません</td></tr>`;

  const rBody = document.querySelector("#parentRecentTable tbody");
  rBody.innerHTML = recent.length
    ? recent
        .slice(0, 30)
        .map(
          (r) => `<tr>
            <td>${escapeHtml(formatCloudDateTime(r.ts))}</td>
            <td><span class="badge" style="background:#f1f5f9;color:#334155;">${escapeHtml(r.device || "-")}</span></td>
            <td>${escapeHtml(r.event)}</td>
            <td>${escapeHtml(r.subject)}</td>
            <td>${escapeHtml(r.qid)}</td>
            <td><strong>${escapeHtml(r.result)}</strong></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" style="text-align:center;color:var(--text-sub);">まだ記録がありません</td></tr>`;
}

// =========================================================================
// 実践試験モード（本番フル模試メイン・10秒カウントダウン・タイム計測・一括採点）
// =========================================================================
const FULL_MOCK_BLOCKS = {
  day1_1: { label: "1日目① 必須問題", startQ: 1, endQ: 90, limitMin: 90, isHissuFull: true },
  day1_2: { label: "1日目② 薬学理論問題①", startQ: 91, endQ: 150, limitMin: 150, isHissuFull: false },
  day1_3: { label: "1日目③ 薬学理論問題②", startQ: 151, endQ: 195, limitMin: 115, isHissuFull: false },
  day2_1: { label: "2日目① 薬学実践問題①", startQ: 196, endQ: 245, limitMin: 125, isHissuFull: false },
  day2_2: { label: "2日目② 薬学実践問題②", startQ: 246, endQ: 285, limitMin: 100, isHissuFull: false },
  day2_3: { label: "2日目③ 薬学実践問題③", startQ: 286, endQ: 345, limitMin: 150, isHissuFull: false },
  all_345: { label: "全科目 通しフル模試", startQ: 1, endQ: 345, limitMin: 730, isHissuFull: false },
};

function bindMockControls() {
  const tabPrac = document.getElementById("tabPracticeMode");
  const tabMock = document.getElementById("tabMockMode");
  if (!tabPrac || !tabMock) return;

  tabPrac.addEventListener("click", () => switchExamSubMode("practice"));
  tabMock.addEventListener("click", () => {
    switchExamSubMode("mock");
    renderMockHistory();
  });

  // メイン：本番フル模試（回数選択＋本番ブロック選択＋10秒カウントダウン）
  document.getElementById("btnStartFullMock").addEventListener("click", async () => {
    const examNum = Number(document.getElementById("fullMockExam").value) || 111;
    const blockKey = document.getElementById("fullMockBlock").value;
    const blk = FULL_MOCK_BLOCKS[blockKey] || FULL_MOCK_BLOCKS.day1_1;

    await startMockByConfig({
      title: `第${examNum}回 ${blk.label}`,
      exam: String(examNum),
      section: "all",
      subject: "all",
      startQ: blk.startQ,
      endQ: blk.endQ,
      count: blk.endQ - blk.startQ + 1,
      limitMin: blk.limitMin,
      shuffleOrder: false,
      isHissuFull: blk.isHissuFull,
    });
  });

  document.getElementById("presetHissu10").addEventListener("click", async () => {
    await startMockByConfig({
      title: "必須ミニ模試（10問）",
      exam: "all",
      section: "必須",
      subject: "all",
      count: 10,
      limitMin: 10,
      shuffleOrder: true,
      isHissuFull: false,
    });
  });

  document.getElementById("presetLaw15").addEventListener("click", async () => {
    await startMockByConfig({
      title: "法規・制度 集中模試（15問）",
      exam: "all",
      section: "all",
      subject: "法規・制度・倫理",
      count: 15,
      limitMin: 20,
      shuffleOrder: true,
      isHissuFull: false,
    });
  });

  document.getElementById("presetRiron20").addEventListener("click", async () => {
    await startMockByConfig({
      title: "薬学理論スピード模試（20問）",
      exam: "all",
      section: "理論",
      subject: "all",
      count: 20,
      limitMin: 35,
      shuffleOrder: true,
      isHissuFull: false,
    });
  });

  document.getElementById("btnStartCustomMock").addEventListener("click", async () => {
    const exam = document.getElementById("mExam").value;
    const section = document.getElementById("mSection").value;
    const subject = document.getElementById("mSubject").value;
    const count = Number(document.getElementById("mCount").value) || 10;
    const limitVal = document.getElementById("mTimeLimit").value;

    let limitMin = 0;
    if (limitVal === "auto") {
      const perQ = section === "必須" ? 1 : 2;
      limitMin = count * perQ;
    } else {
      limitMin = Number(limitVal) || 0;
    }

    const labelExam = exam === "all" ? "10年分" : `第${exam}回`;
    const labelSubj = subject === "all" ? (section === "all" ? "全範囲" : `${section}問題`) : subject;
    await startMockByConfig({
      title: `${labelExam} ${labelSubj} 模試`,
      exam,
      section,
      subject,
      count,
      limitMin,
      shuffleOrder: exam === "all",
      isHissuFull: section === "必須" && count >= 90,
    });
  });

  document.getElementById("btnMockPrev").addEventListener("click", () => {
    if (state.mock.index > 0) {
      recordCurrentMockQuestionTime();
      state.mock.index -= 1;
      renderMockQuestion();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  document.getElementById("btnMockNext").addEventListener("click", () => {
    if (state.mock.index < state.mock.questions.length - 1) {
      recordCurrentMockQuestionTime();
      state.mock.index += 1;
      renderMockQuestion();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  document.getElementById("btnJumpUnanswered").addEventListener("click", () => {
    const total = state.mock.questions.length;
    for (let offset = 1; offset <= total; offset++) {
      const idx = (state.mock.index + offset) % total;
      const set = state.mock.answers[idx];
      if (!set || set.size === 0) {
        recordCurrentMockQuestionTime();
        state.mock.index = idx;
        renderMockQuestion();
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
    }
    alert("すべての問題に解答済みです！上の「📝 終了して採点」ボタンで一括採点できます。");
  });

  document.getElementById("btnJumpFlagged").addEventListener("click", () => {
    const total = state.mock.questions.length;
    for (let offset = 1; offset <= total; offset++) {
      const idx = (state.mock.index + offset) % total;
      if (state.mock.flags[idx]) {
        recordCurrentMockQuestionTime();
        state.mock.index = idx;
        renderMockQuestion();
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
    }
    alert("🚩 見直しチェックが付いている問題はありません。");
  });

  document.getElementById("btnMockFlag").addEventListener("click", () => {
    const i = state.mock.index;
    state.mock.flags[i] = !state.mock.flags[i];
    updateMockFlagBtn();
    renderMockPalette();
  });

  document.getElementById("btnMockFont").addEventListener("click", () => {
    state.largeFont = !state.largeFont;
    document.getElementById("mockQuestionCard").classList.toggle("font-large", state.largeFont);
    document.getElementById("questionCard").classList.toggle("font-large", state.largeFont);
    const label = state.largeFont ? "🔤 文字サイズ：大" : "🔤 文字サイズ：標準";
    document.getElementById("btnMockFont").textContent = label;
    document.getElementById("btnToggleFontSize").textContent = label;
  });

  document.getElementById("btnMockPdfToggle").addEventListener("click", () => {
    state.mock.pdfVisible = !state.mock.pdfVisible;
    const imgBox = document.getElementById("mqImages");
    const hasLead = imgBox.querySelectorAll(".js-lead-img").length > 0;
    imgBox.querySelectorAll(".js-body-img").forEach((el) => {
      el.style.display = state.mock.pdfVisible ? "block" : "none";
    });
    imgBox.style.display = state.mock.pdfVisible || hasLead ? "flex" : "none";
    document.getElementById("btnMockPdfToggle").textContent = state.mock.pdfVisible
      ? "📄 試験用紙を隠す"
      : "📄 元の試験用紙を見る";
  });

  document.getElementById("btnFinishMock").addEventListener("click", () => {
    const total = state.mock.questions.length;
    const answered = countMockAnswered();
    if (answered < total) {
      const ok = confirm(`まだ未解答の問題が ${total - answered} 問あります。このまま終了して一括採点しますか？`);
      if (!ok) return;
    }
    finishMockExam(false);
  });

  document.getElementById("btnAbortMock").addEventListener("click", () => {
    if (!confirm("進行中の試験を中断して最初の画面に戻りますか？（途中経過は破棄されます）")) return;
    clearInterval(state.mock.timerHandle);
    state.mock.active = false;
    clearMockDraft();
    document.getElementById("mockRunPanel").style.display = "none";
    document.getElementById("mockResultPanel").style.display = "none";
    document.getElementById("mockSetupPanel").style.display = "block";
    renderMockHistory();
    updateMockReturnBanners();
    refreshMockDraftBanner();
  });

  document.getElementById("btnMockBackToSetup").addEventListener("click", () => {
    state.hasMockResult = false;
    document.getElementById("mockResultPanel").style.display = "none";
    document.getElementById("mockSetupPanel").style.display = "block";
    renderMockHistory();
    updateMockReturnBanners();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  document.getElementById("btnMockReviewWrong").addEventListener("click", () => {
    if (!state.mock.lastWrongQuestions.length) {
      alert("間違えた問題はありません！満点おめでとうございます🎉");
      return;
    }
    state.filteredQuestions = [...state.mock.lastWrongQuestions];
    state.currentIndex = 0;
    document.getElementById("examMatchCount").textContent = `模試で間違えた ${state.filteredQuestions.length} 問を復習中`;
    switchExamSubMode("practice");
    renderCurrentQuestion();
  });

  // 戻りバー・途中再開バナーのボタン
  document.getElementById("btnReturnToActiveMock").addEventListener("click", () => {
    switchView("exam");
    switchExamSubMode("mock");
  });

  document.getElementById("btnBackToMockResult").addEventListener("click", () => {
    switchView("exam");
    switchExamSubMode("mock");
    document.getElementById("mockSetupPanel").style.display = "none";
    document.getElementById("mockRunPanel").style.display = "none";
    document.getElementById("mockResultPanel").style.display = "block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  document.getElementById("btnResumeMockDraft").addEventListener("click", () => resumeMockFromDraft());
  document.getElementById("btnDiscardMockDraft").addEventListener("click", () => {
    if (!confirm("保存されている途中の試験データを破棄してもよろしいですか？（クラウド保存も消去されます）")) return;
    clearMockDraft(true);
    refreshMockDraftBanner();
  });

  const cloudSaveBtn = document.getElementById("btnCloudSaveMock");
  if (cloudSaveBtn) {
    cloudSaveBtn.addEventListener("click", () => {
      recordCurrentMockQuestionTime();
      saveMockDraft(true);
      const orig = cloudSaveBtn.textContent;
      cloudSaveBtn.textContent = isParentMuted() ? "✅ この端末に保存済" : "✅ クラウド保存済";
      setTimeout(() => (cloudSaveBtn.textContent = orig), 2000);
    });
  }

  // ページ離脱・バックグラウンド移行時の自動保存＆誤操作防止警告（iPhone/iPad/Android/PC対応）
  window.addEventListener("beforeunload", (e) => {
    if (state.mock.active) {
      recordCurrentMockQuestionTime();
      saveMockDraft(true);
      e.preventDefault();
      e.returnValue = "";
    }
  });
  window.addEventListener("pagehide", () => {
    if (state.mock.active) {
      recordCurrentMockQuestionTime();
      saveMockDraft(true);
    }
    pushProgressToCloudNow();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (state.mock.active) {
        recordCurrentMockQuestionTime();
        saveMockDraft(true);
      }
      pushProgressToCloudNow();
    }
  });
}

function buildCurrentMockDraftObj() {
  const answersPlain = {};
  Object.entries(state.mock.answers).forEach(([k, set]) => {
    if (set && set.size > 0) answersPlain[k] = [...set];
  });
  const orderMap = {};
  Object.entries(state.mock.shuffledMap).forEach(([k, arr]) => {
    if (Array.isArray(arr)) orderMap[k] = arr.map((c) => c.orig);
  });
  const examsUsed = [...new Set(state.mock.questions.map((q) => q.exam))];
  return {
    v: 1,
    savedAt: Date.now(),
    device: getDeviceLabel(),
    title: state.mock.title,
    isHissuFull: state.mock.isHissuFull,
    examsUsed,
    qIds: state.mock.questions.map((q) => q.id),
    orderMap,
    answers: answersPlain,
    flags: state.mock.flags,
    qSpentSec: state.mock.qSpentSec,
    index: state.mock.index,
    limitSec: state.mock.limitSec,
    elapsedSec: Math.max(0, Math.floor((Date.now() - state.mock.startMs) / 1000)),
  };
}

function pushMockDraftToCloud(draftJson) {
  if (!PARENT_WEBHOOK_URL || isParentMuted()) return;
  try {
    const body = JSON.stringify({
      event: "mock_draft_save",
      draftJson,
      deviceId: getDeviceLabel(),
    });
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
      navigator.sendBeacon(PARENT_WEBHOOK_URL, blob);
    } else {
      fetch(PARENT_WEBHOOK_URL, {
        method: "POST",
        mode: "no-cors",
        keepalive: true,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
      }).catch(() => {});
    }
  } catch (_) {}
}

function saveMockDraft(immediateCloud = false) {
  if (!state.mock.active || !state.mock.questions.length) return;
  try {
    const draft = buildCurrentMockDraftObj();
    const jsonStr = JSON.stringify(draft);
    localStorage.setItem(MOCK_DRAFT_KEY, jsonStr);
    if (!PARENT_WEBHOOK_URL || isParentMuted()) return;
    if (immediateCloud) {
      clearTimeout(state.cloudDraftSaveTimer);
      pushMockDraftToCloud(jsonStr);
    } else {
      clearTimeout(state.cloudDraftSaveTimer);
      state.cloudDraftSaveTimer = setTimeout(() => {
        if (state.mock.active) {
          pushMockDraftToCloud(JSON.stringify(buildCurrentMockDraftObj()));
        }
      }, 1800);
    }
  } catch (_) {}
}

function loadMockDraft() {
  try {
    const raw = localStorage.getItem(MOCK_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.qIds) || d.qIds.length === 0) return null;
    return d;
  } catch (_) {
    return null;
  }
}

function getBestAvailableMockDraft() {
  const local = loadMockDraft();
  const cloud = state.cloudDraft;
  if (local && cloud) {
    return (cloud.savedAt || 0) > (local.savedAt || 0) ? { draft: cloud, fromCloud: true } : { draft: local, fromCloud: false };
  }
  if (cloud) return { draft: cloud, fromCloud: true };
  if (local) return { draft: local, fromCloud: false };
  return null;
}

async function checkCloudMockDraft(manual = false) {
  const statusEl = document.getElementById("cloudSyncStatusText");
  if (!PARENT_WEBHOOK_URL) {
    state.cloudSyncInitialized = true;
    return;
  }
  if (isParentMuted()) {
    state.cloudSyncInitialized = true;
    if (statusEl && manual) {
      statusEl.textContent = "🔇 この端末は保護者用ミュート中のためクラウド同期をスキップしました。";
    }
    return;
  }
  if (manual && statusEl) {
    statusEl.textContent = "🔄 クラウドと最新データを同期中です...";
  }
  try {
    const sep = PARENT_WEBHOOK_URL.includes("?") ? "&" : "?";
    const resp = await fetch(`${PARENT_WEBHOOK_URL}${sep}mode=sync`);
    const data = await resp.json();
    if (data && data.ok) {
      // 1. 途中試験データの反映
      if (data.mockDraft && Array.isArray(data.mockDraft.qIds) && data.mockDraft.qIds.length > 0) {
        state.cloudDraft = data.mockDraft;
      } else {
        state.cloudDraft = null;
      }
      refreshMockDraftBanner();

      // 2. 全学習成績・今日の学習・ブックマーク・メモ・模試履歴の安全マージ
      let shouldPushBack = false;
      if (data.progress && typeof data.progress === "object") {
        const { merged, localHadNewer } = mergeProgressData(state.progress, data.progress);
        state.progress = merged;
        saveProgress(true);
        shouldPushBack = localHadNewer;
      } else {
        // クラウドがまだ空でローカルに学習記録がある場合はアップロード
        shouldPushBack = Object.keys(state.progress.answers || {}).length > 0;
      }

      state.cloudSyncInitialized = true;
      if (shouldPushBack || manual) {
        pushProgressToCloudNow();
      }

      renderDashboard();
      renderMockHistory();
      updateSidebarStats();
      if (state.filteredQuestions.length > 0 && !state.answeredCurrent && state.examMode === "practice") {
        renderCurrentQuestion();
      }

      if (statusEl) {
        statusEl.textContent = `✅ クラウド同期完了（${nowTimeStr().slice(0, 5)} 更新・スマホ/iPad/PC共通）`;
      }
    } else {
      state.cloudSyncInitialized = true;
    }
  } catch (_) {
    state.cloudSyncInitialized = true;
    if (manual && statusEl) {
      statusEl.textContent = "⚠️ 通信に失敗しました。電波の良い場所で再度お試しください。";
    }
  }
}

function clearMockDraft(syncCloud = true) {
  clearTimeout(state.cloudDraftSaveTimer);
  state.cloudDraft = null;
  try {
    localStorage.removeItem(MOCK_DRAFT_KEY);
  } catch (_) {}
  if (syncCloud && PARENT_WEBHOOK_URL && !isParentMuted()) {
    try {
      fetch(PARENT_WEBHOOK_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ event: "mock_draft_clear", deviceId: getDeviceLabel() }),
      }).catch(() => {});
    } catch (_) {}
  }
}

function refreshMockDraftBanner() {
  const bar = document.getElementById("mockDraftResumeBar");
  if (!bar) return;
  if (state.mock.active) {
    bar.classList.remove("open");
    return;
  }
  const best = getBestAvailableMockDraft();
  if (!best) {
    bar.classList.remove("open");
    return;
  }
  const { draft, fromCloud } = best;
  const ansCount = Object.keys(draft.answers || {}).length;
  const devInfo = draft._cloudDevice || draft.device || "";
  const prefix = fromCloud
    ? `☁ クラウド途中保存（${devInfo || "別端末"}）`
    : "⏱ 途中の実践試験があります";
  document.getElementById("mockDraftResumeText").textContent = `${prefix}：${draft.title}`;
  document.getElementById("mockDraftResumeSub").textContent =
    `解答済 ${ansCount} / ${draft.qIds.length} 問・経過 ${formatMinSec(draft.elapsedSec || 0)}（前回の続きからそのまま再開できます）`;
  bar.classList.add("open");
}

function updateMockReturnBanners() {
  const activeBar = document.getElementById("mockActiveReturnBar");
  if (activeBar) {
    const awayFromRunningMock = state.mock.active && !(state.currentView === "exam" && state.examMode === "mock");
    activeBar.classList.toggle("open", awayFromRunningMock);
    if (awayFromRunningMock) {
      const remTxt =
        state.mock.limitSec > 0
          ? `残り ${formatMinSec(Math.max(0, state.mock.limitSec - state.mock.elapsedSec))}`
          : `経過 ${formatMinSec(state.mock.elapsedSec)}`;
      document.getElementById("mockActiveReturnText").textContent =
        `⏱ 実践試験が進行中：${state.mock.title}（解答済 ${countMockAnswered()}/${state.mock.questions.length}・${remTxt}）`;
    }
  }
  const resBar = document.getElementById("mockResultReturnBar");
  if (resBar) {
    const showRes = !state.mock.active && state.hasMockResult && state.examMode === "practice";
    resBar.classList.toggle("open", showRes);
  }
}

async function resumeMockFromDraft() {
  const best = getBestAvailableMockDraft();
  if (!best) {
    refreshMockDraftBanner();
    return;
  }
  const draft = best.draft;
  const exams = Array.isArray(draft.examsUsed) && draft.examsUsed.length ? draft.examsUsed : ALL_EXAM_NUMS;
  await Promise.all(exams.map((n) => loadExamData(Number(n))));

  const qMap = {};
  exams.forEach((n) => {
    (state.examCache[Number(n)] || []).forEach((q) => {
      qMap[q.id] = q;
    });
  });

  const restoredQuestions = draft.qIds.map((id) => qMap[id]).filter(Boolean);
  if (!restoredQuestions.length) {
    alert("問題の復元に失敗したため途中データを破棄しました。");
    clearMockDraft();
    refreshMockDraftBanner();
    return;
  }

  // シャッフル順を完全復元
  const shuffledMap = {};
  restoredQuestions.forEach((q, idx) => {
    if (q.can_shuffle && q.choices && q.choices.length > 0) {
      const savedOrder = draft.orderMap && draft.orderMap[idx];
      if (Array.isArray(savedOrder) && savedOrder.length === q.choices.length) {
        const byOrig = {};
        q.choices.forEach((c) => (byOrig[c.orig] = c));
        const ordered = savedOrder.map((o) => byOrig[o]).filter(Boolean);
        shuffledMap[idx] = ordered.length === q.choices.length ? ordered : q.choices.map((c) => ({ ...c }));
      } else {
        shuffledMap[idx] = q.choices.map((c) => ({ ...c }));
      }
    }
  });

  const restoredAnswers = {};
  Object.entries(draft.answers || {}).forEach(([k, arr]) => {
    if (Array.isArray(arr) && arr.length > 0) restoredAnswers[Number(k)] = new Set(arr);
  });

  clearInterval(state.mock.timerHandle);
  state.hasMockResult = false;
  state.mock.active = true;
  state.mock.title = draft.title;
  state.mock.isHissuFull = Boolean(draft.isHissuFull);
  state.mock.questions = restoredQuestions;
  state.mock.shuffledMap = shuffledMap;
  state.mock.answers = restoredAnswers;
  state.mock.flags = draft.flags || {};
  state.mock.qSpentSec = draft.qSpentSec || {};
  state.mock.index = Math.min(draft.index || 0, restoredQuestions.length - 1);
  state.mock.limitSec = draft.limitSec || 0;
  state.mock.elapsedSec = draft.elapsedSec || 0;
  // 中断時点の経過時間からシームレスに再開（離れていた間の時間は消費しない！）
  state.mock.startMs = Date.now() - state.mock.elapsedSec * 1000;
  state.mock.qEnterMs = Date.now();

  switchView("exam");
  switchExamSubMode("mock");
  document.getElementById("mockTitleLabel").textContent = state.mock.title;
  document.getElementById("mockSetupPanel").style.display = "none";
  document.getElementById("mockHistoryCard").style.display = "none";
  document.getElementById("mockResultPanel").style.display = "none";
  document.getElementById("mockRunPanel").style.display = "block";
  document.getElementById("mockQuestionCard").classList.toggle("font-large", state.largeFont);

  refreshMockDraftBanner();
  updateMockReturnBanners();
  startMockTimerLoop();
  renderMockQuestion();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function startMockTimerLoop() {
  clearInterval(state.mock.timerHandle);
  updateMockClock();
  let tick = 0;
  state.mock.timerHandle = setInterval(() => {
    state.mock.elapsedSec = Math.floor((Date.now() - state.mock.startMs) / 1000);
    updateMockClock();
    updateMockReturnBanners();
    tick += 1;
    if (tick % 5 === 0) saveMockDraft();
    if (state.mock.limitSec > 0 && state.mock.elapsedSec >= state.mock.limitSec) {
      clearInterval(state.mock.timerHandle);
      alert("⏰ 制限時間になりました！自動で一括採点を行います。");
      finishMockExam(true);
    }
  }, 1000);
}

function recordCurrentMockQuestionTime() {
  if (!state.mock.active || !state.mock.qEnterMs) return;
  const i = state.mock.index;
  const delta = Math.max(0, Math.round((Date.now() - state.mock.qEnterMs) / 1000));
  state.mock.qSpentSec[i] = (state.mock.qSpentSec[i] || 0) + delta;
  state.mock.qEnterMs = Date.now();
}

function switchExamSubMode(mode) {
  state.examMode = mode;
  document.getElementById("tabPracticeMode").classList.toggle("active", mode === "practice");
  document.getElementById("tabMockMode").classList.toggle("active", mode === "mock");
  document.getElementById("practiceContainer").style.display = mode === "practice" ? "block" : "none";
  document.getElementById("mockContainer").style.display = mode === "mock" ? "block" : "none";
  updateMockReturnBanners();
  refreshMockDraftBanner();
}

function renderMockHistory() {
  const card = document.getElementById("mockHistoryCard");
  const list = state.progress.mockHistory || [];
  if (!card) return;
  if (list.length === 0 || state.mock.active) {
    card.style.display = "none";
    return;
  }
  card.style.display = "block";
  const tbody = document.querySelector("#mockHistoryTable tbody");
  tbody.innerHTML = list
    .slice(0, 12)
    .map(
      (h) => `<tr>
        <td>${escapeHtml(h.ts)}</td>
        <td><strong>${escapeHtml(h.title)}</strong></td>
        <td>${h.correct} / ${h.total}</td>
        <td><strong>${h.pct}%</strong></td>
        <td>${formatMinSec(h.elapsedSec)}</td>
        <td>${h.pass ? `<span style="color:#059669;font-weight:800;">合格圏</span>` : `<span style="color:#dc2626;font-weight:700;">要復習</span>`}</td>
      </tr>`
    )
    .join("");
}

/**
 * 10秒前カウントダウンを実行しつつ裏側で問題データを準備し、0で本番スタート
 */
async function startMockByConfig({
  title,
  exam,
  section,
  subject,
  startQ = 1,
  endQ = 345,
  count,
  limitMin,
  shuffleOrder,
  isHissuFull = false,
}) {
  const overlay = document.getElementById("countdownOverlay");
  const titleEl = document.getElementById("cdExamTitle");
  const subEl = document.getElementById("cdSubText");
  const numEl = document.getElementById("cdNumber");
  const cancelBtn = document.getElementById("btnCdCancel");
  const skipBtn = document.getElementById("btnCdSkip");

  titleEl.textContent = `${title}${limitMin > 0 ? `（制限時間 ${limitMin}分）` : ""}`;
  subEl.textContent = "深呼吸して準備してください… 試験開始まで";
  numEl.textContent = "10";
  numEl.style.color = "#ffffff";
  overlay.classList.add("open");

  // カウントダウン中に裏側で試験データを読み込み
  const dataPromise = (async () => {
    let pool = [];
    if (exam === "all") {
      await loadAllExams();
      pool = ALL_EXAM_NUMS.flatMap((n) => state.examCache[n] || []);
    } else {
      pool = await loadExamData(Number(exam));
    }
    let filtered = pool.filter((q) => {
      if (q.q_no < startQ || q.q_no > endQ) return false;
      if (section !== "all" && q.section !== section) return false;
      if (subject !== "all" && q.subject !== subject) return false;
      // 通し・ブロック本番模試以外では採点除外を省く
      if (shuffleOrder && q.multi_mode === "none") return false;
      return true;
    });
    if (shuffleOrder) shuffleArray(filtered);
    return filtered.slice(0, Math.min(count, filtered.length));
  })();

  let cancelled = false;
  let skipped = false;
  clearInterval(state.mock.cdTimerHandle);

  const countdownDone = new Promise((resolve) => {
    let rem = 10;
    const cleanup = () => {
      clearInterval(state.mock.cdTimerHandle);
      cancelBtn.onclick = null;
      skipBtn.onclick = null;
    };

    cancelBtn.onclick = () => {
      cancelled = true;
      cleanup();
      overlay.classList.remove("open");
      resolve();
    };

    skipBtn.onclick = () => {
      skipped = true;
      cleanup();
      resolve();
    };

    state.mock.cdTimerHandle = setInterval(() => {
      rem -= 1;
      if (rem > 0) {
        numEl.textContent = String(rem);
        if (rem <= 3) {
          numEl.style.color = "#fbbf24";
          subEl.textContent = "まもなく開始します！";
        }
      } else {
        numEl.textContent = "開始！";
        numEl.style.color = "#34d399";
        subEl.textContent = "がんばってください！";
        cleanup();
        setTimeout(() => resolve(), 450);
      }
    }, 1000);
  });

  const [selected] = await Promise.all([dataPromise, countdownDone]);
  overlay.classList.remove("open");
  if (cancelled) return;

  if (!selected || selected.length === 0) {
    alert("選択した条件に合う問題がありません。条件を変えてお試しください。");
    return;
  }

  // 各問題のシャッフル順を試験開始時に固定
  const shuffledMap = {};
  selected.forEach((q, idx) => {
    if (q.can_shuffle && q.choices && q.choices.length > 0) {
      const list = q.choices.map((c) => ({ ...c }));
      if (state.shuffleChoices) shuffleArray(list);
      shuffledMap[idx] = list;
    }
  });

  clearInterval(state.mock.timerHandle);
  state.hasMockResult = false;
  state.mock.active = true;
  state.mock.title = `${title}（全${selected.length}問）`;
  state.mock.isHissuFull = isHissuFull;
  state.mock.questions = selected;
  state.mock.shuffledMap = shuffledMap;
  state.mock.answers = {};
  state.mock.flags = {};
  state.mock.qSpentSec = {};
  state.mock.index = 0;
  state.mock.startMs = Date.now();
  state.mock.qEnterMs = Date.now();
  state.mock.limitSec = limitMin > 0 ? limitMin * 60 : 0;
  state.mock.elapsedSec = 0;

  document.getElementById("mockTitleLabel").textContent = state.mock.title;
  document.getElementById("mockSetupPanel").style.display = "none";
  document.getElementById("mockHistoryCard").style.display = "none";
  document.getElementById("mockResultPanel").style.display = "none";
  document.getElementById("mockRunPanel").style.display = "block";
  document.getElementById("mockQuestionCard").classList.toggle("font-large", state.largeFont);

  saveMockDraft();
  refreshMockDraftBanner();
  updateMockReturnBanners();
  startMockTimerLoop();

  recordActivity("mock_start", `${selected.length}問${skipped ? "(即開始)" : ""}`, state.mock.title, null);
  renderMockQuestion();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formatMinSec(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function updateMockClock() {
  const el = document.getElementById("mockClockLabel");
  const hud = document.querySelector(".mock-hud");
  if (!el) return;
  const elapsedStr = formatMinSec(state.mock.elapsedSec);
  const answered = countMockAnswered();
  const total = state.mock.questions.length;
  const remainingQ = Math.max(1, total - answered);

  if (state.mock.limitSec > 0) {
    const rem = Math.max(0, state.mock.limitSec - state.mock.elapsedSec);
    const perRemSec = Math.floor(rem / remainingQ);
    el.textContent = `経過 ${elapsedStr} ／ 残り ${formatMinSec(rem)}（残1問あたり約${perRemSec}秒）`;
    if (hud) {
      if (rem <= 180) hud.style.background = "linear-gradient(90deg, #991b1b 0%, #dc2626 100%)";
      else if (rem <= 600) hud.style.background = "linear-gradient(90deg, #b45309 0%, #d97706 100%)";
      else hud.style.background = "linear-gradient(90deg, #0f4c48 0%, #0f766e 100%)";
    }
  } else {
    el.textContent = `経過時間 ${elapsedStr}`;
    if (hud) hud.style.background = "linear-gradient(90deg, #0f4c48 0%, #0f766e 100%)";
  }
  document.getElementById("mockAnsweredPill").textContent = `解答済 ${answered} / ${total}`;
}

function countMockAnswered() {
  return Object.values(state.mock.answers).filter((set) => set && set.size > 0).length;
}

function updateMockFlagBtn() {
  const active = Boolean(state.mock.flags[state.mock.index]);
  const btn = document.getElementById("btnMockFlag");
  btn.classList.toggle("active", active);
  btn.textContent = active ? "🚩 見直しチェック済" : "🚩 見直しチェック";
}

function renderMockQuestion() {
  state.mock.qEnterMs = Date.now();
  const i = state.mock.index;
  const q = state.mock.questions[i];
  if (!q) return;

  document.getElementById("mqBadges").innerHTML = `
    <span class="badge badge-exam">問題 ${i + 1} / ${state.mock.questions.length}</span>
    <span class="badge badge-sec">第${q.exam}回 問${q.q_no}（${q.section}）</span>
    <span class="badge badge-subj">${q.subject}</span>
    ${q.select_count > 1 ? `<span class="badge badge-multi">${q.select_count}つ選択</span>` : ""}
  `;
  updateMockFlagBtn();

  const list = state.mock.shuffledMap[i];
  const leadImgs = (q.images || []).filter((src) => src.includes("lead_"));
  const bodyImgs = (q.images || []).filter((src) => !src.includes("lead_"));
  const hasNonLeadFigure = Boolean(q.show_img_alongside && !q.has_lead);
  const useTextMode = Boolean(list && q.stem && !hasNonLeadFigure);
  const stemBox = document.getElementById("mqStemBox");
  const imgBox = document.getElementById("mqImages");
  const pdfBtn = document.getElementById("btnMockPdfToggle");

  imgBox.innerHTML = "";
  const appendMockImg = (src, isLead, extraClass = "") => {
    const wrap = document.createElement("div");
    wrap.className = `q-img-wrap ${extraClass}`.trim();
    if (isLead) {
      const tag = document.createElement("div");
      tag.className = "lead-tag";
      tag.textContent = "📌 共通の症例・処方箋・リード文（タップで拡大）";
      wrap.appendChild(tag);
    }
    const img = document.createElement("img");
    img.src = `./${src}`;
    img.alt = `第${q.exam}回 問${q.q_no}`;
    img.loading = "eager";
    img.addEventListener("click", () => {
      document.getElementById("zoomImgTarget").src = img.src;
      document.getElementById("zoomModal").classList.add("open");
    });
    wrap.appendChild(img);
    imgBox.appendChild(wrap);
  };

  if (useTextMode) {
    leadImgs.forEach((src) => appendMockImg(src, true, "js-lead-img"));
    bodyImgs.forEach((src) => appendMockImg(src, false, "js-body-img"));
    stemBox.style.display = "block";
    stemBox.textContent = q.stem;
    state.mock.pdfVisible = false;
    imgBox.querySelectorAll(".js-body-img").forEach((el) => (el.style.display = "none"));
    imgBox.style.display = leadImgs.length > 0 ? "flex" : "none";
    pdfBtn.style.display = "inline-flex";
    pdfBtn.textContent = "📄 元の試験用紙を見る";
  } else {
    (q.images || []).forEach((src) => appendMockImg(src, src.includes("lead_")));
    stemBox.style.display = "none";
    state.mock.pdfVisible = true;
    imgBox.style.display = "flex";
    pdfBtn.style.display = "none";
  }

  document.getElementById("mqSelectHint").textContent =
    q.multi_mode === "none"
      ? "※この問題は公式発表により採点除外（解なし）対象です。そのまま次へ進んでください。"
      : q.select_count > 1
      ? `選択肢から ${q.select_count}つ 選んで次へ進んでください（採点は終了後にまとめて行います）`
      : "選択肢から 1つ 選んで次へ進んでください（採点は終了後にまとめて行います）";

  const chosenSet = state.mock.answers[i] || new Set();
  const choicesEl = document.getElementById("mqChoices");
  choicesEl.innerHTML = "";

  if (useTextMode) {
    choicesEl.className = "choices-cards";
    list.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `choice-card-btn ${chosenSet.has(item.orig) ? "selected" : ""}`;
      btn.dataset.choice = String(item.orig);
      const lbl = state.shuffleChoices ? String(idx + 1) : String(item.orig);
      btn.innerHTML = `<span class="choice-label-badge">${lbl}</span><span>${escapeHtml(item.text)}</span>`;
      btn.addEventListener("click", () => toggleMockChoice(i, item.orig, q.select_count));
      choicesEl.appendChild(btn);
    });
  } else {
    choicesEl.className = "choices-bar";
    const numChoices = Math.max(5, q.max_choice || 5);
    for (let c = 1; c <= numChoices; c++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `choice-btn ${chosenSet.has(c) ? "selected" : ""}`;
      btn.textContent = String(c);
      btn.dataset.choice = String(c);
      btn.addEventListener("click", () => toggleMockChoice(i, c, q.select_count));
      choicesEl.appendChild(btn);
    }
  }

  document.getElementById("mqPagerInfo").textContent = `${i + 1} / ${state.mock.questions.length}`;
  document.getElementById("btnMockPrev").disabled = i === 0;
  document.getElementById("btnMockNext").textContent =
    i === state.mock.questions.length - 1 ? "最終問題です（上の終了ボタンで採点）" : "次の問題 →";
  document.getElementById("btnMockNext").disabled = i === state.mock.questions.length - 1;

  renderMockPalette();
  updateMockClock();
  saveMockDraft();
}

function toggleMockChoice(idx, choiceNum, maxSelect) {
  if (!state.mock.answers[idx]) state.mock.answers[idx] = new Set();
  const set = state.mock.answers[idx];
  if (maxSelect === 1) {
    set.clear();
    set.add(choiceNum);
  } else {
    if (set.has(choiceNum)) set.delete(choiceNum);
    else {
      if (set.size >= maxSelect) {
        const first = set.values().next().value;
        set.delete(first);
      }
      set.add(choiceNum);
    }
  }
  document.querySelectorAll("#mqChoices button[data-choice]").forEach((btn) => {
    const c = Number(btn.dataset.choice);
    btn.classList.toggle("selected", set.has(c));
  });
  renderMockPalette();
  updateMockClock();
  saveMockDraft();
}

function renderMockPalette() {
  const pal = document.getElementById("mockPalette");
  pal.innerHTML = "";
  state.mock.questions.forEach((_, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-num";
    if (idx === state.mock.index) btn.classList.add("current");
    if (state.mock.flags[idx]) btn.classList.add("flagged");
    else if (state.mock.answers[idx] && state.mock.answers[idx].size > 0) btn.classList.add("answered");
    btn.textContent = String(idx + 1);
    btn.addEventListener("click", () => {
      recordCurrentMockQuestionTime();
      state.mock.index = idx;
      renderMockQuestion();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    pal.appendChild(btn);
  });
}

function finishMockExam(timeUp) {
  recordCurrentMockQuestionTime();
  clearInterval(state.mock.timerHandle);
  state.mock.active = false;
  state.hasMockResult = true;
  clearMockDraft();
  refreshMockDraftBanner();
  updateMockReturnBanners();
  const elapsedSec = Math.max(1, Math.floor((Date.now() - state.mock.startMs) / 1000));
  let validTotal = 0;
  let correctCount = 0;
  const bySubj = {};
  const wrongList = [];
  const rowsHtml = [];

  state.mock.questions.forEach((q, idx) => {
    const chosen = [...(state.mock.answers[idx] || new Set())].sort((a, b) => a - b);
    const official = [...(q.answers || [])].sort((a, b) => a - b);
    const spent = state.mock.qSpentSec[idx] || 0;
    const spentHtml =
      spent >= 120
        ? `<span style="color:#d97706;font-weight:700;">${spent}秒</span>`
        : `${spent}秒`;

    if (q.multi_mode === "none") {
      rowsHtml.push(`
        <tr>
          <td>${idx + 1}</td>
          <td><strong>第${q.exam}回 問${q.q_no}</strong></td>
          <td>${escapeHtml(q.subject)}</td>
          <td><span style="color:#0369a1; font-weight:700;">採点除外</span></td>
          <td>${spentHtml}</td>
          <td>解なし</td>
          <td><button type="button" class="btn btn-secondary btn-sm js-mock-open-q" data-idx="${idx}">確認</button></td>
        </tr>
      `);
      return;
    }

    validTotal += 1;
    let isCorrect = false;
    if (chosen.length > 0) {
      if (q.multi_mode === "any") isCorrect = chosen.every((c) => official.includes(c));
      else isCorrect = chosen.length === official.length && chosen.every((c, k) => c === official[k]);
    }

    if (isCorrect) correctCount += 1;
    else wrongList.push(q);

    if (!bySubj[q.subject]) bySubj[q.subject] = { total: 0, correct: 0 };
    bySubj[q.subject].total += 1;
    if (isCorrect) bySubj[q.subject].correct += 1;

    state.progress.answers[q.id] = {
      correct: isCorrect,
      chosen,
      subject: q.subject,
      ts: Date.now(),
    };

    const statusBadge =
      chosen.length === 0
        ? `<span style="color:#64748b; font-weight:700;">未解答</span>`
        : isCorrect
        ? `<span style="color:#059669; font-weight:800;">⭕ 正解</span>`
        : `<span style="color:#dc2626; font-weight:800;">❌ 不正解</span>`;

    rowsHtml.push(`
      <tr>
        <td>${idx + 1}</td>
        <td><strong>第${q.exam}回 問${q.q_no}</strong></td>
        <td>${escapeHtml(q.subject)}</td>
        <td>${statusBadge}</td>
        <td>${spentHtml}</td>
        <td>${official.join("・")}</td>
        <td><button type="button" class="btn btn-secondary btn-sm js-mock-open-q" data-idx="${idx}">復習・解説</button></td>
      </tr>
    `);
  });

  const denom = Math.max(1, validTotal);
  state.mock.lastWrongQuestions = wrongList;
  const pct = Math.round((correctCount / denom) * 100);
  const avgSec = Math.round(elapsedSec / denom);
  const passLine = state.mock.title.includes("必須") ? 70 : 65;

  // 必須フル模試の場合は本番の足切りルール（各科目30%以上）も判定！
  const cutoffFails = [];
  if (state.mock.isHissuFull) {
    Object.entries(bySubj).forEach(([sub, d]) => {
      if (d.total > 0 && (d.correct / d.total) * 100 < 30) {
        cutoffFails.push(`${sub}(${Math.round((d.correct / d.total) * 100)}%)`);
      }
    });
  }
  const isPass = pct >= passLine && cutoffFails.length === 0;

  // ローカル模試履歴に保存
  if (!state.progress.mockHistory) state.progress.mockHistory = [];
  state.progress.mockHistory.unshift({
    ts: `${todayKey().slice(5)} ${nowTimeStr().slice(0, 5)}`,
    title: state.mock.title,
    correct: correctCount,
    total: denom,
    pct,
    elapsedSec,
    pass: isPass,
  });
  if (state.progress.mockHistory.length > 30) state.progress.mockHistory.length = 30;

  // 日別カウント＆お父さんの裏見守りレポートに模試結果を送信
  const dKey = todayKey();
  if (!state.progress.daily[dKey]) {
    state.progress.daily[dKey] = { count: 0, correct: 0, minutes: 1, lastActive: nowTimeStr() };
  }
  state.progress.daily[dKey].count += denom;
  state.progress.daily[dKey].correct += correctCount;
  state.progress.daily[dKey].minutes = Math.max(
    state.progress.daily[dKey].minutes || 0,
    Math.max(1, Math.ceil(elapsedSec / 60))
  );
  recordActivity(
    "mock_finish",
    `${correctCount}/${denom} (${pct}%) ${formatMinSec(elapsedSec)}`,
    state.mock.title,
    isPass
  );

  // 結果画面描画
  const cutoffMsg =
    cutoffFails.length > 0
      ? `<div style="margin-top:6px; font-size:13px; color:#b91c1c; font-weight:800;">⚠️ 必須足切り注意（30%未満の科目）：${escapeHtml(cutoffFails.join("・"))}</div>`
      : state.mock.isHissuFull
      ? `<div style="margin-top:4px; font-size:12px; color:#065f46; font-weight:700;">✅ 必須科目の足切り基準（全科目30%以上）クリア！</div>`
      : "";

  const hero = document.getElementById("mockResultHero");
  hero.className = `mock-result-hero ${isPass ? "pass" : "fail"}`;
  hero.innerHTML = `
    <div style="font-size:13px; font-weight:800; color:${isPass ? "#065f46" : "#991b1b"};">
      ${escapeHtml(state.mock.title)}${timeUp ? "（時間終了）" : ""}
    </div>
    <div class="mock-score-big" style="color:${isPass ? "#059669" : "#dc2626"};">
      ${correctCount} / ${denom} 問（${pct}%）
    </div>
    <div style="font-size:14px; font-weight:700; color:${isPass ? "#065f46" : "#991b1b"};">
      ${isPass ? `🎉 合格基準目安（${passLine}%以上）クリア！素晴らしい結果です！` : `💪 合格基準目安（${passLine}%以上）まであと少し！間違えた問題を復習しましょう`}
    </div>
    ${cutoffMsg}
  `;

  document.getElementById("mockResultKpis").innerHTML = `
    <div class="kpi-card"><div class="kpi-label">所要時間（開始〜終了）</div><div class="kpi-val">${formatMinSec(elapsedSec)}</div></div>
    <div class="kpi-card"><div class="kpi-label">1問あたり平均時間</div><div class="kpi-val">${avgSec}秒</div></div>
    <div class="kpi-card"><div class="kpi-label">正解数</div><div class="kpi-val" style="color:var(--success);">${correctCount}問</div></div>
    <div class="kpi-card"><div class="kpi-label">間違い・未解答</div><div class="kpi-val" style="color:var(--danger);">${wrongList.length}問</div></div>
  `;

  const subjEl = document.getElementById("mockResultSubjects");
  subjEl.innerHTML = "";
  Object.entries(bySubj).forEach(([sub, d]) => {
    const sp = Math.round((d.correct / d.total) * 100);
    const barColor = state.mock.isHissuFull && sp < 30 ? "#dc2626" : "linear-gradient(90deg, #0f766e, #14b8a6)";
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span style="font-weight:700;">${escapeHtml(sub)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${sp}%; background:${barColor};"></div></div>
      <span style="text-align:right; font-weight:700;">${sp}% (${d.correct}/${d.total})</span>
    `;
    subjEl.appendChild(row);
  });

  const tbody = document.querySelector("#mockResultTable tbody");
  tbody.innerHTML = rowsHtml.join("");
  tbody.querySelectorAll(".js-mock-open-q").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      state.filteredQuestions = [...state.mock.questions];
      state.currentIndex = idx;
      document.getElementById("examMatchCount").textContent = `模試の全${state.filteredQuestions.length}問を復習中`;
      switchExamSubMode("practice");
      renderCurrentQuestion();
      revealCurrentAnswerOnly();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  document.getElementById("mockRunPanel").style.display = "none";
  document.getElementById("mockResultPanel").style.display = "block";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// =========================================================================
// ユーティリティ
// =========================================================================
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

document.addEventListener("DOMContentLoaded", init);
