# -*- coding: utf8 -*-

"""
cron: 0 1 * * *
new Env('MCII 节点共享 签到');

MCII 节点共享（proxy.mcii.cc）每日签到并激活订阅（青龙面板 / Python3）。

环境变量：
  MCII_ACCOUNTS         多账号 JSON 数组；每项 {"cookie":"..."} 或
                        {"username":"...","password":"..."}，可带 "name" 作显示名
  MCII_COOKIE           单账号简写（仅当 MCII_ACCOUNTS 未配置时生效）
  MCII_BASE_URL         可选，默认 https://proxy.mcii.cc（站点换域名时不用改代码）
  MCII_TIMEOUT_MS       可选，默认 20000，单位毫秒（与前端 setTimeout(..., 2e4) 一致）
  MCII_CONFIRM_PARTIAL  可选，默认 true

四条必须先读懂的事实（改动前请先读，实测来源见任务 PRD）：

  1. 「签到」与「激活订阅」是**同一个接口** POST /api/v1/me/checkin ——
     对应网页 https://proxy.mcii.cc/subscriptions 上那颗「签到并激活订阅」按钮。
     签到本身不产生「订阅」，它做的是把 subscription_expires_at 推到「此刻 + 14 天」。
  2. awarded:false **也是成功**：今日奖励已领过（不重复发经验/积分），
     但服务端仍会把订阅重新激活并续期到「此刻 + 14 天」。
  3. 因此**即使今天已签到也必须真发 POST**，不能「今天已签就跳过」——
     跳过等于白白损失一天的订阅续期。
  4. MCII_CONFIRM_PARTIAL=true（默认）会在请求体里带 confirm_partial:true，
     让服务端**移除**无法激活的来源以完成签到。这是**破坏性操作**（只影响自己的组合），
     修改前的组合会保留在网页「历史组合」里，可随时恢复；
     设为 false 则保持非破坏性：服务端返回 needs_confirmation:true 且**没有提交签到**，
     脚本据此判失败并在通知里提示，不会静默把面板刷绿。
     ⚠️ needs_confirmation 分支的响应形状属**推断**（来自前端 bundle 反编译）：本机测试账号
        6 个来源全部 available:true，触发不到该分支，未能用真账号复现。

鉴权链路（Session Cookie，无 Cloudflare 挑战 / 无验证码 / 无 CSRF token）：
  A. Cookie 形态（LinuxDo / GitHub OAuth 账号 has_password:false，只能用这条）
       浏览器复制 Cookie: proxy_sid=<JWT>; nodepool_session=<会话>
       --直接带 Cookie-->  POST /api/v1/me/checkin  {"confirm_partial": <bool>}
  B. 账号密码形态
       POST /api/v1/auth/login  {"username":"...","password":"...","remember":true}
       --Set-Cookie 落到 requests.Session 的 CookieJar-->  同上签到
     密码形态的成功响应形状属**推断**（本机测试账号是 OAuth、无密码），
     因此实现上不解析响应体细节，只校验 authenticated 为真。
  ⚠️ 两条路径都**每次运行从零建会话**：登录换来的 Cookie 不落盘、不复用
     （cron 日频，缓存只带来过期判定与并发写两类新 bug）。

调度说明（cron: 0 1 * * *）：
  站点**未公布**签到重置时刻，前端只用「当天」判定（checkin_on），没有小时级窗口说明，
  所以不必掐点抢窗口；签到幂等且每次调用都会续期 14 天，每日一次即够，多跑无额外收益。
  定 01:00：凌晨低峰，且与仓库其它脚本的 8–10 点错峰；当天失败到次日 01:00 有约 24 小时
  由 cron 自然重试（本脚本不实现重试/退避，见 C4：一次性任务挂死比失败更糟）。

错误分类（type 决定通知文案与下游「双 TG Bot」分流）：
  config / auth_failed / email_required / network / schema_changed / api_error / rate_limited
  ⚠️ 非凭证类文案**不得**出现 失效 / expired / invalid / 重新登录 / 发生异常 等关键词，
     且**不回显服务端响应体**（站点错误文案自带「请先登录」这类词，会把普通失败灌进失效 Bot）。

只读原则（C5）：本脚本只读账号自身状态，唯一写入动作是签到（幂等）。
不实现补签 / 请假 / 打赏等会花积分或改社交状态的接口。
"""

import datetime
import json
import os
import re
import sys
import time

import requests

# Windows 控制台默认 GBK，中文/emoji 日志会花屏或抛 UnicodeEncodeError；
# 青龙容器本就是 UTF-8，这里是跨平台的无害兜底（非 Windows 专有 API）。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

LOG_PREFIX = "[mcii]"
TASK_TITLE = "MCII 节点共享 每日签到"
DEFAULT_BASE_URL = "https://proxy.mcii.cc"
DEFAULT_TIMEOUT_MS = 20000
ACCOUNT_GAP_MS = 1500  # 多账号之间的礼貌间隔（照 STATE_REQUEST_GAP_MS 先例，不做成环境变量）
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
BEIJING_TZ = datetime.timezone(datetime.timedelta(hours=8))

API_PREFIX = "/api/v1"
PATH_LOGIN = "/auth/login"
PATH_CHECKIN = "/me/checkin"

# 下游青龙 Node-RED「配置区:双TG Bot分流」的关键词表（与节点侧保持一致）。
# 匹配规则：大小写不敏感；「原文小写」与「去掉全部空白后的紧凑串」各匹配一次。
ALERT_KEYWORDS = (
    "已失效,无效用户,失效,cookie失效,ck失效,登录失效,"
    "账号失效,账号过期,重新登录,发生异常,invalid,expired"
)

MSG_AUTH_FAILED = (
    "❌ MCII 会话已失效，请重新登录 proxy.mcii.cc 复制新的 Cookie，"
    "并更新 MCII_COOKIE（或 MCII_ACCOUNTS）"
)

MSG_EMAIL_REQUIRED = "⚠️ 该账号需要先到 proxy.mcii.cc 网页绑定或验证邮箱后才能签到"

# ⚠️ 这段文案属「配置缺失」，不是「凭证失效」：
#    用户只需去面板填一个变量，不需要重新登录，因此**不得**出现 已失效 / 重新登录。
MSG_CONFIG_MISSING = (
    "❌ 未配置环境变量 MCII_ACCOUNTS / MCII_COOKIE\n"
    "请登录 https://proxy.mcii.cc 后按下面步骤复制 Cookie：\n"
    "  1. 打开 https://proxy.mcii.cc/subscriptions 并确认页面已是登录状态\n"
    "  2. 按 F12 打开开发者工具 → Network（网络）→ 刷新页面\n"
    "  3. 点任一 /api/v1 请求 → Request Headers（请求标头）→ 整行复制 Cookie\n"
    "     （应包含 proxy_sid=… 与 nodepool_session=… 两段）\n"
    "  4. 青龙面板 → 环境变量 → 新建：MCII_COOKIE=<粘贴的 Cookie>\n"
    "多账号写成 JSON 数组 MCII_ACCOUNTS：\n"
    '  MCII_ACCOUNTS=[{"cookie":"...","name":"账号1"},{"username":"...","password":"..."}]'
)

__all__ = [
    "MciiError",
    "is_truthy",
    "normalize_cookie",
    "mask_secret",
    "parse_accounts",
    "matches_alert_routing",
    "format_expires_at",
    "describe_award",
    "build_notification",
    "has_credential_failure",
]


class MciiError(Exception):
    """站点专属错误：type 决定通知文案与下游分流。

    type: 'config' | 'auth_failed' | 'email_required' | 'network'
          | 'schema_changed' | 'api_error' | 'rate_limited'
    """

    def __init__(self, type_, message):
        super().__init__(message)
        self.name = "MciiError"
        self.type = type_
        self.message = message


def log(message):
    print("%s %s" % (LOG_PREFIX, message))


def _as_text(value):
    """把 JSON 里可能是任意类型的字段安全转成字符串（非标量一律当空）。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return ""
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def _num(value, default=0):
    """数值段专用：只接受真正的数字（int/float / 纯数字字符串），其余回落 default。

    ⚠️ 通知里的数字段（经验 / 积分 / 连续天数 / 等级）**不得**用 `%s` 原样回显服务端字段：
       `checkin` 只校验 user 是 dict、awarded 是 bool，不校验这些字段的类型；
       一旦服务端把 `xp_added` 写成字符串 `"invalid"`，模板会渲染出「经验 +invalid」
       并把一条**成功**通知带进失效 Bot（复核探针 C 实测）。
    """
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if re.fullmatch(r"-?\d+", text):
            return int(text)
        if re.fullmatch(r"-?\d+\.\d+", text):
            return float(text)
    return default


# --------------------------------------------------------------------------
# 纯函数（按依赖顺序排列，便于顺序阅读）
# --------------------------------------------------------------------------


def is_truthy(raw, default=False):
    """布尔取值解析：1/true/yes/on/y → True；0/false/no/off/n → False。

    其它或空 → 回落到 default，并对**无法识别**的取值打一条 ⚠️ 警告后回落
    （照 whos-daily.js 的 WHOS_RATE_SCORE 约定：配置问题不中断任务）。
    注意 str.strip() 后为空串（比如环境变量写成空值）属于「未配置」，直接回落、不告警。
    """
    if raw is None:
        return default
    text = str(raw).strip().lower()
    if not text:
        return default
    if text in ("1", "true", "yes", "on", "y"):
        return True
    if text in ("0", "false", "no", "off", "n"):
        return False
    log("⚠️ 无法识别的布尔取值 `%s`，回落到 %s" % (raw, str(default).lower()))
    return default


def normalize_cookie(raw):
    """把用户粘贴的 Cookie 归一化成 `k=v; k=v`。

    容错：BOM、`Cookie:` 前缀、成对引号、换行/制表符、`;,` 混用分隔、多余空白、结尾分号。
    **不校验值的字符内容**：Cookie 值允许任意可见字符，过度校验会把能用的凭证判成无效。
    """
    if raw is None:
        return ""
    text = str(raw)
    if text.startswith("\ufeff"):
        text = text[1:]
    text = text.strip()
    if text.lower().startswith("cookie:"):
        text = text[len("cookie:"):]
    text = text.replace("\r", ";").replace("\n", ";").replace("\t", ";").replace(",", ";")
    text = text.strip().strip(";").strip()
    text = text.strip('"').strip("'").strip()
    text = text.strip().strip(";").strip()
    parts = []
    for part in text.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        parts.append(part)
    return "; ".join(parts)


def mask_secret(value):
    """脱敏：保留前 12 字符 + `***` + 末 4 字符；长度 ≤ 20 时只给 `***`。

    ⚠️ 阈值必须是 20 而不是 12：前 12 + 末 4 在长度 ≤ 16 时首尾重叠、等于**完整还原**
       （实测 len=13/14/16 都可从脱敏串拼回原文）。真实 MCII Cookie 约 200+ 字符，
       本条当前无实际泄漏路径，但阈值留足冗余以免日后换用短凭证时默默泄。

    日志与通知里出现的凭证标识**只能**来自这个函数，绝不打印完整 Cookie / 密码。
    """
    if not value:
        return "(空)"
    text = str(value)
    if len(text) <= 20:
        return "***"
    return "%s***%s" % (text[:12], text[-4:])


def parse_accounts(raw_accounts, raw_cookie):
    """解析环境变量，返回账号列表；缺配置/格式错时抛 MciiError('config', ...)。

    返回：[{"kind": "cookie"|"password", "name": str, "cookie"?: str,
            "username"?: str, "password"?: str}]

    规则：
      - raw_accounts 非空 → 必须是 JSON 数组；逐项校验，缺字段时报错**带下标**；
        一项同时给了 cookie 与 username/password 时按 cookie 走（cookie 优先）
      - raw_accounts 为空 → raw_cookie 非空则当作单账号 cookie 形态
      - 两者都空 → 缺配置（不是凭证失效，文案里不得出现 重新登录）
      - 保序去重：cookie 按 cookie 串，密码账号按 username
    """
    accounts = []
    seen = set()

    def push(account):
        if account["kind"] == "password":
            key = ("password", account["username"])
        else:
            key = ("cookie", account["cookie"])
        if key in seen:
            return
        seen.add(key)
        accounts.append(account)

    text = (raw_accounts or "").strip()
    if text:
        try:
            data = json.loads(text)
        except ValueError as exc:
            # ⚠️ json.JSONDecodeError 原文会带 `Invalid \escape` / `Invalid control character`，
            #    而「JSON 写错」属**配置缺失类**：它的通知在 main() 里**直接 send**，
            #    不经过 build_and_check_notification 的守卫。不在这里收口，
            #    一条配置错误就会被灌进失效提醒 Bot（第三轮复核实测，违反 R7 / AC3）。
            detail = "%s" % exc
            log("⚠️ MCII_ACCOUNTS 解析失败，原始错误：%s" % detail)
            raise MciiError(
                "config",
                "❌ MCII_ACCOUNTS 解析失败：%s\n"
                "请确认写成了合法 JSON 数组（Cookie 值里的反斜杠、换行、制表符等需要转义）"
                % notice_safe(detail, "JSON 语法错误"),
            )
        if not isinstance(data, list):
            raise MciiError(
                "config", '❌ MCII_ACCOUNTS 必须是 JSON 数组，例如 [{"cookie":"..."}]'
            )
        for index, item in enumerate(data):
            if not isinstance(item, dict):
                raise MciiError(
                    "config",
                    '❌ MCII_ACCOUNTS[%d] 不是 JSON 对象，应为 {"cookie":"..."} 或 '
                    '{"username":"...","password":"..."}' % index,
                )
            cookie = normalize_cookie(_as_text(item.get("cookie")))
            username = _as_text(item.get("username")).strip()
            password = _as_text(item.get("password"))
            name = _as_text(item.get("name")).strip()
            if cookie:
                push({"kind": "cookie", "name": name or mask_secret(cookie), "cookie": cookie})
                continue
            if username and password:
                push({"kind": "password", "name": name or username,
                      "username": username, "password": password})
                continue
            raise MciiError(
                "config",
                "❌ MCII_ACCOUNTS[%d] 缺少有效 cookie 字段，也没有完整的 "
                "username/password" % index,
            )
        if not accounts:
            raise MciiError(
                "config", "❌ MCII_ACCOUNTS 是空数组，至少填一个账号\n" + MSG_CONFIG_MISSING
            )
        return accounts

    cookie = normalize_cookie(raw_cookie)
    if not cookie:
        raise MciiError("config", MSG_CONFIG_MISSING)
    push({"kind": "cookie", "name": mask_secret(cookie), "cookie": cookie})
    return accounts


def matches_alert_routing(text):
    """青龙 Node-RED「双 TG Bot 分流」的 Python 等价实现（关键词表原样）。"""
    lower = str(text or "").lower()
    compact = re.sub(r"\s+", "", lower)
    for keyword in ALERT_KEYWORDS.split(","):
        keyword = keyword.strip()
        if not keyword:
            continue
        if keyword in lower:
            return True
        if re.sub(r"\s+", "", keyword) in compact:
            return True
    return False


def safe_label(name, index):
    """通知里出现的账号名（用户自填的 `name`）是**用户可控自由文本**，先过分流关键词。

    ⚠️ 否则一个叫「我的号已失效」的账号会把一条**完全正常**的通知带进失效 Bot，
       并且触发守卫的 ❌ 误报（谎称「静态通知模板自身命中」，把责任推给模板）。
       中立化只作用于**通知**；console 日志（面板内，不进 TG）仍保留用户填的原名，便于定位。
    """
    text = str(name or "").strip()
    if not text or matches_alert_routing(text):
        return "账号%d" % index
    return text


def notice_safe(value, fallback="未知"):
    """把即将进通知的动态片段过一遍分流关键词；命中则换成无关键词占位。

    通知里的自由文本来源不止 `skipped[].reason`：还有服务端字段（到期串 / 数值）、
    环境变量（`MCII_BASE_URL`）、异常消息。它们都**不该**决定这条通知进哪个 Bot。
    账号名用 `safe_label`，其余动态片段一律过本函数。
    原始值请另行 `log()` 到 console：面板日志不进 TG，可完整保留。
    """
    text = str(value)
    if matches_alert_routing(text):
        return fallback
    return text


def _json_keys_from(doc):
    """响应键列表用于排查「接口结构变了」，但它是**服务端可控文本**。

    ⚠️ 键名里若带 invalid / expired 这类词，原样拼进 schema_changed 文案就会把一个
       普通结构异常误导进失效 Bot（实测：响应键 {'invalid': True, 'expired_at': 1}
       → alerts True）。命中时分流整段省略，`缺少 X 字段` 这个事实本身不受影响。
    """
    if not isinstance(doc, dict):
        return "响应类型：%s" % type(doc).__name__
    keys = ", ".join(sorted(doc.keys()))
    if matches_alert_routing(keys):
        # ⚠️ 占位文案本身也必须**无关键词**：写「响应键已省略（键名命中失效分流关键词）」
        #    会把刚剔掉的词又塞回去（--selfcheck 实测抓到过）。
        return "响应键已省略"
    return "响应键：%s" % keys


def format_expires_at(value, now=None):
    """订阅到期时间 → 北京时间 `YYYY-MM-DD HH:MM（剩 N 天）`。

    输入实测形如 `2026-11-03T02:18:09.85777219Z`（**9 位小数 = 纳秒**）。
    `datetime.fromisoformat` 在 3.11 之前不接受 9 位小数、也不接受裸 `Z`，
    所以先把 `Z` 换成 `+00:00` 并**截断小数到 6 位**；解析失败**不抛**，
    但也不原样返回服务端文本 —— 它是服务端可控字段，
    写「订阅有效至 invalid」会把一条成功通知带进失效 Bot（复核探针 A 实测）。
    失败时原始值只进 console 日志，通知里给 `未知`。
    """
    if value is None:
        return "未知"
    text = str(value).strip()
    if not text:
        return "未知"

    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    match = re.match(r"^(.*\.\d{6})\d*(.*)$", normalized)
    if match:
        normalized = match.group(1) + match.group(2)
    try:
        parsed = datetime.datetime.fromisoformat(normalized)
    except ValueError:
        log("⚠️ 订阅到期时间无法解析，服务端原值：%s" % text[:120])
        return "未知"
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)

    beijing = parsed.astimezone(BEIJING_TZ)
    stamp = beijing.strftime("%Y-%m-%d %H:%M")
    current = now or datetime.datetime.now(datetime.timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=datetime.timezone.utc)
    remaining_days = (parsed - current).days
    if parsed <= current:
        return "%s（已过期）" % stamp
    if remaining_days <= 0:
        return "%s（剩不足 1 天）" % stamp
    return "%s（剩 %d 天）" % (stamp, remaining_days)


def describe_award(doc, confirm_partial=False):
    """把签到响应翻译成 (ok, 文案)。这三条分支是本脚本的全部业务判定。

    ⚠️ `awarded` 是**唯一**权威判定：不要拿 checkin_on 自己比日期（前端比的是浏览器本地日，
       服务端按自己时区写 checkin_on，跨时区/跨日边界会得出错误结论）。
    ⚠️ skipped 非空**不代表**签到失败：confirm_partial:true 时服务端可能边移除边签到，
       仍然返回 awarded:true，所以 skipped 只作提醒信息，不参与判定。
    ⚠️ needs_confirmation:true 且未 awarded = **签到压根没提交**，必须判失败：
       算成功会让面板显示绿而订阅实际没续期。
       （该分支形状属推断，见头部注释第 4 条：本机账号触发不到。）
    """
    doc = doc if isinstance(doc, dict) else {}
    skipped = doc.get("skipped")
    if not isinstance(skipped, list):
        skipped = []
    needs_confirmation = bool(doc.get("needs_confirmation"))
    awarded = doc.get("awarded") is True

    if needs_confirmation and not awarded:
        if confirm_partial:
            hint = (
                "已按 MCII_CONFIRM_PARTIAL=true 请求服务端自动移除无法激活的来源，"
                "但仍未完成，请到 https://proxy.mcii.cc/subscriptions 网页手动确认一次"
            )
        else:
            hint = (
                "本次按 MCII_CONFIRM_PARTIAL=false 保持非破坏性、未提交签到；"
                "如需自动移除这些来源请把 MCII_CONFIRM_PARTIAL 设为 true（默认值），"
                "或到 https://proxy.mcii.cc/subscriptions 网页确认"
            )
        return False, "⚠️ 有 %d 个来源当前无法激活，签到未完成。%s" % (len(skipped), hint)

    if awarded:
        xp_added = _num(doc.get("xp_added"))
        points_added = _num(doc.get("points_added"))
        return True, "✅ 签到成功：经验 +%s，积分 +%s，订阅已激活续期" % (
            xp_added,
            points_added,
        )

    return True, "✅ 今日奖励已领取（订阅已重新激活并续期，不重复发奖）"


def _snapshot(user):
    """从签到响应的 user 快照里挑出要展示的字段（不含任何凭证）。"""
    if not isinstance(user, dict):
        return {}
    return {
        "username": _as_text(user.get("username") or user.get("display_name")).strip(),
        "streak": user.get("checkin_streak"),
        "level": user.get("level"),
        "xp": user.get("xp"),
        "points": user.get("points"),
        "expires": user.get("subscription_expires_at"),
    }


def _stats_line(snapshot):
    """`连续签到 2 天 · Lv3 · 1065 XP · 20 积分`，缺字段就少一段。

    ⚠️ 全部数值过 `_num`：这些字段来自服务端 user 快照、未经类型校验，
       原样 `%s` 会把「连续签到 expired 账号 天」渲染进一条成功通知（复核探针 B 实测）。
    """
    parts = []
    for key, template in (
        ("streak", "连续签到 %s 天"),
        ("level", "Lv%s"),
        ("xp", "%s XP"),
        ("points", "%s 积分"),
    ):
        if snapshot.get(key) is None:
            continue
        number = _num(snapshot.get(key), None)
        if number is None:
            continue
        parts.append(template % number)
    return " · ".join(parts)


def build_notification(results, include_details=True):
    """组装 (标题, 正文)。标题的成功计数必须与各账号 verdict 一致。

    ⚠️ 服务端 `skipped[].reason` 是**自由文本**（站点自己的枚举里就有「大量节点失效」），
       只进 console 日志，**任何模式下都不进通知**，否则一个正常运行的通知会被
       Node-RED 分流进失效提醒 Bot。
    ⚠️ include_details=False 用于「通知自检回落」：连来源名（同样属于用户侧自由文本）
       也一并省略，保证静态模板不被自由文本带偏。
    """
    ok_count = sum(1 for item in results if item.get("ok"))
    lines = ["%s：成功 %d / 共 %d" % (TASK_TITLE, ok_count, len(results)), ""]
    for index, item in enumerate(results, 1):
        lines.append("【%s】%s" % (safe_label(item.get("name"), index), item.get("message")))
        snapshot = item.get("snapshot") or {}
        stats = _stats_line(snapshot)
        if stats:
            lines.append("    %s" % stats)
        if snapshot.get("expires"):
            lines.append("    订阅有效至 %s" % format_expires_at(snapshot["expires"]))
        if include_details:
            sources = [str(name) for name in (item.get("sources") or []) if name]
            if sources:
                lines.append("    未能激活的来源：%s" % "、".join(sources[:5]))
    return TASK_TITLE, "\n".join(lines)


def build_minimal_notification(results):
    """最后一道防线：只用**我们完全可控**的文本组装通知（标题 + 计数 + 序号 + 成败）。

    仅当「完整通知」与「剔除明细的通知」都命中分流关键词、但这条通知**确实不属于**
    凭证/登录类时才走到这里（说明有未覆盖的动态文本混进了正文）。
    代价是丢失可读性，但保证：① 不把正常通知灌进失效 Bot；② 不静默发送。
    动态细节全部已在 console 日志里。
    """
    ok_count = sum(1 for item in results if item.get("ok"))
    lines = ["%s：成功 %d / 共 %d" % (TASK_TITLE, ok_count, len(results)), ""]
    for index, item in enumerate(results, 1):
        lines.append("【账号%d】%s" % (index, "✅ 成功" if item.get("ok") else "❌ 失败"))
    lines.append("")
    lines.append("（通知正文混入了可控性未覆盖的动态文本，已降级为最小化通知；详情见面板日志）")
    return TASK_TITLE, "\n".join(lines)


def has_credential_failure(results):
    """存在**凭证类失败**账号（type == 'auth_failed'）→ 这条通知本身就是凭证提醒，
    命中分流关键词属于正命中，不该触发「自由文本回落」。

    ⚠️ 判定口径必须是 any（存在），**不是** all（全都）：
       「1 个坏 Cookie + 1 个网络失败」的混合场景里，all 会返回 False，
       于是 build_and_check_notification 把这条**本来完全正确**的通知当成分流误报，
       先打 ⚠️ 再打 ❌，其中 ❌ 还谎称「静态通知模板自身命中」并误导维护者去改模板。
       
       口径只取决于「这条通知里是否真存在需要用户去重新登录的账号」：
       存在 → 进失效 Bot 是正确行为，保留明细直接发；
       不存在（纯网络类/结构类/成功路径）→ 才需要防自由文本把普通通知带偏。
    """
    for item in results:
        if not item.get("ok") and item.get("type") == "auth_failed":
            return True
    return False


# --------------------------------------------------------------------------
# 网络层
# --------------------------------------------------------------------------


def base_url():
    raw = os.getenv("MCII_BASE_URL")
    text = (raw or "").strip() or DEFAULT_BASE_URL
    return text.rstrip("/")


def timeout_seconds():
    raw = os.getenv("MCII_TIMEOUT_MS")
    if raw is None or not str(raw).strip():
        return DEFAULT_TIMEOUT_MS / 1000.0
    try:
        value = float(str(raw).strip())
    except ValueError:
        log("⚠️ MCII_TIMEOUT_MS 不是数字（%s），回落到 %d" % (raw, DEFAULT_TIMEOUT_MS))
        return DEFAULT_TIMEOUT_MS / 1000.0
    if value <= 0:
        log("⚠️ MCII_TIMEOUT_MS 必须大于 0（%s），回落到 %d" % (raw, DEFAULT_TIMEOUT_MS))
        return DEFAULT_TIMEOUT_MS / 1000.0
    return value / 1000.0


def make_session(cookie=None):
    """最小头集 + 可选 Cookie。密码形态下不挂 Cookie，由 login 的 Set-Cookie 写入 CookieJar。

    ⚠️ Cookie 只存在内存里的 Session，任何情况下都不落盘、不打印。
    """
    session = requests.Session()
    session.headers.update({"Accept": "application/json", "User-Agent": USER_AGENT})
    if cookie:
        # 显式 Cookie 头：CookieJar 为空时 requests 会保留本头，不会被覆盖
        session.headers.update({"Cookie": cookie})
    return session


def _body_text(resp):
    """只用于判定 403 是否属于 email_required；不进入任何日志/通知。"""
    try:
        return resp.text or ""
    except Exception:
        return ""


def request_json(session, method, path, payload=None, where="", auth_statuses=(401,)):
    """统一请求 + 错误分类：network / rate_limited / auth_failed / email_required /
    api_error / schema_changed。

    ⚠️ api_error **不回显响应体**：站点错误文案自带「请先登录」这类词，
       原样拼进非凭证类通知会把普通失败误导进失效 Bot。
    ⚠️ 只对 429 做**分类显示**，不做自动重试（C4：cron 日频，失败次日自然重试，
       一次性任务挂死比失败更糟）。
    """
    url = base_url() + API_PREFIX + path
    try:
        resp = session.request(
            method,
            url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=timeout_seconds(),
        )
    except requests.RequestException as exc:
        # 网络文案里回显站点地址便于排查配置写错，但它是**环境可控文本**：
        # 用户把 host 写成 invalid.example 时，会把一个非凭证类失败带进失效 Bot
        # （复核探针 D 实测）。所以通知里过 notice_safe，原值只进 console 日志。
        log("⚠️ 网络请求失败：连不上 %s（%s）" % (base_url(), exc.__class__.__name__))
        raise MciiError(
            "network",
            "❌ 网络请求失败（连不上 %s）：%s（%s）"
            % (notice_safe(base_url(), "配置的站点地址"), exc.__class__.__name__, where),
        )
    if resp.status_code == 429:
        raise MciiError("rate_limited", "⚠️ MCII 返回 429 限流，请稍后重试（%s）" % where)
    if resp.status_code in auth_statuses:
        raise MciiError("auth_failed", MSG_AUTH_FAILED)
    if resp.status_code == 403 and "email_required" in _body_text(resp):
        raise MciiError("email_required", MSG_EMAIL_REQUIRED)
    if resp.status_code >= 400:
        raise MciiError(
            "api_error", "❌ MCII 接口返回异常状态 %s（%s）" % (resp.status_code, where)
        )
    try:
        return resp.json()
    except ValueError:
        raise MciiError(
            "schema_changed",
            "⚠️ MCII 接口结构未识别（schema_changed）：%s 返回非 JSON 内容" % where,
        )


def login(session, username, password):
    """密码形态：POST /auth/login，会话 Cookie 由 requests 自动收进 CookieJar。

    只校验 authenticated 为真，不解析 user 形状（成功响应形状属推断，见头部注释）。
    """
    doc = request_json(
        session, "POST", PATH_LOGIN,
        payload={"username": username, "password": password, "remember": True},
        where="账号密码登录",
    )
    if not isinstance(doc, dict) or doc.get("authenticated") is not True:
        raise MciiError(
            "schema_changed",
            "⚠️ MCII 接口结构未识别（schema_changed）：登录响应缺少 authenticated=true（%s）"
            % _json_keys_from(doc),
        )
    return doc


def checkin(session, confirm_partial):
    """POST /me/checkin {"confirm_partial": <bool>} —— 签到与激活订阅是同一个接口。

    每次运行都真发这一次 POST，**不因「今天已签到」而跳过**（见头部事实 3）。
    响应必须含 user(dict) 与 awarded(bool)，否则按 schema_changed 处理。
    """
    doc = request_json(
        session, "POST", PATH_CHECKIN,
        payload={"confirm_partial": bool(confirm_partial)}, where="签到",
    )
    if not isinstance(doc, dict):
        raise MciiError(
            "schema_changed",
            "⚠️ MCII 接口结构未识别（schema_changed）：签到响应不是 JSON 对象（%s）"
            % _json_keys_from(doc),
        )
    user = doc.get("user")
    if not isinstance(user, dict) or not isinstance(doc.get("awarded"), bool):
        raise MciiError(
            "schema_changed",
            "⚠️ MCII 接口结构未识别（schema_changed）：签到响应缺少 user 或 awarded 字段（%s）"
            % _json_keys_from(doc),
        )
    return doc


# --------------------------------------------------------------------------
# 编排
# --------------------------------------------------------------------------


def _skipped_names(skipped):
    """skipped[] 的来源名（只给通知的 include_details=True 用，不含服务端 reason 文本）。"""
    if not isinstance(skipped, list):
        return []
    names = []
    for item in skipped:
        if not isinstance(item, dict):
            continue
        name = _as_text(item.get("name")).strip()
        if not name:
            source_id = item.get("source_id")
            name = "来源%s" % source_id if source_id is not None else "未命名来源"
        names.append(name)
    return names


def _log_skipped_details(tag, skipped):
    """服务端 skipped[].reason 是自由文本，**只进 console 日志**，绝不进通知正文。"""
    if not isinstance(skipped, list):
        return
    for item in skipped:
        if not isinstance(item, dict):
            continue
        name = _as_text(item.get("name")).strip() or "来源%s" % item.get("source_id")
        reason = _as_text(item.get("reason")).strip() or "未给出原因"
        log("%s 未能激活的来源：%s（%s）" % (tag, name, reason[:80]))


def run_account(account, index, confirm_partial):
    """跑单个账号，内部捕获所有异常，绝不向调用方抛出（多账号隔离）。

    verdict 在**唯一业务步骤（签到）跑完之后**才定稿，不存在「先置成功、后吞异常」。
    """
    name = account.get("name") or "账号%d" % index
    tag = "账号%d(%s)" % (index, name)
    result = {"name": name, "ok": False, "type": None,
              "message": "❌ 签到失败", "snapshot": {}, "sources": []}

    try:
        if account.get("kind") == "password":
            session = make_session()
            login(session, account.get("username"), account.get("password"))
            log("%s 登录成功（账号密码形态，会话仅存内存）" % tag)
        else:
            session = make_session(account.get("cookie"))
            # Cookie 形态不做额外的 GET /me 预校验：签到接口本身就会返回 401，
            # 多打一个请求只是多一个失败点（design.md §2.3）。
            log("%s Cookie 形态，直接签到（签到接口同时校验登录态）" % tag)

        doc = checkin(session, confirm_partial)
        ok, message = describe_award(doc, confirm_partial)

        result["ok"] = bool(ok)
        result["message"] = message
        result["snapshot"] = _snapshot(doc.get("user"))
        result["sources"] = _skipped_names(doc.get("skipped"))
        if not ok:
            result["type"] = "needs_confirmation"

        log("%s %s" % (tag, message))
        stats = _stats_line(result["snapshot"])
        if stats:
            log("%s %s" % (tag, stats))
        if result["snapshot"].get("expires"):
            log(
                "%s 订阅有效至 %s"
                % (tag, format_expires_at(result["snapshot"]["expires"]))
            )
        _log_skipped_details(tag, doc.get("skipped"))
    except MciiError as exc:
        result["ok"] = False
        result["type"] = exc.type
        result["message"] = exc.message
        log("%s %s" % (tag, exc.message))
    except Exception as exc:  # 单账号未知异常隔离，不中断其余账号
        detail = "%s: %s" % (exc.__class__.__name__, exc)
        result["ok"] = False
        result["type"] = "unknown"
        # 异常消息是**不可控自由文本**（如 `ValueError: invalid literal for int()`），
        # 进通知前过 notice_safe，完整细节只进 console 日志（复核探针 E）。
        result["message"] = "❌ 签到失败（未知错误）：%s" % notice_safe(detail, "详见面板日志")
        log("%s ❌ 签到失败（未知错误）：%s" % (tag, detail))

    return result


def build_and_check_notification(results):
    """组装通知并做分流自洽性自检（design.md §6.2）。

    命中分流关键词时只有两种可能：
      ① 确实有凭证类失败账号 → 正命中，原样发送（用户要的就是这条提醒）；
      ② 非凭证类通知被动态文本带偏 → 逐级回落（剔明细 → 最小化通知），
         回落**必须真正生效**：只打日志不回退等于没回落。
    """
    title, content = build_notification(results, include_details=True)
    if matches_alert_routing(title + "\n" + content):
        if has_credential_failure(results):
            return title, content
        log("⚠️ 通知正文意外命中失效分流关键词，已剔除自由文本详情后重发")
        title, content = build_notification(results, include_details=False)
        if matches_alert_routing(title + "\n" + content):
            log("❌ 仍有可控性未覆盖的动态文本进入通知正文，已降级为最小化通知（请补收口）")
            title, content = build_minimal_notification(results)
    return title, content


# --------------------------------------------------------------------------
# 通知（多候选路径查找 sendNotify，失败降级 print，绝不因通知中断任务）
# --------------------------------------------------------------------------

# 查找必须有界：青龙面板的 /ql/data/scripts 可能有上千个脚本目录，无界递归/无界展开会
# 在每次启动时拖慢任务。下面四个常量分工明确，每个都必须真能触发（不能摆一个永不可达的数字）。
#
# 注意：候选目录是**两遍构建**（见 _candidate_dirs）：先占固定位置，再单独做子目录展开，
# 两遍各有独立预算，互不打架。
MAX_UP_LEVELS = 3            # 从脚本目录向上最多走 3 代：仓库通常只有 <repo>/mcii/ 一层，
                             #   向上 3 代足够覆盖 <repo>、<repo>/.. 这类常见落位，再往上就出仓库了
MAX_CHILDREN_PER_ROOT = 40   # 单个根最多展开多少个子目录：防止某一个巨型根（如平铺了
                             #   上百个脚本的 /ql/data/scripts）独吞整个展开预算；必须小于
                             #   MAX_EXPANSIONS 才有意义（曾写成 200，而总闸只有 60，永不可达）
MAX_EXPANSIONS = 50          # 子目录展开产物总数：多个根共享的展开预算，只统计真正 add 的目录
MAX_CANDIDATES = 60          # 候选目录总数上限（固定位置 + 展开），最后一道硬闸

# 降级告警文案（模块级常量：--selfcheck 直接断言同一份文本，避免两处漂移）。
# ⚠️ 文案**不得**含失效分流关键词（已失效/失效/expired/invalid/重新登录/发生异常 等）；
#    它只走 log()（console / 面板日志），**不**拼进 build_notification() 的通知正文。
MSG_SEND_NOTIFY_MISSING = "⚠️ 未找到 sendNotify.py，本次通知未发送（已搜索 %d 个目录）"
MSG_SEND_NOTIFY_FIX = (
    "⚠️ 修复：把 sendNotify.py 放到脚本同目录，"
    "或复制 fuliba/sendNotify.py 到青龙脚本根 /ql/data/scripts/"
)

# 一轮运行最多会调 2–3 次通知（配置缺失分支 + 结果汇总），重复刷屏会让人关掉通知，
# 所以降级告警用模块级 flag 保证只打一次。
_send_notify_missing_warned = False


def _safe_listdir(path):
    """列目录，权限不足/不存在一律吞掉返回空列表（不能让通知查找把任务搞崩）。"""
    try:
        return os.listdir(path)
    except OSError:
        return []


def _candidate_dirs():
    """按优先级返回可能存放 sendNotify.py 的目录。有界：不递归、层数与子目录数都有硬上限。

    **两遍构建**（关键，不要写成一遍）：
      · 第一遍只加**固定位置**（脚本同目录 → 逐代向上 → cwd → 两个 /ql 字面路径 +
        它们的 function 子目录），这些位置永远吃得下，不会被子目录扫描挤掉；
      · 第二遍才做**子目录展开**，用独立预算 MAX_EXPANSIONS，且只 add 真目录。

    为什么必须分两遍：青龙面板的 /ql/data/scripts 是**平铺**着上百个脚本的目录。
    若边加固定位置边展开、共用一个 MAX_CANDIDATES，它作为 generation 0 的父目录展开时会
    把平铺条目全部塞进候选、吃光额度，导致后面的 /ql/data/scripts/function
    （标准候选位，function/sendNotify.py 的实际落点）被挤出列表 —— 于是**老版本能找到、
    新版本找不到**，纯回归。分两遍后固定位置先占位，展开走自己的预算，互不干扰。

    为什么只展开最近两代：脚本在 <repo>/mcii/ 时，generation 0 的父目录正好是 <repo>，
    展开后覆盖 <repo>/fuliba/ —— 即「同仓库不同子目录」这一核心修复点；再往上的代
    只加自己，避免在 /ql 这种大目录下做多余扫描。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    out, seen = [], set()

    def add(path):
        if len(out) >= MAX_CANDIDATES:
            return
        try:
            resolved = os.path.abspath(path)
        except Exception:
            return
        if resolved in seen:
            return
        seen.add(resolved)
        out.append(resolved)

    # —— 第一遍：固定位置（约 10 个，永远吃得下） ——
    add(here)  # 1) 脚本同目录
    roots = []
    cur = here
    for generation in range(MAX_UP_LEVELS):  # 2) 逐代向上
        parent = os.path.dirname(cur)
        if not parent or parent == cur:  # 到文件系统根了
            break
        add(parent)
        if generation < 2:  # 只对最近两代展开子目录
            roots.append(parent)
        cur = parent

    add(os.getcwd())  # 3) cwd
    for base in ("/ql/data/scripts", "/ql/scripts"):
        add(base)
        add(os.path.join(base, "function"))

    # —— 第二遍：子目录展开（独立预算，只取目录） ——
    expanded = 0
    for root in roots:
        for name in sorted(_safe_listdir(root))[:MAX_CHILDREN_PER_ROOT]:
            if expanded >= MAX_EXPANSIONS:
                break
            sub = os.path.join(root, name)
            if not os.path.isdir(sub):  # 只要真目录；平铺的脚本文件跳过
                continue
            add(sub)
            expanded += 1
    return out


def _warn_send_notify_missing(searched):
    """降级不再静默：找不到通知模块时打一次 ⚠️ 告警，说明未发送 + 该放哪。

    只打一次（模块级 flag）；只走 log()，不改退出码、不中断任务。
    """
    global _send_notify_missing_warned
    if _send_notify_missing_warned:
        return
    _send_notify_missing_warned = True
    log(MSG_SEND_NOTIFY_MISSING % searched)
    log(MSG_SEND_NOTIFY_FIX)


def load_send_notify():
    """返回 sendNotify.send，找不到返回 None（并在返回前打一次降级告警）。"""
    try:
        from sendNotify import send

        return send
    except Exception:
        pass

    candidate_dirs = _candidate_dirs()
    for directory in candidate_dirs:
        if not os.path.isfile(os.path.join(directory, "sendNotify.py")):
            continue
        if directory not in sys.path:
            sys.path.insert(0, directory)
        try:
            from sendNotify import send

            return send
        except Exception:
            # 坏副本不能挡住后面的好副本：失败的 import 可能把半成品留在 sys.modules，
            # 不清理的话下一个候选会直接命中缓存里那个坏模块。
            sys.modules.pop("sendNotify", None)
            continue
    _warn_send_notify_missing(len(candidate_dirs))
    return None


def send_notification(title, content):
    """发送通知；任何失败一律降级为 print，绝不抛、绝不改退出码。"""
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
# 自检（不联网、不读环境变量）
# --------------------------------------------------------------------------


def run_selfcheck():
    """`--selfcheck`：断言错误分类文案与分流关键词归属（R7 / AC10 的机器化证明）。"""
    sample_user = {
        "id": 1,
        "username": "demo_user",
        "display_name": "演示账号",
        "level": 3,
        "xp": 1065,
        "points": 20,
        "checkin_streak": 2,
        "checkin_on": "2026-10-20",
        "subscription_expires_at": "2026-11-03T02:18:09.85777219Z",
    }
    awarded_doc = {"user": sample_user, "awarded": True, "xp_added": 5, "points_added": 2,
                   "needs_confirmation": False, "skipped": []}
    replayed_doc = {"user": sample_user, "awarded": False, "xp_added": 0, "points_added": 0,
                    "needs_confirmation": False, "skipped": []}
    confirm_doc = {"user": sample_user, "awarded": False, "xp_added": 0, "points_added": 0,
                   "needs_confirmation": True,
                   "skipped": [{"source_id": 143, "name": "范特西", "reason": "订阅已过期"}]}

    cases = []

    def check(label, text, expected):
        actual = matches_alert_routing(text)
        cases.append((label, expected, actual, text))

    ok_message = describe_award(awarded_doc, True)[1]
    replayed_message = describe_award(replayed_doc, True)[1]
    confirm_message = describe_award(confirm_doc, False)[1]

    # —— 必须命中：凭证类 / 顶层兜底 ——
    check("凭证失效文案", MSG_AUTH_FAILED, True)
    check("凭证失效文案（标题+账号明细）", TASK_TITLE + "\n" + "【账号2】" + MSG_AUTH_FAILED, True)
    check("顶层兜底文案", "❌ 发生异常:执行失败\n\nTypeError: x", True)

    # —— 必须不命中：成功路径 / 各非凭证类失败 / 配置缺失 ——
    check("签到成功文案", ok_message, False)
    check("今日奖励已领取文案", replayed_message, False)
    check("needs_confirmation 提示", confirm_message, False)
    check("email_required 提示", MSG_EMAIL_REQUIRED, False)
    check("网络失败文案", "❌ 网络请求失败（连不上 %s）：Timeout（签到）" % DEFAULT_BASE_URL, False)
    check("429 限流文案", "⚠️ MCII 返回 429 限流，请稍后重试（签到）", False)
    check("api_error 文案", "❌ MCII 接口返回异常状态 500（签到）", False)
    check(
        "schema_changed 文案",
        "⚠️ MCII 接口结构未识别（schema_changed）：签到响应缺少 user 或 awarded 字段"
        "（响应键：awarded, skipped）",
        False,
    )
    check("配置缺失文案", MSG_CONFIG_MISSING, False)

    # —— 整条通知（标题+正文）的自洽性 ——
    def result(name, ok, type_, message, snapshot=None, sources=()):
        return {"name": name, "ok": ok, "type": type_, "message": message,
                "snapshot": snapshot or {}, "sources": list(sources)}

    good = result("demo_user", True, None, ok_message, _snapshot(sample_user))
    title, content = build_notification([good], include_details=True)
    check("成功通知（标题+正文）", title + "\n" + content, False)
    check(
        "混合通知：成功1/共2 + 一个凭证失败（语义自洽，应命中）",
        build_notification(
            [good, result("账号2", False, "auth_failed", MSG_AUTH_FAILED)]
        )[1],
        True,
    )

    # —— 守卫口径：只看「是否存在凭证类失败」，不是「是否全为凭证类失败」 ——
    def check_bool(label, actual, expected=True):
        cases.append((label, expected, actual, "%s → %s" % (label, actual)))

    auth_item = result("账号2", False, "auth_failed", MSG_AUTH_FAILED)
    net_item = result("账号3", False, "network",
                      "❌ 网络请求失败（连不上 x）：Timeout（签到）")
    check_bool("守卫：仅凭证失败 → True", has_credential_failure([auth_item]))
    check_bool(
        "守卫：凭证失败 + 网络失败 → True（写成 all 会误退 False 并打出模板误报）",
        has_credential_failure([auth_item, net_item]),
    )
    check_bool("守卫：仅网络失败 → False", has_credential_failure([net_item]), False)
    check_bool("守卫：成功 + 凭证失败 → True", has_credential_failure([good, auth_item]))

    # 行为断言：凭证类命中时守卫**不**回落，自由文本详情段必须保留
    _, guard_content = build_and_check_notification(
        [good, result("账号2", False, "auth_failed", MSG_AUTH_FAILED, sources=["某来源"])]
    )
    check_bool("守卫：凭证类命中时保留明细（不回落）", "未能激活的来源" in guard_content)

    # —— 自由文本三处口子：用户自填 name / 服务端响应键 ——
    risky_name = result("我的号已失效", True, None, ok_message, _snapshot(sample_user))
    _, name_content = build_and_check_notification([risky_name])
    check("通知：用户自填 name 命中关键词时被中立化", TASK_TITLE + "\n" + name_content, False)
    check_bool("通知：中立化后仍保留账号维度（账号1）", "【账号1】" in name_content)
    check("schema_changed：服务端响应键含 invalid/expired 时整段省略",
          "⚠️ MCII 接口结构未识别（schema_changed）：签到响应缺少 user 字段"
          "（%s）" % _json_keys_from({"invalid": True, "expired_at": 1}), False)
    check_bool(
        "schema_changed：正常响应键仍保留（可排查结构变化）",
        "响应键：awarded, skipped, user" == _json_keys_from({"user": 1, "awarded": True, "skipped": []}),
    )

    # —— 配置类：JSONDecodeError 原文带 `Invalid \escape`，且 config 分支不经过守卫 ——
    for bad_json in ('{"a":"\\q"}', '[{"cookie":"a\nb"}]'):
        try:
            parse_accounts(bad_json, None)
            check_bool("配置类：非法 JSON 必须抛 MciiError", False)
        except MciiError as exc:
            check("配置类：非法 JSON 的解析失败文案不命中", exc.message, False)
    try:
        parse_accounts('{"not":"array"}', None)
        check_bool("配置类：非数组必须抛 MciiError", False)
    except MciiError as exc:
        check("配置类：非数组文案不命中", exc.message, False)

    # —— 动态文本逐处收口：服务端字段 / 环境变量 / 异常消息 ——
    bad_doc = {
        "user": dict(sample_user, subscription_expires_at="invalid"),
        "awarded": True,
        "xp_added": "invalid",
        "points_added": 2,
        "needs_confirmation": False,
        "skipped": [],
    }
    bad_item = result(
        "demo_user", True, None, describe_award(bad_doc, True)[1],
        {"streak": "expired 账号", "level": 3, "xp": 1065, "points": 20,
         "expires": "已失效"},
    )
    bad_title, bad_content = build_notification([bad_item], include_details=True)
    check("动态文本：数值/到期串/连续天数含关键词时通知不命中",
          bad_title + "\n" + bad_content, False)
    check_bool("动态文本：到期串解析失败回落为「未知」", "订阅有效至 未知" in bad_content)
    check_bool("动态文本：非数字字段整段不渲染", "expired" not in bad_content)
    check_bool("动态文本：非数字经验值回落为 +0", "经验 +0" in bad_content)

    check(
        "环境变量：BASE_URL 含 invalid 时网络文案不命中",
        "❌ 网络请求失败（连不上 %s）：ConnectionError（签到）"
        % notice_safe("https://invalid.example", "配置的站点地址"),
        False,
    )

    # —— 最后一道防线：未被收口的动态文本 → 降级为最小化通知 ——
    leaky = result("账号1", False, "api_error",
                   "❌ MCII 接口返回异常状态 500（签到）invalid")
    lean_title, lean_content = build_and_check_notification([leaky])
    check("兜底：未收口动态文本时降级后的通知不命中", lean_title + "\n" + lean_content, False)
    check_bool("兜底：降级通知保留计数与成败",
               "成功 0 / 共 1" in lean_content and "【账号1】❌ 失败" in lean_content)

    # —— 通知回落：自由文本注入 → 命中 → 剔除明细 → 不命中 ——
    risky = [result("milktea", True, None, ok_message, _snapshot(sample_user),
                    ["大量节点失效线路"])]
    first_title, first_content = build_notification(risky, include_details=True)
    second_title, second_content = build_notification(risky, include_details=False)
    fallback_ok = matches_alert_routing(first_title + "\n" + first_content) and not (
        matches_alert_routing(second_title + "\n" + second_content)
    )
    cases.append(("通知回落：明细注入自由文本后剔除可消除命中", True, fallback_ok,
                  "include_details=True → 命中；include_details=False → 不命中"))

    # —— 通知降级告警：文案必须无分流关键词（AC11），且真的说了"未发送"（AC7） ——
    #     文案取自模块级常量，与实际 load_send_notify() 打出的文本同源，避免两处漂移。
    for label, text in (
        ("未找到 sendNotify.py 告警", MSG_SEND_NOTIFY_MISSING % 24),
        ("修复提示", MSG_SEND_NOTIFY_FIX),
    ):
        check(label, text, False)
        # AC7：告警合起来必须明确告诉用户"本次通知未发送" —— 该说明在「未找到…」那行，
        #       「修复提示」行只讲怎么放文件，两行合起来才是完整、可行动的告警。
        cases.append((label + "（含'未发送'说明）", True,
                      "未发送" in (MSG_SEND_NOTIFY_MISSING % 24 + text), text))

    failed = 0
    for label, expected, actual, text in cases:
        passed = expected == actual
        if not passed:
            failed += 1
        print(
            "%s selfcheck %s %s（期望 %s，实际 %s）"
            % (LOG_PREFIX, "✅" if passed else "❌", label, expected, actual)
        )
        if not passed:
            print("%s   文案：%s" % (LOG_PREFIX, str(text).replace("\n", " / ")[:160]))

    print(
        "%s selfcheck %s：共 %d 项，通过 %d，失败 %d"
        % (LOG_PREFIX, "✅" if failed == 0 else "❌", len(cases), len(cases) - failed, failed)
    )
    return 0 if failed == 0 else 1


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------


def main():
    # 默认 true：用户已确认「宁可让脚本自动移除无法激活的来源，也要把签到做掉」
    confirm_partial = is_truthy(os.getenv("MCII_CONFIRM_PARTIAL"), True)

    try:
        accounts = parse_accounts(os.getenv("MCII_ACCOUNTS"), os.getenv("MCII_COOKIE"))
    except MciiError as exc:
        log(exc.message)
        title, content = TASK_TITLE, exc.message
        # config 类**不得**命中分流关键词（R7/AC3）。这条路径不走 build_and_check_notification，
        # 所以单独兜一道：万一仍有未收口的动态文本（如 JSON 原始错误），降级为无关键词文案。
        if matches_alert_routing(title + "\n" + content):
            log("❌ 配置类通知意外命中失效分流关键词，已降级（请补收口）")
            content = "%s：环境变量配置无效，请检查后重试（详情见面板日志）" % TASK_TITLE
        send_notification(title, content)
        return 1

    log(
        "开始签到：共 %d 个账号（confirm_partial=%s）"
        % (len(accounts), str(confirm_partial).lower())
    )

    results = []
    for index, account in enumerate(accounts, 1):
        if index > 1:
            time.sleep(ACCOUNT_GAP_MS / 1000.0)
        results.append(run_account(account, index, confirm_partial))

    title, content = build_and_check_notification(results)
    send_notification(title, content)

    return 0 if all(item.get("ok") for item in results) else 1


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        sys.exit(run_selfcheck())
    try:
        sys.exit(main())
    except Exception as exc:
        fallback = "❌ 发生异常:执行失败\n\n%s: %s" % (exc.__class__.__name__, exc)
        log(fallback)
        send_notification(TASK_TITLE, fallback)
        sys.exit(1)
