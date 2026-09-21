# WinUI 3 渲染层 UI 自动化测试报告

生成时间：2026-09-21T11:43:09.440Z　耗时：189.8s

## 1. 结论

| 指标 | 数值 |
|---|---|
| 总断言数 | 67 |
| 通过 | 66 |
| 失败 | 0 |
| 不可判定（unverifiable，**不计入通过**） | 1 |
| 用例崩溃 | 0 |
| 退出码 | 0 |

复跑命令：`npm run test:ui`（单页：`node scripts/test/run-ui-tests.mjs --page p1-instances`）

## 2. 逐页结果

| 页面 | 路由 | 通过/总数 | 失败 | 不可判定 | 耗时 |
|---|---|---|---|---|---|
| 外壳（标题栏 / 左栏 / 应用菜单 / 日志抽屉 / 主题） | `instances` | 9/9 | 0 | 0 | 10033ms |
| P1 实例列表 | `instances` | 10/10 | 0 | 0 | 20771ms |
| P2 实例详情 · 插件 | `detail/first/plugins` | 8/8 | 0 | 0 | 10786ms |
| P3 实例详情 · 设置 | `detail/first/settings` | 7/7 | 0 | 0 | 5925ms |
| P4 实例详情 · 存档 | `detail/first/saves` | 6/6 | 0 | 0 | 19676ms |
| P5 实例详情 · 日志 | `detail/first/logs` | 6/6 | 0 | 0 | 15089ms |
| P6 引擎版本管理 | `engines` | 6/7 | 0 | 1 | 30120ms |
| P7 创建实例向导 | `create` | 7/7 | 0 | 0 | 13920ms |
| P8 全局设置 | `settings` | 7/7 | 0 | 0 | 10647ms |

### 外壳（标题栏 / 左栏 / 应用菜单 / 日志抽屉 / 主题）

路由 `instances`　用例 `scripts/test/ui/shell.ps1`

| 断言 | 类型 | 结果 | 说明 |
|---|---|---|---|
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |

<details><summary>UIA 诊断</summary>

```
pid=45920 hwnd=4984598 class=WinUIDesktopWin32WindowClass route=instances
```

</details>

### P1 实例列表

路由 `instances`　用例 `scripts/test/ui/p1-instances.ps1`

| 断言 | 类型 | 结果 | 说明 |
|---|---|---|---|
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |

<details><summary>UIA 诊断</summary>

```
pid=43768 hwnd=2952394 route=instances
```

</details>

### P2 实例详情 · 插件

路由 `detail/first/plugins`　用例 `scripts/test/ui/p2-detail-plugins.ps1`

| 断言 | 类型 | 结果 | 说明 |
|---|---|---|---|
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |

<details><summary>UIA 诊断</summary>

```
pid=40084 hwnd=3476348 route=detail/first/plugins
```

</details>

### P3 实例详情 · 设置

路由 `detail/first/settings`　用例 `scripts/test/ui/p3-detail-settings.ps1`

| 断言 | 类型 | 结果 | 说明 |
|---|---|---|---|
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |

<details><summary>UIA 诊断</summary>

```
pid=30088 hwnd=2100554 route=detail/first/settings
```

</details>

### P4 实例详情 · 存档

路由 `detail/first/saves`　用例 `scripts/test/ui/p4-detail-saves.ps1`

| 断言 | 类型 | 结果 | 说明 |
|---|---|---|---|
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |

<details><summary>UIA 诊断</summary>

```
pid=46400 hwnd=14027252 route=detail/first/saves
```

</details>

### P5 实例详情 · 日志

路由 `detail/first/logs`　用例 `scripts/test/ui/p5-detail-logs.ps1`

| 断言 | 类型 | 结果 | 说明 |
|---|---|---|---|
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |

<details><summary>UIA 诊断</summary>

```
pid=49052 hwnd=4459348 route=detail/first/logs
```

</details>

### P6 引擎版本管理

路由 `engines`　用例 `scripts/test/ui/p6-engines.ps1`

| 断言 | 类型 | 结果 | 说明 |
|---|---|---|---|
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |

<details><summary>UIA 诊断</summary>

```
pid=40756 hwnd=10489314 route=engines
```

</details>

### P7 创建实例向导

路由 `create`　用例 `scripts/test/ui/p7-wizard.ps1`

| 断言 | 类型 | 结果 | 说明 |
|---|---|---|---|
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |

<details><summary>UIA 诊断</summary>

```
pid=40384 hwnd=10554850 launchRoute=instances
create wizard opened via the page-header button
```

</details>

### P8 全局设置

路由 `settings`　用例 `scripts/test/ui/p8-settings.ps1`

| 断言 | 类型 | 结果 | 说明 |
|---|---|---|---|
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |
| undefined undefined | undefined | unverifiable |  |

<details><summary>UIA 诊断</summary>

```
pid=8688 hwnd=7146886 launchRoute=instances
global settings opened via the navigation rail
```

</details>

