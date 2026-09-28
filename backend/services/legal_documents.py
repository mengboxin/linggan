"""Immutable, application-owned legal document registry for Linggan."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date
from typing import Literal


LegalDocumentType = Literal["terms", "privacy", "ai", "payment"]
CURRENT_LEGAL_VERSION = "2026.08.13"
# Old clients only submit two booleans. Keep that evidence bound to the
# version they actually displayed instead of silently accepting future text.
LEGACY_BOOLEAN_LEGAL_VERSION = "2026-06-28"


@dataclass(frozen=True)
class LegalDocument:
    document_type: LegalDocumentType
    version: str
    title: str
    summary: str
    content_markdown: str
    published_on: date
    effective_on: date
    requires_reacceptance: bool
    required_at_login: bool = False

    @property
    def content_hash(self) -> str:
        normalized = self.content_markdown.replace("\r\n", "\n").replace("\r", "\n")
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def public_payload(self, *, include_content: bool = False) -> dict:
        payload = {
            "documentType": self.document_type,
            "version": self.version,
            "title": self.title,
            "summary": self.summary,
            "contentHash": self.content_hash,
            "publishedOn": self.published_on.isoformat(),
            "effectiveOn": self.effective_on.isoformat(),
            "requiresReacceptance": self.requires_reacceptance,
            "requiredAtLogin": self.required_at_login,
        }
        if include_content:
            payload["contentMarkdown"] = self.content_markdown
        return payload


_PUBLISHED_ON = date(2026, 8, 13)
_EFFECTIVE_ON = date(2026, 8, 13)

_TERMS = """# 灵感用户服务协议

## 1. 协议范围与接受
本协议适用于用户使用灵感网站、桌面端、移动端及其提供的图像生成与编辑、自由画布、工作流、科研绘图、海报、演示文稿、云端存储、灵感配方、会员及其他相关服务。用户应在注册或登录前完整阅读本协议和《隐私政策》，尤其是责任限制、内容规则、计费退款和争议解决条款，并通过主动勾选作出明确同意。

## 2. 账号与安全
用户应使用本人有权使用且能正常接收通知的邮箱注册，提供准确资料并妥善保管密码、验证码、访问令牌和设备。账号仅限用户本人使用，不得出借、转让、售卖或用于批量注册、绕过风控、自动化滥用、攻击、爬取或其他危害平台与第三方的行为。发现异常时，平台可要求验证身份，并采取限流、冻结、暂停或终止服务等必要措施。

## 3. AI 创作与内容规范
用户对提交的提示词、参考图、源文件、字体、商标、人物肖像、工作流和其他材料拥有合法权利或充分授权，并对生成、编辑、发布、商用和交付行为负责。不得制作、上传或传播违法违规、有害、欺诈、侵权、歧视、淫秽色情、暴力恐怖、侵犯隐私、危害国家安全或违反公序良俗的内容。平台可依法进行机器或人工安全审核，并拒绝、停止、限制或删除相关内容。

## 4. 用户内容与平台授权
用户保留依法享有的用户内容权益。为提供模型调用、编辑、预览、导出、历史记录、同步、存储、安全审核、故障排查和客户支持，用户授予平台在服务所必需范围内处理、复制、转换、传输、缓存和展示相关内容的非独占授权。除非另行取得明确同意，平台不会将用户的非公开内容用于公开展示或广告宣传。

## 5. 知识产权
平台软件、界面、品牌、文档、代码、模型调度、系统设计和运营素材的权利归平台或相应权利人所有。用户不得未经许可复制、反向工程、出租、转售、镜像或用于建立竞争性服务。AI 输出可能与第三方内容相似，平台不保证输出当然具有著作权、可注册商标或不侵犯第三方权利，用户应在重要或商用场景自行审查。

## 6. 服务、存储与数据导出
模型供应商、网络、浏览器、对象存储、支付渠道、维护、安全事件或不可抗力可能造成任务延迟、失败、限流或中断。历史、上传、预览和导出文件按页面公示的配额与保留规则保存，重要成果应由用户及时下载备份。删除可能因缓存、备份、日志和第三方回收周期存在合理延迟。

## 7. 计费、会员与退款
积分、会员、套餐、存储及增值服务的价格、配额、有效期、消耗顺序和限制，以购买页面与《付费服务规则》为准。数字化服务一经实际调用或权益被消耗，除法律另有规定或平台责任导致服务无法交付外，通常不支持无理由退款。用户应在支付前核对商品、金额、期限和支付方式。

## 8. 未成年人
未满十八周岁的用户应在监护人阅读并同意相关协议后，在监护人指导下使用和付费。平台原则上不主动面向未满十四周岁儿童提供需要收集其个人信息的服务；监护人发现未经同意的使用，可通过微信 wj040204520 或邮箱 2558212076@qq.com 联系我们处理。

## 9. 违约与服务终止
用户违反法律、本协议、第三方模型规则或安全策略时，平台可根据风险采取警示、拒绝任务、删除内容、限制功能、暂停账号、终止服务、保存证据或向主管机关报告。终止不影响已经产生的付款、赔偿、知识产权、保密和争议解决义务。

## 10. 协议更新与争议解决
因法律、功能、供应商或经营方式发生重大变化时，平台将通过显著提示、站内通知或邮件说明更新内容和生效时间，并在依法需要时重新取得同意。本协议适用中华人民共和国法律；如有使用、账号、付费或内容问题，可通过微信 wj040204520 或邮箱 2558212076@qq.com 联系处理。
""".strip()

_PRIVACY = """# 灵感隐私政策

## 1. 适用范围和处理原则
本政策说明灵感在网站、桌面端和移动端中如何处理个人信息。我们遵循合法、正当、必要、诚信、目的明确和最小范围原则；不同功能实际处理的信息，以功能页面提示和用户选择为准。

## 2. 我们处理的信息
账号与验证信息包括邮箱、显示名称、密码哈希、验证码状态、账号状态和安全验证记录；服务信息包括提示词、参数、任务状态、工作流、历史、灵感配方、上传文件、生成结果、预览与导出；交易信息包括订单、金额、支付状态、积分与会员流水；安全与设备信息包括 IP 地址、浏览器、操作系统、设备类型、请求时间、错误日志和风控记录。桌面端选择本地存储时，本地项目原则上保存在用户设备；切换云端后，所选内容才按功能说明上传。

## 3. 处理目的和法律基础
我们为创建与保护账号、履行服务协议、完成 AI 调用和文件处理、保存用户选择的历史、结算订单和权益、提供客服、保障网络安全、处理争议和履行法定义务而处理必要信息。对非必要的分析、通知或个性化处理，将按法律要求提供选择或另行征得同意。

## 4. 委托处理、共享和第三方
为完成服务，必要信息可能由 AI 模型、云服务器、对象存储、邮件、支付、内容安全、错误监控和网络防护服务商受托处理。我们将通过合同、权限控制和安全措施限制其处理目的与范围。我们不会出售个人信息，也不会因合并、重组等情形之外向无关第三方转让；发生转让时将依法告知并履行相应义务。

## 5. 跨境处理
部分模型或基础设施服务可能涉及境外处理。实际发生向境外提供个人信息时，我们将依法告知境外接收方、处理目的、信息种类、保存地点与用户行使权利方式，并取得单独同意或履行适用的安全评估、认证、标准合同等义务。未完成必要合规程序前，不应据此条款推定用户已经同意任何跨境传输。

## 6. 保存期限和删除
我们仅在实现目的所需最短期限内保存信息，但法律、支付对账、安全、投诉或争议处理另有要求的除外。上传和历史记录以对应功能显示的保存规则为准；期限届满后将删除或匿名化，缓存和第三方回收可能存在合理延迟。

## 7. Cookie 与本地存储
平台可使用 Cookie、LocalStorage、SessionStorage 或类似技术保存登录状态、协议版本、主题、存储模式和必要安全信息。清除这些信息可能导致退出登录、偏好重置或部分功能不可用。非必要追踪技术将按适用规则提供选择。

## 8. 安全措施与事件响应
我们采取加密传输、密码哈希、权限隔离、最小授权、日志审计、限流、对象权限和备份恢复等措施。发生或可能发生个人信息安全事件时，将及时采取补救措施，并按法律要求向主管机关报告及通知受影响用户。

## 9. 用户权利
用户可依法请求查阅、复制、更正、补充、删除、限制处理、撤回同意、注销账号或在符合法定条件时转移个人信息。撤回不影响此前基于同意进行处理的效力。我们可在响应前核验身份，并在法律规定期限内处理；法律要求保留或存在合理例外的，将说明理由。

## 10. 未成年人和政策更新
未成年人应在监护人指导下使用。涉及未满十四周岁儿童信息时，应取得监护人同意并采取专门保护。重大政策更新将显著告知；个人信息查阅、更正、删除及投诉请求，可通过微信 wj040204520 或邮箱 2558212076@qq.com 提交。
""".strip()

_AI = """# AI 服务与生成内容免责声明

## 1. 技术性质
灵感提供的是概率性 AI 辅助创作工具，不是专业法律、医疗、金融、新闻、鉴定或其他受监管领域的意见。模型可能产生事实错误、偏差、遗漏、不可复现、与提示不符或与既有作品相似的内容，预览效果与最终导出也可能存在差异。

## 2. 用户审查责任
用户在发布、印刷、商用、投放、参赛、科研发表、教学、公共传播或交付第三方前，应对事实、数据、引用、版权、商标、肖像、隐私、字体许可、内容安全和适用性进行人工复核，并按适用规则标识 AI 生成或合成内容。不得将模型输出作为唯一依据作出可能影响人身、财产、健康、权利或公共利益的重大决定。

## 3. 权利与相似性风险
平台不承诺生成结果具有独占性、当然受到知识产权保护、可获得登记注册、不会与第三方内容相似或不会侵权。参考图、风格描述、人物、品牌和作品的使用应具有合法来源与授权。收到有效侵权通知后，平台可依法采取限制访问、下架、保存证据等措施。

## 4. 科研、PPT 与信息真实性
科研绘图、文献辅助和演示文稿中的数据、公式、图表、引用、结论及版式均可能出错或被误解，必须由具备相应能力的用户校核。不得伪造实验、数据、文献、资质、证据或以 AI 输出冒充真实记录。

## 5. 可用性与责任边界
平台将尽合理努力提供服务，但不保证模型持续可用、结果满足特定目的或每次可复现。因第三方模型、网络、设备、输入材料、政策限制或不可抗力导致的失败与延迟，按用户协议和法律规定处理。本免责声明不排除或限制依法不得排除的法定责任，也不减损消费者依法享有的权利。
""".strip()

_PAYMENT = """# 付费服务、会员与退款规则

## 1. 商品与价格
平台可提供按量积分、限期会员、套餐、存储和其他数字化服务。购买页面应展示商品名称、价格、有效期、配额、使用范围、消耗顺序、自动续费状态和重要限制；最终订单以用户确认时展示的信息为准。会员权益与按量积分相互独立，不得将限期会员配额表述为永久按量余额。

## 2. 支付与开通
用户选择商品后，通过页面显示的支付渠道完成付款。权益在平台收到可信支付成功通知并通过必要风控后开通。支付处理中、重复支付、金额不符或回调异常时，不应重复付款；可凭订单号通过平台公示渠道查询。平台不会要求用户向非公示个人账户转账。

## 3. 会员生效与排队
同类限期会员重复购买时，除购买页另有明确说明外，后购买权益按订单顺序等待前一权益结束后生效，不直接合并为永久积分。用户拥有多个可用套餐时，可在产品支持范围内选择消耗来源；一次任务的实际扣减以提交前页面确认和账单记录为准。

## 4. 消耗、失败与退还
任务提交后可进行预扣、冻结或结算。未实际调用、系统明确失败或发生重复扣减时，平台应按可核验记录释放冻结或退还对应权益；已完成模型调用但用户主观不满意，通常不视为服务未交付。异常争议以订单、任务、模型调用和账本的幂等记录综合核验。

## 5. 退款
数字化服务具有即时履行特征。已使用的积分、已生效且权益已消耗的会员部分，一般不支持无理由退款，但法律另有规定、平台重复收费、无法开通或因平台原因长期无法提供核心服务的除外。未消耗部分能否退款、退款路径、手续费和到账时间，以购买页承诺、支付渠道规则和适用法律为准。

## 6. 发票、未成年人和争议
如当前购买页面未展示发票入口，即表示暂未提供在线开票能力。未成年人付费应取得监护人同意；价格或规则调整不追溯影响已完成订单。订单疑问可通过微信 wj040204520 或邮箱 2558212076@qq.com 提交订单号核查。
""".strip()


_DOCUMENTS: tuple[LegalDocument, ...] = (
    LegalDocument("terms", CURRENT_LEGAL_VERSION, "用户服务协议", "账号、服务、内容与平台使用规则", _TERMS, _PUBLISHED_ON, _EFFECTIVE_ON, True, True),
    LegalDocument("privacy", CURRENT_LEGAL_VERSION, "隐私政策", "个人信息处理、共享、保存与用户权利", _PRIVACY, _PUBLISHED_ON, _EFFECTIVE_ON, True, True),
    LegalDocument("ai", CURRENT_LEGAL_VERSION, "AI 服务与生成内容免责声明", "AI 输出风险、人工复核与责任边界", _AI, _PUBLISHED_ON, _EFFECTIVE_ON, True),
    LegalDocument("payment", CURRENT_LEGAL_VERSION, "付费服务、会员与退款规则", "积分、会员、支付、结算与退款规则", _PAYMENT, _PUBLISHED_ON, _EFFECTIVE_ON, True),
)

LEGAL_DOCUMENTS = {(document.document_type, document.version): document for document in _DOCUMENTS}
CURRENT_LEGAL_DOCUMENTS = {document.document_type: document for document in _DOCUMENTS}


def current_required_legal_documents() -> tuple[LegalDocument, ...]:
    """Documents that must be accepted before an authenticated session may operate."""
    return tuple(
        document
        for document in CURRENT_LEGAL_DOCUMENTS.values()
        if document.required_at_login and document.requires_reacceptance
    )


def current_required_legal_fingerprint() -> str:
    """Stable JWT claim that changes whenever a required document changes."""
    material = "\n".join(
        f"{document.document_type}:{document.version}:{document.content_hash}"
        for document in current_required_legal_documents()
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def documents_cover_current_required(documents: tuple[LegalDocument, ...] | list[LegalDocument]) -> bool:
    accepted = {
        (document.document_type, document.version, document.content_hash)
        for document in documents
    }
    return all(
        (document.document_type, document.version, document.content_hash) in accepted
        for document in current_required_legal_documents()
    )


def get_legal_document(document_type: str, version: str | None = None) -> LegalDocument | None:
    current = CURRENT_LEGAL_DOCUMENTS.get(document_type)  # type: ignore[arg-type]
    if current is None:
        return None
    return LEGAL_DOCUMENTS.get((current.document_type, version or current.version))


def current_acceptance_claims(*document_types: LegalDocumentType) -> list[dict[str, str]]:
    return [
        {
            "document_type": document_type,
            "version": CURRENT_LEGAL_DOCUMENTS[document_type].version,
            "content_hash": CURRENT_LEGAL_DOCUMENTS[document_type].content_hash,
        }
        for document_type in document_types
    ]
