import type { LegalDocumentSnapshot, LegalDocumentType } from '../lib/legal'

type LegalSection = {
  title: string
  paragraphs: string[]
}

export type LegalDocumentStatus = 'effective'

export interface LegalDocumentMeta {
  title: string
  shortTitle: string
  subtitle: string
  version: string
  updatedAt: string
  effectiveAt: string
  status: LegalDocumentStatus
  path: string
  icon: string
}

export const LEGAL_VERSION = '2026.08.13'
export type { LegalDocumentType }

type RenderedLegalSection = {
  title: string
  paragraphs: string[]
}

function parseLegalMarkdown(markdown: string): RenderedLegalSection[] {
  const sections: RenderedLegalSection[] = []
  let current: RenderedLegalSection | null = null
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (current && paragraph.length > 0) current.paragraphs.push(paragraph.join(' ').trim())
    paragraph = []
  }

  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('# ')) continue
    if (line.startsWith('## ')) {
      flushParagraph()
      current = { title: line.slice(3).trim(), paragraphs: [] }
      sections.push(current)
      continue
    }
    if (!line) {
      flushParagraph()
      continue
    }
    if (!current) {
      current = { title: '', paragraphs: [] }
      sections.push(current)
    }
    paragraph.push(line)
  }
  flushParagraph()
  return sections
}

function formatLegalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : value
}

const termsSections: LegalSection[] = [
  {
    title: '1. 条款适用与接受',
    paragraphs: [
      '本服务条款适用于 Linggan（灵感）向用户提供的账号、图像生成、图像编辑、工作流、PPT 生成、云端存储、积分充值、桌面端联动以及其他 AI 辅助创作服务。',
      '用户在注册、登录、使用平台功能、提交提示词、上传文件、生成内容、充值或下载成果前，应完整阅读并理解本条款及《隐私政策》。勾选同意或继续使用服务，即视为用户已充分理解并同意受本条款约束。',
      '本条款根据《中华人民共和国民法典》《中华人民共和国网络安全法》《中华人民共和国数据安全法》《中华人民共和国个人信息保护法》《生成式人工智能服务管理暂行办法》等中华人民共和国现行法律法规制定。'
    ],
  },
  {
    title: '2. 账号注册、登录与安全',
    paragraphs: [
      '用户应使用真实、有效、可接收通知的电子邮箱注册账号，并对账号下发生的全部操作负责。平台可根据安全、风控、支付、合规或服务管理需要，要求用户进行邮箱验证、验证码验证、二次确认或其他合理身份核验。',
      '用户应妥善保管账号、密码、验证码、访问令牌及设备安全。因用户泄露、转让、出借账号或使用弱密码导致的损失，由用户自行承担；平台发现异常登录、撞库、批量注册、恶意调用等风险时，有权限制、暂停或终止相关账号功能。',
      '用户不得冒用他人身份、侵犯他人权益、规避风控或以自动化脚本批量注册、登录、调用、爬取平台数据。'
    ],
  },
  {
    title: '3. AI 服务规则',
    paragraphs: [
      '用户应依法、理性、审慎使用生成式人工智能功能，不得利用平台生成、编辑、上传、传播违法违规、有害、虚假、侵权、暴力、淫秽色情、歧视、恐怖极端、危害国家安全、破坏社会稳定或违反公序良俗的内容。',
      '用户提交的提示词、参考图、源文件、PPT、工作流节点、生成结果及后续编辑指令，应保证具有合法来源，且不侵犯他人的知识产权、肖像权、名誉权、荣誉权、隐私权、个人信息权益、商业秘密或其他合法权益。',
      'AI 生成结果具有概率性和不确定性，可能存在错误、偏差、相似性、不可用或不符合预期的情况。用户在对外发布、商用、印刷、交付或用于重要场景前，应自行审查内容合法性、准确性、权利状态和适用性。',
      '平台可基于法律法规、模型服务商规则、内容安全策略、投诉举报或风险识别，对提示词、上传内容、生成结果、工作流、历史记录进行安全审核、拒绝生成、停止传输、限制展示、删除或封禁处理。'
    ],
  },
  {
    title: '4. 用户内容与授权',
    paragraphs: [
      '用户保留其依法享有权利的原始上传内容、提示词、项目资料和生成成果的相关权益。用户确认并授权平台为提供服务、完成模型调用、保存历史、同步工作流、生成预览、排查故障、履行合规义务之目的，处理、缓存、复制、转换、展示和存储相关内容。',
      '用户不得上传或处理无权使用的图片、字体、商标、作品、人物肖像、个人信息、商业资料或保密文件。因用户内容引起的侵权、投诉、索赔或行政、司法风险，由用户自行承担。',
      '平台界面、代码、交互、商标、服务名称、模型调度逻辑、系统设计、文档和运营素材等平台自有内容，未经许可不得复制、反向工程、转售、镜像或用于竞争性服务。'
    ],
  },
  {
    title: '5. 存储、历史记录与删除',
    paragraphs: [
      '平台可能为网页端用户保存生成历史、缩略图、预览图、工作流快照、PPT 文件、导出文件和用户上传源文件，以支持继续编辑、项目恢复、演示、下载和空间管理。',
      '不同类型文件会按照平台展示的配额、保留期限和清理策略保存。临时文件、导出文件、大体积文件、被删除记录或超过保留期限的内容，可能被自动或手动清理。用户应及时下载和备份重要成果。',
      '用户主动删除历史、项目、工作流、PPT 或存储空间资源后，平台将删除数据库引用，并尽合理努力异步删除对象存储中的对应文件。由于缓存、备份、日志、第三方服务回收周期等原因，彻底清除可能存在合理延迟。'
    ],
  },
  {
    title: '6. 积分、充值与订单',
    paragraphs: [
      '平台可使用积分、套餐、订单或其他计费方式收取 AI 调用、存储、导出、加速或增值服务费用。具体价格、消耗规则、赠送规则、有效期和限制，以页面展示和后台配置为准。',
      '用户发起支付前应核对商品名称、金额、支付方式、订单状态和服务说明。支付成功后，平台将根据支付回调和风控校验发放积分或开通服务；如发生重复支付、回调延迟、订单异常或充值未到账，用户应联系平台处理。',
      '除法律法规另有规定、页面明确承诺或平台责任导致的异常外，已实际消耗的积分、已完成的模型调用和已交付的数字化服务通常不支持无理由退款。'
    ],
  },
  {
    title: '7. 未成年人保护',
    paragraphs: [
      '未满十八周岁的未成年人使用本服务，应在监护人阅读并同意本条款和《隐私政策》后，在监护人的指导和同意下使用。未满十四周岁儿童的个人信息属于敏感个人信息，平台原则上不主动面向儿童收集该类信息。',
      '监护人应合理管理未成年人的账号、充值、生成内容、下载和分享行为。平台发现未成年人存在沉迷、过度依赖、违法违规使用或不适宜内容风险时，有权采取提醒、限制、暂停或删除等措施。'
    ],
  },
  {
    title: '8. 服务变更、中断与责任限制',
    paragraphs: [
      '平台会尽合理努力保障服务安全、稳定和持续，但服务可能因模型供应商、网络、浏览器、对象存储、支付通道、系统维护、不可抗力、安全事件、政策变化或第三方原因发生中断、延迟、失败、限流或结果异常。',
      '平台可根据产品迭代、成本变化、合规要求和运营需要，调整功能、模型、价格、配额、存储策略、内容安全规则和服务入口，并通过页面公告、站内提示、邮件或其他合理方式通知用户。',
      '在法律允许范围内，平台不对 AI 生成结果的绝对准确性、完整性、适销性、特定用途适用性、商业收益或不会侵权作保证。用户基于生成结果作出的发布、交易、展示、交付、决策或其他行为，由用户自行负责。'
    ],
  },
  {
    title: '9. 违约处理与投诉',
    paragraphs: [
      '用户违反本条款、法律法规、模型服务商规则或平台安全策略的，平台可视情况采取警示、拒绝生成、删除内容、限制功能、冻结积分、暂停账号、终止服务、保存证据、向主管部门报告等措施。',
      '用户认为平台内容、处理措施或账号状态存在错误，或发现违法违规、侵权、个人信息泄露等问题，可通过微信 wj040204520 或邮箱 2558212076@qq.com 提交申诉、投诉或举报。平台将在合理期限内处理。'
    ],
  },
  {
    title: '10. 法律适用与争议解决',
    paragraphs: [
      '本条款的订立、生效、履行、解释及争议解决，适用中华人民共和国法律法规。',
      '因本服务产生争议的，双方应优先友好协商；协商不成的，任一方可向平台运营者住所地或有管辖权的人民法院提起诉讼。'
    ],
  },
]

const privacySections: LegalSection[] = [
  {
    title: '1. 我们处理的信息类型',
    paragraphs: [
      '账号信息：电子邮箱、显示名称、密码哈希、登录状态、注册时间、账号状态、角色和必要的安全验证记录。',
      '使用信息：提示词、模型选择、生成参数、任务状态、工作流快照、编辑记录、历史记录、PPT 任务、下载记录、积分流水、订单和支付回调状态。',
      '用户内容：用户上传的图片、PPT、源文件、参考图、遮罩、生成结果、缩略图、预览图、导出文件以及为继续编辑、演示和存储管理所需的关联元数据。',
      '设备与日志信息：IP 地址、浏览器类型、设备类型、操作系统、错误日志、接口请求、风控记录、性能数据和必要的安全审计信息。'
    ],
  },
  {
    title: '2. 处理目的与法律基础',
    paragraphs: [
      '我们基于用户同意、履行与用户之间的服务协议、保障网络与交易安全、履行法定义务、处理投诉争议以及在合理范围内改善服务的需要，处理个人信息。',
      '具体用途包括账号注册与登录、邮箱验证、找回密码、AI 生成与编辑、工作流保存、PPT 生成与演示、存储空间统计、订单支付、积分结算、异常排查、内容安全审核、用户支持和合规留痕。',
      '除实现基本功能所必需的信息外，如某项信息仅用于改进体验、通知或非必要统计，用户可按照页面提示或联系我们行使选择、撤回或删除权利。'
    ],
  },
  {
    title: '3. 第三方服务与跨境处理',
    paragraphs: [
      '为完成 AI 生成、图像编辑、PPT 生成、对象存储、邮件发送、支付处理、错误监控或安全防护，平台可能会在必要范围内向第三方服务提供商传输提示词、上传文件、生成内容、订单信息、设备信息或日志信息。',
      '第三方可能包括 AI 模型服务商、云服务器、对象存储、邮件服务、支付通道、内容安全和基础设施服务商。我们会尽合理努力要求第三方仅为约定目的处理数据，并采取必要安全措施。',
      '如相关处理涉及向中华人民共和国境外提供个人信息，我们将按照《个人信息保护法》等法律法规要求进行告知、取得必要同意或采取其他合法机制。'
    ],
  },
  {
    title: '4. 存储期限与空间管理',
    paragraphs: [
      '我们仅在实现本政策所述目的所需的最短期限内保存个人信息和用户内容，但法律法规、争议处理、审计、支付对账、安全风控或用户主动保存另有要求的除外。',
      '网页端生成历史、工作流、预览图、缩略图、PPT 导出和用户上传文件，会按照平台展示的保留期限、配额和清理策略保存。临时任务文件通常仅短期保存；导出文件和大体积文件可能有更短保留期。',
      '桌面端或本地功能产生的文件可能保存在用户设备本地。用户应自行维护本地文件备份、设备安全和访问权限。'
    ],
  },
  {
    title: '5. Cookie、令牌与本地存储',
    paragraphs: [
      '平台可能使用 Cookie、LocalStorage、SessionStorage 或类似技术保存登录令牌、语言偏好、记住邮箱、界面状态、功能开关和必要的安全信息。',
      '用户可通过浏览器设置管理 Cookie 或清除本地存储，但这可能导致登录状态失效、偏好丢失、页面状态重置或部分功能不可用。'
    ],
  },
  {
    title: '6. 信息安全措施',
    paragraphs: [
      '我们会采取访问控制、加密传输、密码哈希、权限隔离、日志审计、限流、异常检测、对象存储权限控制和必要的备份恢复措施，降低信息泄露、篡改、丢失、滥用和未授权访问风险。',
      '由于互联网环境并非绝对安全，如发生或可能发生个人信息安全事件，我们将按照法律法规要求采取补救措施，并在必要时通过站内通知、邮件或公告告知受影响用户。'
    ],
  },
  {
    title: '7. 用户权利',
    paragraphs: [
      '用户有权依法查询、复制、更正、补充、删除其个人信息，撤回同意，注销账号，获取隐私政策解释，并在符合法定条件时请求转移个人信息。',
      '用户可在平台功能入口自行管理部分资料、历史记录和存储空间，也可通过微信 wj040204520 或邮箱 2558212076@qq.com 提交权利请求。为保障账号安全，我们可能在处理请求前核验用户身份。',
      '用户删除内容或注销账号后，我们将停止为日常业务目的继续处理相关信息，并按照法律法规、争议处理、审计和安全要求进行删除或匿名化。'
    ],
  },
  {
    title: '8. 未成年人个人信息',
    paragraphs: [
      '未成年人使用本服务应取得监护人同意。对于未满十四周岁儿童的个人信息，我们将按照敏感个人信息和儿童个人信息保护要求进行更严格保护。',
      '如监护人发现未成年人未经同意使用平台或提交个人信息，可联系我们删除、限制或更正相关信息。'
    ],
  },
  {
    title: '9. 政策更新',
    paragraphs: [
      '我们可能因法律法规、产品功能、存储策略、第三方服务或运营方式变化而更新本政策。重大变更将通过页面提示、站内通知、邮件或其他合理方式告知用户。',
      '如用户不同意更新后的政策，应停止使用相关服务；继续登录、注册或使用服务，视为接受更新后的政策。'
    ],
  },
  {
    title: '10. 联系我们',
    paragraphs: [
      '如用户对本政策、个人信息处理、账号安全、内容删除、投诉举报或权利行使有疑问，可通过微信 wj040204520 或邮箱 2558212076@qq.com 联系我们。',
      '我们将在核验身份并确认请求合理后，在法律法规要求或合理期限内予以答复。'
    ],
  },
]

const aiSections: LegalSection[] = [
  {
    title: '1. 适用范围',
    paragraphs: [
      '本声明适用于灵感提供的文生图、图片编辑、提示词反推、海报设计、科研绘图、PPT 创作、自由画布、图片编辑工作流及其他包含人工智能生成、分析或辅助决策能力的功能。',
      '本声明是《服务条款》的组成部分。使用相关功能前，请同时阅读《服务条款》《隐私政策》以及具体功能页面展示的规则和限制。',
    ],
  },
  {
    title: '2. 生成内容的不确定性',
    paragraphs: [
      '人工智能依据概率模型生成或分析内容，输出可能存在事实错误、逻辑缺失、偏见、遗漏、重复、画面瑕疵、与提示词不一致或与既有内容偶然相似等情况。平台不保证输出绝对准确、完整、唯一、持续可用或适合任何特定目的。',
      '同一输入在不同时间、模型版本、参数、服务商或运行环境下可能得到不同结果。预览图、缩略图和压缩展示仅用于界面查看，正式使用前应核对原始成果及实际导出规格。',
    ],
  },
  {
    title: '3. 用户审查与重要场景限制',
    paragraphs: [
      '用户是生成内容的最终选择者和使用者。在发布、传播、商用、印刷、交付或基于输出作出决定前，应对真实性、准确性、适当性、权利状态、安全性和合规性进行独立审查，并根据需要由具备资质的专业人员复核。',
      '未经充分人工复核，不应将生成内容直接用于医疗诊断、法律意见、金融投资、公共安全、招聘录用、教育评价、科研结论、工程施工或其他可能对人身、财产和重大权益产生显著影响的场景。科研绘图和数据表达功能不替代真实实验、原始数据和学术规范审查。',
    ],
  },
  {
    title: '4. 权利、授权与内容责任',
    paragraphs: [
      '用户应确保提示词、参考图、人物肖像、商标、字体、作品、数据、论文、PPT 和其他输入材料具有合法来源及必要授权，不得要求平台仿冒他人身份、侵犯知识产权、个人信息权益、商业秘密或其他合法权益。',
      '人工智能输出能否取得著作权或用于商业用途，可能因内容、人类创作投入、所选模型规则、使用地区法律和第三方权利而不同。平台不承诺输出当然归属于用户、当然可以注册权利或当然不侵犯第三方权益。',
      '用户对其选择、编辑、发布、传播和商业使用生成内容的行为承担相应责任。收到权利人通知、主管部门要求或发现明显风险时，平台可限制生成、屏蔽、删除、保全记录或采取其他必要措施。',
    ],
  },
  {
    title: '5. 第三方模型与服务可用性',
    paragraphs: [
      '部分能力可能由第三方模型、云计算、对象存储或其他基础服务提供。第三方可能调整模型能力、内容政策、速率、价格或可用区域，平台也可能据此调整可选模型、参数、排队方式和功能范围。',
      '因网络波动、服务商限流、系统维护、安全审核、不可抗力或其他合理原因，任务可能排队、中断、失败或延迟。平台将依照页面规则处理任务状态和相关计费，但不保证服务永久无中断。',
    ],
  },
  {
    title: '6. 内容标识与禁止用途',
    paragraphs: [
      '用户应遵守适用的人工智能生成内容标识要求，不得删除依法必须保留的标识，不得将生成内容冒充为真实新闻、证据、官方文件或未经处理的真实影像，不得用于欺诈、操纵舆论、骚扰、歧视、违法营销或其他违法违规活动。',
      '平台可依据法律法规、监管要求、模型服务商政策和内容安全规则更新审核标准。对高风险输入或输出，平台有权拒绝处理或要求用户补充说明。',
    ],
  },
  {
    title: '7. 责任边界与反馈',
    paragraphs: [
      '在法律允许范围内，平台不对用户因未进行必要审查、超出功能说明使用、依赖错误输出或侵犯第三方权益而产生的损失承担责任；法律法规规定平台应承担责任的，从其规定。',
      '如发现明显错误、疑似侵权、违法内容、安全问题或不当输出，请通过微信 wj040204520 或邮箱 2558212076@qq.com 提交任务信息和必要证据，平台将按照适用规则处理。',
    ],
  },
]

const paymentSections: LegalSection[] = [
  {
    title: '1. 适用范围与商品信息',
    paragraphs: [
      '本规则适用于灵感平台的按量积分、限时会员或订阅卡、付费增值能力及相关订单。商品名称、价格、额度、有效期、适用模型、并发限制、每日或周期配额，以用户付款前的订单确认页和当时有效的商品说明为准。',
      '按量积分与会员额度属于不同的计费来源。按量积分通常按账户余额持续使用；会员额度受对应卡片的生效时间、有效期和使用规则限制，不与按量积分混同。',
    ],
  },
  {
    title: '2. 购买、支付与开通',
    paragraphs: [
      '用户提交订单前应核对账号、商品、金额、支付方式、有效期和自动续费状态。平台仅通过订单页面明确展示的支付方式收款，不会要求用户向个人账户转账或提供支付密码、短信验证码。',
      '支付结果以支付机构通知和平台订单状态校验为准。因回调延迟导致页面暂未更新时，请勿连续重复支付；可先查询订单记录，仍未到账时再通过平台公示渠道反馈。',
      '购买多张同类限时卡时，卡片是否立即生效或按购买顺序等待启用，以订单确认页展示为准。处于等待启用状态的卡片不提前消耗有效期。',
    ],
  },
  {
    title: '3. 计费来源选择与扣减',
    paragraphs: [
      '使用平台计费时，用户可在产品支持的范围内选择按量积分或某张有效会员卡作为消耗来源。一次任务仅应由一个选定来源结算；切换仅影响切换后提交的任务，不追溯改变已完成或已进入结算流程的任务。',
      '实际扣减以任务提交时展示的计费规则、模型、参数、生成数量和任务结果为依据。任务失败、取消、重试、退款或补偿的处理，以系统记录及页面规则为准。若发现重复扣减或记录异常，用户可凭任务编号和订单记录申请核查。',
      '会员卡额度用尽、过期、暂停或不适用于当前模型时，系统应提示用户切换其他可用来源；未经页面明确提示和用户选择，不应擅自把会员额度与按量积分合并展示为同一余额。',
    ],
  },
  {
    title: '4. 积分和会员权益性质',
    paragraphs: [
      '积分和会员额度仅用于兑换平台约定的数字化服务，不是法定货币、存款或理财产品，不产生利息，原则上不得转让、提现、交易或用于平台外结算。赠送额度、活动权益和补偿额度可另设使用范围及有效期。',
      '会员名称、专属标识、优先队列或优惠仅代表对应服务权益，不构成对生成成功率、商业收益、永久可用性或无限资源的保证。“不限量”等表述如在具体活动中出现，仍受合理使用、安全审核、并发、速率和适用模型范围限制。',
    ],
  },
  {
    title: '5. 退款、撤销与异常订单',
    paragraphs: [
      '数字化服务具有即时交付和按次消耗特点。除法律法规另有规定、商品页另有承诺、重复支付、未到账或平台责任导致服务无法交付外，已生效并实际消耗的积分、会员额度和已完成的模型任务通常不支持无理由退款。',
      '退款申请需由账户本人通过平台公示渠道提交订单号、支付凭证和原因。平台核验后，退款将原则上按原支付路径退回；支付机构处理时间不由平台单方控制。发生退款时，对应未使用权益可被撤销。',
      '对于盗刷、欺诈、异常支付、恶意退款、利用系统漏洞获取权益等情形，平台可暂停发放或使用相关权益、保全记录并依法处理，但不影响用户依法申诉。',
    ],
  },
  {
    title: '6. 价格与规则调整',
    paragraphs: [
      '平台可因模型成本、产品能力、运营策略或法律要求调整未来商品价格和计费规则。调整通常不追溯影响已经完成的订单；如会实质影响已购未使用权益，平台将通过页面通知、站内消息或其他合理方式说明处理方案。',
      '优惠券、限时折扣、赠送额度和活动规则以活动页面为准，不同优惠能否叠加以结算页面实际展示为准。',
    ],
  },
  {
    title: '7. 对账、凭证与争议处理',
    paragraphs: [
      '用户可通过订单记录、积分流水、会员卡明细或任务记录核对购买和消耗情况。对扣费有异议时，应尽快提供账号、任务编号、订单号、发生时间和问题截图，以便核查。',
      '如当前购买页面未展示发票入口，即表示暂未提供在线开票能力。订单或扣费疑问可通过微信 wj040204520 或邮箱 2558212076@qq.com 提交订单号和任务编号核查。',
    ],
  },
]

export const legalDocumentMeta: Record<LegalDocumentType, LegalDocumentMeta> = {
  terms: {
    title: '用户服务协议',
    shortTitle: '用户协议',
    subtitle: '登录、注册和使用 Linggan 前请仔细阅读',
    version: LEGAL_VERSION,
    updatedAt: '2026年8月13日',
    effectiveAt: '2026年8月13日',
    status: 'effective',
    path: '/terms',
    icon: 'contract',
  },
  privacy: {
    title: '隐私政策',
    shortTitle: '隐私政策',
    subtitle: '说明我们如何收集、使用、存储、共享和保护信息',
    version: LEGAL_VERSION,
    updatedAt: '2026年8月13日',
    effectiveAt: '2026年8月13日',
    status: 'effective',
    path: '/privacy',
    icon: 'shield_lock',
  },
  ai: {
    title: 'AI 服务与生成内容免责声明',
    shortTitle: 'AI 免责声明',
    subtitle: '了解生成式人工智能的能力边界、使用责任和高风险场景限制',
    version: LEGAL_VERSION,
    updatedAt: '2026年8月13日',
    effectiveAt: '2026年8月13日',
    status: 'effective',
    path: '/ai-disclaimer',
    icon: 'neurology',
  },
  payment: {
    title: '付费服务与退款规则',
    shortTitle: '付费与退款',
    subtitle: '说明按量积分、会员卡、订单、扣减、退款和异常处理规则',
    version: LEGAL_VERSION,
    updatedAt: '2026年8月13日',
    effectiveAt: '2026年8月13日',
    status: 'effective',
    path: '/payment-terms',
    icon: 'payments',
  },
}

export const legalDocumentTypes = Object.freeze(Object.keys(legalDocumentMeta) as LegalDocumentType[])

export const legalDocumentStatusLabel: Record<LegalDocumentStatus, string> = {
  effective: '现行有效',
}

const legalDocumentSections: Record<LegalDocumentType, LegalSection[]> = {
  terms: termsSections,
  privacy: privacySections,
  ai: aiSections,
  payment: paymentSections,
}

export function legalDocumentMarkdown(type: LegalDocumentType): string {
  const meta = legalDocumentMeta[type]
  return [
    `# ${meta.title}`,
    ...legalDocumentSections[type].flatMap(section => [
      '',
      `## ${section.title}`,
      ...section.paragraphs.map(paragraph => `\n${paragraph}`),
    ]),
  ].join('\n').trim()
}

async function legalContentHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content.replace(/\r\n?/g, '\n'))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Compatibility snapshot used only while an older API has no legal-document route. */
export async function bundledLegalDocument(type: LegalDocumentType): Promise<LegalDocumentSnapshot> {
  const meta = legalDocumentMeta[type]
  const contentMarkdown = legalDocumentMarkdown(type)
  return {
    documentType: type,
    version: meta.version,
    title: meta.title,
    summary: meta.subtitle,
    contentHash: await legalContentHash(contentMarkdown),
    publishedOn: '2026-08-13',
    effectiveOn: '2026-08-13',
    requiresReacceptance: true,
    requiredAtLogin: type === 'terms' || type === 'privacy',
    contentMarkdown,
  }
}

export function LegalDocument({
  type,
  document,
  isDark = false,
  compact = false,
}: {
  type: LegalDocumentType
  document?: LegalDocumentSnapshot
  isDark?: boolean
  compact?: boolean
}) {
  const fallbackMeta = legalDocumentMeta[type]
  const sections = document ? parseLegalMarkdown(document.contentMarkdown) : legalDocumentSections[type]
  const meta = document ? {
    ...fallbackMeta,
    title: document.title,
    subtitle: document.summary,
    version: document.version,
    updatedAt: formatLegalDate(document.publishedOn),
    effectiveAt: formatLegalDate(document.effectiveOn),
  } : fallbackMeta
  const titleColor = 'var(--app-text)'
  const bodyColor = 'var(--app-muted)'
  const mutedColor = 'var(--app-muted)'

  return (
    <article className={compact ? 'space-y-5' : 'space-y-8'}>
      <header className={compact ? 'space-y-1' : 'space-y-2'}>
        <h1
          className={compact ? 'text-xl font-bold' : 'text-2xl font-bold'}
          style={{ color: titleColor, fontFamily: 'Space Grotesk, sans-serif' }}
        >
          {meta.title}
        </h1>
        <p className="text-sm" style={{ color: mutedColor }}>{meta.subtitle}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: mutedColor }}>
          <span>版本：{meta.version}</span>
          <span>更新：{meta.updatedAt}</span>
          <span>生效：{meta.effectiveAt}</span>
          <span style={{ color: isDark ? '#e4e4e7' : 'var(--app-primary)' }}>{legalDocumentStatusLabel[meta.status]}</span>
        </div>
      </header>

      <div className={compact ? 'space-y-5' : 'space-y-7'}>
        {sections.map(section => (
          <section key={section.title} className="space-y-2">
            {section.title && (
              <h2 className={compact ? 'text-base font-semibold' : 'text-lg font-semibold'} style={{ color: titleColor }}>
                {section.title}
              </h2>
            )}
            <div className="space-y-2 text-sm leading-7" style={{ color: bodyColor }}>
              {section.paragraphs.map(paragraph => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </article>
  )
}
