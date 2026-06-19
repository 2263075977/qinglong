# -*- coding: utf8 -*-

"""
cron: 30 */4 * * *
new Env('福利吧签到');
"""

import os
import re

import requests
from sendNotify import send


DOMAINS = ["www.wnflb99.com", "www.wnflb2023.com", "www.wnflb00.com"]
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


def get_candidate_domains():
    configured = os.getenv("FUBA_DOMAIN") or os.getenv("FUBA_DOMAINS") or ""
    raw_domains = re.split(r"[,;\s]+", configured) + DOMAINS
    domains = []
    for domain in raw_domains:
        domain = re.sub(r"^https?://", "", domain.strip()).strip("/")
        if domain and domain not in domains:
            domains.append(domain)
    return domains


def build_headers(cookie, host):
    return {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "cache-control": "max-age=0",
        "Upgrade-Insecure-Requests": "1",
        "Host": host,
        "Cookie": cookie,
        "User-Agent": USER_AGENT,
    }


def find_available_domain(session):
    last_error = None
    for domain in get_candidate_domains():
        try:
            response = session.get(f"https://{domain}", timeout=TIMEOUT)
            if response.status_code == 200:
                return domain
            last_error = f"{domain} 状态码 {response.status_code}"
        except requests.RequestException as exc:
            last_error = f"{domain} 请求失败：{exc}"
    raise RuntimeError(f"所有备用域名均不可用：{last_error}")


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
        flb_url = find_available_domain(session)
        headers = build_headers(cookie, flb_url)

        # 访问 PC 主页，下面保留原脚本的登录校验方式。
        print(flb_url)
        user_info = session.get(
            f"https://{flb_url}/forum.php?mobile=no",
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
            f"https://{flb_url}/{qiandao_url}",
            headers=headers,
            timeout=TIMEOUT,
        ).text
        if is_already_signed(sign_response):
            print("检测到今日已签到")

        user_info = session.get(
            f"https://{flb_url}/forum.php?mobile=no",
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
