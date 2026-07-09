from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from jwt.exceptions import PyJWKClientError

from app import auth
from app.config import settings


def test_oidc_rs256_claim_and_signature_validation(monkeypatch):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()
    monkeypatch.setattr(settings, "oidc_issuer", "https://issuer.example")
    monkeypatch.setattr(settings, "oidc_audience", "pvweb-api")
    monkeypatch.setattr(settings, "oidc_jwks_url", "https://issuer.example/jwks")

    class StaticJwks:
        def __init__(self, _url):
            pass

        def get_signing_key_from_jwt(self, _token):
            return SimpleNamespace(key=public_key)

    monkeypatch.setattr(auth.jwt, "PyJWKClient", StaticJwks)
    now = datetime.now(timezone.utc)
    base = {
        "sub": "user-1",
        "iss": settings.oidc_issuer,
        "aud": settings.oidc_audience,
        "exp": now + timedelta(minutes=5),
    }

    valid = jwt.encode(base, private_key, algorithm="RS256")
    assert auth._decode_oidc_token(valid).id == "user-1"

    rejected = [
        {**base, "aud": "wrong-audience"},
        {**base, "iss": "https://wrong-issuer.example"},
        {**base, "exp": now - timedelta(seconds=1)},
        {key: value for key, value in base.items() if key != "sub"},
    ]
    rejected_tokens = [jwt.encode(claims, private_key, algorithm="RS256") for claims in rejected]
    rejected_tokens.append(jwt.encode(base, other_key, algorithm="RS256"))
    for token in rejected_tokens:
        with pytest.raises(HTTPException) as error:
            auth._decode_oidc_token(token)
        assert error.value.status_code == 401

    class BrokenJwks:
        def __init__(self, _url):
            pass

        def get_signing_key_from_jwt(self, _token):
            raise PyJWKClientError("JWKS unavailable")

    monkeypatch.setattr(auth.jwt, "PyJWKClient", BrokenJwks)
    with pytest.raises(HTTPException) as error:
        auth._decode_oidc_token(valid)
    assert error.value.status_code == 401
