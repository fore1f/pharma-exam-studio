"""既存の過去問JSON（exam_107〜111.json）から問題文と選択肢1〜5を高精度に分離するスクリプト。

文章で成り立つ問題には `stem`（問題文）と `choices`（選択肢配列）および `can_shuffle: true` を付与し、
化学構造式・グラフ・複雑な数式が選択肢になっている問題は安全に `can_shuffle: false` とする。
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

EXAMS_DIR = Path("docs/data/exams")
EXAM_NUMS = [111, 110, 109, 108, 107, 106, 105, 104, 103, 102]

# 図・構造式・グラフ・処方箋など、元画像も併せて見せるべきキーワード
FIGURE_HINT_RE = re.compile(
    r"(下図|下の図|右図|次の図|図[1-9１-９]|グラフ|構造式|化学式|反応式|スペクトル|模式図|処方[箋せん]|次の表|下表|以下の表|検査値)"
)

# 選択肢自体が図・画像・複雑数式になりやすいキーワード
CHOICE_IMG_ONLY_RE = re.compile(
    r"(構造式はどれか|構造はどれか|グラフはどれか|曲線はどれか|スペクトルはどれか|模式図はどれか|図はどれか)"
)


def _normalize_line(line: str) -> str:
    """行頭の全角数字を半角に寄せて判定しやすくする。"""
    return line.replace("\u3000", " ").strip()


def parse_stem_and_choices(
    text: str,
    max_choice: int,
    has_lead: bool,
) -> tuple[str, list[dict[str, Any]], bool, bool]:
    """テキストから (stem, choices, can_shuffle, show_img_alongside) を返す。"""
    if not text or max_choice > 6:
        return "", [], False, True

    lines = [_normalize_line(ln) for ln in text.splitlines() if ln.strip()]
    if not lines:
        return "", [], False, True

    # 選択肢行の開始インデックスを後ろ側から探索（問題文中の箇条書き「1 ...」と誤認しないため）
    # 1, 2, 3, 4, 5 が昇順に並ぶ最後のブロックを探す
    choice_starts: dict[int, int] = {}
    choice_re = re.compile(r"^([1-6１-６])[\s\u3000]+(.+)$")

    # 後ろから走査して max_choice -> 1 の順に見つける
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

    # 昇順確認
    indices = [choice_starts[n] for n in range(1, max_choice + 1)]
    if indices != sorted(indices):
        return "", [], False, True

    first_choice_idx = indices[0]
    if first_choice_idx == 0:
        return "", [], False, True

    stem_lines = lines[:first_choice_idx]
    stem = _join_japanese_lines(stem_lines)

    # 選択肢自体が図・構造式を直接選ぶ問題なら安全のため画像モード維持
    if CHOICE_IMG_ONLY_RE.search(stem):
        return "", [], False, True

    choices: list[dict[str, Any]] = []
    for n in range(1, max_choice + 1):
        start_i = choice_starts[n]
        end_i = choice_starts[n + 1] if n < max_choice else len(lines)
        c_lines = lines[start_i:end_i]
        first_m = choice_re.match(c_lines[0])
        if not first_m:
            return "", [], False, True
        body_parts = [first_m.group(2).strip()] + c_lines[1:]
        c_text = _join_japanese_lines(body_parts)

        # 明らかに壊れた選択肢（空、または2文字未満の記号だけ、極端に長いゴミ）を除外
        if not c_text or len(c_text) > 260:
            return "", [], False, True
        choices.append({"orig": n, "text": c_text})

    # 選択肢のテキストがすべて極端に短い（例：分数や構造式の断片だけ）場合を除外
    avg_len = sum(len(c["text"]) for c in choices) / len(choices)
    if avg_len < 2.0:
        return "", [], False, True

    # 連問や図表・処方箋・表を含む場合は、問題文の下に元画像も自動表示する
    show_img_alongside = has_lead or bool(FIGURE_HINT_RE.search(stem))
    return stem, choices, True, show_img_alongside


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
            # 行末が句点や記号、または次行が「問」「【」「（」「1」等の見出しなら改行維持
            if re.match(r"^(問\s*\d|【|〈|＜|［|（[1-9１-９]|ア|イ|ウ|エ|オ|[a-e]\s)", s):
                out.append("\n" + s)
            elif prev.endswith(("。", "：", ":")):
                out.append("\n" + s)
            else:
                out.append(s)
    return "".join(out)


def main() -> None:
    """全5回分のJSONに選択肢シャッフル用データを付与する。"""
    total_q = 0
    total_shuffle = 0
    for exam_num in EXAM_NUMS:
        path = EXAMS_DIR / f"exam_{exam_num}.json"
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        shufflable = 0
        for q in data["questions"]:
            stem, choices, can_shuffle, show_img = parse_stem_and_choices(
                q.get("text", ""),
                q.get("max_choice", 5),
                q.get("has_lead", False),
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
        logger.info("第%d回: シャッフル対応 %d / %d 問", exam_num, shufflable, len(data["questions"]))

    logger.info("完了: 合計 %d / %d 問 (%.1f%%) が選択肢シャッフル＆スマホ拡大表示に対応", total_shuffle, total_q, total_shuffle / max(1, total_q) * 100)


if __name__ == "__main__":
    main()
