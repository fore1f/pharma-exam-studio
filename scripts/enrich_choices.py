"""元の公式PDF（raw_pdfs/）をPyMuPDFで物理スキャンし、
数式・分数・上付き/下付き・化学式・表・図形を含まない「100%正確にテキスト化できる問題」
だけを安全に選択肢シャッフル＆大文字テキスト表示対象（can_shuffle: true）とするスクリプト。

数式・分数・指数・上付き下付き・表・構造式・グラフを含む問題は、
誤学習を完全に防ぐため can_shuffle: false（元の公式PDF画像をそのまま表示）とする。
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

import pymupdf

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

RAW_DIR = Path("raw_pdfs")
EXAMS_DIR = Path("docs/data/exams")
EXAM_NUMS = [111, 110, 109, 108, 107, 106, 105, 104, 103, 102]

# テキスト側でも二重チェックする数式・特殊レイアウト記号
MATH_SYMBOL_RE = re.compile(r"[∑∫√±×÷≠≦≧∞⇌→←↑↓⇔∂∇∝∴∵≡≒≪≫]")
# 上付き/下付き・化学式が潰れやすいパターン（英数字＋数字の上下付き、10の乗数、イオン表記など）
SUB_SUP_TEXT_RE = re.compile(
    r"(10[-−ー]\d|\b[A-Z][a-z]?\d+[+-]?\b|pKa|pKb|log\s*\d|ln\s*[a-zA-Z]|mol/L|mL/min|mg/dL|μg/mL|cm[-−]\d|s[-−]1)"
)
# 問題文で数式・図・表・構造式を直接問う表現
UNSAFE_STEM_RE = re.compile(
    r"(構造式|構造はどれか|グラフはどれか|曲線はどれか|スペクトル|模式図|図はどれか|求める式|関係式|反応式|化学式|示性式|電子式|下表|次の表|以下の表|組合せのうち|組合せとして)"
)
# 連問や図表参照（問題文上に元画像も並べるヒント）
FIGURE_HINT_RE = re.compile(
    r"(下図|下の図|右図|次の図|図[1-9１-９]|グラフ|処方[箋せん]|検査値)"
)
# 英数字・数式記号の小文字スパン（上付き・下付き検出用：ひらがなルビは除外）
SUPER_SUB_CHAR_RE = re.compile(r"[0-9０-９a-zA-Zａ-ｚＡ-Ｚ+\-−＝=/()\[\]α-ωΑ-Ω]")


def _normalize_digits(text: str) -> str:
    return text.translate(str.maketrans("０１２３４５６７８９−―‐－〜～", "0123456789------"))


def scan_pdf_question_hazards(exam_num: int) -> dict[int, dict[str, bool]]:
    """元のPDF全6本を物理スキャンし、各問題に数式・上付き下付き・図形・表があるか判定する。"""
    exam_dir = RAW_DIR / str(exam_num)
    hazards: dict[int, dict[str, bool]] = {}

    lead_pattern = re.compile(r"^問\s*(\d{1,3})\s*[-]\s*(\d{1,3})")
    single_pattern = re.compile(r"^問\s*(\d{1,3})(?!\s*[-])")

    for key in ["day1_1", "day1_2", "day1_3", "day2_1", "day2_2", "day2_3"]:
        pdf_path = exam_dir / f"{key}.pdf"
        if not pdf_path.exists():
            continue
        doc = pymupdf.open(pdf_path)

        current_type: str | None = None
        current_q: int | None = None

        for page_idx in range(1, len(doc)):
            page = doc[page_idx]
            page_h = page.rect.height
            page_w = page.rect.width
            header_cut_y = 55.0
            footer_cut_y = page_h - 38.0

            blocks = page.get_text("blocks")
            blocks.sort(key=lambda b: (round(b[1], 1), round(b[0], 1)))

            events: list[tuple[float, str, Any]] = []
            for b in blocks:
                x0, y0, x1, y1, text, *_ = b
                if y1 < header_cut_y or y0 > footer_cut_y or x0 > page_w * 0.25:
                    continue
                first_line = _normalize_digits(text.strip().splitlines()[0].strip()) if text.strip() else ""
                m_lead = lead_pattern.match(first_line)
                if m_lead:
                    sq, eq = int(m_lead.group(1)), int(m_lead.group(2))
                    if 1 <= sq <= eq <= 345 and (eq - sq) <= 5:
                        events.append((max(header_cut_y, y0 - 6), "lead", list(range(sq, eq + 1))))
                        continue
                m_single = single_pattern.match(first_line)
                if m_single:
                    qn = int(m_single.group(1))
                    if 1 <= qn <= 345:
                        events.append((max(header_cut_y, y0 - 6), "q", qn))

            # ページ全体の描画・画像を取得しておく
            page_drawings = page.get_drawings()
            page_images = page.get_image_info(xrefs=False)

            def _inspect_region(q_no: int, y0: float, y1: float) -> None:
                h = hazards.setdefault(
                    q_no,
                    {
                        "has_sub_sup": False,
                        "has_large_math": False,
                        "has_drawing": False,
                        "has_image": False,
                        "has_table_cols": False,
                    },
                )
                clip = pymupdf.Rect(0, y0, page_w, y1)

                # 1. フォントサイズ解析（上付き・下付き・大記号）＋多列レイアウト検出
                d = page.get_text("dict", clip=clip)
                multi_col_lines = 0
                for blk in d.get("blocks", []):
                    if blk.get("type") != 0:
                        continue
                    for line in blk.get("lines", []):
                        spans = [s for s in line.get("spans", []) if s.get("text", "").strip()]
                        if not spans:
                            continue
                        # 同一行内に大きな水平ギャップ（表や横並び選択肢）があるか
                        for i in range(len(spans) - 1):
                            gap = spans[i + 1]["bbox"][0] - spans[i]["bbox"][2]
                            if gap > 38.0 and spans[i]["bbox"][0] > 75.0:
                                multi_col_lines += 1
                        for s in spans:
                            sz = float(s.get("size", 12.0))
                            txt = s.get("text", "").strip()
                            if sz < 9.4 and SUPER_SUB_CHAR_RE.search(txt):
                                h["has_sub_sup"] = True
                            if sz > 14.5:
                                h["has_large_math"] = True
                if multi_col_lines >= 2:
                    h["has_table_cols"] = True

                # 2. ページ本文エリア内側のベクター描画（分数横線、化学構造式、空欄枠、グラフ、表罫線など）
                # ページ外側の印刷トンボを除外。
                # 問題文の「誤っているのはどれか」等の単なる強調下線（height<=2.5pt かつ width>=22pt）
                # だけは1〜2本まで許容し、分数横線(width<22pt)・空欄ボックス(height>=5pt)・図表は確実に検出！
                non_underline_drawings = 0
                underline_count = 0
                for dr in page_drawings:
                    r = dr.get("rect")
                    if not r:
                        continue
                    if r.x0 < 25.0 or r.x1 > (page_w - 25.0):
                        continue
                    if r.y0 < header_cut_y or r.y1 > footer_cut_y:
                        continue
                    if r.y1 > y0 + 2 and r.y0 < y1 - 2:
                        w_dr = r.x1 - r.x0
                        h_dr = r.y1 - r.y0
                        if h_dr >= (page_h * 0.75) or w_dr >= (page_w * 0.92):
                            continue
                        # 強調下線（細くて横に長い直線）
                        if h_dr <= 2.5 and w_dr >= 22.0:
                            underline_count += 1
                        else:
                            non_underline_drawings += 1
                if non_underline_drawings >= 1 or underline_count >= 4:
                    h["has_drawing"] = True

                # 3. ページ本文エリア内側の埋め込み画像
                for im in page_images:
                    bb = im.get("bbox")
                    if not bb:
                        continue
                    if bb[0] < 20.0 or bb[2] > (page_w - 20.0):
                        continue
                    if bb[3] > y0 + 2 and bb[1] < y1 - 2:
                        h["has_image"] = True

            if not events:
                if current_type == "q" and current_q is not None:
                    _inspect_region(current_q, header_cut_y, footer_cut_y)
                continue

            first_ev_y = events[0][0]
            if first_ev_y > header_cut_y + 25 and current_type == "q" and current_q is not None:
                _inspect_region(current_q, header_cut_y, first_ev_y)

            for idx, (ev_y, ev_type, ev_val) in enumerate(events):
                next_y = events[idx + 1][0] if idx + 1 < len(events) else footer_cut_y
                if ev_type == "lead":
                    current_type = "lead"
                    current_q = None
                else:
                    current_type = "q"
                    current_q = ev_val
                    _inspect_region(ev_val, ev_y, next_y)

        doc.close()

    return hazards


def _clean_page_headers_and_footers(lines: list[str]) -> list[str]:
    """PDFのページ番号（― 2 ― など）や区分見出し行を除去する。"""
    cleaned: list[str] = []
    skip_next_page_num = False
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        # 「― 　 ―」や「― 2 ―」のようなページ番号装飾行
        if re.fullmatch(r"[―ー−‐\-]+\s*\d*\s*[―ー−‐\-]+", s):
            skip_next_page_num = True
            continue
        if skip_next_page_num and re.fullmatch(r"\d{1,3}", s):
            skip_next_page_num = False
            continue
        skip_next_page_num = False
        # 単独の区分見出し（必須問題 【...】 等）
        if re.fullmatch(r"(必須問題|一般問題|薬学理論問題|薬学実践問題).*?【.*?】", s):
            continue
        cleaned.append(s)

    # 先頭が「問 N」より前の余計な行なら「問 N」の行から開始するようにトリミング
    for idx, ln in enumerate(cleaned):
        if re.match(r"^問\s*[0-9０-９]{1,3}", ln):
            if idx > 0 and idx <= 3:
                return cleaned[idx:]
            break
    return cleaned


def _join_japanese_lines(lines: list[str]) -> str:
    """PDFの折り返し改行を自然な日本語文章に結合する。"""
    out: list[str] = []
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        if not out:
            out.append(s)
        else:
            prev = out[-1]
            if re.match(r"^(問\s*\d|【|〈|＜|［|（[1-9１-９]|ア|イ|ウ|エ|オ|[a-e]\s)", s):
                out.append("\n" + s)
            elif prev.endswith(("。", "：", ":")):
                out.append("\n" + s)
            else:
                out.append(s)
    return "".join(out)


def parse_stem_and_choices_strict(
    text: str,
    max_choice: int,
    has_lead: bool,
    hazard: dict[str, bool],
) -> tuple[str, list[dict[str, Any]], bool, bool]:
    """厳格な安全基準を満たす純粋テキスト問題のみをシャッフル対象にする。"""
    # 物理PDF検査で数式・上付き/下付き・図形・画像・表が1つでもあれば即座に画像モード（安全最優先！）
    if (
        hazard.get("has_sub_sup")
        or hazard.get("has_large_math")
        or hazard.get("has_drawing")
        or hazard.get("has_image")
        or hazard.get("has_table_cols")
    ):
        return "", [], False, True

    if not text or max_choice > 6:
        return "", [], False, True

    # テキスト側の二重安全チェック（数式記号・潰れた上付き下付き）
    if MATH_SYMBOL_RE.search(text) or SUB_SUP_TEXT_RE.search(text):
        return "", [], False, True

    raw_lines = [ln.replace("\u3000", " ").strip() for ln in text.splitlines() if ln.strip()]
    lines = _clean_page_headers_and_footers(raw_lines)
    if not lines:
        return "", [], False, True

    # 選択肢行を後ろから探索
    choice_starts: dict[int, int] = {}
    choice_re = re.compile(r"^([1-6１-６])[\s\u3000]+(.+)$")
    target_num = max_choice
    for idx in range(len(lines) - 1, -1, -1):
        m = choice_re.match(lines[idx])
        if not m:
            continue
        num_str = m.group(1).translate(str.maketrans("１２３４５６", "123456"))
        num = int(num_str)
        if num == target_num:
            choice_starts[num] = idx
            target_num -= 1
            if target_num == 0:
                break

    if len(choice_starts) != max_choice:
        return "", [], False, True

    indices = [choice_starts[n] for n in range(1, max_choice + 1)]
    if indices != sorted(indices) or indices[0] == 0:
        return "", [], False, True

    stem = _join_japanese_lines(lines[: indices[0]])
    if UNSAFE_STEM_RE.search(stem):
        return "", [], False, True

    choices: list[dict[str, Any]] = []
    for n in range(1, max_choice + 1):
        start_i = choice_starts[n]
        end_i = choice_starts[n + 1] if n < max_choice else len(lines)
        c_lines = lines[start_i:end_i]
        first_m = choice_re.match(c_lines[0])
        if not first_m:
            return "", [], False, True
        c_text = _join_japanese_lines([first_m.group(2).strip()] + c_lines[1:])
        if not c_text or len(c_text) > 220:
            return "", [], False, True
        # 選択肢内に等号や計算式っぽい表現があれば安全のため除外
        if "＝" in c_text or "=" in c_text:
            return "", [], False, True
        choices.append({"orig": n, "text": c_text})

    avg_len = sum(len(c["text"]) for c in choices) / len(choices)
    if avg_len < 2.5:
        return "", [], False, True

    show_img_alongside = has_lead or bool(FIGURE_HINT_RE.search(stem))
    return stem, choices, True, show_img_alongside


def main() -> None:
    """全10年分のJSONに対して物理PDF検査つき厳格シャッフル判定を再実行する。"""
    total_q = 0
    total_shuffle = 0
    for exam_num in EXAM_NUMS:
        path = EXAMS_DIR / f"exam_{exam_num}.json"
        if not path.exists():
            continue
        hazards = scan_pdf_question_hazards(exam_num)
        data = json.loads(path.read_text(encoding="utf-8"))
        shufflable = 0
        for q in data["questions"]:
            h = hazards.get(q["q_no"], {})
            stem, choices, can_shuffle, show_img = parse_stem_and_choices_strict(
                q.get("text", ""),
                q.get("max_choice", 5),
                q.get("has_lead", False),
                h,
            )
            q["stem"] = stem
            q["choices"] = choices
            q["can_shuffle"] = can_shuffle
            q["show_img_alongside"] = show_img
            if can_shuffle:
                shufflable += 1
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        total_q += len(data["questions"])
        total_shuffle += shufflable
        logger.info("第%d回: 安全シャッフル対象 %d / %d 問（残りは100%%正確な試験用紙画像表示）", exam_num, shufflable, len(data["questions"]))

    logger.info(
        "完了: 合計 %d / %d 問 (%.1f%%) を安全シャッフル、%d 問を試験用紙PDF画像そのまま表示に確定",
        total_shuffle,
        total_q,
        total_shuffle / max(1, total_q) * 100,
        total_q - total_shuffle,
    )


if __name__ == "__main__":
    main()
