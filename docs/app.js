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
const PARENT_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbwz34ohkIf15dmLQmkrkjE5DAq87QQJLs9Xuy4lHTGANkVhbHTN-3RRuEpDZZ_SbQ_H3A/exec";

// 起動パスワードのSHA-256ハッシュ（初期パスワード: yakugaku2026）
const AUTH_HASH = "6abed39429b147f70634cb1fc554069f2e53d6bbf03487daac82bead1a050af2";
const AUTH_SESSION_KEY = "pharma_exam_auth_ok_v1";

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
  largeFont: false,
  pdfImgVisible: false,

  // 法令・○×・比較表
  studyPack: null,
  activeLawIdx: -1, // -1 = 全法令横断
  redSheetOn: false,
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
  };
}

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
  } catch (_) {}
  updateSidebarStats();
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

/**
 * 裏側で静かにGoogleスプレッドシートへ送信（エラー時も画面には一切出さない）
 */
function sendSilentParentLog(event, qid, subject, isCorrect) {
  if (!PARENT_WEBHOOK_URL) return;
  try {
    const stats = getOverallStats();
    const payload = {
      event,
      qid: qid || "",
      subject: subject || "",
      correct: isCorrect,
      todayCount: stats.todayCount,
      totalCount: stats.total,
      accuracy: stats.acc,
      todayMinutes: getTodayMinutes(),
      deviceId: state.progress.deviceId,
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
  const resp = await fetch(`./data/exams/exam_${examNum}.json`);
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
  const resp = await fetch("./data/laws/study_pack.json");
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
  document.querySelectorAll(".view-section").forEach((s) => s.classList.remove("active"));
  const el = document.getElementById(`view-${viewName}`);
  if (el) el.classList.add("active");

  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-view") === viewName);
  });

  if (viewName === "dashboard") {
    renderDashboard();
  }
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
    document.getElementById("qImages").style.display = state.pdfImgVisible ? "flex" : "none";
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
  const useTextMode = Boolean(q.can_shuffle && q.stem && q.choices && q.choices.length > 0);
  const stemBox = document.getElementById("qStemBox");
  const imgBox = document.getElementById("qImages");
  const pdfToggleBtn = document.getElementById("btnTogglePdfImg");

  imgBox.innerHTML = "";
  (q.images || []).forEach((src, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "q-img-wrap";
    if (q.has_lead && src.includes("lead_")) {
      const tag = document.createElement("div");
      tag.className = "lead-tag";
      tag.textContent = "📌 共通の症例・処方箋・リード文（タップで拡大）";
      wrap.appendChild(tag);
    }
    const img = document.createElement("img");
    img.src = `./${src}`;
    img.alt = `第${q.exam}回 問${q.q_no}`;
    img.loading = idx === 0 ? "eager" : "lazy";
    img.addEventListener("click", () => {
      document.getElementById("zoomImgTarget").src = img.src;
      document.getElementById("zoomModal").classList.add("open");
    });
    wrap.appendChild(img);
    imgBox.appendChild(wrap);
  });

  if (useTextMode) {
    stemBox.style.display = "block";
    stemBox.textContent = q.stem;
    state.pdfImgVisible = Boolean(q.show_img_alongside);
    imgBox.style.display = state.pdfImgVisible ? "flex" : "none";
    pdfToggleBtn.style.display = "inline-flex";
    pdfToggleBtn.textContent = state.pdfImgVisible ? "📄 試験用紙を隠す" : "📄 元の試験用紙を見る";
  } else {
    stemBox.style.display = "none";
    state.pdfImgVisible = true;
    imgBox.style.display = "flex";
    pdfToggleBtn.style.display = "none";
  }

  // 選択肢ボタン
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
      " ※図表・構造式問題のため試験用紙のまま表示（画像タップで拡大できます）";
  }

  const choicesEl = document.getElementById("qChoices");
  choicesEl.innerHTML = "";
  if (useTextMode) {
    choicesEl.className = "choices-cards";
    const list = q.choices.map((c) => ({ ...c }));
    if (state.shuffleChoices) {
      shuffleArray(list);
    }
    const letters = ["A", "B", "C", "D", "E", "F"];
    list.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice-card-btn";
      btn.dataset.choice = String(item.orig);
      const label = state.shuffleChoices ? letters[idx] || String(idx + 1) : String(item.orig);
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
  });

  document.getElementById("lawSearch").addEventListener("input", () => renderLawArticles());
}

function renderLawView() {
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

  const shown = matched.slice(0, 80);
  container.innerHTML = "";
  if (shown.length === 0) {
    container.innerHTML = `<div class="card">該当する条文が見つかりません。別のキーワードでお試しください。</div>`;
    return;
  }

  const countNote = document.createElement("div");
  countNote.style.cssText = "font-size:12px; font-weight:700; color:var(--text-sub); margin-bottom:10px;";
  countNote.textContent = `該当条文：${matched.length}件${matched.length > 80 ? "（先頭80件を表示）" : ""}`;
  container.appendChild(countNote);

  shown.forEach(({ lawShort, art }) => {
    const div = document.createElement("div");
    div.className = "article-card";
    const bodyHtml = highlightClozeHtml(escapeHtml(art.body), art.keywords || []);
    div.innerHTML = `
      <div class="article-head">
        <span class="badge badge-subj">${escapeHtml(lawShort)}</span>
        <span class="article-title">${escapeHtml(art.title)}</span>
        <span class="article-caption">${escapeHtml(art.caption || "")}</span>
      </div>
      <div class="article-body">${bodyHtml}</div>
    `;
    div.querySelectorAll(".cloze").forEach((span) => {
      span.addEventListener("click", () => span.classList.toggle("revealed"));
    });
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
    sendSilentParentLog("test_ping", "TEST", "接続テスト", true);
    alert("テスト記録を送信しました。数秒後に「クラウドから最新レポート取得」を押して確認してください。");
  });
}

function openParentModal() {
  document.getElementById("parentModal").classList.add("open");
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
            <td>${escapeHtml(r.event)}</td>
            <td>${escapeHtml(r.subject)}</td>
            <td>${escapeHtml(r.qid)}</td>
            <td><strong>${escapeHtml(r.result)}</strong></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" style="text-align:center;color:var(--text-sub);">まだ記録がありません</td></tr>`;
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
