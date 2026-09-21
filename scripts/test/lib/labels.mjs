/**
 * 所有面向界面的中文字面量集中在这里。
 *
 * 为什么不让 .ps1 自己写中文：Windows PowerShell 5.1 按 ANSI 读 `.ps1`/`.psm1`，
 * 文件里任何一个非 ASCII 字节都会被错误解码（本项目已因此产生过 20+ 编译错误）。
 * 因此用例脚本一律纯 ASCII，中文只经由 runner 写出的 UTF-8 JSON context 文件进入。
 * 顺带的好处：界面文案一旦改动，只会有一个地方需要跟着改。
 */

export const LABELS = Object.freeze({
  /* ---------------- 外壳 ---------------- */
  shell: {
    windowTitle: 'WhalesLauncher',
    subtitleInstances: '实例',
    appMenuFile: '文件',
    appMenuEdit: '编辑',
    appMenuHelp: '帮助',
    logToggleName: '运行日志',
    themeButtonPrefix: '切换深浅色主题',
    themeDark: '深色',
    themeLight: '浅色',
    themeFollowSystem: '跟随系统',
    logDrawerCloseName: '关闭日志抽屉',
    logFollowName: '跟随最新日志',
    logCountAid: 'LogCountText',
    logSourceName: '日志来源',
    railItemTypeName: 'WhalesLauncher.Shell.RailEntry',
    railNewInstance: '新建实例',
    railEngines: '引擎版本管理',
    railSettings: '全局设置',
    cardItemTypeName: 'WhalesLauncher.Views.InstanceCard',
    /** 菜单展开后必然出现的应用菜单项（来自 app:menu），用于判断菜单真的打开了。 */
    appMenuExpected: ['打开启动器目录', '打开实例目录', '打开引擎目录'],
  },

  /* ---------------- P1 实例列表 ---------------- */
  p1: {
    searchName: '搜索实例',
    refreshName: '刷新实例列表',
    createName: '新建实例',
    /** x:Name of the card GridView -> exposed as AutomationId. */
    gridAid: 'InstanceGrid',
    /** AutomationProperties.Name of the same GridView. */
    gridName: '实例卡片列表',
    moreButton: '更多操作',
    detailButton: '查看实例详情',
    primaryButton: '启动',
    filterAll: '全部',
    filterRunning: '运行中',
    filterStopped: '已停止',
    filterAttention: '需处理',
    statusStoppedText: '已停止',
    statusRunningText: '运行中',
    emptyNoInstanceTitle: '还没有实例',
    /** Anchor button of the "no instance at all" empty state (a Button peer always exists). */
    emptyNoInstanceButton: '创建第一个实例',
    emptyNoMatchTitle: '没有匹配的实例',
    /** Anchor button of the "filtered to nothing" empty state. */
    emptyNoMatchButton: '清除筛选条件',
    emptyNoMatchHintPrefix: '没有实例匹配',
    moreMenuExpected: ['启动或停止实例', '在浏览器中打开界面', '打开实例文件夹', '查看实例详情', '编辑实例设置', '刷新该实例状态', '删除实例'],
  },

  /* ---------------- P2–P5 详情页公共 ---------------- */
  detail: {
    tabPlugins: '插件',
    tabSettings: '设置',
    tabSaves: '存档',
    tabLogs: '日志',
    tabs: ['插件', '设置', '存档', '日志'],
    backName: '返回实例列表',
    primaryActionName: '启动或停止实例',
    subtitlePrefix: '实例详情 · ',
  },

  /* ---------------- P2 插件 ---------------- */
  p2: {
    blockBundles: '内置组合包',
    blockLocal: '本地插件',
    blockDeps: '依赖',
    blocks: ['内置组合包', '本地插件', '依赖'],
    bundlesEmptyTitle: '没有组合包',
    localEmptyTitle: '还没有本地插件',
    depsEmptyTitle: '没有额外依赖',
    installButton: '安装本地插件',
  },

  /* ---------------- P3 设置 ---------------- */
  p3: {
    editorName: 'settings.yaml 内容',
    gutterAid: 'Gutter',
    editorAid: 'Editor',
    saveName: '保存 settings.yaml',
    reloadName: '放弃更改并重新载入',
    isolationTitle: '隔离策略',
    isolationRadios: {
      workspace: '工作区隔离策略',
      saves: '存档隔离策略',
      settings: '设置隔离策略',
      credentials: '凭证隔离策略',
    },
  },

  /* ---------------- P4 存档 ---------------- */
  p4: {
    listAid: 'SavesList',
    summaryAid: 'SummaryText',
    emptyAid: 'EmptyState',
    filteredEmptyAid: 'FilteredEmpty',
    emptyTitle: '还没有存档',
    emptyDesc: '存档在实例运行后产生',
    filteredEmptyTitle: '该工作区暂无存档',
    crumbAid: 'Crumb',
    workspaceFilterName: '按工作区筛选存档',
  },

  /* ---------------- P5 日志 ---------------- */
  p5: {
    logViewAid: 'Logs',
    followName: '跟随日志底部',
    countAid: 'CountText',
    truncateAid: 'TruncateText',
    keywordName: '日志关键字过滤',
    clearName: '清空当前显示的日志',
    copyName: '复制当前显示的全部日志',
    emptyAid: 'EmptyState',
    emptyTitle: '暂无日志',
  },

  /* ---------------- P6 引擎版本 ---------------- */
  p6: {
    installedTab: '已安装',
    availableTab: '可安装',
    installedListAid: 'InstalledList',
    availableListAid: 'AvailableList',
    installedEmptyAid: 'InstalledEmpty',
    availableEmptyAid: 'AvailableEmpty',
    installedEmptyTitle: '还没有安装任何引擎版本',
    availableEmptyTitle: '无法获取可用版本',
    installedFirstLoad: '正在读取已安装的引擎版本…',
    availableFirstLoad: '正在向 npm registry 查询可安装版本…',
    refreshName: '刷新可用版本',
    nodeBadgeAid: 'NodeBadge',
    nodeCaptionAid: 'NodeCaption',
  },

  /* ---------------- P7 创建向导 ---------------- */
  p7: {
    steps: ['1 名称与外观', '2 引擎版本', '3 profile 模板', '4 隔离策略'],
    nameBoxAid: 'NameBox',
    nameErrorAid: 'NameErrorText',
    dirPreviewAid: 'DirPreviewText',
    iconGridAid: 'IconGrid',
    colorGridAid: 'ColorGrid',
    createButton: '创建',
    backButton: '上一步',
    cancelButton: '取消',
    /** 非法名（含路径分隔符）——NameValidator 必须拦下。 */
    invalidName: 'bad/name',
    /** 另一个非法形态：纯点号。 */
    invalidName2: '..',
    validName: 'UI Wizard Probe',
  },

  /* ---------------- P8 全局设置 ---------------- */
  p8: {
    themeRadiosAid: 'ThemeRadios',
    themeDark: '深色',
    themeLight: '浅色',
    /** 必须出现在界面上的「不跟随系统」说明（视觉规范 §9.8 要求显式告知）。 */
    noFollowSystemPhrase: '不跟随系统',
    candidateListAid: 'CandidateList',
    candidateEmptyAid: 'CandidateEmptyText',
    redetectButton: '重新探测 Node',
    primaryHomeAid: 'PrimaryHomeBox',
    rootDirAid: 'RootDirBox',
    registryAid: 'RegistryBox',
    nodeConclusionAid: 'NodeConclusionText',
    versionAid: 'VersionText',
    confirmDeleteAid: 'ConfirmDeleteSwitch',
  },
});

/**
 * 每条断言的标题（页面 id -> 断言 id -> 中文标题）。
 * 单列出来是为了让报告可读，并且让 .ps1 里只剩判断逻辑。
 */
export const CHECKS = Object.freeze({
  shell: {
    'SH-01': '左栏实例项数量与后端实例数一致',
    'SH-02': '左栏固定入口（新建实例 / 引擎版本管理 / 全局设置）齐全',
    'SH-03': '应用菜单可展开并列出菜单项',
    'SH-04': '应用菜单可用 Escape 关闭',
    'SH-05': '日志抽屉可打开',
    'SH-06': '日志抽屉可再次关闭',
    'SH-07': '主题按钮可点击且标签在深色/浅色间变化',
    'SH-08': '标题栏副标题反映当前路由',
    'SH-09': '左栏实例筛选框可读写',
  },
  'p1-instances': {
    'P1-01': '卡片数量 == 后端实例数',
    'P1-02': '每张卡都有状态文字（不仅靠颜色）',
    'P1-03': '输入搜索词后卡片数量减少',
    'P1-04': '输入不存在的词出现"无匹配"空态',
    'P1-05': '"无匹配"空态与"无实例"空态文案不同',
    'P1-06': '卡片"更多"菜单可展开且含预期菜单项',
    'P1-07': '每张卡都有"查看实例详情"入口',
    'P1-08': '状态筛选 4 项存在且默认选中"全部"',
    'P1-09': '排序下拉存在',
    'P1-10': '点击刷新后卡片数量不变',
  },
  'p2-detail-plugins': {
    'P2-01': '深链进入时选中的是"插件"页签',
    'P2-02': '三个分区（内置组合包/本地插件/依赖）入口齐全',
    'P2-03': '页签栏共 4 项且文案正确',
    'P2-04': '切换到"设置"后内容真的变了',
    'P2-05': '深链 detail/first/saves 进入时选中的是"存档"（历史缺陷回归）',
    'P2-06': '页头返回按钮存在',
    'P2-07': '页头副标题与当前页签一致',
    'P2-08': '主操作按钮（启动/停止）存在',
  },
  'p3-detail-settings': {
    'P3-01': 'settings.yaml 编辑器存在',
    'P3-02': '编辑器行号列存在',
    'P3-03': '隔离策略四个维度可读',
    'P3-04': '隔离策略每个维度的说明文字非空',
    'P3-05': '保存按钮存在（初始未修改状态可判定）',
    'P3-06': '选中页签为"设置"',
    'P3-07': '设置视图显示 settings.yaml 的路径标签',
  },
  'p4-detail-saves': {
    'P4-01': '存档列表或明确空态二者必居其一',
    'P4-02': '空态/列表与后端会话数一致（fixture 无会话 → 空态）',
    'P4-03': '空态标题文案非空且符合预期',
    'P4-04': '选中页签为"存档"',
    'P4-05': '页头副标题含"存档"',
    'P4-06': '存档汇总文案可读',
  },
  'p5-detail-logs': {
    'P5-01': '日志面板存在',
    'P5-02': '跟随滚动开关存在且可切换',
    'P5-03': '行数计数文案可读',
    'P5-04': '选中页签为"日志"',
    'P5-05': '日志区空态或日志行为非空（二者必居其一）',
    'P5-06': '关键字过滤与清空按钮存在',
  },
  'p6-engines': {
    'P6-01': '已安装引擎行数 == 后端引擎数',
    'P6-02': '默认选中"已安装"视图',
    'P6-03': '切到"可安装"视图后内容真的变了',
    'P6-04': '"未安装任何引擎"与"探测不到可用版本"两种空态可区分',
    'P6-05': 'Node 运行时状态可读',
    'P6-06': '刷新可用版本按钮存在',
    'P6-07': '每个引擎行显示后端返回的版本号',
  },
  'p7-wizard': {
    'P7-01': '4 步步骤条存在且文案正确',
    'P7-02': '空名称时不会被创建（实例目录数不变）',
    'P7-03': '非法名（含 /）被拦截并给出错误文案',
    'P7-04': '输入合法名后错误消失、目录名预览出现',
    'P7-05': '未完成第 1 步时后续步骤不可点',
    'P7-06': '图标与强调色选择网格存在',
    'P7-07': '取消按钮存在',
    'P7-08': '深链 create 直接落到创建向导（不靠点击）',
  },
  'p8-settings': {
    'P8-01': '主题两项（深色/浅色）存在',
    'P8-02': 'Node 运行时候选列表存在',
    'P8-03': '界面上有"不跟随系统"的明确说明',
    'P8-04': '主题单选项可切换且选中态跟随',
    'P8-05': '存储位置路径与 registry 输入框可读',
    'P8-06': '重新探测 Node 按钮存在',
    'P8-07': '版本号文案可读',
    'P8-08': '深链 settings 直接落到全局设置（不靠点击）',
  },
});
