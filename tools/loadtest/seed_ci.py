#!/usr/bin/env python3
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import uuid

DRIVER_COUNT = int(os.environ.get("LOAD_DRIVER_COUNT", "2000"))
RIDER_COUNT = int(os.environ.get("LOAD_RIDER_COUNT", "100"))
SECRET = os.environ["JWT_HS256_SECRET"].encode()
now = int(time.time())

def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()

def make_jwt(payload: dict) -> str:
    header = b64url(json.dumps(
        {"alg": "HS256", "typ": "JWT"},
        separators=(",", ":"),
    ).encode())
    claims = b64url(json.dumps(payload, separators=(",", ":")).encode())
    signing = (header + "." + claims).encode()
    signature = b64url(hmac.new(SECRET, signing, hashlib.sha256).digest())
    return header + "." + claims + "." + signature

def resp_command(*parts: str) -> bytes:
    encoded = [str(part).encode() for part in parts]
    payload = ("*" + str(len(encoded)) + "\r\n").encode()
    for part in encoded:
        payload += ("$" + str(len(part)) + "\r\n").encode()
        payload += part + b"\r\n"
    return payload

sql = ["BEGIN;"]
redis_rows = []
drivers = []
riders = []

for i in range(DRIVER_COUNT):
    user_id = str(uuid.uuid4())
    driver_id = str(uuid.uuid4())
    session_id = str(uuid.uuid4())
    session_key = secrets.token_bytes(32)
    token = make_jwt({
        "sub": driver_id,
        "user_id": user_id,
        "role": "driver",
        "driver_id": driver_id,
        "iat": now,
        "exp": now + 3600,
    })

    sql.append(
        "INSERT INTO core.users "
        "(id, first_name, last_name, email, status, rating) VALUES "
        f"('{user_id}', 'Load', 'Driver{i}', "
        f"'load-driver-{i}@example.test', 'active', 4.90);"
    )
    sql.append(
        "INSERT INTO core.drivers "
        "(id, user_id, vehicle_type, license_plate, verification_status, "
        "is_online, is_available) VALUES "
        f"('{driver_id}', '{user_id}', 'taxi', 'LOAD{i:06d}', "
        "'approved', TRUE, TRUE);"
    )

    encoded_key = base64.b64encode(session_key).decode()
    redis_rows.append(("telemetry:active-session:" + driver_id, session_id))
    redis_rows.append((
        "telemetry:session:" + driver_id + ":" + session_id,
        encoded_key,
    ))
    drivers.append({
        "DriverID": driver_id,
        "JWT": token,
        "SessionID": session_id,
        "SessionKey": encoded_key,
    })

for i in range(RIDER_COUNT):
    rider_id = str(uuid.uuid4())
    token = make_jwt({
        "sub": rider_id,
        "user_id": rider_id,
        "role": "rider",
        "iat": now,
        "exp": now + 3600,
    })
    sql.append(
        "INSERT INTO core.users "
        "(id, first_name, last_name, email, status, rating) VALUES "
        f"('{rider_id}', 'Load', 'Rider{i}', "
        f"'load-rider-{i}@example.test', 'active', 5.00);"
    )
    riders.append({"RiderID": rider_id, "JWT": token})

sql.append("COMMIT;")

with open("/tmp/fida-load-seed.sql", "w", encoding="utf-8") as handle:
    handle.write("\n".join(sql) + "\n")

with open("/tmp/fida-load-redis.resp", "wb") as handle:
    for key, value in redis_rows:
        handle.write(resp_command("SET", key, value, "EX", "3600"))

with open("fixtures.json", "w", encoding="utf-8") as handle:
    json.dump({"Drivers": drivers, "Riders": riders}, handle)

print(f"generated {DRIVER_COUNT} drivers and {RIDER_COUNT} riders")
