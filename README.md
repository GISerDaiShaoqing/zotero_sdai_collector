# zotero_sdai_collector — 微信推送 / 论文直达 Zotero

微信里看到感兴趣的公众号推送 / 论文链接 → 链接自动进机器人 → 抓取元数据 → LLM 按你的 Zotero 集合树分类 → 你确认后写入 Zotero。桌面托盘常驻（Electron），带主面板、右下角卡片通知（HUD）和手机端飞书入口。个人科研文献收集工具，非商用。

## 功能

- **三个入口**：电脑剪贴板（复制即捕获）· 飞书机器人（手机微信复制 → 飞书发给机器人，电脑离线时消息留存、上线补处理）· 论文直链（arXiv / DOI / 期刊页）
- **LLM 分类**：任意 OpenAI 兼容接口（DeepSeek 等）或本地 Ollama（qwen3 系推理模型已自动关闭思考模式）；从你 Zotero 的全部集合树中按完整路径选 ≤3 个
- **分类随使用变准**：每次"确认保存"所选的集合会作为示例注入后续分类提示词（few-shot），模型逐渐跟随你的分类习惯
- **论文识别**：arXiv API / OpenAlex / Crossref / 页面 Highwire 元标签四级回退，生成 `journalArticle` / `preprint` 条目（作者姓名/名字两字段正确拆分）
- **写入策略**：默认每条弹确认卡片（点选集合胶囊 → 确认/忽略）；可开启高置信度自动写入（阈值可调）
- **稳健性**：Zotero 未运行时自动暂存、恢复后补写；本地 API key 过期自动静默重授权；微信验证墙 3 次重试；抓取失败可存"仅链接条目"
- **去重**：Zotero 已有同链接条目自动跳过；10 分钟内重复捕获忽略
- **跟手直存**：Zotero 桌面端停留在某具体集合时，新链接直接落入该集合（跳过分类与确认）；停在库根目录时走常规分类流程

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
主面板 / 右下角确认卡片（HUD）
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

## 数据与隐私

- 所有事件记录、配置存本地 JSON（开发态 `electron-app/data/`；打包版 `%APPDATA%\zotero_sdai_collector\data\`）
- 外发流量仅两处：LLM 接口（分类用的正文节选）、飞书长连接；论文元数据查询发往 arXiv/OpenAlex/Crossref
- `seed/store.example.json` 是空配置模板；**你自己的 `seed/store.json` 和 `data/` 已被 .gitignore 排除，不会提交**

## 声明

本项目仅供个人学习与研究使用。抓取微信公众号文章仅限低频个人阅读场景，请遵守微信、飞书的相关服务条款；链接抓取偶发被风控拦截属正常现象，程序会自动重试或降级为仅链接条目。

## License

MIT（见 [LICENSE](LICENSE)）
