from __future__ import annotations

from app.db import SessionLocal
from app.jobs import recover_interrupted_jobs
from app.models import Dataset, Job, Project


def test_recover_interrupted_jobs_fails_zombies_and_resets_ingest_dataset(client):
    with SessionLocal() as db:
        project = Project(name="restart-recovery")
        db.add(project)
        db.flush()
        dataset = Dataset(
            project_id=project.id,
            filename="restart.vtp",
            ext=".vtp",
            size_bytes=0,
            object_key="restart-recovery-test.vtp",
            status="ingesting",
        )
        db.add(dataset)
        db.flush()
        jobs = [
            Job(project_id=project.id, kind="ingest", target_id=dataset.id, status="running"),
            Job(project_id=project.id, kind="render", status="queued"),
        ]
        db.add_all(jobs)
        db.commit()
        job_ids = [job.id for job in jobs]
        dataset_id = dataset.id

    assert recover_interrupted_jobs() >= 2
    with SessionLocal() as db:
        recovered = [db.get(Job, job_id) for job_id in job_ids]
        assert all(job is not None and job.status == "failed" for job in recovered)
        assert all("interrupted by service restart" in (job.log or "") for job in recovered if job)
        dataset = db.get(Dataset, dataset_id)
        assert dataset is not None
        assert dataset.status == "registered"
        project = db.get(Project, dataset.project_id)
        assert project is not None
        db.delete(project)
        db.commit()
