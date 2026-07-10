from __future__ import annotations

import math
import re
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..auth import Principal, get_principal, require_project_role
from ..db import get_db
from ..models import Dataset
from ..schemas import AssistProposalCreate, AssistProposalOut

router = APIRouter(prefix="/assist", tags=["assistant"])


@router.post("/proposals", response_model=AssistProposalOut)
def propose_operation(
    payload: AssistProposalCreate,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    dataset = db.get(Dataset, payload.dataset_id)
    if dataset is None:
        raise HTTPException(404, "dataset not found")
    require_project_role(db, dataset.project_id, principal)
    request.state.audit_project_id = dataset.project_id
    request.state.audit_resource_type = "assistant_proposal"
    request.state.audit_resource_id = dataset.id
    prompt = payload.prompt.casefold()
    scalars = [
        array
        for array in (dataset.arrays or [])
        if array.get("association") in {"point", "cell"}
        and int(array.get("num_components", 1)) == 1
    ]
    mentioned_scalar = next(
        (
            array
            for array in scalars
            if re.search(
                rf"(?<!\w){re.escape(str(array.get('name', '')).casefold())}(?!\w)",
                prompt,
            )
        ),
        None,
    )
    scalar = mentioned_scalar or (scalars[0] if scalars else None)

    operation_word = r"contour|isosurface|threshold|color(?:ing)?"
    explicit_name = (
        re.search(rf"(?P<name>[\w.-]+)\s+(?:{operation_word})\b", prompt)
        or re.search(
            rf"(?:{operation_word})\s+(?:(?:of|by|using)\s+)?(?P<name>[\w.-]+)",
            prompt,
        )
        or re.search(
            r"(?P<name>[\w.-]+)\s*(?:を|で|の)?\s*(?:色付け|着色|等値面?|閾値|しきい)",
            prompt,
        )
        or re.search(
            r"(?:色付け|着色|等値面?|閾値|しきい)\s*(?:を|で|の)?\s*"
            r"(?P<name>[a-z_][\w.-]*)",
            prompt,
        )
    )
    unknown_scalar = None
    if explicit_name and mentioned_scalar is None:
        candidate = explicit_name.group("name")
        if candidate not in {
            "a", "an", "the", "make", "create", "show", "add", "at", "with", "using"
        }:
            unknown_scalar = candidate

    def scalar_range(array: dict) -> tuple[float, float] | None:
        value_range = array.get("value_range")
        if not isinstance(value_range, (list, tuple)) or len(value_range) != 2:
            return None
        try:
            minimum, maximum = (float(value_range[0]), float(value_range[1]))
        except (TypeError, ValueError, OverflowError):
            return None
        if not math.isfinite(minimum) or not math.isfinite(maximum) or minimum > maximum:
            return None
        return (minimum, maximum)
    bounds = dataset.bounds or [0, 0, 0, 0, 0, 0]
    origin = [
        (float(bounds[0]) + float(bounds[1])) / 2,
        (float(bounds[2]) + float(bounds[3])) / 2,
        (float(bounds[4]) + float(bounds[5])) / 2,
    ]
    if "slice" in prompt or "断面" in prompt:
        def requested_axis(axis: str) -> bool:
            return bool(
                re.search(rf"(?<!\w){axis}(?:-axis|\s+axis)?(?!\w)", prompt)
                or f"{axis}軸" in prompt
                or f"{axis}方向" in prompt
            )

        normal = [1, 0, 0] if requested_axis("x") else ([0, 1, 0] if requested_axis("y") else [0, 0, 1])
        return AssistProposalOut(
            action="filter_job",
            params={"filter": "slice", "origin": origin, "normal": normal},
            reason="データ境界の中心を通る平面Sliceを提案します。",
        )
    if "clip" in prompt or "切り取り" in prompt:
        return AssistProposalOut(
            action="filter_job",
            params={"filter": "clip", "origin": origin, "normal": [0, 0, 1]},
            reason="データ境界中心のZ法線Clipを提案します。",
        )
    scalar_operation = any(
        keyword in prompt
        for keyword in ("contour", "isosurface", "等値", "threshold", "しきい", "閾値", "color", "色")
    )
    if scalar_operation and unknown_scalar:
        return AssistProposalOut(
            action="none",
            params={},
            reason=f"配列 {unknown_scalar!r} はデータセットに存在しません。",
        )
    if scalar and ("contour" in prompt or "isosurface" in prompt or "等値" in prompt):
        value_range = scalar_range(scalar)
        if value_range is None:
            return AssistProposalOut(
                action="none",
                params={},
                reason="スカラー範囲が不明なため、先にrangeを取得するか等値を明示してください。",
            )
        value = (value_range[0] + value_range[1]) / 2
        return AssistProposalOut(
            action="filter_job",
            params={
                "filter": "contour",
                "array": scalar["name"],
                "association": "CELLS" if scalar["association"] == "cell" else "POINTS",
                "value": value,
            },
            reason="選択したスカラー配列の範囲の中点でContourを提案します。",
        )
    if scalar and ("threshold" in prompt or "しきい" in prompt or "閾値" in prompt):
        value_range = scalar_range(scalar)
        if value_range is None:
            return AssistProposalOut(
                action="none",
                params={},
                reason="スカラー範囲が不明なためThreshold範囲を提案できません。",
            )
        return AssistProposalOut(
            action="filter_job",
            params={
                "filter": "threshold",
                "array": scalar["name"],
                "association": "CELLS" if scalar["association"] == "cell" else "POINTS",
                "minimum": float(value_range[0]),
                "maximum": float(value_range[1]),
            },
            reason="利用可能なスカラー範囲全体を初期Thresholdとして提案します。",
        )
    if scalar and ("color" in prompt or "色" in prompt):
        return AssistProposalOut(
            action="view_change",
            params={
                "color_by": {"name": scalar["name"], "association": scalar["association"]},
                "color_map": "viridis",
            },
            reason="最初のスカラー配列をViridisで着色する表示差分を提案します。",
        )
    return AssistProposalOut(
        action="none",
        params={},
        reason="実行可能な安全な提案を特定できません。Slice、Clip、Contour、Threshold、着色を指定してください。",
    )
