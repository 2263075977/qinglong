# -*- coding: utf8 -*-

"""
cron: 30 8 * * *
new Env('福利吧签到');
"""

import os
import re
from urllib.parse import urljoin, urlparse

import requests
from sendNotify import send


BASE_URLS = [
    "https://www.wnflb99.com",
    "http://www.wnflb2023.com",
    "https://wnflb00.com",
    "https://www.wnflb00.com",
]
TIMEOUT = 15
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def normalize_cookie(cookie):
    cookie = (cookie or "").strip()
    if cookie.lower().startswith("cookie:"):
        cookie = cookie.split(":", 1)[1].strip()
    if len(cookie) >= 2 and cookie[0] == cookie[-1] and cookie[0] in ("'", '"'):
        cookie = cookie[1:-1].strip()
    return cookie.replace("\r", "").replace("\n", "; ")


def normalize_base_url(raw_value):
    value = raw_value.strip().strip("/")
    if not value:
        return []
    if re.match(r"^https?://", value):
        return [value]
    return [f"https://{value}", f"http://{value}"]


def get_candidate_base_urls():
    configured = " ".join(
        filter(
            None,
            (
                os.getenv("FUBA_BASE_URL"),
                os.getenv("FUBA_URL"),
                os.getenv("FUBA_DOMAIN"),
                os.getenv("FUBA_DOMAINS"),
            ),
        )
    )
    raw_urls = re.split(r"[,;\s]+", configured) + BASE_URLS
    urls = []
    for raw_url in raw_urls:
        for base_url in normalize_base_url(raw_url):
            if base_url and base_url not in urls:
                urls.append(base_url)
    return urls


def build_headers(cookie, host):
    return {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "cache-control": "max-age=0",
        "Upgrade-Insecure-Requests": "1",
        "Host": host,
        "Cookie": cookie,
        "User-Agent": USER_AGENT,
    }


def build_probe_headers():
    return {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "User-Agent": USER_AGENT,
    }


def get_origin(url):
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        raise RuntimeError(f"无效站点地址：{url}")
    return f"{parsed.scheme}://{parsed.netloc}", parsed.netloc


def make_url(base_url, path):
    return urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))


def find_available_base_url(session):
    errors = []
    for base_url in get_candidate_base_urls():
        try:
            response = session.get(
                base_url,
                headers=build_probe_headers(),
                timeout=TIMEOUT,
                allow_redirects=True,
            )
            if 200 <= response.status_code < 400:
                return get_origin(response.url)[0]
            errors.append(f"{base_url} 状态码 {response.status_code}")
        except requests.RequestException as exc:
            errors.append(f"{base_url} 请求失败：{exc}")
    raise RuntimeError("所有备用域名均不可用：" + "；".join(errors))


def extract_checkin_url(page_text):
    patterns = [
        r"['\"]([^'\"]*plugin\.php\?id=fx_checkin:checkin[^'\"]*)['\"]",
        r"(plugin\.php\?id=fx_checkin:checkin[^\s'\"<>)]*)",
    ]
    for pattern in patterns:
        match = re.search(pattern, page_text, re.S)
        if match:
            return match.group(1).replace("&amp;", "&")

    # 兼容最初脚本依赖的 fx_checkin 函数片段。
    match = re.search(r"}function fx_checkin(.*?);", page_text, re.S)
    if match:
        old_value = match.group(1)[47:-2]
        if old_value:
            return old_value.replace("&amp;", "&")
    raise RuntimeError("未找到 fx_checkin 签到链接，页面结构可能已变化")


def is_already_signed(page_text):
    signed_words = (
        "今日已签到",
        "今天已签到",
        "已经签到",
        "已签到",
        "请明日再来",
        "您今日第",
        "连续签到",
    )
    return any(word in page_text for word in signed_words)


def extract_sign_result(page_text):
    current_money = re.search(r'<a.*? id="extcreditmenu".*?>(.*?)</a>', page_text)
    sing_day = re.search(r'<div class="tip_c">(.*?)</div>', page_text)
    if not current_money or not sing_day:
        return None
    return "{}当前{}".format(sing_day.group(1), current_money.group(1))


def start(cookie, username):
    try:
        cookie = normalize_cookie(cookie)
        if not cookie:
            raise RuntimeError("未配置环境变量 FUBA")
        if not username:
            raise RuntimeError("未配置环境变量 FUBAUN")

        session = requests.session()
        base_url = find_available_base_url(session)
        host = get_origin(base_url)[1]
        headers = build_headers(cookie, host)

        # 访问 PC 主页，下面保留原脚本的登录校验方式。
        print(base_url)
        user_info = session.get(
            make_url(base_url, "forum.php?mobile=no"),
            headers=headers,
            timeout=TIMEOUT,
        ).text
        user_name = re.search(r'title="访问我的空间">(.*?)</a>', user_info)
        if user_name:
            print("登录用户名为：" + user_name.group(1))
            print("环境用户名为：" + username)
        else:
            print("未获取到用户名")
        if user_name is None or user_name.group(1) != username:
            raise RuntimeError("【福利吧】cookie失效???????")

        try:
            qiandao_url = extract_checkin_url(user_info)
        except RuntimeError:
            log_info = extract_sign_result(user_info)
            if log_info and is_already_signed(user_info):
                log_info = "检测到今日已签到，" + log_info
                print(log_info)
                send("签到结果", log_info)
                return
            raise

        print(qiandao_url)
        sign_response = session.get(
            make_url(base_url, qiandao_url),
            headers=headers,
            timeout=TIMEOUT,
        ).text
        if is_already_signed(sign_response):
            print("检测到今日已签到")

        user_info = session.get(
            make_url(base_url, "forum.php?mobile=no"),
            headers=headers,
            timeout=TIMEOUT,
        ).text
        log_info = extract_sign_result(user_info)
        if not log_info:
            raise RuntimeError("未获取到签到结果或积分信息")
        print(log_info)
        send("签到结果", log_info)

    except Exception as e:
        print("签到失败，失败原因:" + str(e))
        send("签到结果", str(e))


if __name__ == "__main__":
    start(os.getenv("FUBA"), os.getenv("FUBAUN"))
