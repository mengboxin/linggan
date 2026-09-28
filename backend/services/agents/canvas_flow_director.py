"""Canvas-flow drama director: understand source material, then compile a graph recipe.

The director only writes a graph recipe. Image/video generation stays on the
existing canvas-flow execution planner.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Literal, TypedDict

from fastapi import HTTPException
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

import repositories.model_repo as model_repo
from services.agents.base import call_llm_chat
from services.attachment_parser import build_attachment_context
from services.billing_operation import model_billing_operation_key
from services.model_billing import execute_billed_model_call

logger = logging.getLogger(__name__)

DirectorMode = Literal["shot_pipeline", "nine_grid"]
DirectorInputMode = Literal["plan", "inherit"]
DirectorIntent = Literal["plan", "edit", "rebuild"]
DirectorObjective = Literal["full_episode", "script_breakdown", "character_consistency", "shot_production"]
DirectorSourceKind = Literal["premise", "script", "canvas"]
DirectorGenre = Literal[
    "urban", "apocalypse", "xianxia", "campus", "rule_horror", "office",
    "costume", "scifi", "mystery", "romance", "war", "custom",
]
DirectorLook = Literal["manhua", "manga", "live_action", "cinematic", "illustration"]
DirectorStage = Literal["script", "board", "cast", "stills", "episode"]

MAX_SHOTS = 8
DEFAULT_SHOTS = 6
MAX_CHARACTERS = 4
MAX_TOPIC_CHARS = 8000
MAX_REPAIR_ATTEMPTS = 2
VALID_GENRES = {
    "urban", "apocalypse", "xianxia", "campus", "rule_horror", "office",
    "costume", "scifi", "mystery", "romance", "war", "custom",
}
VALID_INTENTS = {"plan", "edit", "rebuild"}
VALID_LOOKS = {"manhua", "manga", "live_action", "cinematic", "illustration"}
VALID_STAGES = {"script", "board", "cast", "stills", "episode"}
VALID_OBJECTIVES = {"full_episode", "script_breakdown", "character_consistency", "shot_production"}
VALID_SOURCE_KINDS = {"premise", "script", "canvas"}

_AGE_WORD = re.compile(r"男孩|女孩|少年|孩子|儿童|幼童|\bboy\b|\bgirl\b|\bchild\b|\bkid\b|\bteen\b|\byoung\b", re.I)
_REAL_FACE = re.compile(r"真实人脸|真人面部|real human face|real person", re.I)
_ANTISLOP = re.compile(
    r"令人叹为观止|视觉盛宴|光影交响|巧妙融合|震撼人心|breathtaking|stunning|cinematic masterpiece|a symphony of|seamlessly|flawlessly|groundbreaking",
    re.I,
)
TEMPLATE_CLICHES = (
    "一句闲话或一个眼神把身份差露出来",
    "当众被低估或羞辱",
    "日常裂口",
    "证据翻盘",
    "当众被嘲",
    "都市日常空间先看起来正常",
)

LOOK_PROMPTS: dict[str, str] = {
    "manhua": "当代国漫厚涂剧场，电影构图，皮肤有体积和血色，服装褶皱清楚，五官立体，不是日漫大眼赛璐璐，不是扁平贴纸。8K 高清，无文字，无水印。",
    "manga": "日韩漫画赛璐璐平涂，干净流畅线条，精致五官，类似高质量乙游动态漫，统一光源。8K 高清，无文字，无水印。",
    "live_action": "超写实数字短剧剧照，皮肤毛孔、布料质感、自然光和轻微镜头呼吸，像真人短剧，不是二次元，不是漫画线稿，不是插画描边。8K 高清，无文字，无水印。",
    "cinematic": "电影剧照，浅景深，写实光影，16:9 宽银幕，偏真人质感的数字角色，色彩有胶片层次，不是动漫滤镜。8K 高清，无文字，无水印。",
    "illustration": "高质量数字插画剧场，细腻光影和材质，偏概念艺术，构图完整，不是廉价日漫滤镜，不是简笔漫画。8K 高清，无文字，无水印。",
}

FACTS_SYSTEM = """你是中文短剧编剧助理。只抽取用户原文和附件里已经出现的事实，不要写成另一个故事。
只返回 JSON，不要 markdown 围栏。
{
  "must_keep": ["必须保留的人名/地名/道具/关键对白"],
  "characters": [{"name": "原文里的名字", "identity": "原文给出的身份", "look": "原文给出的外貌或服装"}],
  "conflict": "原文里的冲突，没有就空字符串",
  "events": ["原文里按顺序发生的事件"],
  "setting": "原文里的地点或时代",
  "source_kind": "topic|script|board|mixed"
}
规则：
- 没有写过的信息标空，禁止脑补都市打脸、末世觉醒、仙侠废灵等类型母题。
- must_keep 必须能在用户原文或附件中找到原文。
- 不要输出剧本或分镜。
"""

SCENES_SYSTEM = """你是中文分场助理。只把用户剧本/分镜拆成已经写过的场次，不要改情节，不要另写故事。
只返回 JSON，不要 markdown 围栏。
{
  "scenes": [
    {"index": 1, "heading": "场次或地点", "action": "这段里发生了什么", "dialogue": "关键对白原文", "source_ref": "尽量贴近原文的一句"}
  ]
}
规则：
- inherit 模式：一场对应原文里的一个场次/镜头，不要合并成类型母题。
- heading / action / dialogue / source_ref 必须能在用户原文或附件里找到依据。
- 没有写过的不要补。最多 8 场。
"""

PLAN_SYSTEM = """你是中文短剧/漫剧导演，也是给小白用的制片。用户可能只丢一句话题材。
你的工作不是复述用户原句，而是交出这一集能拍的制作包。
只返回 JSON，不要 markdown 围栏，不要解释。

输出形状：
{
  "title": "剧名 · 第一集",
  "mode": "shot_pipeline 或 nine_grid",
  "bible": {
    "logline": "一句话：谁在什么规则/压力下做什么，代价是什么",
    "genre": "urban|apocalypse|xianxia|campus|office|costume|scifi|custom",
    "look": "manhua|manga|live_action|cinematic|illustration",
    "style": "跟 look 一致的视觉描述，不要擅自改成日漫",
    "setting": "这一集发生的具体地点，2-3 个可反复拍的空间",
    "hook": "开场 3 秒看得见的异常或冲突",
    "conflict": "这一集唯一主冲突",
    "rules": ["可执行的世界规则或校规，能遵守、能违反、违反有可见后果"],
    "script_card": "这一集剧本：按场次写地点、动作、对白，不要四行提纲"
  },
  "characters": [
    {"id": "hero", "name": "角色名", "identity": "这一集里的身份", "sheet_prompt": "发型/五官/服装/标志物，用于三视图和正面锁定"}
  ],
  "shots": [
    {
      "id": "shot-1",
      "title": "镜头名",
      "has_characters": true,
      "character_ids": ["hero"],
      "location": "这一镜的地点",
      "shot_size": "远景|全景|中景|近景|特写",
      "camera": "固定|缓推|缓拉|跟拍|硬切|正反打",
      "action": "谁在做什么，必须是看得见的动作",
      "dialogue": "这一镜的对白或空字符串",
      "storyboard": "给导演看的镜头说明：地点+景别+动作+对白",
      "image_prompt": "只写这一镜画面里看见什么",
      "motion_prompt": "这一镜的运镜和动作",
      "duration": 5,
      "source_ref": "对应的用户原文、事实或你发明的规则"
    }
  ]
}

先判断素材薄不薄：
- 用户只给题材/类型/一句话（例如「校园规则怪谈」）：input_mode=plan 时你必须发明这一集。补 3-5 条可执行规则、至少两个可画角色、开场钩子、5-8 个不同节拍。不要把用户原句贴进 logline、剧本或每一镜。
- 用户已经写出人名、场次、对白：优先用原文。缺的镜头字段才补。
- input_mode=inherit：用户剧本/分镜是 canon。只结构化，不换情节、不换人名、不合并场次。

类型理解（用来发明，不是用来套话）：
- 校园 + 规则怪谈/校规：必须发明 3-5 条可执行校规，能遵守、能违反、违反有可见后果。至少两个角色：进入规则的人 + 执行规则的人。不要把「校园规则怪谈」六个字写进每一镜。
- 校园青春（没有怪谈）：公开课/操场上的同辈对峙，高光是答题、比赛或点名，不是校规杀人。
- 职场：必须有当众放完的证据（录音、聊天记录、文件），不要写「身份差露出来」。
- 末世：先给一个具体救人/能力兑现，再给暴露的代价，不要只写废墟氛围。
- 仙侠：境界差落在一个可见法术或器物动作上。
- 都市情感：当众高光必须是具体动作或对白，不是眼神蒙太奇。
- 古装权谋：宴席/朝堂上诏书、跪和不跪必须看得见。
- 科幻：一条可读的系统规则，工牌、身体或闸机变化看得见。

硬规则：
- 保持用户语言。不要翻译成英文，除非用户原文是英文。
- 严格使用用户指定的 genre / look / stage。look=manhua 是国漫厚涂，look=live_action 是数字真人短剧，look=manga 才是日韩漫画。
- 禁止套类型模板节拍。尤其禁止：一句闲话或一个眼神把身份差露出来、当众被低估或羞辱、日常裂口、证据翻盘。
- 禁止把用户原句整句复制进每一镜。
- script_card 必须是能演的剧本：场次标题、动作、至少两句对白。禁止只写「场次/人物/冲突/钩子」四行。
- 每镜必须彼此不同：不同地点或不同动作。必须填 location、shot_size、camera、action；有人开口就写 dialogue。
- image_prompt 只写这一镜看见什么，不要重复「国漫厚涂 / 8K 高清 / 无文字 / 无水印」。画风只写在 bible.style。
- 默认 shot_pipeline。只有用户明确说九宫格/漫画页时才用 nine_grid。
- shot_pipeline：1-8 镜，默认按用户给定镜数。每镜 4-8 秒。
- 有人物的镜头 has_characters=true，character_ids 必须能在 characters 里找到。
- image_prompt 写单镜头剧场画面，禁止 comic page / 九宫格 / 分镜稿。
- motion_prompt 写该镜头场景里的动作和运镜，禁止“镜头扫过漫画页/九宫格/分镜稿”。
- 禁用年龄词（男孩/女孩/少年/孩子/boy/girl/child/kid）和真实人脸。
- 禁用 antislop：令人叹为观止、视觉盛宴、breathtaking、stunning、cinematic masterpiece。
- 不要编造真实名人脸。不要输出 NSFW。
"""

REPAIR_SYSTEM = """你是短剧导演修订助理。根据保真问题改计划。
薄题材要把规则、人物、对白补具体；承接脚本时必须贴着用户原文，不要换成类型模板。
只返回完整计划 JSON，形状与导演计划相同。不要 markdown 围栏。
禁止出现：一句闲话或一个眼神把身份差露出来、当众被低估或羞辱、日常裂口、证据翻盘。
禁止把用户原句复制进每一镜。script_card 必须有场次和对白。
"""

EDIT_SYSTEM = """你是中文短剧导演的修订助理。画布上已经有一集制作包。
用户用自然语言点名要改的规则、角色或镜头。你只输出补丁，不重写整集。
只返回 JSON，不要 markdown 围栏，不要解释。

输出形状：
{
  "summary": "一句话说明改了什么",
  "bible": {"logline": "", "setting": "", "hook": "", "conflict": "", "rules": [], "script_card": ""},
  "characters": [{"id": "hero", "name": "", "identity": "", "sheet_prompt": ""}],
  "shots": [{"id": "shot-3", "title": "", "dialogue": "", "action": "", "storyboard": "", "image_prompt": "", "motion_prompt": ""}],
  "add_shots": [],
  "remove_shot_ids": []
}

规则：
- 只填真正要改的字段。没点名的镜头、角色、规则不要出现在补丁里。
- 「第N镜」对应 shots 里的 shot-N，或 current_plan.shots[N-1]。
- 改对白时同步改该镜 storyboard / image_prompt 里对应的那一句，并在 script_card 里改同一句。
- 「加一条校规/规则」只改 bible.rules，必要时改故事卡相关字段，不要新增或改镜头。
- 不要换故事，不要换人名，不要重排未点名镜头。
- 不要输出完整制作包。不要清空未点名字段。
"""

PATCH_REPAIR_SYSTEM = """你是短剧导演补丁修订助理。上一次补丁改动了用户没点名的镜头或规则。
只返回补丁 JSON，形状与编辑补丁相同。不要重写整集，不要 markdown 围栏。
没点名的镜头必须从补丁里拿掉。
"""

class CanvasFlowDirectRequest(BaseModel):
    topic: str = Field(default="", max_length=MAX_TOPIC_CHARS)
    objective: DirectorObjective = "full_episode"
    source_kind: DirectorSourceKind = "premise"
    mode: DirectorMode = "shot_pipeline"
    input_mode: DirectorInputMode = "plan"
    genre: DirectorGenre = "custom"
    look: DirectorLook = "manhua"
    stage: DirectorStage | None = None
    shot_count: int = Field(DEFAULT_SHOTS, ge=1, le=MAX_SHOTS)
    include_video: bool = True
    aspect_ratio: str = ""
    # Accepted only for old clients. The platform now owns this choice so
    # planning can never use a user key or a billable model.
    model_id: str = Field(default="", max_length=160)
    client_request_id: str = Field(default="", max_length=160)
    canvas_summary: str = Field(default="", max_length=2000)
    intent: DirectorIntent = "plan"
    director_plan: dict[str, Any] | None = None
    graph_index: list[dict[str, Any]] = Field(default_factory=list)
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    attachment_context: str = Field(default="", max_length=60000)


class CanvasFlowDirectResponse(BaseModel):
    plan: dict[str, Any]
    patch: dict[str, Any] | None = None
    intent: DirectorIntent = "plan"
    fallback: bool = False
    message: str = ""


class DirectorAgentState(TypedDict, total=False):
    request: CanvasFlowDirectRequest
    user_id: str
    director_model: dict[str, Any]
    source_text: str
    attachment_context: str
    input_mode: DirectorInputMode
    intent: DirectorIntent
    source_facts: dict[str, Any]
    source_scenes: list[dict[str, Any]]
    previous_plan: dict[str, Any]
    plan: dict[str, Any]
    patch: dict[str, Any]
    fidelity_issues: list[str]
    repair_attempt: int
    fallback: bool
    message: str


async def resolve_director_model(_legacy_model_id: str = "") -> dict[str, Any] | None:
    """Use only the enabled free platform LLM for canvas planning."""
    return await model_repo.get_free_platform_llm_model()


def _clean(value: Any, fallback: str = "") -> str:
    text = str(value or "").replace("\r", " ").strip()
    return re.sub(r"\s+", " ", text) if text else fallback


def _clean_multiline(value: Any, fallback: str = "", limit: int = MAX_TOPIC_CHARS) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    if not text:
        return fallback
    return text[:limit]


def _sanitize(value: str) -> str:
    cleaned = _AGE_WORD.sub("角色", value)
    cleaned = _REAL_FACE.sub("超逼真数字角色", cleaned)
    cleaned = _ANTISLOP.sub("", cleaned)
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def _sanitize_multiline(value: str) -> str:
    cleaned = _AGE_WORD.sub("角色", value)
    cleaned = _REAL_FACE.sub("超逼真数字角色", cleaned)
    cleaned = _ANTISLOP.sub("", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _slug(value: str, fallback: str) -> str:
    slug = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", value.lower()).strip("-")[:24]
    return slug or fallback


def _json_object(raw: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", raw or ""):
        try:
            parsed, _ = decoder.raw_decode(raw[match.start():])
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("director did not return JSON")


def _resolve_genre(value: Any, topic: str = "") -> DirectorGenre:
    del topic
    raw = _clean(value).replace("-", "_")
    if raw in VALID_GENRES:
        return raw  # type: ignore[return-value]
    return "custom"


def _resolve_look(value: Any) -> DirectorLook:
    raw = _clean(value).replace("-", "_")
    if raw == "liveaction":
        return "live_action"
    if raw in VALID_LOOKS:
        return raw  # type: ignore[return-value]
    return "manhua"


def _resolve_stage(value: Any) -> DirectorStage:
    raw = _clean(value)
    aliases = {
        "video": "episode",
        "full": "episode",
        "character": "cast",
        "sheet": "cast",
        "sheets": "cast",
        "still": "stills",
        "frames": "stills",
        "storyboard": "board",
    }
    raw = aliases.get(raw, raw)
    if raw in VALID_STAGES:
        return raw  # type: ignore[return-value]
    return "episode"


def _resolve_input_mode(value: Any) -> DirectorInputMode:
    raw = _clean(value).replace("-", "_")
    if raw in {"inherit", "script", "board", "continue"}:
        return "inherit"
    return "plan"


def _resolve_objective(value: Any) -> DirectorObjective:
    raw = _clean(value).replace("-", "_")
    if raw in VALID_OBJECTIVES:
        return raw  # type: ignore[return-value]
    return "full_episode"


def _stage_for_objective(objective: DirectorObjective, *, include_video: bool) -> DirectorStage:
    if objective == "script_breakdown":
        return "board"
    if objective == "character_consistency":
        return "cast"
    if objective == "shot_production":
        return "stills"
    return "episode" if include_video else "stills"


def _resolve_source_kind(value: Any, *, input_mode: DirectorInputMode = "plan", intent: DirectorIntent = "plan") -> DirectorSourceKind:
    if intent == "edit":
        return "canvas"
    raw = _clean(value)
    if raw in VALID_SOURCE_KINDS:
        return raw  # type: ignore[return-value]
    return "script" if input_mode == "inherit" else "premise"


def production_profile(
    objective: DirectorObjective,
    source_kind: DirectorSourceKind,
    *,
    include_video: bool,
) -> dict[str, Any]:
    if objective == "script_breakdown":
        return {
            "source_kind": source_kind,
            "deliverables": (
                ["原文事实", "场次拆解", "分镜表", "连续性检查"]
                if source_kind == "script"
                else ["故事设定", "可拍剧本", "分镜表", "连续性检查"]
            ),
            "checkpoints": ["事实核对", "故事锁定", "分镜锁定"],
        }
    if objective == "character_consistency":
        return {
            "source_kind": source_kind,
            "deliverables": ["角色档案", "造型规则", "三视图", "正面锚点"],
            "checkpoints": ["角色锁定", "造型一致性"],
        }
    if objective == "shot_production":
        return {
            "source_kind": source_kind,
            "deliverables": ["分镜表", "角色引用", "逐镜提示词", "逐镜静帧", "结果预览"],
            "checkpoints": ["角色锁定", "分镜锁定", "出图复核"],
        }
    return {
        "source_kind": source_kind,
        "deliverables": [
            "原文事实" if source_kind == "script" else "故事设定",
            "可拍剧本",
            "角色资产",
            "分镜表",
            "逐镜静帧",
            *(["逐镜视频"] if include_video else []),
            "交付检查",
        ],
        "checkpoints": [
            "故事锁定",
            "角色锁定",
            "分镜锁定",
            "出图复核",
            *(["成片复核"] if include_video else []),
        ],
    }


def _instruction_looks_like_rebuild(instruction: str) -> bool:
    return bool(re.search(
        r"全部重来|重新规划|整集重写|换个故事|按这份剧本重铺|推倒重来|重铺|换成.{0,20}(故事|董事会|题材|剧本)",
        _clean(instruction),
    ))


def _has_existing_canvas(request: CanvasFlowDirectRequest) -> bool:
    if isinstance(request.director_plan, dict) and request.director_plan:
        return True
    if request.graph_index:
        return True
    return bool(re.search(r"nodes=([1-9]\d*)", request.canvas_summary or ""))


def route_director_intent(
    *,
    has_canvas: bool,
    topic: str,
    requested: Any = "",
) -> DirectorIntent:
    requested_raw = _clean(requested).replace("-", "_")
    if requested_raw in VALID_INTENTS and requested_raw != "plan":
        if requested_raw == "edit" and not has_canvas:
            return "plan"
        if requested_raw == "rebuild" and not has_canvas:
            return "plan"
        return requested_raw  # type: ignore[return-value]
    if not has_canvas:
        return "plan"
    if _instruction_looks_like_rebuild(topic):
        return "rebuild"
    return "edit"


def _excerpt(topic: str, limit: int = 80) -> str:
    text = _clean_multiline(topic, "未命名短剧")
    return f"{text[:limit].rstrip()}…" if len(text) > limit else text


def _fallback_kind(source: str, genre: DirectorGenre) -> str:
    if re.search(r"规则怪谈|校园怪谈|校规|禁止回头|值日生", source) or genre == "rule_horror":
        return "campus_rule"
    if re.search(r"末世|废墟|觉醒|丧尸|求生", source) or genre == "apocalypse":
        return "apocalypse"
    if re.search(r"董事会|录音|职场|项目经理", source) or genre == "office":
        return "office"
    if re.search(r"仙侠|宗门|灵根|修仙|炼器", source) or genre == "xianxia":
        return "xianxia"
    if re.search(r"古装|冷宫|密诏|朝堂|后宅", source) or genre == "costume":
        return "costume"
    if re.search(r"科幻|舰长|工牌|格式化|安检", source) or genre == "scifi":
        return "scifi"
    if re.search(r"年会|装穷|前未婚夫|当众翻盘|都市", source) or genre == "urban":
        return "urban"
    if re.search(r"公开课|转校生|操场|年级第一", source) or genre == "campus":
        return "campus"
    return "generic"


def _fallback_name(source: str) -> str:
    blocked = re.compile(r"规划|校园|漫剧|短剧|分镜|剧本|帮我|一个|规则|怪谈|题材|第一集|公开课|转校生|董事会|录音|末世|废墟")
    for token in re.findall(r"[\u4e00-\u9fff]{2,3}", source or ""):
        if not blocked.search(token) and not re.search(r"的|了|在|是|和|与", token):
            return token
    return "主角"


def _fallback_episode(source: str, genre: DirectorGenre) -> dict[str, Any]:
    kind = _fallback_kind(source, genre)
    if kind == "campus_rule":
        return {
            "title": "夜自习守则 · 第一集",
            "logline": "转校生林晚第一天夜自习，发现校规第三条会当场改写走廊。",
            "setting": "旧教学楼三层，夜自习后的日光灯走廊和阶梯教室。",
            "hook": "走廊尽头的灯一盏盏灭到她脚边，墙上校规自己多出一行红字。",
            "conflict": "她回头看了一眼三楼，违反了「晚自习后禁止回头看三楼」。",
            "rules": [
                "晚自习结束后必须在两分钟内离开教学楼。",
                "走廊只许往前走，禁止回头看三楼。",
                "如果有人在身后叫你的学号，不要答应。",
                "值日生袖章是红的才是人；袖章发黑时跟着他走的人会从名单上消失。",
            ],
            "script_card": (
                "场1 日 外 校门：林晚第一次走进旧教学楼，广播重复「请遵守夜自习守则」。\n"
                "林晚：「这学校连校规都印红字？」\n"
                "场2 夜 内 三楼走廊：她看见告示「禁止回头看三楼」，身后有人喊「林晚」。\n"
                "值日生：「第三条规定过了。你回头了。」\n"
                "场3 夜 内 教室后门：灯一盏盏灭到她脚边，墙上多出新校规：回头的人留下值日。\n"
                "钩子：名单最后一行出现她的学号，还没写名字。"
            ),
            "characters": [
                {"id": "hero", "name": "林晚", "identity": "刚转入的高中生", "sheet_prompt": "十七八岁观感的转校生，黑色齐肩直发，深灰校服外套，白衬衫，深蓝领带，帆布鞋，神情克制，肩上斜挎旧书包。"},
                {"id": "monitor", "name": "值日生", "identity": "执行校规的人", "sheet_prompt": "同龄值日生，寸头，校服扣到最上一颗，左臂红袖章，手持铁皮点名册，表情没有温度。"},
            ],
            "shots": [
                {"title": "校门广播", "location": "旧教学楼门口", "shot_size": "全景", "camera": "缓推", "action": "林晚停在校门，广播重复夜自习守则。", "dialogue": "广播：请遵守夜自习守则。", "storyboard": "日，校门外。林晚抬头看旧教学楼，广播正在念校规。", "image_prompt": "阴天旧教学楼门口，林晚背着书包停在铁门前，喇叭挂在门柱上。", "motion_prompt": "从校门外缓推进到林晚停下的脚步。", "duration": 5, "character_ids": ["hero"]},
                {"title": "校规告示", "location": "三楼走廊", "shot_size": "特写接中景", "camera": "切", "action": "她看见墙上红字：晚自习后禁止回头看三楼。", "dialogue": "林晚：禁止回头？", "storyboard": "夜，走廊。先特写告示红字，再切到林晚侧脸。", "image_prompt": "日光灯走廊，墙上海报特写红字校规，林晚侧脸停住。", "motion_prompt": "告示特写硬切到林晚侧脸。", "duration": 4, "character_ids": ["hero"]},
                {"title": "身后喊名", "location": "三楼走廊", "shot_size": "过肩", "camera": "固定后微推", "action": "身后有人喊她的学号，她的肩膀动了一下，还是没有回头。", "dialogue": "值日生：林晚。", "storyboard": "夜，走廊。镜头停在她后背，声音从画面外传来。", "image_prompt": "林晚背对镜头站在走廊中央，身后灯更暗，点名册的影子投在地上。", "motion_prompt": "固定看她后背，轻微前推。", "duration": 5, "character_ids": ["hero", "monitor"]},
                {"title": "回头的代价", "location": "三楼走廊转角", "shot_size": "中景", "camera": "硬切", "action": "她还是回头了。值日生站在灯下，袖章正在变黑。", "dialogue": "值日生：第三条规定过了。你回头了。", "storyboard": "她回头，值日生挡住去路，袖章从红转黑。", "image_prompt": "走廊转角中景，林晚回头，值日生挡住过道，红袖章正在发黑。", "motion_prompt": "正反打，距离越来越近。", "duration": 5, "character_ids": ["hero", "monitor"]},
                {"title": "灯灭到脚边", "location": "阶梯教室后门", "shot_size": "全景转特写", "camera": "跟拍再切特写", "action": "灯一盏盏灭到她脚边，墙上多出新校规。", "dialogue": "新校规：回头的人留下值日。", "storyboard": "她退进教室后门，灯灭到脚边，红字自己长出来。", "image_prompt": "空教室后门，灯一盏盏灭，墙上海报多出一行新红字。", "motion_prompt": "跟她后退，再切到新校规特写。", "duration": 6, "character_ids": ["hero"]},
                {"title": "名单钩子", "location": "教室讲台", "shot_size": "特写", "camera": "缓推", "action": "点名册最后一行出现她的学号，名字栏还是空的。", "dialogue": "", "storyboard": "铁皮点名册特写，最后一行只有学号。", "image_prompt": "讲台上打开的铁皮点名册，最后一行红笔学号，名字栏空白。", "motion_prompt": "缓推进到学号那一行停住。", "duration": 4, "character_ids": []},
            ],
        }
    if kind == "office":
        name = "沈渡" if "沈渡" in source else "主角"
        return {
            "title": f"{name}的录音 · 第一集",
            "logline": f"{name}把录音放进董事会，甩锅的人第一次当众说不出话。",
            "setting": "白天，高层玻璃会议室。",
            "hook": "录音刚响第一句，对面的手就按住了话筒。",
            "conflict": "项目被栽赃，唯一证据是一段被删过的录音。",
            "rules": ["证据必须当众放完，中途停掉就作废。"],
            "script_card": (
                f"场1 日 内 会议室门外：{name}整理衣领，手机里是那段录音。\n"
                f"{name}：「这次不解释。只放证据。」\n"
                "场2 日 内 董事会：录音放到栽赃原话，对面伸手去抢手机。\n"
                "钩子：录音还没放完，门又被推开。"
            ),
            "characters": [
                {"id": "hero", "name": name, "identity": "被甩锅的项目负责人", "sheet_prompt": "成年职场人，深色西装，白衬衫，没有领带，黑眼圈，手里捏着旧手机。"},
                {"id": "boss", "name": "对面", "identity": "甩锅的上级", "sheet_prompt": "中年管理者，浅灰西装，袖扣发亮，笑容先于眼睛到达。"},
            ],
            "shots": [
                {"title": "门外整理", "location": "会议室门外", "shot_size": "中景", "camera": "缓推", "action": f"{name}停在门外，拇指按在播放键上。", "dialogue": f"{name}：这次不解释。只放证据。", "storyboard": "日，门外。深呼吸，推门。", "image_prompt": "玻璃门外中景，职场人按住手机，会议室灯光从门缝漏出。", "motion_prompt": "缓推进到按播放键的手指。", "duration": 4, "character_ids": ["hero"]},
                {"title": "录音第一句", "location": "董事会长桌", "shot_size": "近景", "camera": "固定", "action": "手机立在桌上，录音响起栽赃原话。", "dialogue": "录音：这锅必须让项目组背。", "storyboard": "日，长桌。全场听第一句。", "image_prompt": "长桌近景，旧手机立着，对面的手停在半空。", "motion_prompt": "固定听完第一句。", "duration": 5, "character_ids": ["hero", "boss"]},
                {"title": "抢手机", "location": "董事会长桌", "shot_size": "中景", "camera": "硬切", "action": "对面伸手去抢，被按住手腕。", "dialogue": "对面：先停一下。", "storyboard": "抢手机失败，录音还在放。", "image_prompt": "两只手在桌面上僵持，手机还在震动。", "motion_prompt": "硬切到僵持的手。", "duration": 4, "character_ids": ["hero", "boss"]},
                {"title": "门又开了", "location": "会议室门口", "shot_size": "全景", "camera": "缓拉", "action": "录音没放完，门再次被推开。", "dialogue": "", "storyboard": "全场回头，门口站着新的人影。", "image_prompt": "玻璃会议室全景，门开着，逆光人影，桌上手机还亮着。", "motion_prompt": "缓拉到门口停住。", "duration": 5, "character_ids": ["hero"]},
                {"title": "证据还在响", "location": "董事会长桌", "shot_size": "特写", "camera": "缓推", "action": "手机屏幕还在跳动波形，没人敢伸第二只手。", "dialogue": "", "storyboard": "特写还在响的手机，全场手都停着。", "image_prompt": "旧手机屏幕波形特写，一圈停在半空的手。", "motion_prompt": "缓推进波形。", "duration": 4, "character_ids": []},
                {"title": "门外的人", "location": "会议室门口", "shot_size": "过肩", "camera": "固定", "action": "门口的人影没有进来，只把文件夹换到另一只手。", "dialogue": "", "storyboard": "钩子：真正要听这段录音的人还站在门外。", "image_prompt": "逆光门口，人影抱着文件夹，会议室里所有人都看着门。", "motion_prompt": "固定停在门口。", "duration": 4, "character_ids": ["hero"]},
            ],
        }
    if kind == "apocalypse":
        return {
            "title": "废墟招人 · 第一集",
            "logline": "陆明在集市挡住一脚，第一次当众把系统能力用出来。",
            "setting": "末日后的城市废墟和地下集市。",
            "hook": "他挡住那一脚时，手腕上的旧表针突然倒转。",
            "conflict": "救人会暴露能力，暴露就会被招进不该进的队伍。",
            "rules": ["白天不在高处停留。", "集市里动手，会被「招人的人」盯上。"],
            "script_card": (
                "场1 日 外 废墟：陆明穿过倒塌高楼，旧表一直停着。\n"
                "场2 日 内 地下集市：有人踢向宁曦，他伸手去挡。\n"
                "陆明：「别碰她。」\n"
                "钩子：表针倒转的同时，远处有人开始记他的脸。"
            ),
            "characters": [
                {"id": "hero", "name": "陆明", "identity": "在废墟里活下来的人", "sheet_prompt": "成年男性，黑色微长碎发，深棕风衣，脏靴，左手旧表，神情压着怒。"},
                {"id": "heroine", "name": "宁曦", "identity": "被集市欺压的人", "sheet_prompt": "成年女性，黑色长发披肩，旧绿外套，手腕有擦伤，表情先怕后盯人。"},
            ],
            "shots": [
                {"title": "废墟远景", "location": "倒塌街区", "shot_size": "远景", "camera": "缓推", "action": "陆明独自走过黑烟和高楼残骸。", "dialogue": "", "storyboard": "日，废墟。一个人很小。", "image_prompt": "倒塌高楼与黑烟，一个穿风衣的人走在尘土路上。", "motion_prompt": "高处缓推进入废墟。", "duration": 5, "character_ids": ["hero"]},
                {"title": "集市拦人", "location": "地下集市角落", "shot_size": "中景", "camera": "硬切", "action": "有人踢向宁曦，陆明伸臂挡住。", "dialogue": "陆明：别碰她。", "storyboard": "日，集市。拦截动作清楚。", "image_prompt": "狭窄集市中景，陆明挡住踢出的腿，宁曦摔倒在地摊边。", "motion_prompt": "硬切到拦截瞬间。", "duration": 5, "character_ids": ["hero", "heroine"]},
                {"title": "表针倒转", "location": "陆明手腕", "shot_size": "特写", "camera": "缓推", "action": "旧表针突然倒转一格。", "dialogue": "", "storyboard": "表针特写，集市嘈杂被压低。", "image_prompt": "脏旧手表特写，指针反向跳动，背景虚化的集市灯。", "motion_prompt": "缓推进指针。", "duration": 4, "character_ids": ["hero"]},
                {"title": "有人在看", "location": "集市出口", "shot_size": "过肩", "camera": "固定", "action": "远处有人合上本子，记下他的脸。", "dialogue": "", "storyboard": "招人的人站在出口看他。", "image_prompt": "集市出口逆光，一个拿本子的人合上封面，陆明还跪在地上。", "motion_prompt": "固定停在合本子的动作。", "duration": 5, "character_ids": ["hero"]},
                {"title": "表还在转", "location": "陆明手腕", "shot_size": "近景", "camera": "切", "action": "宁曦抓住他的手腕，表针又倒了一格。", "dialogue": "宁曦：你的表在倒着走。", "storyboard": "近景，两只手和倒转的表。", "image_prompt": "宁曦抓住陆明手腕，旧表指针反向跳，两人低头看。", "motion_prompt": "切到两只手和表。", "duration": 4, "character_ids": ["hero", "heroine"]},
                {"title": "被跟上", "location": "集市外坡道", "shot_size": "全景", "camera": "缓拉", "action": "他们离开集市，合本子的人跟在同一个出口。", "dialogue": "", "storyboard": "救人结束，跟踪开始。", "image_prompt": "废墟坡道全景，两个人往前走，出口处那人合上本子跟上。", "motion_prompt": "缓拉出坡道。", "duration": 5, "character_ids": ["hero", "heroine"]},
            ],
        }
    if kind == "campus":
        return {
            "title": "公开课第一题 · 第一集",
            "logline": "转校生林晚被粉笔砸中桌子，必须站着把那道题算完。",
            "setting": "白天，阶梯教室公开课。",
            "hook": "粉笔砸在她摊开的本子上，全班转头。",
            "conflict": "她不认识这所学校的题型，但坐下就算弃权。",
            "rules": [
                "粉笔砸中谁的桌子，谁必须站着答完。",
                "公开课中途坐下，记一次弃权。",
                "年级第一有一次当场纠错的权利。",
            ],
            "script_card": (
                "场1 日 内 阶梯教室：粉笔砸在林晚本子上，粉屑迸开。\n"
                "老师：「转校生，站着把这道题算完。」\n"
                "场2 日 内 黑板前：她写到第三步，年级第一周衡举手。\n"
                "周衡：「她用的不是我们的公式。」\n"
                "林晚：「那你上来写。」\n"
                "钩子：老师把她的名字写进下一次竞赛名单，没有问过她。"
            ),
            "characters": [
                {"id": "hero", "name": "林晚", "identity": "刚转入的学生", "sheet_prompt": "黑色齐肩直发，深灰校服，白衬衫，深蓝领带，神情克制，手指有粉笔灰。"},
                {"id": "rival", "name": "周衡", "identity": "年级第一", "sheet_prompt": "短发整齐，校服熨平，袖口翻起一截，下巴微抬，手里转着自动笔。"},
            ],
            "shots": [
                {"title": "粉笔砸桌", "location": "阶梯教室后排", "shot_size": "特写接中景", "camera": "硬切", "action": "粉笔砸在摊开的本子上，粉屑迸到林晚手上。", "dialogue": "老师：转校生，站着把这道题算完。", "storyboard": "先特写粉笔砸本，再切全班回头。", "image_prompt": "课桌特写，粉笔砸进本子，粉屑飞起，林晚的手停住。", "motion_prompt": "硬切到全班转头。", "duration": 4, "character_ids": ["hero"]},
                {"title": "她站起来", "location": "阶梯教室过道", "shot_size": "全景", "camera": "缓推", "action": "林晚抱着本子走上过道，周衡转笔看着她。", "dialogue": "", "storyboard": "日，教室。她从后排走到黑板。", "image_prompt": "阶梯教室全景，一个女生走上过道，前排男生转着笔看她。", "motion_prompt": "从后排缓推跟上她。", "duration": 5, "character_ids": ["hero", "rival"]},
                {"title": "板书第三步", "location": "黑板前", "shot_size": "中景", "camera": "固定", "action": "她在黑板上写到第三步，公式和墙上例题不一样。", "dialogue": "周衡：她用的不是我们的公式。", "storyboard": "板书清楚，周衡举手。", "image_prompt": "黑板中景，林晚写到一半，周衡举手，老师侧身。", "motion_prompt": "固定看板书和举手。", "duration": 5, "character_ids": ["hero", "rival"]},
                {"title": "把笔递回去", "location": "黑板前", "shot_size": "近景", "camera": "正反打", "action": "林晚把粉笔转过去，对着周衡。", "dialogue": "林晚：那你上来写。", "storyboard": "近景对峙，粉笔停在两人中间。", "image_prompt": "近景，粉笔横在两人之间，林晚看着周衡。", "motion_prompt": "正反打。", "duration": 4, "character_ids": ["hero", "rival"]},
                {"title": "她写完", "location": "黑板", "shot_size": "特写", "camera": "缓推", "action": "最后一行数字落下，教室里有人把笔放下。", "dialogue": "", "storyboard": "板书收尾，不是口号，是算完。", "image_prompt": "黑板特写，最后一行数字，粉笔停住。", "motion_prompt": "缓推进最后一行。", "duration": 4, "character_ids": ["hero"]},
                {"title": "竞赛名单", "location": "讲台", "shot_size": "特写", "camera": "缓推", "action": "老师把她的名字写进竞赛名单，没有问她。", "dialogue": "", "storyboard": "钩子：她赢了这一题，被写进下一场。", "image_prompt": "讲台名单特写，新写上林晚两个字，墨水还没干。", "motion_prompt": "缓推进名字。", "duration": 4, "character_ids": []},
            ],
        }
    if kind == "urban":
        return {
            "title": "年会旧名字 · 第一集",
            "logline": "装穷 intern 苏晚在年会上接过话筒，大屏打出她已经改掉的旧名字。",
            "setting": "晚上，酒店宴会厅年会。",
            "hook": "麦递到她手里的同一秒，大屏翻到旧名字。",
            "conflict": "她必须当着前未婚夫把这段主持完，中途放下麦就等于认。",
            "rules": [
                "年会大屏名单一旦打出，现场不能撤回。",
                "话筒递到谁手里，谁必须把这段说完。",
                "中途把麦放下，就算默认大屏上的身份。",
            ],
            "script_card": (
                "场1 夜 内 宴会厅侧门：苏晚整理工牌，不想走主入口。\n"
                "场2 夜 内 主桌前：主持把麦递过来，大屏翻页。\n"
                "苏晚：「今晚只报业绩。名字以后再改。」\n"
                "前未婚夫：「先停一下。」\n"
                "钩子：大屏下一页是一份没签完的合同，甲方栏是她的旧名字。"
            ),
            "characters": [
                {"id": "hero", "name": "苏晚", "identity": "装穷 intern", "sheet_prompt": "黑色长直发，合身黑西装，工牌别得偏低，耳钉很小，神情压着。"},
                {"id": "ex", "name": "前未婚夫", "identity": "台上的嘉宾", "sheet_prompt": "深色礼服，袖扣发亮，笑容先到，手指总想去按遥控。"},
            ],
            "shots": [
                {"title": "侧门进场", "location": "宴会厅侧门", "shot_size": "中景", "camera": "缓推", "action": "苏晚从侧门进来，把工牌翻到背面。", "dialogue": "", "storyboard": "夜，侧门。她不想被第一眼认出来。", "image_prompt": "酒店侧门中景，黑西装女生把工牌翻过去，宴会灯光从门缝漏出。", "motion_prompt": "缓推进侧门。", "duration": 4, "character_ids": ["hero"]},
                {"title": "麦递过来", "location": "主桌前", "shot_size": "中景", "camera": "跟拍", "action": "主持把麦塞进她手里，全场灯光打到她脸上。", "dialogue": "", "storyboard": "她还没准备好，麦已经在手里。", "image_prompt": "宴会厅中景，话筒递到苏晚手里，追光打在她脸上。", "motion_prompt": "跟麦递出的手。", "duration": 4, "character_ids": ["hero"]},
                {"title": "旧名字上屏", "location": "宴会厅大屏", "shot_size": "特写接全景", "camera": "切", "action": "大屏翻出旧名字，全场有人开始交头接耳。", "dialogue": "苏晚：今晚只报业绩。名字以后再改。", "storyboard": "先看大屏，再看她接麦。", "image_prompt": "大屏特写旧名字，再切苏晚举着话筒。", "motion_prompt": "大屏切到她。", "duration": 5, "character_ids": ["hero"]},
                {"title": "他要停掉", "location": "主桌", "shot_size": "近景", "camera": "硬切", "action": "前未婚夫伸手去按遥控，被她用麦挡住。", "dialogue": "前未婚夫：先停一下。", "storyboard": "抢遥控失败，大屏还亮着。", "image_prompt": "近景，一只手去按遥控，话筒横过来挡住。", "motion_prompt": "硬切到两只手。", "duration": 4, "character_ids": ["hero", "ex"]},
                {"title": "她把这段说完", "location": "主桌前", "shot_size": "中景", "camera": "缓推", "action": "她没有放下麦，把业绩数字报完。", "dialogue": "", "storyboard": "高光是报完，不是骂回去。", "image_prompt": "中景，苏晚举麦报数字，前未婚夫的手停在半空。", "motion_prompt": "缓推到她的脸。", "duration": 5, "character_ids": ["hero", "ex"]},
                {"title": "下一页合同", "location": "大屏", "shot_size": "特写", "camera": "缓推", "action": "大屏自动翻到下一页，甲方栏还是那个旧名字。", "dialogue": "", "storyboard": "钩子：名字战没完，合同还在后面。", "image_prompt": "大屏合同特写，甲方栏旧名字，红章位置空着。", "motion_prompt": "缓推进甲方栏。", "duration": 4, "character_ids": []},
            ],
        }
    if kind == "xianxia":
        return {
            "title": "废炉认主 · 第一集",
            "logline": "外门弟子陈岁当众点燃嫡脉废炉，炉里飞出一枚认主的识海钉。",
            "setting": "白日，外门演武场和废炉台。",
            "hook": "别人都在等炉炸，炉火却顺着她的袖口往回走。",
            "conflict": "废炉一旦点燃就不能灭，飞出来的东西会认第一个碰它的人。",
            "rules": [
                "废炉当众点燃后不可用水浇灭。",
                "炉里飞出的器物认第一个碰到它的人。",
                "外门弟子碰嫡脉炉火，要当场报出身。",
            ],
            "script_card": (
                "场1 日 外 演武场：陈岁被点名去点那座半年没亮的废炉。\n"
                "嫡女：「废灵根也敢碰嫡脉的炉。」\n"
                "场2 日 外 废炉台：她伸手进去，炉火顺着袖口回来。\n"
                "陈岁：「它认的不是灵根。」\n"
                "钩子：识海钉钉进她眉心，楼上宗主的茶盏裂了。"
            ),
            "characters": [
                {"id": "hero", "name": "陈岁", "identity": "外门弟子", "sheet_prompt": "束起的黑发，洗旧的灰外门袍，袖口有烧痕，手腕一圈麻绳，神情很稳。"},
                {"id": "heir", "name": "嫡女", "identity": "嫡脉候选人", "sheet_prompt": "金纹白袍，发冠整齐，指上玉扳指，笑意不达眼底。"},
            ],
            "shots": [
                {"title": "点名点炉", "location": "外门演武场", "shot_size": "全景", "camera": "缓推", "action": "执事点到陈岁，让她去点那座废炉。", "dialogue": "执事：外门，陈岁。去点炉。", "storyboard": "日，演武场。她从队列最后走出来。", "image_prompt": "演武场全景，灰袍弟子从队列末尾走出，远处一座冷炉。", "motion_prompt": "缓推进入队列。", "duration": 5, "character_ids": ["hero"]},
                {"title": "嫡女拦话", "location": "废炉台下", "shot_size": "中景", "camera": "正反打", "action": "嫡女挡住台阶，用扇骨点她的袖口。", "dialogue": "嫡女：废灵根也敢碰嫡脉的炉。", "storyboard": "中景对峙，扇骨点在烧痕上。", "image_prompt": "台阶中景，白袍嫡女用扇骨点灰袍袖口的烧痕。", "motion_prompt": "正反打。", "duration": 4, "character_ids": ["hero", "heir"]},
                {"title": "伸手点火", "location": "废炉台", "shot_size": "近景", "camera": "缓推", "action": "陈岁把手伸进炉口，炉灰先塌再亮。", "dialogue": "", "storyboard": "手进炉口，火不是炸，是回来。", "image_prompt": "近景，一只手伸进冷炉，炉心重新亮起。", "motion_prompt": "缓推进炉口。", "duration": 5, "character_ids": ["hero"]},
                {"title": "炉火回袖", "location": "废炉台", "shot_size": "中景", "camera": "跟拍", "action": "炉火顺着袖口往回走，没有烧穿衣服。", "dialogue": "陈岁：它认的不是灵根。", "storyboard": "火沿袖口走，嫡女的扇子停住。", "image_prompt": "中景，火光沿灰袍袖口回流，嫡女后退半步。", "motion_prompt": "跟火走袖口。", "duration": 5, "character_ids": ["hero", "heir"]},
                {"title": "识海钉飞出", "location": "炉心", "shot_size": "特写", "camera": "硬切", "action": "一枚细钉从炉心飞出，钉进她眉心。", "dialogue": "", "storyboard": "器物认主，可见、可拍。", "image_prompt": "特写，细长识海钉飞向眉心，炉火在后面。", "motion_prompt": "硬切钉飞出。", "duration": 4, "character_ids": ["hero"]},
                {"title": "楼上茶盏", "location": "演武场高台", "shot_size": "特写接全景", "camera": "切", "action": "高台上茶盏裂开，有人把茶倒掉。", "dialogue": "", "storyboard": "钩子：真正管这件事的人在楼上。", "image_prompt": "茶盏裂纹特写，再切高台轮廓。", "motion_prompt": "茶盏切到高台。", "duration": 4, "character_ids": []},
            ],
        }
    if kind == "costume":
        return {
            "title": "家宴密诏 · 第一集",
            "logline": "冷宫妃子沈昭把先帝密诏拍进中秋家宴，第一个该跪下的人没有跪。",
            "setting": "夜，王府中秋家宴正殿。",
            "hook": "酒过三巡，她把一卷没拆封的诏书拍在主桌。",
            "conflict": "密诏当众展开才作数，家主想先抢走再灭口。",
            "rules": [
                "密诏必须当众展开才算数。",
                "宴席上谁先跪下，谁就认这卷诏。",
                "没展开之前，任何人夺诏都不算谋逆。",
            ],
            "script_card": (
                "场1 夜 内 侧殿：沈昭把密诏从袖里移到托盘下。\n"
                "场2 夜 内 正殿：她把诏书拍在家主酒杯旁。\n"
                "沈昭：「先帝的字，今晚当众念。」\n"
                "家主：「先收起来。」\n"
                "钩子：殿外甲士的脚步停住了，还没有进来。"
            ),
            "characters": [
                {"id": "hero", "name": "沈昭", "identity": "被打入冷宫的妃", "sheet_prompt": "素色褙子，头发挽得很低，颈间旧玉，手腕有冷宫的冻痕，神情很静。"},
                {"id": "lord", "name": "家主", "identity": "今晚的东道", "sheet_prompt": "暗红吉服，扳指很厚，笑着劝酒，眼睛先看诏再看人。"},
            ],
            "shots": [
                {"title": "侧殿藏诏", "location": "王府侧殿", "shot_size": "近景", "camera": "缓推", "action": "沈昭把密诏从袖里抽出来，压进托盘底下。", "dialogue": "", "storyboard": "夜，侧殿。动作清楚：诏还不能被看见。", "image_prompt": "烛光近景，素衣女子把一卷封泥诏书压进托盘下。", "motion_prompt": "缓推进袖口。", "duration": 4, "character_ids": ["hero"]},
                {"title": "拍诏上桌", "location": "正殿主桌", "shot_size": "中景", "camera": "硬切", "action": "她把诏书拍在家主酒杯旁边，酒面晃了一下。", "dialogue": "沈昭：先帝的字，今晚当众念。", "storyboard": "诏书落地比骂人更清楚。", "image_prompt": "中秋宴中景，一卷诏书拍在酒杯旁，全桌筷子停住。", "motion_prompt": "硬切到主桌。", "duration": 5, "character_ids": ["hero", "lord"]},
                {"title": "夺诏", "location": "正殿主桌", "shot_size": "近景", "camera": "切", "action": "家主伸手去夺，沈昭按住封泥。", "dialogue": "家主：先收起来。", "storyboard": "没展开之前，夺诏还不算谋逆。", "image_prompt": "近景，两只手按在同一卷封泥上。", "motion_prompt": "切到僵持的手。", "duration": 4, "character_ids": ["hero", "lord"]},
                {"title": "展开第一行", "location": "正殿主桌", "shot_size": "特写", "camera": "缓推", "action": "她撕开封泥，展开第一行，有人已经跪下去。", "dialogue": "", "storyboard": "当众展开，规则生效。", "image_prompt": "诏书特写第一行墨字，前景有人跪倒的袖口。", "motion_prompt": "缓推进第一行。", "duration": 5, "character_ids": ["hero"]},
                {"title": "家主没跪", "location": "正殿主位", "shot_size": "中景", "camera": "固定", "action": "半场跪下，家主还坐着，酒杯没有放下。", "dialogue": "", "storyboard": "谁先跪谁认，他不跪。", "image_prompt": "中景，一半人跪着，主位上的人仍坐着举杯。", "motion_prompt": "固定看主位。", "duration": 5, "character_ids": ["lord"]},
                {"title": "殿外甲士", "location": "正殿门外", "shot_size": "全景", "camera": "缓拉", "action": "殿外甲士的脚步停住，刀还没有出鞘。", "dialogue": "", "storyboard": "钩子：里面的诏和外面的兵，还没碰上。", "image_prompt": "夜，殿门外甲士停步，门缝漏出宴席烛光。", "motion_prompt": "缓拉到门外。", "duration": 4, "character_ids": []},
            ],
        }
    if kind == "scifi":
        return {
            "title": "工牌过闸 · 第一集",
            "logline": "快递员江辞过安检口时，工牌自己变成舰长编号。",
            "setting": "白天，轨道站安检口和分拣通道。",
            "hook": "闸机绿灯还没亮，工牌上的名字先换了。",
            "conflict": "系统规则是：工牌过闸只显示一次真实编制，改过就不能改第二次。",
            "rules": [
                "工牌过安检口会显示真实编制。",
                "同一枚工牌只能被系统改写一次。",
                "安检员按住你的牌，你必须当场对视镜头核验。",
            ],
            "script_card": (
                "场1 日 内 安检队列：江辞把一箱货放上传送带，工牌还是快递员。\n"
                "场2 日 内 闸机：绿灯未亮，编号先变成舰长。\n"
                "安检员：「看着镜头。不要眨眼。」\n"
                "江辞：「这牌是公司发的。」\n"
                "钩子：他摔掉的工牌自己从地上爬回他胸口。"
            ),
            "characters": [
                {"id": "hero", "name": "江辞", "identity": "记忆被格式化的快递员", "sheet_prompt": "短发，深灰连帽工装，胸口工牌，护目镜推到额上，小臂有接口疤。"},
                {"id": "guard", "name": "安检员", "identity": "闸机核验员", "sheet_prompt": "黑色站务制服，耳麦，手套，眼神先看牌再看人。"},
            ],
            "shots": [
                {"title": "排队过闸", "location": "轨道站安检队列", "shot_size": "全景", "camera": "缓推", "action": "江辞把货箱放上传送带，工牌还印着快递员。", "dialogue": "", "storyboard": "日，车站。先看起来只是送货。", "image_prompt": "未来车站安检队列全景，灰工装快递员把货箱放上传送带。", "motion_prompt": "缓推进队列。", "duration": 5, "character_ids": ["hero"]},
                {"title": "工牌改号", "location": "闸机读卡区", "shot_size": "特写", "camera": "缓推", "action": "工牌上的字自己刷新成舰长编号。", "dialogue": "", "storyboard": "规则兑现：过闸显示真实编制。", "image_prompt": "工牌特写，字从快递员刷成舰长编号，闸机灯还是红的。", "motion_prompt": "缓推进编号。", "duration": 4, "character_ids": ["hero"]},
                {"title": "按住核验", "location": "闸机前", "shot_size": "近景", "camera": "硬切", "action": "安检员按住他的牌，把镜头转过来。", "dialogue": "安检员：看着镜头。不要眨眼。", "storyboard": "近景对峙，牌被按住。", "image_prompt": "近景，戴手套的手按住工牌，镜头红灯对着江辞的眼睛。", "motion_prompt": "硬切到眼睛和镜头。", "duration": 5, "character_ids": ["hero", "guard"]},
                {"title": "他不认", "location": "闸机前", "shot_size": "中景", "camera": "正反打", "action": "江辞去摘工牌，安检员没有松手。", "dialogue": "江辞：这牌是公司发的。", "storyboard": "他想否认，牌已经改过一次。", "image_prompt": "中景，两人抢同一枚工牌，身后闸机仍是红灯。", "motion_prompt": "正反打。", "duration": 4, "character_ids": ["hero", "guard"]},
                {"title": "摔牌", "location": "闸机地面", "shot_size": "特写", "camera": "切", "action": "工牌摔在地上，编号还亮着。", "dialogue": "", "storyboard": "他以为摔掉就能不当舰长。", "image_prompt": "地面特写，发光工牌正面朝上，舰长编号还在跳。", "motion_prompt": "切到地上的牌。", "duration": 4, "character_ids": []},
                {"title": "牌自己回来", "location": "分拣通道口", "shot_size": "中景", "camera": "缓拉", "action": "工牌从地上滑回他胸口，吸回原位。", "dialogue": "", "storyboard": "钩子：系统不让他改第二次。", "image_prompt": "通道中景，工牌贴着地面滑回他胸口，安检员停在闸机后。", "motion_prompt": "缓拉看牌飞回。", "duration": 5, "character_ids": ["hero"]},
            ],
        }
    name = _fallback_name(source)
    return {
        "title": f"{_excerpt(source, 12)} · 第一集",
        "logline": f"{name}必须在一个看得见的规则里做第一次选择，代价当场出现。",
        "setting": "这一集只发生在两三个能反复拍的室内外空间。",
        "hook": "开场先给一个不该出现的物件或一声不该响起的叫名。",
        "conflict": f"{name}如果照做，会立刻留下把柄；如果不做，对面会当众逼他。",
        "rules": [
            "同一集只推进一个冲突。",
            "关键证据或禁令必须当众兑现，不能只在心里完成。",
            "谁先开口承认，谁先付出代价。",
        ],
        "script_card": (
            f"场1：{name}走进这个空间，环境先看起来正常。\n"
            f"{name}：「按你们的规矩走。」\n"
            "场2：异常出现，必须是看得见的动作或物件。\n"
            "对面：「你已经看见了。」\n"
            f"场3：{name}做一个会立刻有后果的选择。\n"
            "钩子：人走了，新的痕迹留在原地。"
        ),
        "characters": [
            {"id": "hero", "name": name, "identity": "推动这一集的人", "sheet_prompt": "成年角色，服装服务这个题材，五官清楚，有一件能反复入画的标志物。"},
            {"id": "other", "name": "对面", "identity": "把规则按到他头上的人", "sheet_prompt": "成年角色，和主角形成服装反差，手里拿着执行规则的物件。"},
        ],
        "shots": [
            {"title": "入场", "location": "主场景入口", "shot_size": "全景", "camera": "缓推", "action": f"{name}走进这个空间，先把标志物放在手里。", "dialogue": "", "storyboard": "建立镜头，人物入画。", "image_prompt": "入口全景，人物半侧面走进画面，手里有一件标志物。", "motion_prompt": "缓推进入空间。", "duration": 5, "character_ids": ["hero"]},
            {"title": "规矩上桌", "location": "主场景内部", "shot_size": "中景", "camera": "切", "action": "对面把一条写着禁令的纸或牌放上桌。", "dialogue": f"{name}：按你们的规矩走。", "storyboard": "规则必须看得见。", "image_prompt": "中景，桌上多出一张禁令或证件，两人隔桌。", "motion_prompt": "切到桌上的禁令。", "duration": 4, "character_ids": ["hero", "other"]},
            {"title": "异常", "location": "主场景内部", "shot_size": "特写接中景", "camera": "切", "action": "一个不该亮的灯或不该响的声音出现。", "dialogue": "对面：你已经看见了。", "storyboard": "先看异常，再看人物停住。", "image_prompt": "异常物件特写，再接到人物停住的脸。", "motion_prompt": "特写切中景。", "duration": 4, "character_ids": ["hero", "other"]},
            {"title": "选择", "location": "对峙位置", "shot_size": "中景", "camera": "正反打", "action": f"{name}伸手去碰那个物件，对面按住他的腕。", "dialogue": f"{name}：那就按这个来。", "storyboard": "动作清楚，因果关系看得见。", "image_prompt": "中景对峙，两只手抢同一件道具。", "motion_prompt": "正反打后拉开。", "duration": 5, "character_ids": ["hero", "other"]},
            {"title": "代价", "location": "对峙位置", "shot_size": "近景", "camera": "缓推", "action": "物件留下痕迹，名单、印记或裂纹出现。", "dialogue": "", "storyboard": "违反或遵守都要有可见后果。", "image_prompt": "近景，道具上出现新的字迹或裂纹。", "motion_prompt": "缓推进痕迹。", "duration": 4, "character_ids": ["hero"]},
            {"title": "余波", "location": "离开后的空镜", "shot_size": "全景", "camera": "缓拉", "action": "人走了，那件道具还留在原地。", "dialogue": "", "storyboard": "空镜收住钩子。", "image_prompt": "空场景里那件道具还亮着或还开着。", "motion_prompt": "缓拉离开。", "duration": 4, "character_ids": []},
        ],
    }


def fallback_director_plan(
    topic: str,
    *,
    mode: DirectorMode,
    shot_count: int,
    genre: DirectorGenre = "custom",
    look: DirectorLook = "manhua",
    stage: DirectorStage = "episode",
    objective: DirectorObjective = "full_episode",
    source_kind: DirectorSourceKind = "premise",
    include_video: bool = False,
) -> dict[str, Any]:
    source = _clean_multiline(topic, "未命名短剧")
    title = _clean(source, "未命名短剧")[:24]
    resolved_genre = _resolve_genre(genre)
    resolved_look = _resolve_look(look)
    resolved_stage = _resolve_stage(stage)
    resolved_objective = _resolve_objective(objective)
    resolved_source_kind = _resolve_source_kind(source_kind)
    count = max(1, min(9 if mode == "nine_grid" else MAX_SHOTS, shot_count))
    episode = _fallback_episode(source, resolved_genre)
    shots = []
    for index, beat in enumerate(episode["shots"][:count]):
        character_ids = [item for item in beat.get("character_ids") or [] if item]
        shots.append({
            "id": f"shot-{index + 1}",
            "title": beat["title"],
            "has_characters": bool(character_ids),
            "character_ids": character_ids,
            "location": beat.get("location") or "",
            "shot_size": beat.get("shot_size") or "中景",
            "camera": beat.get("camera") or "固定",
            "action": beat.get("action") or beat.get("storyboard") or "",
            "dialogue": beat.get("dialogue") or "",
            "storyboard": beat.get("storyboard") or beat.get("action") or "",
            "image_prompt": beat.get("image_prompt") or "",
            "motion_prompt": beat.get("motion_prompt") or "",
            "duration": 12 if mode == "nine_grid" else int(beat.get("duration") or 5),
            "source_ref": beat.get("storyboard") or episode["logline"],
        })
    style = LOOK_PROMPTS[resolved_look]
    return {
        "title": episode["title"] or f"{title} · 第一集",
        "mode": mode,
        "stage": resolved_stage,
        "objective": resolved_objective,
        "production": production_profile(
            resolved_objective,
            resolved_source_kind,
            include_video=include_video and resolved_stage == "episode",
        ),
        "input_mode": "plan",
        "source_facts": {"must_keep": episode["rules"][:3], "conflict": episode["conflict"], "events": []},
        "bible": {
            "logline": episode["logline"],
            "genre": resolved_genre,
            "look": resolved_look,
            "style": style,
            "setting": episode["setting"],
            "hook": episode["hook"],
            "conflict": episode["conflict"],
            "rules": episode["rules"],
            "script_card": episode["script_card"],
        },
        "characters": episode["characters"],
        "shots": shots,
        "motion_prompt": (
            f"Style & Mood: {style}\n"
            "Dynamic Description: 按分镜顺序演出场景里的动作，硬切衔接。不要拍摄漫画书。\n"
            "Static Description: 角色服装发型与静帧首帧一致。"
            if mode == "nine_grid" else ""
        ),
    }


def normalize_director_plan(
    value: Any,
    *,
    topic: str,
    mode: DirectorMode,
    shot_count: int,
    genre: DirectorGenre = "custom",
    look: DirectorLook = "manhua",
    stage: DirectorStage = "episode",
    objective: DirectorObjective = "full_episode",
    source_kind: DirectorSourceKind = "premise",
    include_video: bool = False,
    input_mode: DirectorInputMode = "plan",
    source_facts: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    resolved_mode: DirectorMode = "nine_grid" if str(value.get("mode") or mode) == "nine_grid" else "shot_pipeline"
    bible_raw = value.get("bible") if isinstance(value.get("bible"), dict) else {}
    title = _sanitize(_clean(value.get("title"), _clean(topic, "未命名短剧")[:24]))
    resolved_genre = _resolve_genre(bible_raw.get("genre") or value.get("genre") or genre)
    resolved_look = _resolve_look(bible_raw.get("look") or value.get("look") or look)
    resolved_stage = _resolve_stage(value.get("stage") or stage)
    resolved_objective = _resolve_objective(value.get("objective") or objective)
    production_raw = value.get("production") if isinstance(value.get("production"), dict) else {}
    resolved_source_kind = _resolve_source_kind(
        production_raw.get("source_kind") or production_raw.get("sourceKind") or value.get("source_kind") or source_kind,
        input_mode=_resolve_input_mode(value.get("input_mode") or input_mode),
    )
    default_production = production_profile(
        resolved_objective,
        resolved_source_kind,
        include_video=include_video and resolved_stage == "episode",
    )
    raw_deliverables = production_raw.get("deliverables") if isinstance(production_raw.get("deliverables"), list) else []
    raw_checkpoints = production_raw.get("checkpoints") if isinstance(production_raw.get("checkpoints"), list) else []
    deliverables = [_sanitize(_clean(item)) for item in raw_deliverables if _sanitize(_clean(item))][:10]
    checkpoints = [_sanitize(_clean(item)) for item in raw_checkpoints if _sanitize(_clean(item))][:8]
    rules = [
        _sanitize(_clean(item))
        for item in (bible_raw.get("rules") or [])
        if _sanitize(_clean(item))
    ][:6]
    bible = {
        "logline": _sanitize(_clean(bible_raw.get("logline"), title)),
        "genre": resolved_genre,
        "look": resolved_look,
        "style": _sanitize(_clean(bible_raw.get("style"), LOOK_PROMPTS[resolved_look])),
        "setting": _sanitize(_clean(bible_raw.get("setting"))),
        "hook": _sanitize(_clean(bible_raw.get("hook"))),
        "conflict": _sanitize(_clean(bible_raw.get("conflict"))),
        "rules": rules,
        "script_card": _sanitize_multiline(_clean_multiline(bible_raw.get("script_card") or bible_raw.get("scriptCard"), bible_raw.get("logline") or title)),
    }
    characters: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, entry in enumerate(value.get("characters") or []):
        if not isinstance(entry, dict) or len(characters) >= MAX_CHARACTERS:
            continue
        name = _sanitize(_clean(entry.get("name"), f"角色{index + 1}"))
        char_id = _slug(_clean(entry.get("id"), name), f"char-{index + 1}")
        if char_id in seen_ids:
            char_id = f"{char_id}-{index + 1}"
        sheet = _sanitize(_clean(entry.get("sheet_prompt") or entry.get("sheetPrompt"), name))
        if not sheet:
            continue
        seen_ids.add(char_id)
        characters.append({
            "id": char_id,
            "name": name,
            "identity": _sanitize(_clean(entry.get("identity"))),
            "sheet_prompt": sheet,
        })

    shot_limit = 9 if resolved_mode == "nine_grid" else min(MAX_SHOTS, max(1, shot_count))
    shots: list[dict[str, Any]] = []
    for index, entry in enumerate(value.get("shots") or []):
        if not isinstance(entry, dict) or len(shots) >= shot_limit:
            continue
        shot_title = _sanitize(_clean(entry.get("title"), f"镜头 {index + 1}"))
        action = _sanitize(_clean(entry.get("action") or entry.get("storyboard"), shot_title))
        storyboard = _sanitize(_clean(entry.get("storyboard"), action or shot_title))
        image_prompt = _sanitize(_clean(entry.get("image_prompt") or entry.get("imagePrompt"), storyboard))
        motion_prompt = _sanitize(_clean(entry.get("motion_prompt") or entry.get("motionPrompt"), storyboard))
        if not storyboard and not image_prompt and not action:
            continue
        raw_ids = entry.get("character_ids") or entry.get("characterIds") or []
        character_ids = [
            _slug(str(item), str(item))
            for item in (raw_ids if isinstance(raw_ids, list) else [])
            if _slug(str(item), str(item)) in seen_ids
        ]
        has_characters = bool(entry.get("has_characters") or entry.get("hasCharacters") or character_ids)
        try:
            duration = int(entry.get("duration") or (12 if resolved_mode == "nine_grid" else 5))
        except (TypeError, ValueError):
            duration = 5
        shots.append({
            "id": _slug(_clean(entry.get("id"), f"shot-{index + 1}"), f"shot-{index + 1}"),
            "title": shot_title,
            "has_characters": has_characters,
            "character_ids": character_ids if has_characters else [],
            "location": _sanitize(_clean(entry.get("location"))),
            "shot_size": _sanitize(_clean(entry.get("shot_size") or entry.get("shotSize"), "中景")),
            "camera": _sanitize(_clean(entry.get("camera"), "固定")),
            "action": action or storyboard or shot_title,
            "dialogue": _sanitize(_clean(entry.get("dialogue"))),
            "storyboard": storyboard or action or shot_title,
            "image_prompt": image_prompt or storyboard or shot_title,
            "motion_prompt": motion_prompt or storyboard or shot_title,
            "duration": max(1, min(15, duration)),
            "source_ref": _sanitize(_clean(entry.get("source_ref") or entry.get("sourceRef"))),
        })

    if not bible["logline"] and not shots:
        return None
    if not shots:
        return fallback_director_plan(
            topic,
            mode=resolved_mode,
            shot_count=shot_count,
            genre=resolved_genre,
            look=resolved_look,
            stage=resolved_stage,
            objective=resolved_objective,
            source_kind=resolved_source_kind,
            include_video=include_video,
        )
    resolved_input = _resolve_input_mode(value.get("input_mode") or input_mode)
    if resolved_mode == "shot_pipeline" and not characters:
        fallback = fallback_director_plan(
            topic,
            mode=resolved_mode,
            shot_count=shot_count,
            genre=resolved_genre,
            look=resolved_look,
            stage=resolved_stage,
        )
        characters = fallback["characters"]
        for shot in shots:
            if shot["has_characters"] and not shot["character_ids"]:
                shot["character_ids"] = ["hero"]
    facts = source_facts if isinstance(source_facts, dict) else value.get("source_facts")
    if not isinstance(facts, dict):
        facts = {}
    plan = {
        "title": title or "未命名短剧",
        "mode": resolved_mode,
        "stage": resolved_stage,
        "objective": resolved_objective,
        "production": {
            "source_kind": resolved_source_kind,
            "deliverables": deliverables or default_production["deliverables"],
            "checkpoints": checkpoints or default_production["checkpoints"],
        },
        "input_mode": resolved_input,
        "source_facts": facts,
        "bible": bible,
        "characters": characters,
        "shots": shots,
        "motion_prompt": _sanitize(_clean(value.get("motion_prompt") or value.get("motionPrompt"))),
    }
    if resolved_input == "plan":
        _enrich_plan_from_fallback(
            plan,
            topic,
            mode=resolved_mode,
            shot_count=shot_count,
            genre=resolved_genre,
            look=resolved_look,
            stage=resolved_stage,
        )
    return plan


def _enrich_plan_from_fallback(
    plan: dict[str, Any],
    topic: str,
    *,
    mode: DirectorMode,
    shot_count: int,
    genre: DirectorGenre,
    look: DirectorLook,
    stage: DirectorStage,
) -> None:
    bible = plan.get("bible") if isinstance(plan.get("bible"), dict) else {}
    script = str(bible.get("script_card") or "")
    has_dialogue = "：" in script or ":" in script or "：「" in script
    thin_script = (not has_dialogue) or (len(script) < 24)
    empty_cast = len(plan.get("characters") or []) < 2
    empty_rules = not bible.get("rules")
    # 只在整包明显是空壳时用本地骨架补故事，避免把林晚校规灌进另一个已经写好的故事。
    needs_story_pack = thin_script and (empty_rules or empty_cast)
    if needs_story_pack:
        fallback = fallback_director_plan(
            topic,
            mode=mode,
            shot_count=shot_count,
            genre=genre,
            look=look,
            stage=stage,
        )
        fall_bible = fallback.get("bible") or {}
        for key in ("setting", "hook", "conflict"):
            if not bible.get(key):
                bible[key] = fall_bible.get(key) or ""
        if empty_rules:
            bible["rules"] = list(fall_bible.get("rules") or [])
        if thin_script:
            bible["script_card"] = fall_bible.get("script_card") or script
        existing = {str(item.get("id") or "") for item in (plan.get("characters") or []) if isinstance(item, dict)}
        if empty_cast:
            for character in fallback.get("characters") or []:
                if not isinstance(character, dict):
                    continue
                char_id = str(character.get("id") or "")
                if char_id and char_id not in existing:
                    plan["characters"].append(character)
                    existing.add(char_id)
                if len(plan["characters"]) >= 2:
                    break
    for shot in plan.get("shots") or []:
        if not isinstance(shot, dict):
            continue
        if not shot.get("location"):
            shot["location"] = "主场景"
        if not shot.get("shot_size"):
            shot["shot_size"] = "中景"
        if not shot.get("camera"):
            shot["camera"] = "固定"
        if not shot.get("action"):
            shot["action"] = shot.get("storyboard") or shot.get("title") or ""


def _plan_text(plan: dict[str, Any]) -> str:
    bible = plan.get("bible") if isinstance(plan.get("bible"), dict) else {}
    parts = [
        str(plan.get("title") or ""),
        str(bible.get("logline") or ""),
        str(bible.get("setting") or ""),
        str(bible.get("hook") or ""),
        str(bible.get("conflict") or ""),
        " ".join(str(item) for item in (bible.get("rules") or [])),
        str(bible.get("script_card") or ""),
    ]
    for character in plan.get("characters") or []:
        if isinstance(character, dict):
            parts.append(str(character.get("name") or ""))
            parts.append(str(character.get("sheet_prompt") or ""))
    for shot in plan.get("shots") or []:
        if isinstance(shot, dict):
            parts.extend([
                str(shot.get("title") or ""),
                str(shot.get("location") or ""),
                str(shot.get("action") or ""),
                str(shot.get("dialogue") or ""),
                str(shot.get("storyboard") or ""),
                str(shot.get("image_prompt") or ""),
                str(shot.get("motion_prompt") or ""),
            ])
    return "\n".join(parts)


def _contains_template_cliche(text: str) -> str | None:
    for cliche in TEMPLATE_CLICHES:
        if cliche in (text or ""):
            return cliche
    return None


def _normalize_facts(value: Any, source_text: str) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    must_keep: list[str] = []
    for item in raw.get("must_keep") or []:
        token = _clean(item)
        if token and token in source_text and token not in must_keep:
            must_keep.append(token)
    characters: list[dict[str, str]] = []
    for entry in raw.get("characters") or []:
        if not isinstance(entry, dict):
            continue
        name = _clean(entry.get("name"))
        if not name:
            continue
        characters.append({
            "name": name,
            "identity": _clean(entry.get("identity")),
            "look": _clean(entry.get("look")),
        })
        if name in source_text and name not in must_keep:
            must_keep.append(name)
    events = [_clean(item) for item in (raw.get("events") or []) if _clean(item)]
    return {
        "must_keep": must_keep[:16],
        "characters": characters[:MAX_CHARACTERS],
        "conflict": _clean(raw.get("conflict")),
        "events": events[:12],
        "setting": _clean(raw.get("setting")),
        "source_kind": _clean(raw.get("source_kind"), "topic"),
    }


def _normalize_scenes(value: Any, source_text: str) -> list[dict[str, Any]]:
    raw_scenes = value.get("scenes") if isinstance(value, dict) else value
    if not isinstance(raw_scenes, list):
        return []
    scenes: list[dict[str, Any]] = []
    for index, entry in enumerate(raw_scenes):
        if not isinstance(entry, dict) or len(scenes) >= MAX_SHOTS:
            continue
        heading = _clean(entry.get("heading") or entry.get("title"))
        action = _clean(entry.get("action") or entry.get("storyboard"))
        dialogue = _clean(entry.get("dialogue"))
        source_ref = _clean(entry.get("source_ref") or entry.get("sourceRef") or heading or action)
        if not heading and not action and not dialogue:
            continue
        if source_ref and source_ref not in source_text:
            source_ref = heading or action or dialogue
        scenes.append({
            "index": index + 1,
            "heading": heading or f"场次 {index + 1}",
            "action": action,
            "dialogue": dialogue,
            "source_ref": source_ref,
        })
    return scenes


def _source_is_thin(source_text: str) -> bool:
    text = _clean_multiline(source_text)
    if len(text) >= 80:
        return False
    if re.search(r"场\s*\d|对白|分镜|镜头", text):
        return False
    return text.count("\n") < 3


def _clone_plan(plan: dict[str, Any]) -> dict[str, Any]:
    return json.loads(json.dumps(plan, ensure_ascii=False))


def _shot_index_from_id(shot_id: str) -> int | None:
    match = re.search(r"(?:shot-)?(\d+)$", _clean(shot_id))
    if not match:
        return None
    index = int(match.group(1))
    return index if index > 0 else None


def apply_director_plan_patch(base: dict[str, Any], patch: dict[str, Any] | None) -> dict[str, Any]:
    next_plan = _clone_plan(base)
    if not isinstance(patch, dict):
        return next_plan
    bible = next_plan.get("bible") if isinstance(next_plan.get("bible"), dict) else {}
    patch_bible = patch.get("bible") if isinstance(patch.get("bible"), dict) else {}
    for key in ("logline", "setting", "hook", "conflict", "style"):
        if patch_bible.get(key):
            bible[key] = _sanitize(_clean(patch_bible.get(key)))
    if isinstance(patch_bible.get("rules"), list) and patch_bible.get("rules"):
        bible["rules"] = [_sanitize(_clean(item)) for item in patch_bible["rules"] if _sanitize(_clean(item))][:6]
    script = patch_bible.get("script_card") or patch_bible.get("scriptCard")
    if script:
        bible["script_card"] = _sanitize_multiline(_clean_multiline(script))
    next_plan["bible"] = bible
    characters = [item for item in (next_plan.get("characters") or []) if isinstance(item, dict)]
    for entry in patch.get("characters") or []:
        if not isinstance(entry, dict):
            continue
        target = next((
            item for item in characters
            if item.get("id") == _clean(entry.get("id")) or item.get("name") == _clean(entry.get("name"))
        ), None)
        if not target:
            continue
        if entry.get("name"):
            target["name"] = _sanitize(_clean(entry.get("name")))
        if entry.get("identity"):
            target["identity"] = _sanitize(_clean(entry.get("identity")))
        sheet = entry.get("sheet_prompt") or entry.get("sheetPrompt")
        if sheet:
            target["sheet_prompt"] = _sanitize(_clean(sheet))
    next_plan["characters"] = characters
    shots = [item for item in (next_plan.get("shots") or []) if isinstance(item, dict)]
    remove = {_clean(item) for item in (patch.get("remove_shot_ids") or []) if _clean(item)}
    if remove:
        shots = [shot for shot in shots if _clean(shot.get("id")) not in remove]
    for entry in patch.get("shots") or []:
        if not isinstance(entry, dict):
            continue
        shot_id = _clean(entry.get("id"))
        index = _shot_index_from_id(shot_id)
        target = next((
            item for item in shots
            if item.get("id") == shot_id or item.get("title") == _clean(entry.get("title"))
        ), None)
        if target is None and index and 0 < index <= len(shots):
            target = shots[index - 1]
        if not target:
            continue
        for key, src in (
            ("title", "title"),
            ("location", "location"),
            ("shot_size", "shot_size"),
            ("camera", "camera"),
            ("action", "action"),
            ("dialogue", "dialogue"),
            ("storyboard", "storyboard"),
            ("image_prompt", "image_prompt"),
            ("motion_prompt", "motion_prompt"),
        ):
            if key == "shot_size" and (entry.get("shot_size") or entry.get("shotSize")):
                target["shot_size"] = _sanitize(_clean(entry.get("shot_size") or entry.get("shotSize")))
                continue
            if key == "image_prompt" and (entry.get("image_prompt") or entry.get("imagePrompt")):
                target["image_prompt"] = _sanitize(_clean(entry.get("image_prompt") or entry.get("imagePrompt")))
                continue
            if key == "motion_prompt" and (entry.get("motion_prompt") or entry.get("motionPrompt")):
                target["motion_prompt"] = _sanitize(_clean(entry.get("motion_prompt") or entry.get("motionPrompt")))
                continue
            if key == "dialogue" and "dialogue" in entry:
                target["dialogue"] = _sanitize(_clean(entry.get("dialogue")))
                continue
            if entry.get(src):
                target[key] = _sanitize(_clean(entry.get(src)))
    for entry in patch.get("add_shots") or []:
        if not isinstance(entry, dict) or len(shots) >= MAX_SHOTS:
            continue
        title = _sanitize(_clean(entry.get("title"), f"镜头 {len(shots) + 1}"))
        action = _sanitize(_clean(entry.get("action") or entry.get("storyboard"), title))
        try:
            duration = int(entry.get("duration") or 5)
        except (TypeError, ValueError):
            duration = 5
        shots.append({
            "id": f"shot-{len(shots) + 1}",
            "title": title,
            "has_characters": False,
            "character_ids": [],
            "location": _sanitize(_clean(entry.get("location"))),
            "shot_size": _sanitize(_clean(entry.get("shot_size") or entry.get("shotSize"), "中景")),
            "camera": _sanitize(_clean(entry.get("camera"), "固定")),
            "action": action,
            "dialogue": _sanitize(_clean(entry.get("dialogue"))),
            "storyboard": action,
            "image_prompt": _sanitize(_clean(entry.get("image_prompt") or entry.get("imagePrompt"), action)),
            "motion_prompt": _sanitize(_clean(entry.get("motion_prompt") or entry.get("motionPrompt"), entry.get("camera") or "固定")),
            "duration": max(1, min(15, duration)),
            "source_ref": "",
        })
    next_plan["shots"] = shots
    return next_plan


_SHOT_INDEX_WORDS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8}


def keyword_director_patch(instruction: str, base: dict[str, Any] | None = None) -> dict[str, Any]:
    text = _clean(instruction)
    patch: dict[str, Any] = {"summary": "关键词最小修改"}
    shot_token = re.search(r"第\s*([一二三四五六七八]|[1-8])\s*镜", text)
    if shot_token:
        raw = shot_token.group(1)
        shot_index = _SHOT_INDEX_WORDS.get(raw) or int(raw)
        dialogue_match = re.search(r"(?:对白|台词)\s*(?:改成|换成)\s*[「\"']?(.+?)[」\"']?$", text)
        if dialogue_match:
            next_dialogue = _sanitize(dialogue_match.group(1))
            shot: dict[str, Any] = {"id": f"shot-{shot_index}", "dialogue": next_dialogue}
            current = None
            if isinstance(base, dict):
                shots = [item for item in (base.get("shots") or []) if isinstance(item, dict)]
                if 0 < shot_index <= len(shots):
                    current = shots[shot_index - 1]
                    shot["id"] = str(current.get("id") or f"shot-{shot_index}")
                    if current.get("storyboard"):
                        shot["storyboard"] = f"{re.sub(r'对白[:：].*$', '', str(current.get('storyboard'))).strip()} 对白：{next_dialogue}"
                    if current.get("image_prompt"):
                        shot["image_prompt"] = f"{re.sub(r'对白[:：].*$', '', str(current.get('image_prompt'))).strip()} 对白：{next_dialogue}"
                    bible = base.get("bible") if isinstance(base.get("bible"), dict) else {}
                    script = str(bible.get("script_card") or "")
                    old_dialogue = str(current.get("dialogue") or "")
                    if old_dialogue and old_dialogue in script:
                        patch["bible"] = {"script_card": script.replace(old_dialogue, next_dialogue)}
            patch["shots"] = [shot]
    rule_match = re.search(r"(?:加一条|加上一条|新增一条|加上|加一条)?(?:校规|规则)[:：]\s*(.+)$", text)
    if rule_match:
        current = []
        if isinstance(base, dict):
            bible = base.get("bible") if isinstance(base.get("bible"), dict) else {}
            current = [str(item) for item in (bible.get("rules") or []) if str(item).strip()]
        current.append(_sanitize(rule_match.group(1)))
        patch["bible"] = {"rules": current[:6]}
    return patch


def _named_shot_ids(instruction: str, plan: dict[str, Any]) -> set[str]:
    named: set[str] = set()
    for match in re.finditer(r"第\s*([一二三四五六七八]|[1-8])\s*镜", instruction or ""):
        raw = match.group(1)
        index = _SHOT_INDEX_WORDS.get(raw) or int(raw)
        named.add(f"shot-{index}")
        shots = [item for item in (plan.get("shots") or []) if isinstance(item, dict)]
        if 0 < index <= len(shots):
            named.add(str(shots[index - 1].get("id") or f"shot-{index}"))
    return named


def patch_fidelity_issues(
    previous: dict[str, Any],
    patched: dict[str, Any],
    patch: dict[str, Any],
    *,
    instruction: str,
) -> list[str]:
    issues: list[str] = []
    named = _named_shot_ids(instruction, previous)
    if named:
        previous_shots = {
            str(item.get("id") or ""): item
            for item in (previous.get("shots") or [])
            if isinstance(item, dict)
        }
        for shot in patched.get("shots") or []:
            if not isinstance(shot, dict):
                continue
            shot_id = str(shot.get("id") or "")
            if not shot_id or shot_id in named:
                continue
            old = previous_shots.get(shot_id)
            if old and old.get("dialogue") != shot.get("dialogue"):
                issues.append(f"未点名镜头被改了对白：{shot_id}")
            if old and old.get("action") != shot.get("action") and old.get("storyboard") != shot.get("storyboard"):
                issues.append(f"未点名镜头被改了动作：{shot_id}")
    if re.search(r"校规|规则", instruction or "") and not re.search(r"第\s*[一二三四五六七八1-8]\s*镜", instruction or ""):
        prev_ids = [str(item.get("id") or "") for item in (previous.get("shots") or []) if isinstance(item, dict)]
        next_ids = [str(item.get("id") or "") for item in (patched.get("shots") or []) if isinstance(item, dict)]
        if prev_ids != next_ids:
            issues.append("只改规则时不要增删镜头")
    if not (patch.get("shots") or patch.get("bible") or patch.get("characters") or patch.get("add_shots") or patch.get("remove_shot_ids")):
        if instruction:
            issues.append("补丁是空的，用户的修改没有落到制作包上")
    return issues[:8]


def fidelity_issues(plan: dict[str, Any], *, source_text: str, input_mode: DirectorInputMode) -> list[str]:
    issues: list[str] = []
    text = _plan_text(plan)
    cliche = _contains_template_cliche(text)
    if cliche:
        issues.append(f"分镜套用了模板套话：{cliche}")
    facts = plan.get("source_facts") if isinstance(plan.get("source_facts"), dict) else {}
    thin = input_mode == "plan" and _source_is_thin(source_text)
    if not thin:
        for token in facts.get("must_keep") or []:
            token_text = _clean(token)
            if token_text and token_text in source_text and token_text not in text:
                issues.append(f"用户原文关键信息丢失：{token_text}")
    if input_mode == "inherit":
        for character in facts.get("characters") or []:
            name = _clean(character.get("name") if isinstance(character, dict) else "")
            if name and name in source_text and name not in text:
                issues.append(f"承接脚本时丢掉了角色名：{name}")
        for scene in plan.get("source_scenes") or []:
            if not isinstance(scene, dict):
                continue
            token = _clean(scene.get("source_ref") or scene.get("heading") or scene.get("dialogue"))
            if token and token in source_text and token not in text:
                issues.append(f"承接脚本时丢掉了场次：{token}")
    bible = plan.get("bible") if isinstance(plan.get("bible"), dict) else {}
    script_card = str(bible.get("script_card") or "")
    shots = [shot for shot in (plan.get("shots") or []) if isinstance(shot, dict)]
    if input_mode == "plan":
        if not (bible.get("rules") or []):
            issues.append("这一集还没有可执行的世界规则或校规")
        if "：「" not in script_card and "：" not in script_card and ":" not in script_card:
            issues.append("剧本缺少能演的对白")
        if len(plan.get("characters") or []) < 2:
            issues.append("至少需要两个可画角色，对戏才立得住")
        if re.search(r"规则怪谈|校园怪谈|校规", source_text):
            rules_text = " ".join(str(item) for item in (bible.get("rules") or []))
            if not re.search(r"禁止|必须|不许|不能", rules_text):
                issues.append("规则怪谈必须有可执行的禁令或必须条款")
        missing_shot_fields = sum(
            1 for shot in shots
            if not str(shot.get("location") or "").strip() or not str(shot.get("action") or shot.get("storyboard") or "").strip()
        )
        if shots and missing_shot_fields >= max(2, (len(shots) + 1) // 2):
            issues.append("分镜缺少地点或动作，无法拍摄")
    if not shots:
        issues.append("没有可用分镜")
    actions = [str(shot.get("action") or shot.get("storyboard") or "") for shot in shots]
    if len(actions) >= 2 and len({item for item in actions if item}) < min(3, len(actions)):
        issues.append("分镜动作同质化，每镜必须是不同空间或不同动作")
    if source_text and input_mode == "plan" and thin:
        repeated = sum(1 for shot in shots if source_text[:12] and source_text[:12] in str(shot.get("storyboard") or "") + str(shot.get("image_prompt") or ""))
        if repeated >= 2:
            issues.append("不要把用户原句复制进每一镜")
    return issues[:8]


def _billing_material(request: CanvasFlowDirectRequest, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    material = {
        "topic": request.topic,
        "mode": request.mode,
        "input_mode": request.input_mode,
        "genre": request.genre,
        "look": request.look,
        "stage": request.stage,
        "shot_count": request.shot_count,
        "include_video": request.include_video,
        "model_id": request.model_id,
        "intent": request.intent,
        "attachment_names": [str(item.get("filename") or "") for item in (request.attachments or [])[:8]],
    }
    if extra:
        material.update(extra)
    return material


async def _call_director_json(
    *,
    request: CanvasFlowDirectRequest,
    user_id: str,
    director_model: dict[str, Any],
    system: str,
    user: str,
    scope: str,
    max_tokens: int,
    temperature: float = 0.3,
) -> dict[str, Any]:
    async def invoke() -> str:
        return await asyncio.wait_for(
            call_llm_chat(
                system=system,
                user=user,
                model=director_model,
                max_tokens=max_tokens,
                temperature=temperature,
            ),
            timeout=45,
        )

    raw = await execute_billed_model_call(
        user_id=user_id,
        model_id=str(director_model.get("id") or "").strip(),
        expected_category=str(director_model.get("category") or "llm"),
        description="Canvas flow drama direction",
        idempotency_key=model_billing_operation_key(
            namespace="canvas-flow-director",
            user_id=user_id,
            operation_scope=f"{request.client_request_id}:{scope}" if request.client_request_id else scope,
            material=_billing_material(request, {"scope": scope}),
        ),
        invoke=invoke,
    )
    return _json_object(raw)


def _ingest_node(state: DirectorAgentState) -> dict[str, Any]:
    request = state["request"]
    attachment_context = _clean_multiline(request.attachment_context, limit=60000) or build_attachment_context(request.attachments or [])
    source_text = "\n\n".join(part for part in [_clean_multiline(request.topic), attachment_context] if part).strip()
    if not source_text:
        raise HTTPException(422, "请先输入题材、剧本，或上传 PDF / Word / TXT")
    intent = route_director_intent(
        has_canvas=_has_existing_canvas(request),
        topic=source_text,
        requested=request.intent,
    )
    previous = request.director_plan if isinstance(request.director_plan, dict) else {}
    return {
        "source_text": source_text,
        "attachment_context": attachment_context,
        "input_mode": _resolve_input_mode(request.input_mode),
        "intent": intent,
        "previous_plan": previous,
        "repair_attempt": 0,
        "fidelity_issues": [],
        "fallback": False,
    }


def _after_ingest(state: DirectorAgentState) -> str:
    return "edit" if state.get("intent") == "edit" else "plan"


async def _extract_facts_node(state: DirectorAgentState) -> dict[str, Any]:
    request = state["request"]
    payload = {
        "input_mode": state.get("input_mode") or request.input_mode,
        "user_text": state.get("source_text") or request.topic,
        "genre": request.genre,
        "notes": "只抽取已经出现的事实。没有的不要编。",
    }
    parsed = await _call_director_json(
        request=request,
        user_id=str(state.get("user_id") or ""),
        director_model=state["director_model"],
        system=FACTS_SYSTEM,
        user=json.dumps(payload, ensure_ascii=False),
        scope="extract-facts",
        max_tokens=1200,
        temperature=0.1,
    )
    return {"source_facts": _normalize_facts(parsed, state.get("source_text") or request.topic)}


async def _extract_scenes_node(state: DirectorAgentState) -> dict[str, Any]:
    request = state["request"]
    input_mode = state.get("input_mode") or request.input_mode
    if input_mode != "inherit":
        return {"source_scenes": []}
    payload = {
        "input_mode": input_mode,
        "user_text": state.get("source_text") or request.topic,
        "source_facts": state.get("source_facts") or {},
        "notes": "按原文场次拆开。不要合并，不要补没写过的戏。",
    }
    parsed = await _call_director_json(
        request=request,
        user_id=str(state.get("user_id") or ""),
        director_model=state["director_model"],
        system=SCENES_SYSTEM,
        user=json.dumps(payload, ensure_ascii=False),
        scope="extract-scenes",
        max_tokens=1600,
        temperature=0.1,
    )
    return {"source_scenes": _normalize_scenes(parsed, state.get("source_text") or request.topic)}


async def _write_plan_node(state: DirectorAgentState) -> dict[str, Any]:
    request = state["request"]
    payload = {
        "input_mode": state.get("input_mode") or request.input_mode,
        "topic": request.topic,
        "attachment_context": (state.get("attachment_context") or "")[:18000],
        "source_facts": state.get("source_facts") or {},
        "source_scenes": state.get("source_scenes") or [],
        "mode": request.mode,
        "objective": request.objective,
        "source_kind": request.source_kind,
        "genre": request.genre,
        "look": request.look,
        "stage": request.stage,
        "shot_count": request.shot_count,
        "include_video": request.include_video and request.stage == "episode",
        "aspect_ratio": request.aspect_ratio,
        "canvas_summary": request.canvas_summary,
        "style_lock": LOOK_PROMPTS[_resolve_look(request.look)],
        "fidelity_issues": state.get("fidelity_issues") or [],
        "notes": (
            "先判断薄不薄。用户只给题材/类型时，必须发明完整制作包："
            "2-3 个可反复拍的地点、3-5 条可执行规则、至少两个带身份的角色、"
            "开场 3 秒钩子、能演的场次和对白、5-8 个彼此不同的镜头。"
            "镜头字段必须填 location / shot_size / camera / action / dialogue。"
            "不要把用户原句复制进 logline、剧本或每一镜。"
            "inherit 模式必须按 source_scenes 的顺序写镜头，不得换场次、不得换人名。"
            "禁止类型模板套话。"
        ),
    }
    parsed = await _call_director_json(
        request=request,
        user_id=str(state.get("user_id") or ""),
        director_model=state["director_model"],
        system=PLAN_SYSTEM if not state.get("fidelity_issues") else REPAIR_SYSTEM,
        user=json.dumps(payload, ensure_ascii=False),
        scope="write-plan" if not state.get("fidelity_issues") else f"repair-{int(state.get('repair_attempt') or 0)}",
        max_tokens=3200,
        temperature=0.35,
    )
    plan = normalize_director_plan(
        parsed,
        topic=request.topic or _excerpt(state.get("source_text") or ""),
        mode=request.mode,
        shot_count=request.shot_count,
        genre=request.genre,
        look=request.look,
        stage=request.stage,
        objective=request.objective,
        source_kind=request.source_kind,
        include_video=request.include_video,
        input_mode=state.get("input_mode") or request.input_mode,
        source_facts=state.get("source_facts") or {},
    )
    if not plan:
        raise ValueError("empty director plan")
    plan["stage"] = _resolve_stage(request.stage)
    plan["objective"] = _resolve_objective(request.objective)
    plan["production"] = production_profile(
        plan["objective"],
        _resolve_source_kind(
            request.source_kind,
            input_mode=state.get("input_mode") or request.input_mode,
            intent=state.get("intent") or request.intent,
        ),
        include_video=request.include_video and request.stage == "episode",
    )
    plan["bible"]["genre"] = _resolve_genre(request.genre)
    plan["bible"]["look"] = _resolve_look(request.look)
    plan["bible"]["style"] = LOOK_PROMPTS[plan["bible"]["look"]]
    plan["input_mode"] = state.get("input_mode") or request.input_mode
    plan["source_facts"] = state.get("source_facts") or {}
    plan["source_scenes"] = state.get("source_scenes") or []
    return {"plan": plan}


def _fidelity_node(state: DirectorAgentState) -> dict[str, Any]:
    plan = state.get("plan") or {}
    issues = fidelity_issues(
        plan,
        source_text=state.get("source_text") or state["request"].topic,
        input_mode=state.get("input_mode") or "plan",
    )
    return {"fidelity_issues": issues}


def _after_fidelity(state: DirectorAgentState) -> str:
    issues = state.get("fidelity_issues") or []
    attempt = int(state.get("repair_attempt") or 0)
    if issues and attempt < MAX_REPAIR_ATTEMPTS:
        return "repair"
    return "done"


def _repair_node(state: DirectorAgentState) -> dict[str, Any]:
    return {"repair_attempt": int(state.get("repair_attempt") or 0) + 1}


async def _write_patch_node(state: DirectorAgentState) -> dict[str, Any]:
    request = state["request"]
    previous = state.get("previous_plan") or request.director_plan or {}
    payload = {
        "instruction": request.topic,
        "attachment_context": (state.get("attachment_context") or "")[:8000],
        "current_plan": previous,
        "graph_index": request.graph_index[:80],
        "notes": (
            "只输出补丁。没点名的镜头不要出现。"
            "第N镜对应 shot-N。"
            "改对白时同步改该镜 storyboard / image_prompt 和 script_card 里同一句。"
            "加规则只改 bible.rules。"
        ),
        "fidelity_issues": state.get("fidelity_issues") or [],
    }
    parsed = await _call_director_json(
        request=request,
        user_id=str(state.get("user_id") or ""),
        director_model=state["director_model"],
        system=EDIT_SYSTEM if not state.get("fidelity_issues") else PATCH_REPAIR_SYSTEM,
        user=json.dumps(payload, ensure_ascii=False),
        scope="write-patch" if not state.get("fidelity_issues") else f"repair-patch-{int(state.get('repair_attempt') or 0)}",
        max_tokens=1800,
        temperature=0.2,
    )
    if not isinstance(parsed, dict):
        parsed = keyword_director_patch(request.topic, previous if isinstance(previous, dict) else None)
    patched = apply_director_plan_patch(previous if isinstance(previous, dict) else {}, parsed)
    return {"patch": parsed, "plan": patched}


def _patch_fidelity_node(state: DirectorAgentState) -> dict[str, Any]:
    previous = state.get("previous_plan") or {}
    patched = state.get("plan") or {}
    patch = state.get("patch") or {}
    issues = patch_fidelity_issues(
        previous if isinstance(previous, dict) else {},
        patched if isinstance(patched, dict) else {},
        patch if isinstance(patch, dict) else {},
        instruction=state.get("source_text") or state["request"].topic,
    )
    return {"fidelity_issues": issues}


def _after_patch_fidelity(state: DirectorAgentState) -> str:
    issues = state.get("fidelity_issues") or []
    attempt = int(state.get("repair_attempt") or 0)
    if issues and attempt < MAX_REPAIR_ATTEMPTS:
        return "repair"
    return "done"


def _repair_patch_node(state: DirectorAgentState) -> dict[str, Any]:
    return {"repair_attempt": int(state.get("repair_attempt") or 0) + 1}


def _build_director_graph():
    graph = StateGraph(DirectorAgentState)
    graph.add_node("ingest", _ingest_node)
    graph.add_node("extract_facts", _extract_facts_node)
    graph.add_node("extract_scenes", _extract_scenes_node)
    graph.add_node("write_plan", _write_plan_node)
    graph.add_node("fidelity_check", _fidelity_node)
    graph.add_node("repair", _repair_node)
    graph.add_node("write_patch", _write_patch_node)
    graph.add_node("patch_fidelity", _patch_fidelity_node)
    graph.add_node("repair_patch", _repair_patch_node)
    graph.add_edge(START, "ingest")
    graph.add_conditional_edges(
        "ingest",
        _after_ingest,
        {"plan": "extract_facts", "edit": "write_patch"},
    )
    graph.add_edge("extract_facts", "extract_scenes")
    graph.add_edge("extract_scenes", "write_plan")
    graph.add_edge("write_plan", "fidelity_check")
    graph.add_conditional_edges(
        "fidelity_check",
        _after_fidelity,
        {"repair": "repair", "done": END},
    )
    graph.add_edge("repair", "write_plan")
    graph.add_edge("write_patch", "patch_fidelity")
    graph.add_conditional_edges(
        "patch_fidelity",
        _after_patch_fidelity,
        {"repair": "repair_patch", "done": END},
    )
    graph.add_edge("repair_patch", "write_patch")
    return graph.compile()


_DIRECTOR_GRAPH = _build_director_graph()


def _edit_fallback_response(request: CanvasFlowDirectRequest, topic: str, message: str) -> CanvasFlowDirectResponse:
    previous = request.director_plan if isinstance(request.director_plan, dict) else None
    if previous:
        patch = keyword_director_patch(topic, previous)
        return CanvasFlowDirectResponse(
            plan=apply_director_plan_patch(previous, patch),
            patch=patch,
            intent="edit",
            fallback=True,
            message=message,
        )
    return CanvasFlowDirectResponse(
        plan={"title": "", "mode": request.mode, "stage": request.stage, "bible": {}, "characters": [], "shots": []},
        patch={},
        intent="edit",
        fallback=True,
        message="现有制作包不完整，这次只能改点名的节点。",
    )


async def direct_canvas_flow_plan(
    request: CanvasFlowDirectRequest,
    *,
    user_id: str,
) -> CanvasFlowDirectResponse:
    explicit_fields = set(getattr(request, "model_fields_set", set()))
    topic = _clean_multiline(request.topic)
    request.topic = topic
    request.input_mode = _resolve_input_mode(request.input_mode)
    request.objective = _resolve_objective(request.objective)
    request.genre = _resolve_genre(request.genre)
    request.look = _resolve_look(request.look)
    request.intent = route_director_intent(
        has_canvas=_has_existing_canvas(request),
        topic=topic,
        requested=request.intent,
    )
    if request.intent == "edit":
        existing_stage = request.director_plan.get("stage") if isinstance(request.director_plan, dict) else None
        request.stage = _resolve_stage(existing_stage or request.stage)
    elif "objective" in explicit_fields or request.stage is None:
        request.stage = _stage_for_objective(request.objective, include_video=request.include_video)
    else:
        request.stage = _resolve_stage(request.stage)
    request.source_kind = _resolve_source_kind(
        request.source_kind,
        input_mode=request.input_mode,
        intent=request.intent,
    )
    fallback = fallback_director_plan(
        topic or "未命名短剧",
        mode=request.mode,
        shot_count=request.shot_count,
        genre=request.genre,
        look=request.look,
        stage=request.stage,
        objective=request.objective,
        source_kind=request.source_kind,
        include_video=request.include_video,
    )
    director_model = await resolve_director_model(request.model_id)
    if not director_model:
        logger.warning("[CanvasFlowDirector] no system text/vision model, using local fallback")
        if request.intent == "edit":
            return _edit_fallback_response(request, topic, "系统文本或视觉模型暂不可用，已按这句话做最小修改。")
        return CanvasFlowDirectResponse(plan=fallback, intent=request.intent, fallback=True, message="系统文本或视觉模型暂不可用，已用本地分镜骨架铺图。")

    try:
        state = await asyncio.wait_for(
            _DIRECTOR_GRAPH.ainvoke({
                "request": request,
                "user_id": user_id,
                "director_model": director_model,
            }),
            timeout=90,
        )
        plan = state.get("plan")
        if not isinstance(plan, dict) or not plan.get("shots"):
            raise ValueError("empty director plan")
        issues = state.get("fidelity_issues") or []
        intent = state.get("intent") or request.intent
        if intent == "edit":
            message = "已按你的话改现有画布，没有重铺整集。"
            if issues:
                message = "已尽量只改你点名的部分，请再核对剧本和分镜。"
            return CanvasFlowDirectResponse(
                plan=plan,
                patch=state.get("patch") if isinstance(state.get("patch"), dict) else {},
                intent="edit",
                fallback=False,
                message=message,
            )
        inherit = request.input_mode == "inherit"
        message = "已按你的剧本/分镜结构化并铺到画布。" if inherit else "已根据题材写好分镜，正在铺到画布。"
        if issues:
            message = "导演已尽量贴着原文铺图，请再核对剧本和分镜提示词。"
        return CanvasFlowDirectResponse(plan=plan, intent=intent, fallback=False, message=message)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("[CanvasFlowDirector] falling back after LLM error: %s", exc)
        if request.intent == "edit":
            return _edit_fallback_response(request, topic, "导演模型暂时不稳定，已按这句话做最小修改，没有重铺整集。")
        return CanvasFlowDirectResponse(plan=fallback, intent=request.intent, fallback=True, message="导演模型暂时不稳定，已用本地分镜骨架铺图，你仍可改提示词。")
