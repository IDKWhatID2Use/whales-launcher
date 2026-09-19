# PCL2（Plain Craft Launcher 2）架构与设计思路调研

> 调研对象：Minecraft 启动器 PCL2（Plain Craft Launcher 2，作者「龙腾猫跃」）
> 相关仓库：`Hex-Dragon/PCL2`（上游）、`PCL-Community/PCL-CE`（社区版）、`Meloong-Git/PCL`（承接更新日志与 issue 的 PCL 仓库）
> 调研目标：**实例隔离**与**整合包/版本管理**的实现方式，并抽象出可迁移到 dsh 启动器的设计原则
> 本文只做设计层面的总结，**不包含任何 PCL2 源码片段**

---

## 0. 调研方法与证据强度说明（务必先读）

### 0.1 环境限制（本机出口受限，已实测）

- 本机 DNS 被本地代理软件劫持为 **fake-ip 模式**：`github.com`、`raw.githubusercontent.com`、`deepwiki.com`、`zhihu.com`、`mcmod.cn`、`cloud.tencent.cn` 等**所有被测域名**均解析到 `198.18.0.0/15` 保留段（实测 `example.com → 198.18.0.155`、`github.com → 198.18.0.14`、`modrinth.com → 198.18.0.162`）。
- 因此 `web_fetch` 对上述域名一律返回 `resolves to a non-public IP address`；主机侧直接用 `Invoke-WebRequest` / `curl.exe` 也被沙箱阻断 TLS（`schannel: SEC_E_NO_CREDENTIALS`）。
- **唯一打通的通道是「公网 IP 直连」**：`http://116.62.65.40/blog/2/67f9a7c8f209ab1306c4eab9` 抓取成功（该站为单站点部署，不校验 Host）。另可用 `https://8.8.8.8/resolve?name=<域名>&type=A` 做真实 DNS 解析，但解析出的 CDN IP（Cloudflare / 腾讯云 EO / 火山引擎）因 Host/SNI 不匹配均无法直连。

### 0.2 本次证据的主要形态

- **主力手段为 `web_search`，共执行 36 轮不同 query**（覆盖版本隔离、整合包、存档、Mod、启动、UI、下载引擎、社区版等方向）。
- 检索工具返回的是**来源标题列表（含少量标题内嵌的正文片段）**，不是网页正文。因此本报告的证据绝大多数是**标题级证据**。
- 全文只有 1 处正文级证据（上述 IP 直连博客），已单独标注。

### 0.3 证据等级标注约定

| 标注 | 含义 |
|---|---|
| `[已确认: URL]` | 该来源的**标题或已抓取正文**直接陈述了此结论 |
| `[推断]` | 由多条来源交叉合理推断，**无直接陈述** |
| `[未确认]` | 未获取到可靠信息，或不满足上述条件 |

### 0.4 关于任务假设中的若干标识符（重要声明）

任务描述中列举了 `PCL/Setup.ini`、`Setup 加载模块`、`PageInstanceLeft` / `PageVersion`、`ModpackInstall` / `ModpackExport`、`ModModify` / `ModLocalComp`、`LoaderDownload` / `DLlib`、`.disabled` 禁用等具体标识符与机制。
**本次检索未能验证其中任何一个的存在**（详见第 8 节）。因此它们**不会**作为结论写入本报告；凡本章程节未标注 `[已确认]` 的机制描述，均视为待验证假设，**不得**在后续实现中当作事实依据。

---

## 1. 版本目录与实例隔离机制

### 1.1 PCL2 中「版本」是什么

- **一个「版本」= 游戏根目录下 `versions/<目录名>/` 这个目录**，其身份由目录内的**同名 json（版本清单）**与**同名 jar（客户端）**共同确定。
- 把版本目录改名后，PCL2 版本列表会提示「**未找到版本 json 文件**」，说明 PCL2 是按「目录内存在同名 json」来识别与加载版本的 —— 即**目录名 = 版本 ID**。[已确认: https://github.com/Meloong-Git/PCL/issues/3939]
- 版本列表由扫描 `versions/` 目录得到，并存在独立的版本管理子系统。[已确认: https://deepwiki.com/Hex-Dragon/PCL2/3.1-version-management]（章节名 "Version Management"）；扫描逻辑本身为 [推断]
- 出现过「版本 Json 文件全部消失」的严重 bug 报告，间接说明 json 清单是版本可用性的唯一判据。[已确认: https://github.com/Meloong-Git/PCL/issues/6911]
- PCL2 支持从版本 **jar 内部的 `version.json`** 读取版本号信息（相关 issue 标题）。[已确认: https://github.com/Meloong-Git/PCL/issues/3294]

### 1.2 目录结构（玩家可见部分）

依据唯一抓取成功的正文来源与标准 Minecraft 目录约定：

```text
<游戏根目录>/
├── .minecraft/
│   ├── versions/<版本名>/<版本名>.json      # 版本清单
│   ├── versions/<版本名>/<版本名>.jar       # 客户端
│   ├── saves/          ← 未隔离时的存档
│   ├── screenshots/    ← 截图
│   ├── mods/ config/ resourcepacks/ ...     # 未隔离时的共享资源目录
└── PCL/
    ├── jdk-21                 # PCL 自带的 Java
    └── LatestLaunch.bat       # 最近一次启动的命令行（可绕过 PCL2.exe 直接启动）
```

- `.minecraft` 下的 `versions` 装版本、`saves` 装存档、`screenshots` 装截图；`PCL` 文件夹内是 `jdk-21`（Java）与 `LatestLaunch.bat`。[已确认: http://116.62.65.40/blog/2/67f9a7c8f209ab1306c4eab9 —— **正文级证据**]
- `mods` / `config` / `resourcepacks` 等标准目录的存在属于 Minecraft 通用事实，非 PCL2 特有。[推断]

### 1.3 隔离开关本身

- PCL2 确实提供「**版本隔离**」设置项，且存在面向用户的操作教程。[已确认: https://soft.3dmgame.com/gl/1929.html ／ https://www.php.cn/faq/1219971.html]
- **隔离设置有两个层级：全局设置层 与 单版本设置层，且二者会互相冲突** —— 有一个专门的 bug 报告标题即为「[BUG] 新安装核心的版本隔离设置与全局设置冲突」。[已确认: https://github.com/Meloong-Git/PCL/issues/5970]
- 版本隔离的行为在版本迭代中被反复调整：
  - Snapshot 2.9.2 的更新项包含「**版本隔离优化**」。[已确认: https://afdian.com/p/be1c733e040511f097e15254001e7c00 ／ https://github.com/Meloong-Git/PCL/discussions/5880]
  - 从 **Snapshot 2.10.3** 起出现「**自动开启版本隔离**」的行为变化（有用户以 issue 形式反馈）。[已确认: https://github.com/Meloong-Git/PCL/issues/6590]

### 1.4 隔离控制哪些子目录（核心问题）

**能确认的：**

- **开启版本隔离后，该版本的存档落在 `versions/<版本名>/saves/` 内**，而不是根目录的 `.minecraft/saves/`。
  [已确认: http://116.62.65.40/blog/2/67f9a7c8f209ab1306c4eab9 —— 原文：「开了版本隔离的话，每个隔离存档的版本的存档都会存在版本文件夹中的 `saves` 文件夹中」，**正文级证据**]
- 隔离确实会作用于 **Mod、资源包、光影** 这几类资源 —— 由跨启动器症状反向确认：BakaXL 官方 FAQ 设有专门条目「**我使用 BakaXL 启动其他启动器所安装的游戏版本，但 Mod、资源包、光影未加载 / 存档消失了**」，这正是「资源被搬进版本目录、只认根目录的启动器找不到」的典型表现。[已确认: https://help.bakaxl.com/en/v3/faq.html ／ https://github.com/BakaXL-Support/BakaXL-Document/...]
- 同源症状在 PCL2 自身 issue 中也有体现：「用 pcl2 自动安装的 Fabric 无法加载模组，但游戏正常运行」。[已确认: https://github.com/Meloong-Git/PCL/issues/3646]

**无法确认的：**

- **一份权威的「隔离目录白名单」**（究竟隔离 mods / config / resourcepacks / shaderpacks / saves 中的哪几项、是否隔离 options.txt、servers.dat 等）—— **未获取到可靠信息**。
  依据上述症状可合理推断至少包含 `mods`、`resourcepacks`（含光影）、`saves`。[推断]
- `config` 目录是否随之隔离：**未获取到可靠信息**。[未确认]
- 一份**权威的隔离目录清单**是否存在官方说明：**未获取到可靠信息**。[未确认]

### 1.5 默认值

- **出厂默认是开还是关，无法从检索证据中判定**：2.10.3 之前与之后行为不同（后者「自动开启」），且用户可分别在全局层和版本层覆盖。[已确认: #6590] + [推断]
- 结论：**「版本隔离的默认值」应标记为 [未确认]**，若要参考实现需自行实测。

### 1.6 隔离如何影响 mods / saves / config（汇总）

| 目录 | 未隔离 | 已隔离 | 证据等级 |
|---|---|---|---|
| `saves` | `.minecraft/saves/`（全版本共用） | `versions/<版本>/saves/` | 已确认（正文级） |
| `mods` | `.minecraft/mods/` | `versions/<版本>/mods/` | 推断（由跨启动器症状） |
| `resourcepacks` / 光影 | `.minecraft/` 下 | `versions/<版本>/` 下 | 推断（由跨启动器症状） |
| `config` | `.minecraft/config/` | 是否隔离未知 | 未确认 |
| `<版本>.json` / `.jar` | 恒定在 `versions/<版本>/` | 同左（不受隔离影响） | 推断 |

---

## 2. 整合包管理

### 2.1 导出（相对较新的能力）

- **导出整合包是 2.9.0 快照版新增的功能**：作者爱发电发布页标题为「快照版 2.9.0 | 现已支持……**导出整合包**！」。[已确认: https://ifdian.net/p/469258a2ec9911efa64d52540025c377]
- PCL2 内置了「**整合包导出指南**」（该指南在 2.9.0 期间存在错误，有 issue 反馈）。[已确认: https://github.com/Meloong-Git/PCL/issues/5686]
- 存在独立的导出子系统。[已确认: https://deepwiki.com/Hex-Dragon/PCL2/5.3-modpack-export]（章节 "Modpack Export"）

### 2.2 导入

- **支持 Modrinth 格式整合包**：有 issue 反馈「Modrinth 整合包使用 zip 后缀」导致的问题，说明 PCL2 会处理 Modrinth 整合包并对其扩展名敏感。[已确认: https://github.com/Meloong-Git/PCL/issues/6122]
- **默认是「新建独立目录」式导入**：社区提出功能请求「导入整合包时支持**合并安装到现有目录**」，说明当时不具备合并能力。[已确认: https://github.com/Meloong-Git/PCL/issues/5901] → 默认行为为新建独立版本目录。[推断]
- 导入流程在正式版中持续优化：「【PCL 正式版更新】Mod 下载、整合包导入优化」「【PCL 更新】整合包导入优化、下载时按加载器分类 Mod」。[已确认: https://www.bilibili.com/read/mobile?id=40085022 ／ https://www.bilibili.com/opus/997125663347441685]
- 存在独立的安装子系统。[已确认: https://deepwiki.com/Hex-Dragon/PCL2/5.2-modpack-installation ／ https://deepwiki.com/Hex-Dragon/PCL2/4.2-installation-process]

### 2.3 清单文件格式、依赖与覆盖处理

- **未获取到可靠信息** [未确认]：
  - PCL2 自己**导出**时所写清单的文件名与字段结构；
  - 是否支持 **CurseForge `manifest.json`**（本次只找到 Modrinth 的相关证据，**不能**断言支持 CurseForge 格式）；
  - 覆盖文件（overrides）的合并策略、同名文件冲突提示策略；
  - 依赖（前置 Mod）在导入时是否自动解析下载。
- 间接旁证：下载界面存在「**前置 mod**」选项（有 issue 报告该选项消失），说明「前置/依赖」是产品内的显式概念。[已确认: https://github.com/Meloong-Git/PCL/issues/5395]

---

## 3. 存档共享机制

### 3.1 存档落在哪

- **非隔离**：存档在游戏根目录 `.minecraft/saves/`（PCL2 的「存档」即此目录）。[已确认: http://116.62.65.40/blog/2/67f9a7c8f209ab1306c4eab9（正文中列明 `saves` 文件夹装的是存档）]
- **已隔离**：存档在 `versions/<版本名>/saves/`。[已确认: 同上，正文级证据]

### 3.2 玩家如何跨实例共享存档

- **PCL2 是否提供内置的「存档互通 / 存档共享」开关：未获取到可靠信息。** [未确认] 我尝试了「存档互通」「版本隔离 存档 共享」等多组 query，只得到模板化的第三方教程页面，无任何一手陈述。
- 由机制可推断的可行做法（**均为 [推断]，非 PCL2 官方功能确认**）：
  1. 关闭该版本的版本隔离 → 存档回到共用的 `.minecraft/saves/`；
  2. 手动把 `versions/<版本>/saves/` 拷回根目录，或用目录联接（junction）/符号链接把一个 `saves` 指到共享位置 —— **PCL2 是否识别或支持这种链接，未确认**。
- 玩家侧最常报告的痛点正是隔离造成的「存档消失」。[已确认: https://help.bakaxl.com/en/v3/faq.html]

### 3.3 结论

「存档共享」在 PCL2 中更像是一个**用户可选的目录布局副作用**（隔离关＝共享，隔离开＝独立），而非一个独立的一等公民功能。[推断]

---

## 4. Mod 管理

### 4.1 扫描与识别

- 当前 mods 目录**不递归扫描子文件夹**：社区提出功能请求「Mod 管理支持版本 mods 目录下**子文件夹递归识别**与分类分组管理」，说明现状是平铺扫描。[已确认: https://github.com/Meloong-Git/PCL/issues/8843] → 平铺扫描为 [推断]
- Mod 列表是**按「当前选中版本」异步加载**的，在完全加载前切换到另一版本会串味（「可能会获取到错误的更新信息」）。[已确认: https://github.com/Meloong-Git/PCL/issues/6604]
- PCL2 会从 mods 内容判断版本所属的 **Mod 加载器**，且会误判（「单次启动时，误判版本拥有所有 Mod 加载器」）。[已确认: https://github.com/Meloong-Git/PCL/issues/9020]

### 4.2 更新

- 存在 Mod 更新检查/更新功能，历史上出现过错误（「在快照 PCL 版本中的 Mod 更新错误」）。[已确认: https://github.com/Meloong-Git/PCL/issues/5104]
- 社区版中仍有误判：PCL-CE「**Quilt 版本中的 Fabric 模组会被更新为 NeoForge 版本**」。[已确认: https://github.com/PCL-Community/PCL-CE/issues/296]
  → 说明「当前加载器 → 目标加载器」的映射判断是这类功能的高频出错点。[推断]

### 4.3 依赖与冲突

- **前置（依赖）是显式概念**：下载页有「前置 mod」选项。[已确认: https://github.com/Meloong-Git/PCL/issues/5395]
- 缺前置会导致崩溃，且崩溃窗口会出现「**NO FILE INFO**」（元数据解析不到）。[已确认: https://github.com/Meloong-Git/PCL/issues/5915]
- 冲突/重复安装处理不完善：游戏已启动时安装同名模组会让 PCL2 崩溃（用户期望是弹窗提示）。[已确认: https://github.com/Meloong-Git/PCL/issues/7840]
- 下载界面会**按加载器分类**展示 Mod。[已确认: https://www.bilibili.com/opus/997125663347441685]

### 4.4 启用 / 禁用

- **PCL2 如何实现「禁用某个 Mod」—— 未获取到可靠信息。** [未确认]
  我专门搜索了「PCL2 禁用 mod 重命名 disabled 后缀」等 query，只得到第三方泛泛教程（如「我的世界整合包安装后如何启用/禁用某个模组？」），其中**没有任何一条能证明 PCL2 使用 `.disabled` 后缀**。任务描述中提到的 `.disabled` 机制**不予采信**。
- 可确认的只有：「批量/分类管理」是社区正在诉求的能力（见 §4.1 的递归识别与分组请求）。[已确认: #8843]

---

## 5. 启动流程

### 5.1 已确认的片段

- **启动命令会落盘**：PCL 文件夹中的 `LatestLaunch.bat` 保存了「**最近一次启动的版本的源代码**」——即完整启动命令行；直接运行它可以绕过 `Plain Craft Launcher 2.exe` 启动上一次的版本。[已确认: http://116.62.65.40/blog/2/67f9a7c8f209ab1306c4eab9 —— **正文级证据**]
  → 设计含义：PCL2 在启动前会**把最终命令行物化成一个可独立执行的脚本**。[推断]
- 存在独立的**启动子系统**与**崩溃分析子系统**，二者在架构文档中是并列章节：
  - Launch System [已确认: https://deepwiki.com/Hex-Dragon/PCL2/3.2-launch-system]
  - Crash Analysis [已确认: https://deepwiki.com/Hex-Dragon/PCL2/3.4-crash-analysis]
- 启动配置是 UI 上的一等模块（Launch Configuration UI）。[已确认: https://deepwiki.com/Hex-Dragon/PCL2/6.1-launch-configuration-ui]
- 内存/参数配置会失败并报错（「无法分配内存大小」）。[已确认: https://github.com/Meloong-Git/PCL/issues/3434]
- JVM 参数可自定义（社区讨论「pcl2 jvm 参数头该如何设置才能设置更高内存」）。[已确认: https://bbs.mcmod.cn/forum.php?mod=viewthread&tid=21033]
- 2.9.2 起支持「**独显运行 MC**」（为 Java 进程指定独立显卡）。[已确认: https://afdian.com/p/be1c733e040511f097e15254001e7c00]

### 5.2 推断的调用链（**整体为 [推断]，未经源码验证**）

```text
[点击「启动」]
   │
   ├─1. 版本解析（Version Management）
   │     扫描 versions/ → 选中版本 → 读取 <版本>.json
   │     → 处理 inheritsFrom 继承链 → 合并父版本清单
   │
   ├─2. 文件补全（Installation Process / Component Management）
   │     校验 libraries / assets / natives / 客户端 jar
   │     缺失则进入下载子系统（Download System）补齐
   │
   ├─3. 设置合并（Configuration System）
   │     全局设置 ⊕ 版本设置（版本隔离 / 内存 / Java / JVM 参数 / 独显）
   │     → 冲突消解（此处正是 §1.3 那类 bug 的高发区）
   │
   ├─4. 参数拼接 + 进程启动（Launch System）
   │     组装 JVM 参数 + 游戏参数 + 账户信息
   │     → 落盘 PCL/LatestLaunch.bat  → 以子进程方式启动 Java
   │
   └─5. 日志与崩溃捕获（Logger / Crash Analysis）
        捕获 stdout/stderr 与游戏日志 → 退出码/异常模式识别
        → 崩溃窗口展示分析结论（依赖 Mod 元数据，解析失败则显示 NO FILE INFO）
```

- 其中「步骤 1–3 的存在」由 DeepWiki 的章节划分支撑 [已确认: 各章节 URL]；**步骤内部的具体顺序与实现方式均为 [推断]**。
- 第 4 步「落盘 `.bat` 再启动」中的**落盘**部分有正文级证据，**执行方式**为 [推断]。
- 崩溃窗口会尝试读取 Mod 元数据用于归因（由 "NO FILE INFO" 反推）。[推断，依据 https://github.com/Meloong-Git/PCL/issues/5915]

### 5.3 未获取到可靠信息 [未确认]

- 版本 `inheritsFrom` 继承链的具体合并规则；
- 资源（assets）索引与库（libraries）的校验算法；
- 账户（微软正版 / 离线）在启动流程中的注入方式；
- 日志文件的确切路径与轮转策略。

---

## 6. UI 与交互设计

### 6.1 技术栈

- PCL2 是 **.NET 桌面客户端**：存在第三方源码分析文章《从 PCL2 源码看 **.NET 桌面客户端**的模块化架构与异步下载引擎设计》。[已确认: https://cloud.tencent.cn/developer/article/2681906]
- 是否为 **WPF/XAML**：该文章出现在腾讯云开发者社区的 `wpf` 标签下，**倾向于是**，但未取得直接陈述。[推断]
- 架构被评价为「**模块化架构 + 异步下载引擎**」。[已确认: 同上一 URL（标题级）]

### 6.2 界面模块化（可确认的部分）

架构文档把 UI 拆成独立章节，本身就是「UI 组件化」的证据：

| 章节 | 含义 |
|---|---|
| User Interface Components | UI 组件总览 [已确认: https://deepwiki.com/Hex-Dragon/PCL2/6-user-interface-components] |
| Launch Configuration UI | 启动配置界面 [已确认: https://deepwiki.com/Hex-Dragon/PCL2/6.1-launch-configuration-ui] |
| Installation UI | 安装/下载界面 [已确认: https://deepwiki.com/Hex-Dragon/PCL2/6.2-installation-ui] |
| Custom UI Controls | 自定义控件层 [已确认: https://deepwiki.com/Hex-Dragon/PCL2/6.3-custom-ui-controls] |

→ [推断] PCL2 在原生控件之上自建了一层**自定义控件库**，并把「启动配置」与「安装」做成独立页面模块。

### 6.3 主页与主题的开放性（PCL2 最有特色的设计之一）

- **主页可以被第三方整体替换**：存在第三方项目「PCL2 炽翎主页 Next」。[已确认: https://mfn233.github.io/PCL-Mainpage-ChiLing/]
- **主页卡片有公开的 API 文档**（含 `latest-card` 等接口），说明主页的卡片是**由数据驱动的、契约化的模块**。[已确认: https://github.com/Light-Beacon/PCL2-NewsHomepage-API-Documents]
- **主题可切换**：存在第三方主题切换器项目。[已确认: https://github.com/PCL-Community/PCL2-Theme-Switcher]
- 界面持续做「减法」：2.9.2 更新包含「**下载界面精简**」。[已确认: https://afdian.com/p/be1c733e040511f097e15254001e7c00]

### 6.4 设置页组织方式

- 明确的**两层结构**：**全局设置** 与 **版本（实例）设置**。两者都包含「版本隔离」等同名项，并因此产生过冲突 bug。[已确认: https://github.com/Meloong-Git/PCL/issues/5970]
- 设置项至少覆盖：版本隔离、内存分配、Java 路径、JVM 参数、下载源、下载线程数、独显运行。[已确认: 分别见 #5970 / #3434 / 116 博客(jdk-21) / bbs.mcmod.cn / #4820 / #7034 / afdian 2.9.2]
- 设置页的完整分类清单（如「启动/界面/Java/下载/高级」）：**未获取到可靠信息**。

### 6.5 未获取到可靠信息 [未确认]

- 主界面的具体布局（导航栏位置、实例列表形态）；
- **实例卡片的字段构成**（图标、加载器标签、上次游玩时间等）与右键菜单项；
- 首次启动向导的具体步骤；
- 崩溃报告界面的具体呈现（仅知它会做归因，并可能显示 `NO FILE INFO`）。

---

## 7. 对 dsh 启动器的可迁移设计思路

以下为**与 Minecraft 无关的抽象原则**。标 `[推断]` 的条目是我从 PCL2 行为反推出的设计意图，属于「值得借鉴的思路」，不代表 PCL2 一定如此实现。

### 原则 1：实例 = 自包含目录 + 指向共享资源的指针

PCL2 的「版本目录」把 `<清单>.json + <本体>.jar + 该实例私有资源` 收进一个文件夹，而共享资源（Java 运行时、下载缓存、账号）留在外层。
**迁移**：dsh 中应把「一个可执行单元」定义为**一个自包含目录**，目录内放该单元的全部私有状态；跨单元共享的东西（运行时、凭据、缓存）一律上提到工作区级。
[依据: 116 博客正文 §1.1/§1.2 —— 已确认]

### 原则 2：隔离是一个「可覆盖的策略开关」，而不是硬编码

隔离与否是**配置**（全局默认 + 实例级覆盖），而不是代码分支写死。PCL2 甚至因此付出过「两层设置冲突」的代价。
**迁移**：把「资源寻址策略」建模成 `Resolve(instance, resourceKind) -> Path`，由策略对象决定落在实例目录还是共享根；策略本身是配置，可全局设默认、可实例级覆盖。**同时必须明确覆盖优先级**，否则会重演 PCL2 那类冲突 bug。
[依据: #5970（两层冲突）、#6590（默认值变更）—— 已确认]

### 原则 3：目录名即身份，元数据文件与目录同名

PCL2 用「目录名 == 清单名」来定位实例，改名即失效并明确报错。
**迁移**：实例目录名 = 实例 ID；目录内固定放一个同名清单文件作为唯一真源。这样实例可以被 `mv` 搬运而不破坏引用，扫描成本也最低。**代价**：必须提供「改名」原子操作（同时改目录与清单），并保证扫描器对不一致状态给出**明确可诊断的错误**而非静默跳过。
[依据: #3939 —— 已确认]

### 原则 4：导入 = 声明式清单 + 落盘策略

导入整合包本质是「读一个声明 → 物化成实例」。PCL2 的默认策略是**新建独立实例**，社区随后要求「合并到现有目录」。
**迁移**：导入器应把「**清单解析**」与「**落盘策略**」解耦。策略至少两种：`CreateNew`（默认，安全）与 `MergeIntoExisting`（高级，需冲突预检与干跑 diff）。把默认设为 `CreateNew` 是安全的，但**要预留 Merge 的接口**，否则后期补会牵动整个导入链路。
[依据: #5901、#6122 —— 已确认]

### 原则 5：导出 = 实例目录到归档的「显式白名单映射」

导出的难点不是打包，而是**决定哪些文件属于「可分发内容」**（构建产物 vs 用户私有数据，如存档、日志、凭据）。
**迁移**：为每个实例维护一份**显式的内容分类表**（可分发 / 私有 / 可再生），导出时按表投影。PCL2 因为「导出指南」写错而产生 issue，说明**导出规则必须同时以文档和代码两种形式存在且保持同步**。
[依据: #5686 —— 已确认]

### 原则 6：把「最近一次成功的启动命令」物化到磁盘

`LatestLaunch.bat` 是一个极低成本、极高收益的设计：用户绕开 GUI 就能复现上次启动；出问题时也能直接看到**最终命令行**。
**迁移**：每次启动后，把**解析出的最终命令行**（环境变量 + 参数 + 工作目录）写入一个人类可读的文件（`.bat` / `.sh` / `.json`）。这同时是：调试入口、问题复现手段、以及参数拼装逻辑的「黄金测试快照」。
[依据: 116 博客正文 —— 已确认，**本次调研中最值得借鉴的单点设计**]

### 原则 7：崩溃分析作为独立子系统，而非启动流程的尾巴

PCL2 把 Crash Analysis 做成与 Launch System 并列的模块，且会结合**扩展（Mod）元数据**做归因（元数据解析失败时退化为 `NO FILE INFO`）。
**迁移**：日志捕获 → 结构化归因 → 面向用户的建议，应独立成层。归因失败时**要有一个明确的降级展示**（"无法解析扩展元数据"），而不是空白或静默。
[依据: DeepWiki 3.4 章节、#5915 —— 已确认]

### 原则 8：安装/下载是一个「可调度 + 可切源 + 可限并发」的独立层

PCL2 的下载并发是**用户可配置**的，并因此暴露了「线程过多导致网络堵塞 / 服务器 503 / 系统缓冲区不足」等真实故障；下载源也可切换。
**迁移**：把下载器抽成独立子系统，暴露 `并发数 / 源 / 重试 / 校验` 四个旋钮，并对并发上限设**保护性默认值**（用户能调到 64 并发就一定会有人调）。
[依据: #7034、#7100、#7007、#4820，zread.ai 的 `13-download-scheduler` 章节 —— 已确认]

### 原则 9：UI 组件化 + 可替换的主页 + 卡片数据契约

PCL2 的主页可被第三方整体替换、卡片有公开 API 文档、主题可切换。
**迁移**：把「主页」定位成一个**消费稳定数据契约的独立视图**，而不是嵌在壳里的硬编码页面；主题做成 token 层。这样第三方能扩展，官方也能随时换掉主页而不动内核。
[依据: PCL-Mainpage-ChiLing、PCL2-NewsHomepage-API-Documents、PCL2-Theme-Switcher —— 已确认]

### 原则 10：异步列表要绑定「版本代次」，防止切换竞态

PCL2 有「Mod 列表未加载完就切版本 → 拿到错误更新信息」的真实缺陷。
**迁移**：任何「按当前选中实例异步加载列表」的 UI，都必须给请求打上**实例 ID + 代次序号**，回调时校验代次，过期结果直接丢弃。
[依据: #6604 —— 已确认]

---

## 8. 未获取到可靠信息的清单

以下项目**没有**取得可靠证据，**每一项均应视为 `[未确认]`**，**请勿据此实现**：

| # | 事项 | 尝试过的 query（节选） |
|---|---|---|
| 1 | 版本隔离的**隔离目录白名单**（哪些子目录被隔离） | `PCL2 版本隔离 隔离哪些文件夹 mods saves config resourcepacks 说明`；`PCL2 版本隔离 隔离 mods config resourcepacks shaderpacks 列表`；`PCL2 关闭版本隔离 mods 目录 回到 .minecraft 根目录` |
| 2 | 版本隔离的**出厂默认值** | `PCL2 版本隔离 默认 自动开启 2.10.3`；`PCL2 版本隔离 默认开启 还是 关闭 隔离选项` |
| 3 | PCL2 **内置的「存档共享 / 存档互通」机制** | `PCL2 存档互通 版本隔离 关闭 后 saves`；`PCL2 多个版本 共用 同一个 存档 方法 版本隔离 关闭`；`PCL2 世界存档 共享 版本隔离 关闭 方法` |
| 4 | **Mod 启用/禁用的实现**（是否用 `.disabled` 后缀重命名） | `PCL2 禁用 mod 重命名 disabled 后缀 方法`；`PCL2 mod 禁用 .disabled 重命名 实现方式`；`PCL2 关闭 mod 不删除 文件 操作` |
| 5 | **整合包清单文件格式**（字段名、文件名）与 **CurseForge `manifest.json` 支持** | `PCL2 整合包 mrpack manifest.json 格式 支持`；`PCL2 整合包 导出 文件 结构 包含 什么`；`PCL2 整合包 导入 过程 分析 版本 json 覆盖` |
| 6 | **`PCL/Setup.ini`** 是否存在、其字段含义 | `PCL2 Setup.ini 配置文件 位置 说明`；`PCL2 配置文件 PCL文件夹 ini 文件 说明`；`PCL2 Setup.ini 配置 内容 版本隔离 项` |
| 7 | **启动调用链的具体实现**（继承合并、资源校验、参数拼装顺序） | `PCL2 启动 游戏 步骤 版本解析 补全 参数 拼接 流程`；`PCL2 启动 命令 参数 拼接 内存 Java 参数 分析` |
| 8 | **日志文件的路径与轮转策略** | `PCL2 日志文件 位置 PCL 文件夹 Log`；`PCL2 崩溃 日志 PCL 文件夹 Log 分析 错误处理` |
| 9 | **设置页的完整分类**、主界面布局、**实例卡片字段与右键菜单** | `PCL2 设置页 分类 启动 界面 Java 下载 高级`；`PCL2 主页 版本卡片 右键菜单 选项 功能`；`PCL2 工具箱 功能 页面 介绍` |
| 10 | 任务假设中的标识符：`PageInstanceLeft`、`PageVersion`、`ModpackInstall`、`ModpackExport`、`ModModify`、`ModLocalComp`、`ModLoader`/`DLlib`、`LoaderDownload`、`Setup 加载模块` | 上述多轮 query 均**未命中任何一手的源码级或文档级来源**。这些名字**未经验证**，本报告不予采用 |
| 11 | `Meloong-Git/PCL` 与上游 `Hex-Dragon/PCL2` 的**确切关系**（镜像 / fork / 官方开发分支） | `PCL2 是否开源 源码 公开 Hex-Dragon 仓库`；`Meloong-Git PCL 分支 PCL2 开源 反编译` |
| 12 | PCL2 是否**开源**（本次找到的第三方分析文章标题含「从 PCL2 源码看」，暗示源码可获取，但未确认许可与仓库位置） | 同上 |

### 8.1 关于检索能力本身的限制说明

本次 36 轮 `web_search` 中，**没有任何一轮返回过可读的正文摘要**，只返回来源标题列表。这是本报告证据强度普遍停留在「标题级」的根本原因。若能解除网络出口限制（或允许 `web_fetch` 绕过 fake-ip DNS），以下来源**应当优先补读**：

1. `https://deepwiki.com/Hex-Dragon/PCL2/*` —— 架构章节（Version Management / Launch System / Download System / Mod and Modpack Management / Configuration System / UI Components）
2. `https://zread.ai/PCL-Community/PCL-CE/*` —— PCL-CE 源码的逐章分析（已确认存在 `13-download-scheduler` 章节）
3. `https://github.com/Meloong-Git/PCL/discussions/5880`（2.9.2 更新日志）、`/discussions/6226`（2.10.0）、`/discussions/8875`（2.13.0.0）、`/discussions/4820`（下载源）
4. `https://cloud.tencent.cn/developer/article/2681906` —— 《从 PCL2 源码看 .NET 桌面客户端的模块化架构与异步下载引擎设计》
5. `https://afdian.com/p/be1c733e040511f097e15254001e7c00`（2.9.2）、`https://ifdian.net/p/469258a2ec9911efa64d52540025c377`（2.9.0 导出整合包）

---

## 9. 核心结论速览

1. **PCL2 的「版本」就是一个目录**：`versions/<名>/` 内的同名 json 是其身份，改名即失效并明确报错。
2. **版本隔离的核心效果是「资源寻址根」的下移**：隔离开启后，该版本的 `saves`（已确认）以及 `mods`/资源包/光影（由跨启动器症状推断）从游戏根目录移到 `versions/<版本>/` 内。
3. **隔离是配置而非硬编码**，且有「全局设置 + 版本设置」两层，两层冲突是 PCL2 历史上的真实 bug 区。
4. **整合包导出是 2.9.0 才补齐的能力**；导入默认新建独立实例，支持 Modrinth 格式（CurseForge 支持未能证实）。
5. **Mod 管理是「按选中实例异步加载」的列表**，其竞态、加载器误判、依赖元数据解析失败（`NO FILE INFO`）是该模块的主要缺陷模式。
6. **启动流程最有价值的设计是 `LatestLaunch.bat`**：把最终命令行物化落盘，使「上次启动」可被独立复现与调试。
7. **架构上把「启动」「崩溃分析」「下载」「安装」「版本管理」「配置」「UI 控件」拆成并列子系统**，并由 DeepWiki / zread.ai 的章节结构侧面印证。
8. **UI 层最值得借鉴的是开放性**：可替换主页 + 卡片数据契约 + 可切换主题，说明主页被设计成消费稳定契约的独立视图，而非内嵌页面。

---

## 参考来源

> 说明：以下 URL 均来自本次 `web_search` 实际返回的来源列表（唯一的正文级来源已特别标注）。

### 正文级（成功抓取）
- [pcl2 内置文件夹教程（PCL/ 与 .minecraft/ 目录说明，含「开启版本隔离后存档位于版本文件夹内的 saves」原文）](http://116.62.65.40/blog/2/67f9a7c8f209ab1306c4eab9)

### 架构与代码分析
- [System Architecture | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/1.1-system-architecture)
- [Version Management | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/3.1-version-management)
- [Launch System | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/3.2-launch-system)
- [Crash Analysis | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/3.4-crash-analysis)
- [Download System | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/4.1-download-system)
- [Installation Process | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/4.2-installation-process)
- [Component Management | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/4.3-component-management)
- [Mod and Modpack Management | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/5-mod-and-modpack-management)
- [Mod Management | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/5.1-mod-management)
- [Modpack Installation | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/5.2-modpack-installation)
- [Modpack Export | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/5.3-modpack-export)
- [Configuration System | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/2.3-configuration-system)
- [User Interface Components | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/6-user-interface-components)
- [Launch Configuration UI | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/6.1-launch-configuration-ui)
- [Installation UI | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/6.2-installation-ui)
- [Custom UI Controls | Hex-Dragon/PCL2 | DeepWiki](https://deepwiki.com/Hex-Dragon/PCL2/6.3-custom-ui-controls)
- [下载调度器（PCL-CE 源码逐章分析）| zread.ai](https://zread.ai/PCL-Community/PCL-CE/13-download-scheduler)
- [从 PCL2 源码看 .NET 桌面客户端的模块化架构与异步下载引擎设计](https://cloud.tencent.cn/developer/article/2681906)

### 版本隔离 / 设置
- [[BUG] 新安装核心的版本隔离设置与全局设置冲突 · Issue #5970](https://github.com/Meloong-Git/PCL/issues/5970)
- [更新至 Snapshot 2.10.3 版本后自动开启版本隔离 · Issue #6590](https://github.com/Meloong-Git/PCL/issues/6590)
- [目录下更改版本名称后 PCL2 版本列表提示「未找到版本 json 文件」· Issue #3939](https://github.com/Meloong-Git/PCL/issues/3939)
- [不知道为什么没有删除任何文件的情况下版本 Json 文件全部消失 · Issue #6911](https://github.com/Meloong-Git/PCL/issues/6911)
- [支持从版本 jar 的 version.json 中读取版本号信息 · Issue #3294](https://github.com/Meloong-Git/PCL/issues/3294)
- [我的世界 PCL2 启动器怎么设置版本隔离 - 3DM 软件](https://soft.3dmgame.com/gl/1929.html)
- [我的世界 PCL2 启动器怎么设置版本隔离 - php.cn](https://www.php.cn/faq/1219971.html)
- [BakaXL 启动器常见问题解决方案文档（「使用其他启动器所安装的版本，Mod、资源包、光影未加载 / 存档消失」）](https://help.bakaxl.com/en/v3/faq.html)
- [用 pcl2 自动安装的 Fabric 无法加载模组，但游戏正常运行 · Issue #3646](https://github.com/Meloong-Git/PCL/issues/3646)

### 整合包
- [Modrinth 整合包使用 zip 后缀 · Issue #6122](https://github.com/Meloong-Git/PCL/issues/6122)
- [导入整合包时支持合并安装到现有目录 · Issue #5901](https://github.com/Meloong-Git/PCL/issues/5901)
- [2.9.0 整合包导出指南错误 · Issue #5686](https://github.com/Meloong-Git/PCL/issues/5686)
- [快照版 2.9.0 | 现已支持……导出整合包！丨爱发电](https://ifdian.net/p/469258a2ec9911efa64d52540025c377)
- [【PCL 正式版更新】Mod 下载、整合包导入优化（Bilibili）](https://www.bilibili.com/read/mobile?id=40085022)
- [【PCL 更新】整合包导入优化、下载时按加载器分类 Mod（Bilibili）](https://www.bilibili.com/opus/997125663347441685)

### Mod 管理
- [Mod 管理支持版本 mods 目录下子文件夹递归识别与分类分组管理 · Issue #8843](https://github.com/Meloong-Git/PCL/issues/8843)
- [完全加载 Mod 列表前切换到另一个版本刷新 Mod 列表，可能会获取到错误的更新信息 · Issue #6604](https://github.com/Meloong-Git/PCL/issues/6604)
- [在快照 PCL 版本中的 Mod 更新错误 · Issue #5104](https://github.com/Meloong-Git/PCL/issues/5104)
- [单次启动时，误判版本拥有所有 Mod 加载器 · Issue #9020](https://github.com/Meloong-Git/PCL/issues/9020)
- [pcl2 下载界面前置 mod 选项消失 · Issue #5395](https://github.com/Meloong-Git/PCL/issues/5395)
- [由于缺少前置而导致的崩溃窗口显示「NO FILE INFO」· Issue #5915](https://github.com/Meloong-Git/PCL/issues/5915)
- [游戏已启动时安装已存在同名模组导致 PCL2 崩溃 · Issue #7840](https://github.com/Meloong-Git/PCL/issues/7840)
- [Quilt 版本中的 Fabric 模组会被更新为 Neoforge 版本 · PCL-CE Issue #296](https://github.com/PCL-Community/PCL-CE/issues/296)

### 启动与下载
- [无法分配内存大小 · Issue #3434](https://github.com/Meloong-Git/PCL/issues/3434)
- [设置过多的下载线程可能导致网络堵塞 · Issue #7034](https://github.com/Meloong-Git/PCL/issues/7034)
- [64 线程下的网络卡顿、掉线问题，服务器返回 503 · Issue #7100](https://github.com/Meloong-Git/PCL/issues/7100)
- [无法下载游戏：系统缓冲区空间不足或队列已满 · Issue #7007](https://github.com/Meloong-Git/PCL/issues/7007)
- [关于 PCL2 到底用的是什么下载源 · Discussion #4820](https://github.com/Meloong-Git/PCL/discussions/4820)
- [pcl2 jvm 参数头该如何设置才能设置更高内存 - MC 百科社群](https://bbs.mcmod.cn/forum.php?mod=viewthread&tid=21033)

### 更新日志与版本
- [2.9.2 更新日志 · Discussion #5880](https://github.com/Meloong-Git/PCL/discussions/5880)
- [快照版 2.9.2 | 独显运行 MC、下载界面精简、版本隔离优化丨爱发电](https://afdian.com/p/be1c733e040511f097e15254001e7c00)
- [2.10.0 更新日志 · Discussion #6226](https://github.com/Meloong-Git/PCL/discussions/6226)
- [2.13.0.0 · Discussion #8875](https://github.com/Meloong-Git/PCL/discussions/8875)
- [Release 2.13.1.0 · Meloong-Git/PCL](https://github.com/Meloong-Git/PCL/releases/tag/2.13.1.0)
- [2.8.11 更新日志 · Discussion #5237](https://github.com/Meloong-Git/PCL/discussions/5237)

### UI / 主题 / 生态
- [PCL2 炽翎主页 Next（第三方自定义主页）](https://mfn233.github.io/PCL-Mainpage-ChiLing/)
- [PCL2-NewsHomepage-API-Documents（主页卡片 API 文档）](https://github.com/Light-Beacon/PCL2-NewsHomepage-API-Documents)
- [PCL-Community/PCL2-Theme-Switcher（主题切换器）](https://github.com/PCL-Community/PCL2-Theme-Switcher)
- [PCL-Community/PCL2-Language（社区语言文件仓库）](https://github.com/PCL-Community/PCL2-Language)
- [PCL-Community/PCL-CE（社区版仓库）](https://github.com/PCL-Community/PCL-CE)
- [PCL2 社区版介绍 · Discussion #5342](https://github.com/Hex-Dragon/PCL2/discussions/5342)
- [PCL Community Edition - Open Source Community SMC](https://oscsmc.baka.ac.cn/zht/launchers/pcl-community-edition)

---

*报告完。所有 `[已确认]` 标注均对应上述来源列表中的条目；正文级证据仅 1 条并已显式标明。凡属 `[推断]` / `[未确认]` 的内容，请在采纳前自行核实。*
