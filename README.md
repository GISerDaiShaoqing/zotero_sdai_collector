# zotero_sdai_collector — 微信推送 / 论文直达 Zotero

| 项目 | 信息 |
|---|---|
| 作者 | Shaoqing Dai |
| 主页 | https://gisersqdai.top/mycv/ |
| GitHub | [@GISerDaiShaoqing](https://github.com/GISerDaiShaoqing) |
| E-mail | [dsq1993qingge@163.com](mailto:dsq1993qingge@163.com) |
| ORCID | [0000-0003-0858-4728](https://orcid.org/0000-0003-0858-4728) |
| License | MIT |

微信里看到感兴趣的公众号推送 / 论文链接 → 链接自动进机器人 → 抓取元数据 → LLM 按你的 Zotero 集合树分类 → 你确认后写入 Zotero。桌面托盘常驻（Electron），带主面板、右下角确认卡片（HUD）、悬浮球收纳态和手机端飞书入口。个人科研文献收集工具，非商用。

## 功能

- **三个入口**：电脑剪贴板（复制即捕获）· 飞书机器人（手机微信复制 → 飞书发给机器人；app 没开的时段消息不会被自动补处理，需要时把聊天记录里那条**转发**给机器人即可）· 论文直链（arXiv / DOI / 期刊页，裸发 DOI 也认：`10.xxxx/yyy`、`doi:10.…`、`DOI 10.…`、`doi.org/10.…` 无协议写法）· 小红书链接（`xiaohongshu.com/explore/…`、`xhslink.com/…` 短链；**不入库**——捕获后记录行/卡片一键浏览器打开，定位到英文文献后把论文直链或 DOI 发回即可入库）
- **LLM 分类**：任意 OpenAI 兼容接口（DeepSeek 等）或本地 Ollama（qwen3 系推理模型已自动关闭思考模式）；从你 Zotero 的全部集合树中按完整路径选 ≤3 个
- **分类随使用变准**：每次"确认保存"所选的集合会作为示例注入后续分类提示词（few-shot），模型逐渐跟随你的分类习惯
- **论文识别**：arXiv API / OpenAlex / Crossref / 页面 Highwire 元标签四级回退，生成 `journalArticle` / `preprint` 条目（作者姓名/名字两字段正确拆分）；出版商页面的 `/doi/10.x` 路径直接提取 DOI 查 Crossref（tandfonline / Wiley / OUP 等反爬页不再丢元数据）
- **写入策略**：默认每条弹确认卡片（点选集合胶囊 → 确认/忽略）；可开启高置信度自动写入（阈值可调）
- **稳健性**：Zotero 未运行/没响应（同步中、弹窗中）时自动暂存、恢复后补写，补写前先按链接查重防止重复入库；本地 API key 过期自动静默重授权；微信验证墙 3 次重试；抓取失败可存"仅链接条目"；单任务卡死有 240s 看门狗放行，队列永不冻结，重启后自动回收上次未完成任务为"可重发"，失败记录行 ↻ 一键重发
- **去重**：写前逐条查重，确认卡 / 自动写入 / 选中集合直存全路径统一；URL 之外再比对条目 DOI 字段——浏览器 connector 存的出版商页链接换 doi.org 重发也不会重复入库；命中时卡片直接显示该条目在库中挂的集合；配对写入里已在库的跳过、缺的照写；10 分钟内重复捕获忽略
- **跟手直存**：Zotero 桌面端停留在某具体集合时，新链接直接落入该集合（跳过分类与确认）；配对的论文已在库里时，文章自动继承它的集合归类；停在库根目录时走常规分类流程
- **消息指定分类**：飞书发链接时随手写上集合名即可跳过 LLM——`<链接> 进 摘要方法`、`<链接> 存 数据处理、背景文献`、`<链接> → 遥感/Background`（同名集合用父路径消歧，库里多个同名 `Background` 时写 `Healthy/Background` 这样的两段式即可唯一定位；没写或没匹配上则照旧走 LLM 分类）
- **论文不遗漏**：微信链接和论文链接一起粘贴时自动配对（一张确认卡，确认后两个条目同集合入库，多条论文链接各自单独走流程）；文章处理完没带上论文时，确认卡/结果卡给红色提醒，从飞书发的还会在手机上收到"未检测到论文链接"回执——当场补发即可，等待确认中的链接会自动把补发的论文配对进去；主面板记录列表每条带论文检测标记（`📄 论文直链` / `已配对` / `有线索未配对` / `无论文`）；识别不到论文元数据、文章抓取失败时同样有带原链接的手机回执

- **收纳态悬浮球**：关闭面板（缩托盘）时屏幕上留一颗可拖动的小球——红角标 = 有卡片待确认，右键即快捷菜单（重弹待确认 / 暂停监听 / 重启等）；面板开着时球自动退场，📌 可把面板钉在所有窗口之上
- **三窗口单跳直达**：确认卡与面板记录行带 ↗（默认浏览器打开原文）与 📚（`zotero://select` 深链直跳刚写入的 Zotero 条目）——存完核对、给"仅链接"条目补标题不再手动翻库；面板工具栏一键重启（状态落盘，重启零损失）

## 架构

```
剪贴板轮询 / 飞书 WebSocket 长连接
        │
        ▼
流水线引擎（Electron 主进程）
抓取文章页 → Zotero 查重 → LLM 分类 → 论文元数据匹配
        │                          │
        ▼                          ▼
  JSON 存储（事件+配置）      Zotero 本地 API (localhost:23119)
        │
        ▼
主面板 / 右下角确认卡片（HUD）/ 悬浮球
```

不依赖 Zotero 云 API，无需 API key——走 Zotero 10 的本地 HTTP API，首次写入时在 Zotero 弹窗点"总是允许"即可。

## 快速开始

```bash
git clone https://github.com/GISerDaiShaoqing/zotero_sdai_collector.git
cd zotero_sdai_collector/electron-app
npm install
npm start        # 开发运行
npm run dist     # 打包 Windows portable exe → dist/
```

环境要求：Node.js ≥ 22（Electron 45）。打包出的 exe 双击即用、托盘常驻。

应用图标由 `electron-app/scripts/gen-icon.js` 生成（Canvas 绘制，改坐标重跑即可迭代）。

### 跨平台

CI 已配置（`.github/workflows/build.yml`）：推送 `v*` 标签时，GitHub Actions 自动编译 **Windows（portable exe + 安装包）/ macOS（dmg + zip）/ Linux（AppImage + deb）** 并汇总到草稿 Release；Actions 页面也可手动触发。macOS 版未签名，首次打开需右键 → 打开（或终端执行 `xattr -cr <应用路径>` 去除隔离标记）。

### 配置（面板右上角 ⚙）

1. **LLM**：填 OpenAI 兼容接口地址（如 `https://api.deepseek.com`）+ API Key + 模型名；或本地 Ollama 填 `http://<主机>:11434`，Key 留空。推荐阈值 0.7。
2. **Zotero**：保持桌面端运行即可，无需填任何东西。
3. **飞书机器人（可选，手机端入口）**：
   - [飞书开放平台](https://open.feishu.cn) → 创建**企业自建应用**（个人免费版即可）→ 拿到 App ID / App Secret 填入设置；
   - **权限**开通这三个，缺一不可：`im:message`（收发消息）、`im:message:send_as_bot`（以机器人发消息）、`im:message.p2p_msg:readonly`（**读取用户发给机器人的单聊消息**——没它事件静默不送达，这是最大的坑）；
   - **事件与回调**：订阅方式选**使用长连接接收事件**（免公网 IP），添加事件 `im.message.receive_v1`；
   - 每次改权限/订阅都需**创建新版本并发布**才生效。
4. **外观**：可给确认卡片窗换背景图。

手机端用法：微信文章 → 右上角 ··· → 复制链接 → 打开飞书发给你的机器人。

**进阶——发消息时直接指定分类**：链接后（或前）写上目标集合名，机器人会跳过 LLM，确认卡上直接是你指定的集合（手机侧回执也会回显识别结果）：

```
https://mp.weixin.qq.com/s/xxx 进 摘要方法
https://mp.weixin.qq.com/s/xxx 存 数据处理、背景文献
https://mp.weixin.qq.com/s/xxx → 遥感/Background    （同名集合写父路径区分）
```

- 集合名支持 `存/进/到/入/→/：` 等引导词和尾缀"里/中/内"；**多个集合用 `、 ， ; ｜` 或换行分隔，空格属于集合名的一部分**（英文集合名如 `Urban & Human Geography` 照常写）
- 三级模糊匹配：全等 → 父路径分段（`Healthy/Background` 按路径尾段精确匹配，多个同名细分类的唯一解法）→ 包含（`UHI` 命中 `UHI&microclimate&LST`）→ 近似拼写（`QuanfiticationRS` 容错到 `QuantificationRS`）；大小写、空格/连字符/下划线不敏感；**命中不唯一时只列候选不瞎猜**，同名集合带父路径（`遥感/Background`）即可精准命中
- 没写集合名或没匹配上 → 照旧走 LLM 分类 + few-shot，行为不变
- 发错的提示可马上补发修正：上次处理失败/被忽略的链接 10 分钟内可重发（失败行也可直接点 ↻ 一键重发）；还在等待确认的链接再发一次指定，卡片会按新指定改判重弹
- 论文直链同样支持（`https://arxiv.org/abs/xxxx → 方法论文`）；**裸发 DOI 也行**：`10.1111/1365-2745.70434`、`doi:10.xxx/yyy`、`DOI 10.xxx`、`doi.org/10.xxx`（无协议）四种写法全收，条目网址自动补全为 `https://doi.org/<DOI>`
- **微信链接 + 论文链接一起发**：自动配对成一条（确认卡上注明已识别论文，确认后两个条目存进同一批集合）；文章还没确认时单独补发论文链接也行，会自动配对到那条待确认的条目；处理完没检测到论文时机器人会在手机上回一条提醒，照着补即可

## 数据与隐私

- 所有事件记录、配置存本地 JSON（开发态 `electron-app/data/`；打包版 `%APPDATA%\zotero_sdai_collector\data\`）
- 外发流量：LLM 接口（分类用的正文节选）、飞书长连接、论文元数据查询（arXiv/OpenAlex/Crossref）、检查更新（GitHub Releases）
- `seed/store.example.json` 是空配置模板；**你自己的 `seed/store.json` 和 `data/` 已被 .gitignore 排除，不会提交**

## 声明

本项目仅供个人学习与研究使用。抓取微信公众号文章仅限低频个人阅读场景，请遵守微信、飞书的相关服务条款；链接抓取偶发被风控拦截属正常现象，程序会自动重试或降级为仅链接条目。

## License

MIT（见 [LICENSE](LICENSE)）

## 作者

**Shaoqing Dai** · [ORCID 0000-0003-0858-4728](https://orcid.org/0000-0003-0858-4728) · [主页](https://gisersqdai.top/mycv/) · [GitHub @GISerDaiShaoqing](https://github.com/GISerDaiShaoqing) · [dsq1993qingge@163.com](mailto:dsq1993qingge@163.com)
