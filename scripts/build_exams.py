"""厚生労働省の公式薬剤師国家試験PDFから過去問データベースを構築するスクリプト。

第111回・第110回・第109回の問題PDFと正答PDFを取得し、
Webアプリ（docs/data/exams/）で使用する軽量JSONおよび問題画像（JPEG）を生成する。
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

import httpx
import pymupdf
from bs4 import BeautifulSoup

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

BASE_URL = "https://www.mhlw.go.jp"
EXAM_PAGES: dict[int, dict[str, str]] = {
    111: {
        "year": "令和8年（2026年）",
        "url": "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000198929.html",
    },
    110: {
        "year": "令和7年（2025年）",
        "url": "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000198928.html",
    },
    109: {
        "year": "令和6年（2024年）",
        "url": "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000198926.html",
    },
    108: {
        "year": "令和5年（2023年）",
        "url": "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000198925.html",
    },
    107: {
        "year": "令和4年（2022年）",
        "url": "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000198924.html",
    },
}

RAW_DIR = Path("raw_pdfs")
DOCS_DATA_DIR = Path("docs/data")
EXAMS_OUT_DIR = DOCS_DATA_DIR / "exams"
IMAGES_OUT_DIR = DOCS_DATA_DIR / "images"

VALID_SUBJECTS = {
    "物理",
    "化学",
    "生物",
    "衛生",
    "薬理",
    "薬剤",
    "病態",
    "法規",
    "実務",
}

SUBJECT_FULL_NAMES: dict[str, str] = {
    "物理": "物理",
    "化学": "化学",
    "生物": "生物",
    "衛生": "衛生",
    "薬理": "薬理",
    "薬剤": "薬剤",
    "病態": "病態・薬物治療",
    "法規": "法規・制度・倫理",
    "実務": "実務",
}


def get_section_name(q_no: int) -> str:
    """問題番号から試験区分（必須・理論・実践）を返す。"""
    if 1 <= q_no <= 90:
        return "必須"
    if 91 <= q_no <= 195:
        return "理論"
    return "実践"


def download_exam_pdfs(exam_num: int, page_url: str) -> dict[str, Path]:
    """指定回の問題PDF6本と正答PDFをダウンロードし、ローカルパス辞書を返す。"""
    exam_dir = RAW_DIR / str(exam_num)
    exam_dir.mkdir(parents=True, exist_ok=True)

    logger.info("第%d回 ページ取得: %s", exam_num, page_url)
    resp = httpx.get(page_url, follow_redirects=True, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.content, "html.parser")

    pdf_map: dict[str, str] = {}
    for a in soup.find_all("a"):
        href = str(a.get("href", ""))
        text = a.get_text(strip=True)
        if ".pdf" not in href.lower():
            continue
        full_url = href if href.startswith("http") else f"{BASE_URL}{href}"
        if "1日目(1)" in text or "１日目(1)" in text or "１日目（１）" in text or "必須問題" in text:
            pdf_map.setdefault("day1_1", full_url)
        elif "1日目(2)" in text or "１日目(2)" in text or "１日目（２）" in text:
            pdf_map["day1_2"] = full_url
        elif "1日目(3)" in text or "１日目(3)" in text or "１日目（３）" in text:
            pdf_map["day1_3"] = full_url
        elif "2日目(1)" in text or "２日目(1)" in text or "２日目（１）" in text:
            pdf_map["day2_1"] = full_url
        elif "2日目(2)" in text or "２日目(2)" in text or "２日目（２）" in text:
            pdf_map["day2_2"] = full_url
        elif "2日目(3)" in text or "２日目(3)" in text or "２日目（３）" in text:
            pdf_map["day2_3"] = full_url
        elif "正答" in text:
            pdf_map["ans"] = full_url

    local_paths: dict[str, Path] = {}
    for key, url in pdf_map.items():
        dest = exam_dir / f"{key}.pdf"
        if not dest.exists() or dest.stat().st_size < 1000:
            logger.info("  ダウンロード中: %s -> %s", key, dest.name)
            r = httpx.get(url, follow_redirects=True, timeout=60)
            r.raise_for_status()
            dest.write_bytes(r.content)
        local_paths[key] = dest

    return local_paths


def parse_answers_pdf(ans_pdf: Path) -> dict[int, dict[str, Any]]:
    """正答PDFから単語座標ベースで全345問の科目と正答情報を100%抽出する。"""
    doc = pymupdf.open(ans_pdf)
    results: dict[int, dict[str, Any]] = {}

    for page in doc:
        # words: (x0, y0, x1, y1, word, block_no, line_no, word_no)
        words = page.get_text("words")
        # 5つのカラム帯を「問No」のX座標から自動検出
        q_header_xs = sorted(
            round(w[0], 1) for w in words if w[4].replace(" ", "") in ("問No", "問No.", "問")
        )
        # 近接Xをマージ
        col_starts: list[float] = []
        for x in q_header_xs:
            if not col_starts or x - col_starts[-1] > 40:
                col_starts.append(x - 10.0)

        if len(col_starts) < 3:
            # フォールバック（5列均等）
            w_page = page.rect.width
            col_starts = [w_page * i / 5.0 for i in range(5)]

        col_bounds: list[tuple[float, float]] = []
        for i, sx in enumerate(col_starts):
            ex = col_starts[i + 1] if i + 1 < len(col_starts) else page.rect.width
            col_bounds.append((sx, ex))

        for sx, ex in col_bounds:
            col_words = [w for w in words if sx <= w[0] < ex]
            # Y座標で同じ行にグルーピング（許容差 ±4.5pt）
            col_words.sort(key=lambda w: (w[1], w[0]))
            rows_grouped: list[list[tuple[Any, ...]]] = []
            for w in col_words:
                if not rows_grouped or abs(w[1] - rows_grouped[-1][0][1]) > 4.5:
                    rows_grouped.append([w])
                else:
                    rows_grouped[-1].append(w)

            for rwords in rows_grouped:
                rwords.sort(key=lambda w: w[0])
                tokens = [w[4].strip() for w in rwords if w[4].strip()]
                if len(tokens) < 2:
                    continue
                if not tokens[0].isdigit():
                    continue
                q_no = int(tokens[0])
                if not (1 <= q_no <= 345):
                    continue
                if tokens[1] not in VALID_SUBJECTS:
                    continue

                subject = tokens[1]
                ans_joined = " ".join(tokens[2:])
                answers: list[int] = []
                note = ""
                multi_mode = "exact"

                if "解なし" in ans_joined or "全員正解" in ans_joined or "除外" in ans_joined:
                    multi_mode = "none"
                    note = "採点除外・解なし（公式発表）"
                elif "※" in ans_joined or "複数" in ans_joined:
                    digits = sorted({int(d) for d in re.findall(r"[1-6]", ans_joined)})
                    answers = digits
                    multi_mode = "any"
                    note = "複数の正答パターンあり（公式正答表の※印対象）"
                else:
                    digits = sorted({int(d) for d in re.findall(r"[1-6]", ans_joined)})
                    answers = digits
                    if not answers:
                        multi_mode = "none"
                        note = "採点除外・特殊採点"

                results[q_no] = {
                    "subject": SUBJECT_FULL_NAMES.get(subject, subject),
                    "subject_short": subject,
                    "answers": answers,
                    "multi_mode": multi_mode,
                    "note": note,
                }

    doc.close()
    logger.info("  正答抽出完了: %d / 345 問", len(results))
    return results


def _normalize_digits(text: str) -> str:
    """全角数字を半角に変換する。"""
    return text.translate(str.maketrans("０１２３４５６７８９−―‐－〜～", "0123456789------"))


def extract_questions_from_pdf(
    pdf_path: Path,
    exam_num: int,
    img_dir: Path,
) -> dict[int, dict[str, Any]]:
    """問題PDFから各問題のテキスト・選択肢・切り出し画像を抽出する。"""
    doc = pymupdf.open(pdf_path)
    img_dir.mkdir(parents=True, exist_ok=True)

    # ページ内のイベント（リード文開始 / 問N開始）を座標付きで収集
    lead_pattern = re.compile(r"^問\s*(\d{1,3})\s*[-]\s*(\d{1,3})")
    single_pattern = re.compile(r"^問\s*(\d{1,3})(?!\s*[-])")

    # 連問リード文を格納: {q_no: [lead_img_rel_path, ...]} と {q_no: lead_text}
    lead_images: dict[int, list[str]] = {}
    lead_texts: dict[int, str] = {}

    # 各問題のセグメント: {q_no: [(page_idx, y0, y1, text), ...]}
    q_segments: dict[int, list[tuple[int, float, float, str]]] = {}

    current_type: str | None = None  # "lead" or "q"
    current_q: int | None = None
    current_lead_qs: list[int] = []
    lead_segments: list[tuple[list[int], int, float, float, str]] = []

    for page_idx in range(len(doc)):
        page = doc[page_idx]
        rect = page.rect
        page_h = rect.height
        page_w = rect.width

        # 表紙・注意事項ページ（1ページ目）をスキップ
        if page_idx == 0:
            continue

        # ブロック単位でテキストとY座標を取得（上から順にソート）
        blocks = page.get_text("blocks")
        blocks.sort(key=lambda b: (round(b[1], 1), round(b[0], 1)))

        # ヘッダ（ページ番号の「― 1 ―」など）を除外し、イベント位置を特定
        header_cut_y = 55.0
        footer_cut_y = page_h - 38.0

        events: list[tuple[float, str, Any]] = []
        for b in blocks:
            x0, y0, x1, y1, text, *_ = b
            if y1 < header_cut_y or y0 > footer_cut_y:
                continue
            # 左マージン付近にある「問 N」のみを問題見出しとして検出
            if x0 > page_w * 0.25:
                continue
            first_line = _normalize_digits(text.strip().splitlines()[0].strip()) if text.strip() else ""
            m_lead = lead_pattern.match(first_line)
            if m_lead:
                start_q = int(m_lead.group(1))
                end_q = int(m_lead.group(2))
                if 1 <= start_q <= end_q <= 345 and (end_q - start_q) <= 5:
                    events.append((max(header_cut_y, y0 - 6), "lead", list(range(start_q, end_q + 1))))
                    continue
            m_single = single_pattern.match(first_line)
            if m_single:
                q_no = int(m_single.group(1))
                if 1 <= q_no <= 345:
                    events.append((max(header_cut_y, y0 - 6), "q", q_no))

        # ページに有効なコンテンツがあるか確認（白紙ページ除外）
        body_text = page.get_text("text", clip=pymupdf.Rect(0, header_cut_y, page_w, footer_cut_y)).strip()
        if not body_text and not page.get_images():
            continue

        # ページ先頭（最初のイベント前）は直前の問題またはリード文の続き
        if not events:
            if current_type == "q" and current_q is not None:
                q_segments.setdefault(current_q, []).append((page_idx, header_cut_y, footer_cut_y, body_text))
            elif current_type == "lead" and current_lead_qs:
                lead_segments.append((current_lead_qs, page_idx, header_cut_y, footer_cut_y, body_text))
            continue

        first_ev_y = events[0][0]
        if first_ev_y > header_cut_y + 25:
            pre_text = page.get_text("text", clip=pymupdf.Rect(0, header_cut_y, page_w, first_ev_y)).strip()
            # 「必須問題 【...】」などの単なる区分見出しだけならスキップ
            if pre_text and not re.fullmatch(r"(必須問題|一般問題|薬学理論問題|薬学実践問題|【.*?】|\s)+", pre_text):
                if current_type == "q" and current_q is not None:
                    q_segments.setdefault(current_q, []).append((page_idx, header_cut_y, first_ev_y, pre_text))
                elif current_type == "lead" and current_lead_qs:
                    lead_segments.append((current_lead_qs, page_idx, header_cut_y, first_ev_y, pre_text))

        # 各イベント区間を登録
        for idx, (ev_y, ev_type, ev_val) in enumerate(events):
            next_y = events[idx + 1][0] if idx + 1 < len(events) else footer_cut_y
            seg_text = page.get_text("text", clip=pymupdf.Rect(0, ev_y, page_w, next_y)).strip()
            if ev_type == "lead":
                current_type = "lead"
                current_lead_qs = ev_val
                current_q = None
                lead_segments.append((ev_val, page_idx, ev_y, next_y, seg_text))
            else:
                current_type = "q"
                current_q = ev_val
                q_segments.setdefault(ev_val, []).append((page_idx, ev_y, next_y, seg_text))

    # リード文画像を書き出し
    for qs, page_idx, y0, y1, seg_text in lead_segments:
        page = doc[page_idx]
        # 実際の描画・テキストの下端にトリミングして余白を削減
        y1_tight = _tighten_bottom(page, y0, y1)
        if y1_tight - y0 < 15:
            continue
        lead_key = f"lead_{qs[0]:03d}_{qs[-1]:03d}_p{page_idx}"
        out_file = img_dir / f"{lead_key}.jpg"
        _render_clip(page, y0, y1_tight, out_file)
        rel_path = f"data/images/{exam_num}/{lead_key}.jpg"
        for q_no in qs:
            lead_images.setdefault(q_no, []).append(rel_path)
            lead_texts[q_no] = (lead_texts.get(q_no, "") + "\n" + seg_text).strip()

    # 各問題の画像とテキストを書き出し
    extracted: dict[int, dict[str, Any]] = {}
    for q_no, segs in q_segments.items():
        img_paths: list[str] = list(lead_images.get(q_no, []))
        full_text_parts: list[str] = []
        if q_no in lead_texts:
            full_text_parts.append(lead_texts[q_no])

        for s_idx, (page_idx, y0, y1, seg_text) in enumerate(segs):
            page = doc[page_idx]
            y1_tight = _tighten_bottom(page, y0, y1)
            if y1_tight - y0 < 15:
                continue
            fname = f"q{q_no:03d}_{s_idx}.jpg" if len(segs) > 1 else f"q{q_no:03d}.jpg"
            out_file = img_dir / fname
            _render_clip(page, y0, y1_tight, out_file)
            img_paths.append(f"data/images/{exam_num}/{fname}")
            full_text_parts.append(seg_text)

        combined_text = "\n".join(p for p in full_text_parts if p).strip()
        # 検索用・プレビュー用の要約（先頭140文字）
        snippet = re.sub(r"\s+", " ", combined_text)[:140]
        extracted[q_no] = {
            "text": combined_text,
            "snippet": snippet,
            "images": img_paths,
            "has_lead": q_no in lead_images,
        }

    doc.close()
    return extracted


def _tighten_bottom(page: pymupdf.Page, y0: float, y1: float) -> float:
    """クリップ領域内のテキスト・画像・ベクター図形の下端に合わせて余白を詰める。"""
    max_y = y0 + 20.0
    clip = pymupdf.Rect(0, y0, page.rect.width, y1)

    for b in page.get_text("blocks", clip=clip):
        if b[4].strip():
            max_y = max(max_y, min(b[3], y1))

    for img in page.get_image_info(xrefs=False):
        bbox = img.get("bbox")
        if bbox and bbox[3] > y0 and bbox[1] < y1:
            max_y = max(max_y, min(bbox[3], y1))

    for d in page.get_drawings():
        r = d.get("rect")
        if r and r.y1 > y0 and r.y0 < y1 and (r.y1 - r.y0) < (y1 - y0) * 0.95:
            max_y = max(max_y, min(r.y1, y1))

    return min(y1, max_y + 12.0)


def _render_clip(page: pymupdf.Page, y0: float, y1: float, out_path: Path) -> None:
    """指定Y範囲をJPEG画像として保存する（軽量かつ文字くっきり）。"""
    if out_path.exists() and out_path.stat().st_size > 1000:
        return
    margin_x = 24.0
    clip = pymupdf.Rect(margin_x, y0, page.rect.width - margin_x, y1)
    mat = pymupdf.Matrix(1.65, 1.65)
    pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
    pix.save(str(out_path), jpg_quality=82)


def build_exam(exam_num: int) -> dict[str, Any]:
    """指定回の全データを生成してJSON保存し、サマリーを返す。"""
    info = EXAM_PAGES[exam_num]
    pdf_paths = download_exam_pdfs(exam_num, info["url"])

    if "ans" not in pdf_paths:
        raise RuntimeError(f"第{exam_num}回の正答PDFが見つかりません")

    answers_map = parse_answers_pdf(pdf_paths["ans"])
    img_dir = IMAGES_OUT_DIR / str(exam_num)

    questions_map: dict[int, dict[str, Any]] = {}
    for key in ["day1_1", "day1_2", "day1_3", "day2_1", "day2_2", "day2_3"]:
        if key not in pdf_paths:
            logger.warning("第%d回 %s PDFが見つかりません", exam_num, key)
            continue
        logger.info("第%d回 解析中: %s", exam_num, key)
        part = extract_questions_from_pdf(pdf_paths[key], exam_num, img_dir)
        questions_map.update(part)

    # 345問を統合
    items: list[dict[str, Any]] = []
    subject_counts: dict[str, int] = {}
    for q_no in range(1, 346):
        ans_info = answers_map.get(q_no, {})
        q_info = questions_map.get(q_no, {})
        subject = ans_info.get("subject", "その他")
        subject_counts[subject] = subject_counts.get(subject, 0) + 1

        # 選択肢数の推定（基本5択、一部6択以上あり）
        ans_list: list[int] = ans_info.get("answers", [])
        max_choice = max(5, max(ans_list) if ans_list else 5)
        select_count = 2 if (ans_info.get("multi_mode") == "exact" and len(ans_list) == 2) else 1
        if "２つ選べ" in q_info.get("text", "") or "2つ選べ" in q_info.get("text", ""):
            select_count = 2
        elif "３つ選べ" in q_info.get("text", "") or "3つ選べ" in q_info.get("text", ""):
            select_count = 3

        items.append(
            {
                "id": f"{exam_num}-{q_no:03d}",
                "exam": exam_num,
                "q_no": q_no,
                "section": get_section_name(q_no),
                "subject": subject,
                "subject_short": ans_info.get("subject_short", "その他"),
                "answers": ans_list,
                "multi_mode": ans_info.get("multi_mode", "exact"),
                "select_count": select_count,
                "max_choice": max_choice,
                "note": ans_info.get("note", ""),
                "snippet": q_info.get("snippet", f"第{exam_num}回 問{q_no}"),
                "text": q_info.get("text", ""),
                "images": q_info.get("images", []),
                "has_lead": q_info.get("has_lead", False),
            }
        )

    EXAMS_OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_json = EXAMS_OUT_DIR / f"exam_{exam_num}.json"
    payload = {
        "exam": exam_num,
        "year": info["year"],
        "total": len(items),
        "subject_counts": subject_counts,
        "questions": items,
    }
    out_json.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    missing_imgs = sum(1 for x in items if not x["images"])
    logger.info(
        "第%d回 完了: %d問（画像なし: %d問）-> %s",
        exam_num,
        len(items),
        missing_imgs,
        out_json,
    )
    return {
        "exam": exam_num,
        "year": info["year"],
        "total": len(items),
        "subject_counts": subject_counts,
        "file": f"data/exams/exam_{exam_num}.json",
    }


def main() -> None:
    """全対象回の過去問データを構築し、マニフェストを出力する。"""
    manifest_exams: list[dict[str, Any]] = []
    for exam_num in sorted(EXAM_PAGES.keys(), reverse=True):
        try:
            summary = build_exam(exam_num)
            manifest_exams.append(summary)
        except Exception as exc:
            logger.exception("第%d回の処理中にエラー: %s", exam_num, exc)

    manifest = {
        "exams": manifest_exams,
        "total_questions": sum(e["total"] for e in manifest_exams),
    }
    manifest_path = EXAMS_OUT_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("全処理完了: 合計 %d 問", manifest["total_questions"])


if __name__ == "__main__":
    main()
