from __future__ import annotations

import math
import re
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import Principal, get_principal, require_project_role
from ..db import get_db
from ..jobs import manager
from ..models import AssistProposal, Dataset, Job
from ..project_locks import locked_project
from ..schemas import (
    AssistProposalCreate,
    AssistProposalOut,
    AssistProposalRecordOut,
    JobOut,
    validate_filter_params,
)
from ..services import run_dataset_operation

router = APIRouter(prefix="/assist", tags=["assistant"])


def _build_proposal(dataset: Dataset, raw_prompt: str) -> AssistProposalOut:
    prompt = raw_prompt.casefold()
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
    proposal = _build_proposal(dataset, payload.prompt)
    record = AssistProposal(
        project_id=dataset.project_id,
        dataset_id=dataset.id,
        actor_id=principal.id,
        prompt=payload.prompt,
        action=proposal.action,
        params=proposal.params,
        reason=proposal.reason,
        status="proposed",
    )
    db.add(record)
    db.commit()
    proposal.id = record.id
    return proposal


@router.get("/proposals", response_model=list[AssistProposalRecordOut])
def list_proposals(
    dataset_id: str = Query(min_length=1),
    limit: int = Query(default=50, ge=1, le=500),
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(404, "dataset not found")
    require_project_role(db, dataset.project_id, principal)
    stmt = (
        select(AssistProposal)
        .where(AssistProposal.dataset_id == dataset_id)
        .order_by(AssistProposal.created_at.desc())
        .limit(limit)
    )
    return list(db.scalars(stmt))


def _load_actionable_proposal(
    db: Session, proposal_id: str, principal: Principal
) -> AssistProposal:
    record = db.get(AssistProposal, proposal_id)
    if record is None:
        raise HTTPException(404, "proposal not found")
    require_project_role(db, record.project_id, principal, "editor")
    if record.status != "proposed":
        raise HTTPException(409, f"proposal already {record.status}")
    return record


@router.post("/proposals/{proposal_id}/apply", response_model=JobOut)
def apply_proposal(
    proposal_id: str,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    """Confirm a persisted filter proposal by launching the matching job.

    ``view_change`` proposals have no server-side effect (the client applies
    them to its own view state), so only ``filter_job`` proposals are accepted.
    """
    record = _load_actionable_proposal(db, proposal_id, principal)
    if record.action != "filter_job":
        raise HTTPException(422, "only filter_job proposals can be applied server-side")
    dataset = db.get(Dataset, record.dataset_id)
    if dataset is None:
        raise HTTPException(410, "proposal dataset no longer exists")
    try:
        params = validate_filter_params(dict(record.params))
    except ValueError as exc:
        raise HTTPException(422, f"stored proposal params invalid: {exc}") from exc
    project_id = record.project_id
    with locked_project(db, project_id, principal, "editor"):
        current = db.get(AssistProposal, proposal_id)
        if current is None or current.status != "proposed":
            raise HTTPException(409, "proposal is no longer applicable")
        job = Job(
            project_id=project_id,
            kind="filter",
            status="queued",
            target_id=record.dataset_id,
            params=params,
        )
        db.add(job)
        db.flush()
        current.status = "applied"
        current.applied_job_id = job.id
        db.add(current)
    request.state.audit_project_id = project_id
    request.state.audit_resource_type = "job"
    request.state.audit_resource_id = job.id
    manager.submit(job.id, run_dataset_operation(record.dataset_id, "filter", params))
    return job


@router.post("/proposals/{proposal_id}/dismiss", response_model=AssistProposalRecordOut)
def dismiss_proposal(
    proposal_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    record = _load_actionable_proposal(db, proposal_id, principal)
    with locked_project(db, record.project_id, principal, "editor"):
        current = db.get(AssistProposal, proposal_id)
        if current is None or current.status != "proposed":
            raise HTTPException(409, "proposal is no longer applicable")
        current.status = "dismissed"
        db.add(current)
        db.flush()
        return AssistProposalRecordOut.model_validate(current)
