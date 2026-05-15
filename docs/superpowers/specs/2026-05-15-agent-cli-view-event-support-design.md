# Agent CLI 视图/事件读写支持 — 设计文档

日期: 2026-05-15
状态: 已批准

## 目标

让 FUXA Agent（Web 聊天面板 + CLI 命令行）都能读取和设置：
- 视图大小（DocProfile width/height）
- 组件事件配置（GaugeEvent: click→onpage, click→onSetValue 等）
- 组件动作配置（GaugeAction: 变量驱动的视觉响应）
- 视图级事件（ViewEvent: onopen/onclose）

## 当前缺口

| 能力 | Web 模式 | CLI 模式 |
|------|----------|----------|
| 读取视图大小 | 有 | 无 |
| 设置视图大小 | 有 (view_set_profile) | 无 |
| 读取组件事件 | **缺失** | 无 |
| 设置组件事件 | **缺失** | 无 |
| 读取视图级事件 | **缺失** | 无 |
| 设置视图级事件 | **缺失** | 无 |
| 任何视图工具 | N/A | 无 |

根因：
- `view_read` 的 `redactProperty()` 只输出 `{text, fill, stroke, fontSize, variableId, bbox, bindings}`，不含 events/actions
- `view_update_gauge` 只支持位置/颜色/文字/标签，不支持 events
- `view_set_profile` 只支持 width/height/bkcolor，不支持 viewEvents
- `tool-router.js` 的 `cli` 模式不含 `viewTools`

## 变更清单

### 1. view_read 输出增强

文件: `server/runtime/agent/tools/view.js`

**redactProperty()** 增加 `events` 和 `actions` 字段：

```js
function redactProperty(p) {
    if (!p) return null;
    const { text, fill, stroke, fontSize, variableId, bbox, bindings, events, actions } = p;
    return { text, fill, stroke, fontSize, variableId, bbox, bindings, events: events || [], actions: actions || [] };
}
```

**view_read executor** 增加 viewEvents 返回：

```js
return {
    id: v.id,
    name: v.name,
    profile: v.profile,
    selection: selection?.ids || [],
    items: filtered.map(it => ({ ... })),
    viewEvents: v.property?.events || []   // 新增
};
```

### 2. view_update_gauge 增加 events 参数

文件: `server/runtime/agent/tools/view.js`

**descriptor** 增加 events 参数定义：

```js
events: {
    type: 'array',
    description: 'Replace all interaction events on this gauge. Each: {type, action, actparam, actoptions}.',
    items: {
        type: 'object',
        required: ['type', 'action'],
        properties: {
            type: { type: 'string', enum: [
                'shapes.event-click', 'shapes.event-dblclick',
                'shapes.event-mousedown', 'shapes.event-mouseup',
                'shapes.event-mouseover', 'shapes.event-mouseout',
                'shapes.event-enter', 'shapes.event-select',
                'shapes.event-onLoad'
            ]},
            action: { type: 'string', enum: [
                'shapes.event-onpage', 'shapes.event-onwindow',
                'shapes.event-onopentab', 'shapes.event-ondialog',
                'shapes.event-oniframe', 'shapes.event-oncard',
                'shapes.event-onsetvalue', 'shapes.event-ontogglevalue',
                'shapes.event-onsetinput', 'shapes.event-onclose',
                'shapes.event-onrunscript', 'shapes.event-onViewToPanel',
                'shapes.event-onmonitor'
            ]},
            actparam: { type: 'string' },
            actoptions: { type: 'object' }
        }
    }
}
```

**executor** 在已有的属性更新逻辑之后增加：

```js
if (args.events !== undefined) {
    it.property.events = args.events;
}
```

### 3. view_set_profile 增加 viewEvents 参数

文件: `server/runtime/agent/tools/view.js`

**descriptor** 增加 viewEvents 参数定义：

```js
viewEvents: {
    type: 'array',
    description: 'Replace view-level events (onopen/onclose). Each: {type, action, actparam, actoptions}.',
    items: {
        type: 'object',
        required: ['type', 'action'],
        properties: {
            type: { type: 'string', enum: ['shapes.event-onopen', 'shapes.event-onclose'] },
            action: { type: 'string', enum: [
                'shapes.event-onpage', 'shapes.event-onwindow',
                'shapes.event-onopentab', 'shapes.event-ondialog',
                'shapes.event-oniframe', 'shapes.event-oncard',
                'shapes.event-onsetvalue', 'shapes.event-ontogglevalue',
                'shapes.event-onsetinput', 'shapes.event-onclose',
                'shapes.event-onrunscript', 'shapes.event-onViewToPanel',
                'shapes.event-onmonitor'
            ]},
            actparam: { type: 'string' },
            actoptions: { type: 'object' }
        }
    }
}
```

**executor** 增加：

```js
if (args.viewEvents !== undefined) {
    buffer.view.property = buffer.view.property || {};
    buffer.view.property.events = args.viewEvents;
    buffer.dirty = true;
}
```

### 4. tool-router.js: cli 模式加入 viewTools

文件: `server/runtime/agent/tool-router.js`

```js
const MODE_TOOLS = {
    web: [viewTools, deviceTools, projectTools],
    cli: [viewTools, deviceTools, projectTools]  // 新增 viewTools
};
```

### 5. Server: CLI turn 端点

文件: `server/api/agent/index.js`

新增端点 `POST /api/agent/cli/turn`：

```js
app.post('/api/agent/cli/turn', secureFnc, async function (req, res) {
    if (!requireEditorOrAdmin(req, res)) return;
    const { viewId, text, sessionId } = req.body || {};
    if (!viewId || !text) {
        return res.status(400).json({ error: 'missing_params', message: 'viewId and text required' });
    }
    try {
        const result = await runtime.agentMgr.getOrchestrator().runCliTurn({
            viewId, userText: text, sessionId
        });
        res.json(result);
    } catch (err) {
        res.status(400).json({
            error: err.code || 'cli_turn_failed',
            message: String(err?.message || err)
        });
    }
});
```

### 6. Orchestrator: runCliTurn 方法

文件: `server/runtime/agent/orchestrator.js`

新增方法，与 `runWebTurn` 类似但使用 `cli` 模式、不依赖 socket.io 流式推送：

```js
async runCliTurn({ viewId, userText, sessionId }) {
    // 验证 agent 启用
    // 获取 mutex
    // 调用 _loop() 但用 mode='cli'
    // 不 emit socket.io 事件（CLI 无 socket 连接）
    // 返回 { text, trace, committed, usage }
}
```

关键区别：`_loop` 需接受 mode 参数，web 模式用 `buildDescriptors('web', ...)` / `buildExecutors('web', ...)`，cli 模式用 `'cli'`。

### 7. CLI: view 子命令

文件: `app/cli/fuxa-agent/src/commands/view.js`（新建）

```bash
fuxa-agent view ls                          # 列出所有视图
fuxa-agent view show <name>                 # 读取视图详情（含组件、事件）
fuxa-agent view resize <name> --width 1920 --height 1080  # 修改视图大小
fuxa-agent view ask <name> "描述"           # 自然语言操作视图（走 agent turn）
```

CLI 入口 `cli.js` 增加 `view` 命令映射。

## 数据流

### Web 模式（已有流程增强）

```
用户 -> Agent Chat Panel -> POST /api/agent/sessions/:viewId/messages
  -> orchestrator.runWebTurn()
  -> _loop(mode='web')
  -> view_read / view_update_gauge / view_set_profile (增强版)
  -> commit -> socket.io agent:view-updated -> canvas 刷新
```

### CLI 模式（新增）

```
用户 -> fuxa-agent view show MainView
  -> GET /api/project (获取视图列表)
  -> POST /api/agent/cli/turn { viewId, text: "read this view" }
  -> orchestrator.runCliTurn()
  -> _loop(mode='cli')
  -> view_read (含 events/actions)
  -> 返回 JSON -> CLI 输出
```

## 测试验证

1. Web Agent 聊天：输入"读取当前视图的所有组件事件"，确认返回含 events/actions
2. Web Agent 聊天：输入"给按钮添加点击跳转事件"，确认 view_update_gauge 写入 events
3. Web Agent 聊天：输入"设置视图打开时运行脚本X"，确认 view_set_profile 写入 viewEvents
4. CLI：`fuxa-agent view ls` 正常列出视图
5. CLI：`fuxa-agent view show MainView` 返回完整结构含 events
6. CLI：`fuxa-agent view resize MainView --width 1920 --height 1080` 修改成功
