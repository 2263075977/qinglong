# -*- coding: utf8 -*-

"""
cron: 0 8 * * *
new Env('Qoder CN 每日签到');

Qoder CN「每天领 100 Credits」自动签到（青龙面板 / Python3）。

环境变量：
  QODERCN_PAT  必填。Qoder CN 个人访问令牌（PAT，pt- 开头）。
               到 https://qoder.cn/account/integrations 创建后填入。
               多账号用 & 或换行分隔，例如：QODERCN_PAT=pt-账号1&pt-账号2
  （命名与 Qoder 官方 CLI 的 QODERCN_PERSONAL_ACCESS_TOKEN 对齐）

调度说明（cron: 0 8 * * *，每一项都有理由，改动前先读）：
  活动窗口为「每日 10:00 (UTC+8) 开放新一轮，持续至次日 10:00 前」，每轮限领一次
  100 Credits、自领取起 30 天有效、错过不补。
  8 点运行时落在**前一天 10:00 那一轮的窗口末尾**：每天一次、每次落在互不重叠的窗口，
  不漏领也不重复领（服务端另有 replayed 幂等兜底）。
  ⚠️ 代价：8 点领的是「再过 2 小时就关闭」的那一轮，若这一跑失败，只剩到当天 10:00 前
     约 2 小时的重试余量。想留满 24 小时重试余量就改到 10:00 之后（如 0 10 * * *）。
  ⚠️ 不要改成一天跑两次以上：同一窗口内多跑没有额外收益，只会多打接口。

鉴权链路（实测 2026-10-18，Qoder CN 0.4.8 / openapi.qoder.com.cn）：
  QODERCN_PAT (pt-…, 永久)
    --POST /api/v1/jobToken/exchange  {"personal_token": "<PAT>"}-->
  jobToken (jt-…, 24h)  --Authorization: Bearer-->  业务接口

  ⚠️ PAT 不能直接当 Bearer，必须先 exchange 成 jt-（每次运行重新 exchange，
     不落盘缓存：cron 日频，jt- 24h 必然过期）。
  ⚠️ Cosy-ClientType 有两处不同值，写反会静默拿不到数据：
       exchange      用 "5"
       业务接口(含 campaigns/claim/usage) 用 "10"
     campaigns 少带 Cosy-ClientType: 10 时仍返回 200，但 campaigns 数组为空。
  ⚠️ 业务接口只需最小头集：Accept / Authorization / User-Agent / Cosy-ClientType: 10。
     不需要 Cosy-Machine* 设备头，exchange 之外也不需要 Cosy-Version。

接口清单（全部本机实测）：
  POST /api/v1/jobToken/exchange                  PAT 换 jobToken
  GET  /sash/api/v1/me/campaigns                  活动列表（含每日领 100）
  POST /sash/api/v1/me/campaigns/{campaignId}/claim  领取（body {}，幂等，replayed）
  GET  /sash/api/v2/me/usage                     余额（userQuota / addOnQuota）

领取必须用 campaignId（UUID），不是 campaignKey（act-YYYYMMDD-NNN）。
签到赠送的 100 credits 落在 addOnQuota（资源包），不在 userQuota。
"""

import os
import sys

import requests

# Windows 控制台默认 GBK，中文/emoji 日志会花屏或抛 UnicodeEncodeError；
# 青龙容器本就是 UTF-8，这里是跨平台的无害兜底（非 Windows 专有 API）。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

API = "https://openapi.qoder.com.cn"
LOG_PREFIX = "[qoder]"
TASK_TITLE = "Qoder CN 每日签到"
USER_AGENT = "Qoder"
EXCHANGE_CLIENT_TYPE = "5"  # exchange 专用
OPENAPI_CLIENT_TYPE = "10"  # 业务接口专用（漏了 campaigns 静默为空）
COSY_VERSION = "1.0.1"  # 仅 exchange 需要
TIMEOUT = 20

PATH_EXCHANGE = "/api/v1/jobToken/exchange"
PATH_CAMPAIGNS = "/sash/api/v1/me/campaigns"
PATH_USAGE = "/sash/api/v2/me/usage"

MSG_AUTH_FAILED = (
    "❌ Qoder PAT 已失效，请重新登录 qoder.cn/account/integrations "
    "重新创建并更新 QODERCN_PAT"
)

__all__ = ["QoderError", "parse_pats", "pick_claimable", "has_claimed_today", "mask"]


class QoderError(Exception):
    """站点专属错误：type 决定通知文案与下游分流。

    type: 'config' | 'auth_failed' | 'network' | 'schema_changed' | 'api_error'
    """

    def __init__(self, type_, message):
        super().__init__(message)
        self.name = "QoderError"
        self.type = type_
        self.message = message


def log(message):
    print("%s %s" % (LOG_PREFIX, message))


# --------------------------------------------------------------------------
# 纯函数（导出，便于将来加测试）
# --------------------------------------------------------------------------


def parse_pats(raw):
    """按 & / 换行切分多个 PAT，去空白、去重并保持顺序。"""
    if not raw:
        return []
    parts = str(raw).replace("\r", "\n").replace("&", "\n").split("\n")
    pats = []
    for part in parts:
        part = part.strip()
        if part and part not in pats:
            pats.append(part)
    return pats


def pick_claimable(campaigns):
    """可领判定：actionType == CLAIM_BENEFIT 且 claimStatus == CLAIMABLE 且 campaignId 非空。

    只按 claimStatus 判会误领 VIEW_DETAILS；只按 actionType 判会误领
    ACHIEVEMENT_NOT_COMPLETED。两类实测都存在，两个条件必须同时满足。
    """
    picked = []
    for item in campaigns or []:
        if not isinstance(item, dict):
            continue
        if item.get("actionType") != "CLAIM_BENEFIT":
            continue
        if item.get("claimStatus") != "CLAIMABLE":
            continue
        if not item.get("campaignId"):
            continue
        picked.append(item)
    return picked


def has_claimed_today(campaigns):
    """今天是否已签到：存在 actionType == CLAIM_BENEFIT 且 claimStatus == CLAIMED 的条目。"""
    for item in campaigns or []:
        if not isinstance(item, dict):
            continue
        if item.get("actionType") == "CLAIM_BENEFIT" and item.get("claimStatus") == "CLAIMED":
            return True
    return False


def mask(token):
    """脱敏：只保留前缀与尾 4 位，绝不回显完整 PAT / jobToken。"""
    if not token:
        return "(空)"
    token = str(token)
    if len(token) <= 12:
        return "***"
    return "%s***%s" % (token[:6], token[-4:])


# --------------------------------------------------------------------------
# 网络层
# --------------------------------------------------------------------------


def make_session(job_token=None):
    """最小头集。exchange 阶段不挂 Authorization；换到 jt- 后再挂业务头。"""
    session = requests.Session()
    session.headers.update({"Accept": "application/json", "User-Agent": USER_AGENT})
    if job_token:
        session.headers.update(
            {
                "Authorization": "Bearer %s" % job_token,
                "Cosy-ClientType": OPENAPI_CLIENT_TYPE,
            }
        )
    return session


def request_json(
    session,
    method,
    path,
    payload=None,
    extra_headers=None,
    where="",
    auth_statuses=(401, 403),
):
    """统一请求 + 错误分类：auth_failed / network / schema_changed / api_error。"""
    url = API + path
    try:
        resp = session.request(
            method, url, json=payload, headers=extra_headers, timeout=TIMEOUT
        )
    except requests.RequestException as exc:
        raise QoderError(
            "network",
            "❌ 网络请求失败（连不上 openapi.qoder.com.cn）：%s %s"
            % (exc.__class__.__name__, where),
        )
    if resp.status_code in auth_statuses:
        raise QoderError("auth_failed", MSG_AUTH_FAILED)
    if resp.status_code >= 400:
        # 不回显响应体，避免把服务端的 invalid/expired 之类词带进非凭证类文案
        raise QoderError(
            "api_error",
            "❌ Qoder 接口返回异常状态 %s（%s）" % (resp.status_code, where),
        )
    try:
        return resp.json()
    except ValueError:
        raise QoderError(
            "schema_changed",
            "⚠️ Qoder 接口结构未识别（schema_changed）：%s 返回非 JSON 内容" % where,
        )


def exchange_job_token(session, pat):
    """PAT -> jobToken。响应字段为 snake_case 的 token（不是 accessToken）。"""
    doc = request_json(
        session,
        "POST",
        PATH_EXCHANGE,
        payload={"personal_token": pat},
        extra_headers={
            "Content-Type": "application/json",
            "Cosy-ClientType": EXCHANGE_CLIENT_TYPE,
            "Cosy-Version": COSY_VERSION,
        },
        where="jobToken 交换",
        # exchange 的唯一变量就是 PAT，400 一并按凭证失效处理
        auth_statuses=(400, 401, 403),
    )
    token = doc.get("token") if isinstance(doc, dict) else None
    if not token or not isinstance(token, str):
        raise QoderError(
            "schema_changed",
            "⚠️ Qoder 接口结构未识别（schema_changed）：jobToken 响应缺少 token 字段（%s）"
            % _json_keys_from(doc),
        )
    return token


def _json_keys_from(doc):
    if isinstance(doc, dict):
        return "响应键：%s" % ", ".join(sorted(doc.keys()))
    return "响应类型：%s" % type(doc).__name__


def fetch_campaigns(session):
    doc = request_json(session, "GET", PATH_CAMPAIGNS, where="活动列表")
    if not isinstance(doc, dict) or not isinstance(doc.get("campaigns"), list):
        raise QoderError(
            "schema_changed",
            "⚠️ Qoder 接口结构未识别（schema_changed）：活动列表缺少 campaigns 字段（%s）"
            % _json_keys_from(doc),
        )
    return doc


def claim(session, campaign_id):
    """POST /sash/api/v1/me/campaigns/{campaignId}/claim，body 恰好 {}。"""
    path = "%s/%s/claim" % (PATH_CAMPAIGNS, campaign_id)
    doc = request_json(
        session,
        "POST",
        path,
        payload={},
        extra_headers={"Content-Type": "application/json"},
        where="领取签到 %s" % campaign_id,
    )
    if not isinstance(doc, dict) or not doc.get("grantId"):
        raise QoderError(
            "schema_changed",
            "⚠️ Qoder 接口结构未识别（schema_changed）：领取响应缺少 grantId（%s）"
            % _json_keys_from(doc),
        )
    return doc


def fetch_usage(session):
    doc = request_json(session, "GET", PATH_USAGE, where="余额查询")
    if not isinstance(doc, dict) or not isinstance(doc.get("qoderUsage"), dict):
        raise QoderError(
            "schema_changed",
            "⚠️ Qoder 接口结构未识别（schema_changed）：余额响应缺少 qoderUsage（%s）"
            % _json_keys_from(doc),
        )
    return doc


def _quota_text(quota):
    if not isinstance(quota, dict):
        return "不可用"
    total = quota.get("total")
    remaining = quota.get("remaining")
    unit = quota.get("unit") or "credits"
    if total is None and remaining is None:
        return "不可用"
    return "%s/%s %s" % (
        "?" if remaining is None else remaining,
        "?" if total is None else total,
        unit,
    )


def format_balance(doc):
    """余额口径：签到发的 100 进 addOnQuota（资源包），userQuota 是套餐额度，两者都要看。"""
    usage = doc.get("qoderUsage") if isinstance(doc, dict) else None
    if not isinstance(usage, dict):
        return "余额：未获取到（qoderUsage 缺失）"
    return "余额：userQuota %s（套餐额度）；addOnQuota %s（资源包，签到发放进这里）" % (
        _quota_text(usage.get("userQuota")),
        _quota_text(usage.get("addOnQuota")),
    )


def _claim_amount(doc, campaign):
    """优先取领取响应里的 benefit.amount，回落到活动条目的 benefit.amount。"""
    for source in (doc, campaign):
        benefit = source.get("benefit") if isinstance(source, dict) else None
        if isinstance(benefit, dict):
            amount = benefit.get("amount")
            if isinstance(amount, (int, float)):
                return amount
    return 0


# --------------------------------------------------------------------------
# 编排
# --------------------------------------------------------------------------


def run_account(pat, index):
    """跑单个账号，内部捕获所有异常，绝不向调用方抛出。"""
    name = mask(pat)
    tag = "账号%d(%s)" % (index, name)
    result = {"name": name, "ok": False, "message": "❌ 签到失败", "balance": None}

    try:
        session = make_session()
        job_token = exchange_job_token(session, pat)
        log("%s jobToken 交换成功（有效期 24h）" % tag)

        session = make_session(job_token)
        doc = fetch_campaigns(session)
        campaigns = doc.get("campaigns") or []
        claimable = pick_claimable(campaigns)
        log("%s 活动列表：共 %d 条，可领 %d 条" % (tag, len(campaigns), len(claimable)))

        if claimable:
            granted = 0
            replayed = False
            for campaign in claimable:
                res = claim(session, campaign["campaignId"])
                if res.get("replayed"):
                    replayed = True
                granted += _claim_amount(res, campaign)
            if replayed:
                message = "✅ 签到成功 +%s CREDITS（replayed，权益不重复发放）" % granted
            else:
                message = "✅ 签到成功 +%s CREDITS" % granted
            log("%s %s" % (tag, message))
        elif has_claimed_today(campaigns):
            message = "✅ 今天已签到（无需操作）"
            log("%s %s" % (tag, message))
        else:
            message = "⚠️ 当前没有进行中的签到活动（活动可能已下线）"
            log("%s %s" % (tag, message))

        result["ok"] = True
        result["message"] = message

        try:
            balance = format_balance(fetch_usage(session))
        except QoderError as exc:
            balance = "余额查询失败：%s" % exc.message
            # 余额查询失败本身不影响已完成的签到，但**凭证类**失败必须让账号判失败。
            # 否则会出现「标题写成功、正文却带 已失效/重新登录」的自相矛盾通知：
            # 通知进失效 Bot，exit code 却错报 0。
            if exc.type == "auth_failed":
                result["ok"] = False
                result["message"] = "%s（余额查询阶段）" % exc.message
        log("%s %s" % (tag, balance))
        result["balance"] = balance
    except QoderError as exc:
        result["ok"] = False
        result["message"] = exc.message
        log("%s %s" % (tag, exc.message))
    except Exception as exc:  # 单账号未知异常隔离，不中断其余账号
        result["ok"] = False
        result["message"] = "❌ 签到失败（未知错误）：%s: %s" % (
            exc.__class__.__name__,
            exc,
        )
        log("%s %s" % (tag, result["message"]))

    return result


def build_notification(results):
    ok_count = sum(1 for item in results if item.get("ok"))
    lines = ["%s：成功 %d / 共 %d" % (TASK_TITLE, ok_count, len(results)), ""]
    for item in results:
        lines.append("【%s】%s" % (item.get("name"), item.get("message")))
        if item.get("balance"):
            lines.append("    %s" % item["balance"])
    return TASK_TITLE, "\n".join(lines)


# --------------------------------------------------------------------------
# 通知（多候选路径查找 sendNotify，失败降级 print，绝不因通知中断任务）
# --------------------------------------------------------------------------


def load_send_notify():
    try:
        from sendNotify import send

        return send
    except Exception:
        pass

    here = os.path.dirname(os.path.abspath(__file__))
    candidate_dirs = [
        here,
        os.getcwd(),
        os.path.join(here, os.pardir),
        os.path.join("/ql", "data", "scripts"),
        os.path.join("/ql", "scripts"),
        os.path.join("/ql", "data", "scripts", "function"),
        os.path.join("/ql", "scripts", "function"),
    ]
    for directory in candidate_dirs:
        try:
            directory = os.path.abspath(directory)
        except Exception:
            continue
        if not os.path.isfile(os.path.join(directory, "sendNotify.py")):
            continue
        if directory not in sys.path:
            sys.path.insert(0, directory)
        try:
            from sendNotify import send

            return send
        except Exception:
            continue
    return None


def send_notification(title, content):
    try:
        send = load_send_notify()
        if send is not None:
            send(title, content)
            return True
    except Exception as exc:
        log("⚠️ 青龙通知发送失败：%s" % exc.__class__.__name__)
    print("\n%s\n%s" % (title, content))
    return False


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------


def main():
    pats = parse_pats(os.getenv("QODERCN_PAT"))
    if not pats:
        message = (
            "❌ 未配置环境变量 QODERCN_PAT\n"
            "请到 https://qoder.cn/account/integrations 创建个人访问令牌（PAT，pt- 开头），\n"
            "然后在青龙面板的「环境变量」中添加：\n"
            "  QODERCN_PAT=pt-你的令牌\n"
            "多账号用 & 或换行分隔，例如：QODERCN_PAT=pt-账号1&pt-账号2"
        )
        log(message)
        send_notification(TASK_TITLE, message)
        return 1

    log("开始签到：共 %d 个账号" % len(pats))
    results = [run_account(pat, index) for index, pat in enumerate(pats, 1)]

    title, content = build_notification(results)
    send_notification(title, content)

    return 0 if all(item.get("ok") for item in results) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        fallback = "❌ 发生异常:执行失败\n\n%s: %s" % (exc.__class__.__name__, exc)
        log(fallback)
        send_notification(TASK_TITLE, fallback)
        sys.exit(1)
