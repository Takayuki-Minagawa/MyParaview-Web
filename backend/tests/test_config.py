"""Environment parsing behavior of Settings (app/config.py).

The module-level ``settings`` singleton is created at import time; these tests
re-instantiate the class under monkeypatched environments instead of mutating
the shared instance.
"""

from __future__ import annotations

import pytest

from app.config import Settings

TRUTHY_FLAG_VARS = [
    ("PVWEB_S3_PRESIGNED_DOWNLOADS", "s3_presigned_downloads"),
    ("PVWEB_ALLOW_INSECURE_DEV_AUTH", "allow_insecure_dev_auth"),
]


@pytest.mark.parametrize(("env_var", "attribute"), TRUTHY_FLAG_VARS)
@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on", " On ", "\tYES\n"])
def test_flag_envs_accept_truthy_forms(monkeypatch, env_var, attribute, value):
    monkeypatch.setenv(env_var, value)
    assert getattr(Settings(), attribute) is True


@pytest.mark.parametrize(("env_var", "attribute"), TRUTHY_FLAG_VARS)
@pytest.mark.parametrize("value", ["", "0", "false", "no", "off", "enabled", " "])
def test_flag_envs_reject_non_truthy_forms(monkeypatch, env_var, attribute, value):
    monkeypatch.setenv(env_var, value)
    assert getattr(Settings(), attribute) is False


@pytest.mark.parametrize(("env_var", "attribute"), TRUTHY_FLAG_VARS)
def test_flag_envs_default_to_disabled(monkeypatch, env_var, attribute):
    monkeypatch.delenv(env_var, raising=False)
    assert getattr(Settings(), attribute) is False


def test_auth_mode_defaults_to_oidc_and_is_lowercased(monkeypatch):
    monkeypatch.delenv("PVWEB_AUTH_MODE", raising=False)
    assert Settings().auth_mode == "oidc"

    monkeypatch.setenv("PVWEB_AUTH_MODE", "DEV")
    assert Settings().auth_mode == "dev"


def test_bootstrap_admin_subjects_split_and_strip(monkeypatch):
    monkeypatch.setenv("PVWEB_BOOTSTRAP_ADMIN_SUBS", " alice , bob ,, ")
    assert Settings().bootstrap_admin_subjects == {"alice", "bob"}

    monkeypatch.setenv("PVWEB_BOOTSTRAP_ADMIN_SUBS", "")
    assert Settings().bootstrap_admin_subjects == set()


def test_trame_allowed_ws_hosts_lowercase_and_strip(monkeypatch):
    monkeypatch.setenv("PVWEB_TRAME_ALLOWED_WS_HOSTS", " Viz.Example.COM ,other.host, ")
    assert Settings().trame_allowed_ws_hosts == {"viz.example.com", "other.host"}

    monkeypatch.delenv("PVWEB_TRAME_ALLOWED_WS_HOSTS", raising=False)
    assert Settings().trame_allowed_ws_hosts == set()


def test_cors_origins_default_and_comma_split(monkeypatch):
    monkeypatch.delenv("PVWEB_CORS_ORIGINS", raising=False)
    assert Settings().cors_origins == ["http://localhost:5173"]

    monkeypatch.setenv("PVWEB_CORS_ORIGINS", " https://a.example ,, https://b.example ")
    assert Settings().cors_origins == ["https://a.example", "https://b.example"]


def test_worker_command_uses_shell_style_splitting(monkeypatch):
    monkeypatch.delenv("PVWEB_PVPYTHON", raising=False)
    assert Settings().worker_command == []

    monkeypatch.setenv("PVWEB_PVPYTHON", '/opt/pv/bin/pvpython --force-offscreen "-dr"')
    assert Settings().worker_command == ["/opt/pv/bin/pvpython", "--force-offscreen", "-dr"]


def test_ffmpeg_setting_is_a_single_trimmed_executable(monkeypatch):
    monkeypatch.delenv("PVWEB_FFMPEG", raising=False)
    assert Settings().ffmpeg_executable == ""

    monkeypatch.setenv("PVWEB_FFMPEG", "  /opt/ffmpeg/bin/ffmpeg  ")
    assert Settings().ffmpeg_executable == "/opt/ffmpeg/bin/ffmpeg"


def test_empty_optional_envs_normalize_to_none(monkeypatch):
    monkeypatch.setenv("PVWEB_S3_ENDPOINT_URL", "")
    monkeypatch.setenv("PVWEB_OIDC_ISSUER", "")
    monkeypatch.setenv("PVWEB_TRAME_BROKER_URL", "")
    parsed = Settings()
    assert parsed.s3_endpoint_url is None
    assert parsed.oidc_issuer is None
    assert parsed.trame_broker_url is None
