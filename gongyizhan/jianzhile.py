#!/usr/bin/env python3
# cron: 23 8 * * *
# new Env('简直了自动签到');
"""
简直了（https://jianzhile.vip）自动签到。

青龙依赖：
  ddddocr

环境变量：
  JIANZHILE_COOKIE    必填，浏览器 Cookie，例如 session=xxx
  JIANZHILE_USER_ID   可选，无法从 session 自动解析时填写
  JIANZHILE_URL       可选，默认 https://jianzhile.vip
  JIANZHILE_RETRIES   可选，验证码最大尝试次数，默认 2，最大 3
  JIANZHILE_CODE_LEN  可选，验证码位数，默认 4
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_URL = "https://jianzhile.vip"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/132.0.0.0 Safari/537.36"
)


class CheckinError(RuntimeError):
    pass


@dataclass
class ApiResponse:
    status: int
    data: dict[str, Any]


def env_text(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def normalize_url(value: str) -> str:
    return (value or DEFAULT_URL).rstrip("/")


def normalize_cookie(value: str) -> str:
    cookie = value.strip()
    if not cookie:
        raise CheckinError("缺少环境变量 JIANZHILE_COOKIE")
    if "=" not in cookie:
        cookie = f"session={cookie}"
    return cookie


def decode_base64_loose(value: str) -> bytes | None:
    text = value.strip().replace("-", "+").replace("_", "/")
    text += "=" * (-len(text) % 4)
    try:
        return base64.b64decode(text, validate=False)
    except (ValueError, TypeError):
        return None


def decode_gob_signed_int(value: bytes) -> int | None:
    if not value:
        return None
    if value[0] < 128:
        encoded = value[0]
    else:
        size = 256 - value[0]
        if size <= 0 or len(value) != size + 1:
            return None
        encoded = int.from_bytes(value[1:], "big")
    decoded = encoded >> 1 if encoded % 2 == 0 else -((encoded >> 1) + 1)
    return decoded if 0 < decoded <= 10_000_000 else None


def extract_gob_field_ints(value: bytes, field: str = "id") -> list[int]:
    marker = field.encode() + bytes((3,)) + b"int" + bytes((4,))
    results: list[int] = []
    offset = 0
    while True:
        index = value.find(marker, offset)
        if index < 0:
            break
        start = index + len(marker)
        if start + 1 < len(value) and value[start + 1] == 0:
            size = value[start] - 1
            number_start = start + 2
            number_end = number_start + size
            if size > 0 and number_end <= len(value):
                number = decode_gob_signed_int(value[number_start:number_end])
                if number and number not in results:
                    results.append(number)
        offset = start
    return results


def extract_session_value(cookie: str) -> str:
    match = re.search(r"(?:^|;\s*)session=([^;]+)", cookie, re.IGNORECASE)
    return match.group(1).strip() if match else ""


def extract_user_ids(cookie: str) -> list[int]:
    session_value = extract_session_value(cookie)
    if not session_value:
        return []
    outer = decode_base64_loose(session_value)
    if not outer:
        return []

    buffers = [outer]
    texts = [outer.decode("utf-8", errors="ignore")]
    parts = texts[0].split("|")
    if len(parts) >= 2:
        inner = decode_base64_loose(parts[1])
        if inner:
            buffers.append(inner)
            texts.append(inner.decode("utf-8", errors="ignore"))

    results: list[int] = []

    def add(value: str | int) -> None:
        try:
            number = int(value)
        except (TypeError, ValueError):
            return
        if 0 < number <= 10_000_000 and number not in results:
            results.append(number)

    for text in texts:
        for match in re.finditer(r"_(\d{4,8})(?!\d)", text):
            add(match.group(1))
        for match in re.finditer(
            r"(?:user(?:name)?|uid|id)[^\d]{0,16}(\d{4,8})(?!\d)",
            text,
            re.IGNORECASE,
        ):
            add(match.group(1))
    for buffer in buffers:
        for number in extract_gob_field_ints(buffer):
            add(number)
    return results


class JianzhileClient:
    def __init__(self, base_url: str, cookie: str, user_id: int | None = None):
        self.base_url = normalize_url(base_url)
        self.cookie = normalize_cookie(cookie)
        self.user_id = user_id

    def headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Cookie": self.cookie,
            "Origin": self.base_url,
            "Referer": f"{self.base_url}/console/personal",
            "User-Agent": USER_AGENT,
            "X-Requested-With": "XMLHttpRequest",
        }
        if self.user_id:
            headers["New-Api-User"] = str(self.user_id)
        return headers

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        query: dict[str, str] | None = None,
    ) -> ApiResponse:
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urlencode(query)}"
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(url, data=body, headers=self.headers(), method=method)
        try:
            with urlopen(request, timeout=20) as response:
                text = response.read().decode("utf-8", errors="replace")
                return ApiResponse(response.status, parse_json(text))
        except HTTPError as error:
            text = error.read().decode("utf-8", errors="replace")
            return ApiResponse(error.code, parse_json(text))
        except URLError as error:
            raise CheckinError(f"网络请求失败: {error.reason}") from error

    def resolve_user_id(self) -> int:
        candidates: list[int] = []
        if self.user_id:
            candidates.append(self.user_id)
        for candidate in extract_user_ids(self.cookie):
            if candidate not in candidates:
                candidates.append(candidate)
        if not candidates:
            raise CheckinError(
                "无法从 Cookie 解析用户 ID，请设置 JIANZHILE_USER_ID"
            )

        for candidate in candidates:
            self.user_id = candidate
            response = self.request("GET", "/api/user/self")
            data = response.data
            if data.get("success") and data.get("data", {}).get("id") == candidate:
                return candidate
        raise CheckinError(
            "Cookie 或用户 ID 无效，请更新 JIANZHILE_COOKIE/JIANZHILE_USER_ID"
        )

    def checkin_state(self) -> dict[str, Any]:
        month = datetime.now().strftime("%Y-%m")
        response = self.request(
            "GET", "/api/user/checkin", query={"month": month}
        )
        if not response.data.get("success"):
            raise CheckinError(response.data.get("message") or "获取签到状态失败")
        return response.data.get("data") or {}

    def fetch_captcha(self) -> tuple[str, bytes]:
        response = self.request("POST", "/api/user/checkin/captcha", {})
        data = response.data
        captcha = data.get("data") or {}
        captcha_id = str(captcha.get("captcha_id") or "").strip()
        captcha_image = str(captcha.get("captcha_image") or "").strip()
        if not data.get("success") or not captcha_id or not captcha_image:
            raise CheckinError(data.get("message") or "获取签到验证码失败")
        encoded = captcha_image.split(",", 1)[-1]
        try:
            return captcha_id, base64.b64decode(encoded)
        except (ValueError, TypeError) as error:
            raise CheckinError("签到验证码图片格式异常") from error

    def submit_checkin(self, captcha_id: str, answer: str) -> dict[str, Any]:
        response = self.request(
            "POST",
            "/api/user/checkin",
            {"captcha_id": captcha_id, "captcha_answer": answer},
        )
        return response.data


def parse_json(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else {"message": text[:200]}
    except json.JSONDecodeError:
        return {"message": text[:200]}


def create_ocr() -> list[Any]:
    try:
        import ddddocr  # type: ignore
    except ImportError as error:
        raise CheckinError(
            "缺少 ddddocr，请先在青龙依赖管理中安装 Python3 依赖 ddddocr"
        ) from error
    models = [ddddocr.DdddOcr(show_ad=False)]
    try:
        models.append(ddddocr.DdddOcr(show_ad=False, beta=True))
    except (TypeError, ValueError):
        # 兼容不支持 beta 参数的旧版 ddddocr。
        pass
    return models


def captcha_variants(image: bytes) -> list[bytes]:
    variants = [image]
    try:
        from PIL import Image, ImageEnhance, ImageFilter, ImageOps  # type: ignore

        with Image.open(io.BytesIO(image)) as source:
            rgb = Image.new("RGB", source.size, "white")
            if source.mode == "RGBA":
                rgb.paste(source, mask=source.getchannel("A"))
            else:
                rgb.paste(source.convert("RGB"))
            enlarged = rgb.resize(
                (rgb.width * 4, rgb.height * 4), Image.Resampling.LANCZOS
            )
            grayscale = ImageOps.autocontrast(enlarged.convert("L"))
            sharpened = ImageEnhance.Contrast(
                grayscale.filter(ImageFilter.MedianFilter(size=3))
            ).enhance(2.0)
            images = [enlarged, grayscale, sharpened]
            for threshold in (110, 140, 170, 200):
                images.append(
                    grayscale.point(lambda value, level=threshold: 255 if value > level else 0)
                )
            for candidate in images:
                output = io.BytesIO()
                candidate.save(output, format="PNG")
                variants.append(output.getvalue())
    except (ImportError, OSError, ValueError):
        pass
    return variants


def recognize_captcha(models: list[Any], image: bytes, expected_length: int) -> str:
    readings: list[str] = []
    variants = captcha_variants(image)
    for model in models:
        for variant in variants:
            try:
                raw = str(model.classification(variant) or "").upper()
            except Exception:
                continue
            answer = re.sub(r"[^A-Z0-9]", "", raw)
            if answer:
                readings.append(answer)

    valid = [
        reading
        for reading in readings
        if re.fullmatch(rf"[A-Z0-9]{{{expected_length}}}", reading)
    ]
    if not valid:
        summary = ", ".join(dict.fromkeys(readings)) or "空"
        raise CheckinError(f"OCR 未识别出 {expected_length} 位验证码: {summary}")
    return Counter(valid).most_common(1)[0][0]


def already_checked_in(message: str) -> bool:
    lowered = message.lower()
    return any(
        text in lowered
        for text in (
            "already checked",
            "already signed",
            "今日已签到",
            "今天已签到",
            "已经签到",
            "已签到",
        )
    )


def retryable_captcha_error(message: str) -> bool:
    return "验证码" in message and any(
        text in message for text in ("错误", "失效", "过期", "重试")
    )


def run() -> int:
    cookie = normalize_cookie(env_text("JIANZHILE_COOKIE"))
    user_id_text = env_text("JIANZHILE_USER_ID")
    user_id = int(user_id_text) if user_id_text else None
    retries = min(max(int(env_text("JIANZHILE_RETRIES", "2")), 1), 3)
    code_length = min(max(int(env_text("JIANZHILE_CODE_LEN", "4")), 3), 8)
    client = JianzhileClient(env_text("JIANZHILE_URL", DEFAULT_URL), cookie, user_id)

    resolved_user_id = client.resolve_user_id()
    print(f"[简直了] 登录验证成功，用户 ID: {resolved_user_id}")

    state = client.checkin_state()
    stats = state.get("stats") or {}
    if stats.get("checked_in_today"):
        print("[简直了] 今日已签到")
        return 0

    if not state.get("captcha_enabled"):
        result = client.request("POST", "/api/user/checkin", {}).data
        if result.get("success"):
            print("[简直了] 签到成功")
            return 0
        raise CheckinError(result.get("message") or "签到失败")

    # 先加载模型，再获取验证码，缩短 captcha_id 的存活时间消耗。
    ocr_models = create_ocr()
    last_message = "验证码识别失败"
    for attempt in range(1, retries + 1):
        captcha_id, image = client.fetch_captcha()
        try:
            answer = recognize_captcha(ocr_models, image, code_length)
        except CheckinError as error:
            last_message = str(error)
            if attempt >= retries:
                break
            print(f"[简直了] 第 {attempt} 张验证码识别失败，重新获取验证码")
            continue
        result = client.submit_checkin(captcha_id, answer)
        message = str(result.get("message") or "签到失败")
        if result.get("success"):
            reward = (result.get("data") or {}).get("quota_awarded")
            suffix = f"，奖励: {reward}" if reward is not None else ""
            print(f"[简直了] 签到成功{suffix}")
            return 0
        if already_checked_in(message):
            print("[简直了] 今日已签到")
            return 0
        last_message = message
        if not retryable_captcha_error(message) or attempt >= retries:
            break
        print(f"[简直了] 第 {attempt} 次验证码识别失败，重新获取验证码")
    raise CheckinError(last_message)


def main() -> None:
    try:
        raise SystemExit(run())
    except (CheckinError, ValueError) as error:
        print(f"[简直了] 失败: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
