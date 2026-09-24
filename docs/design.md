# 设计文档 — @richard432/note-core

## 1. 总体架构

```
┌─────────────────────────────────────────────┐
│                useNotebook()                  │  Vue 组合式函数（状态 + 编辑器联动）
│  providers / currentProvider / allNotes ...   │
└───────────────┬─────────────────────────────┘
                │ createProvider(type,name,config)
                ▼
┌─────────────────────────────────────────────┐
│              NotebookProvider (接口)          │
├──────────────┬──────────────┬───────────────┤
│ PouchDBProv. │  GitProvider  │ WebDAVProvider│  本地/远端存储实现
└──────┬───────┴──────────────┴───────────────┘
       │ (作为本地源)
       ▼
┌─────────────────────────────────────────────┐
│   SyncEngine(local: PouchDBProvider, config)  │  本地 <-> 远端 双向同步
└─────────────────────────────────────────────┘
```

- **依赖方向**：`useNotebook` → `providers`(factory + 实现) / `sync`(SyncEngine)。三者均依赖 `types` 与 `utils`。
- **解耦**：Provider 之间互不依赖；SyncEngine 仅依赖 `NotebookProvider` 接口与 `PouchDBProvider` 类型。

## 2. 数据模型

`SidebarNote` 是跨 Provider 的统一传输结构。`_id` 的语义由各 Provider 自决：
- PouchDB：uuid
- Git / WebDAV：相对文件路径（含 `.md`）

`updatedAt`（毫秒时间戳）是冲突解决的唯一依据（last-write-wins）。

## 3. Provider 设计要点

### 3.1 生命周期
- `init(config)` 建立连接/打开库；`destroy()` 释放资源。
- `switchProvider` 严格串行：旧实例 `destroy()`（含 `changesFeed.cancel()` 与 `db.close()`）完成后才建立新实例，避免多个 live changes 并行。

### 3.2 变更订阅
- PouchDB：`db.changes({live:true, include_docs:true})`，按 `_id` 是否在 `seen` 集合中区分 add/update/delete。
- Git / WebDAV：轮询（3s / 5s），用 `known` 时间戳映射生成 add/update/delete 事件。
- 统一返回 `() => void` 取消订阅函数。

### 3.3 错误隔离
- 所有 `listNotes/saveNote/...` 的异常向上抛出，由 `useNotebook` 的 `try/catch` 捕获并写入 `error`。
- `watchChanges` 内部轮询/事件错误被静默吞掉，仅刷新失败时不阻塞编辑器。

## 4. SyncEngine

- 本地固定为 `PouchDBProvider`；远端由 `config` 推导（git/webdav/pouchdb）。
- `push`：遍历本地 → 远端缺失则写；远端较旧则覆盖；本地较旧记 `conflicts`。
- `pull`：对称，远端较新则写回本地。
- 进度通过 `onProgress(current,total,message)` 上报。
- 单条错误不影响整体，最终汇总到 `SyncResult.errors`。

## 5. useNotebook 状态与持久化

- `providers`：`localStorage['notebook_providers']` 读写（JSON）。
- `currentName`：`localStorage['notebook_current']`。
- `init()` 用 `initPromise` 去重，避免并行初始化导致多个 changesFeed。
- `connect()` 用 `connecting` 互斥锁，确保连接串行。

## 6. 构建与发布

- **构建工具**：Vite library mode（多入口 → `.mjs`），`vite-plugin-dts` 生成 `.d.ts`。
- **依赖外部化**：`vue`、`pouchdb-browser`、`isomorphic-git`、`@isomorphic-git/lightning-fs`、`webdav` 均 external，保持包体小且可被 `esm.sh` / import map 直接解析，满足“网页直接调用”。
- **子路径导出**：`./useNotebook`、`./providers`、`./sync`、`./style.css`。
- **CI**：GitHub Actions 在 `tag v*` 或 release 时 `npm ci → build → npm publish`，使用 `NPM_TOKEN` 密钥。

## 7. 浏览器直接调用方案

通过 esm.sh 自动重写依赖：
```html
<script type="module">
  import { useNotebook } from 'https://esm.sh/@richard432/note-core';
</script>
```
或配合 import map 指定 `vue` 版本以避免重复实例化（见 README）。

## 8. 组件对接契约（新增）

`useNotebook()` 的返回值必须与下列四个 UI 组件的 `props / emits` 对齐。说明：
- `saveStatus`（`'saved' | 'saving' | 'unsaved'`）不在 `useNotebook` 内，由页面层根据编辑器状态派生后下传。
- 以下映射中 `nb` 代表 `useNotebook()` 的返回值。

### 8.1 vue-note-bar（顶部栏：笔记本切换 / 新建 / 删除 / 同步 / 手动保存）

| 组件 props | 来源（useNotebook） | 组件 emits | 调用（useNotebook） |
| --- | --- | --- | --- |
| `notebooks: ProviderInfo[]` | `nb.providers` | `switch(name)` | `nb.switchProvider(name)` |
| `current: string` | `nb.currentName` | `new()` | 打开 BackendConfig（见 8.4），最终 `nb.createProvider(...)` |
| `saveStatus: string` | 页面派生 | `delete(name)` | `nb.deleteProvider(name)` |
| `syncing: boolean` | `nb.syncing` | `config()` | 页面层打开 BackendConfig 弹窗 |
|  |  | `sync()` | `nb.sync('push')` |
|  |  | `manual-save()` | `nb.saveCurrentNote(content)` |

### 8.2 vue-note-editor（编辑器：自动保存 / 标签）

| 组件 props | 来源（useNotebook） | 组件 emits | 调用（useNotebook） |
| --- | --- | --- | --- |
| `note: SidebarNote \| null` | `nb.currentNote` | `save(content)` | `nb.saveCurrentNote(content)` |
| `autoSaveDelay: number`（默认 1000） | —（组件内用） | `update-tags(tags)` | `nb.updateCurrentTags(tags)` |
| `saveStatus: string` | 页面派生 |  |  |

### 8.3 @richard432/vue-note-sidebar（侧边栏：笔记列表 / 搜索过滤由页面层完成）

| 组件 props | 来源（useNotebook） | 组件 emits | 调用（useNotebook） |
| --- | --- | --- | --- |
| `notes: SidebarNote[]` | `nb.allNotes`（页面先做 searchAndFilter 再传） | `select(id)` | `nb.selectNote(id)` |
| `activeId: string` | `nb.currentNote?._id` | `create(path?)` | `nb.createNote(path)` |
|  |  | `delete(id)` | `nb.deleteNote(id)` |
|  |  | `move({id,newPath})` | `nb.updateNotePath(id, newPath)` |
|  |  | `add-tag({id,tag})` | `nb.updateNoteTags(id, 新tags)` |
|  |  | `remove-tag({id,tag})` | `nb.updateNoteTags(id, 新tags)` |

> 说明：`move` / `add-tag` / `remove-tag` 本质是「更新 note 的 path / tags 后 saveNote」，`useNotebook` 已提供 `updateNotePath(id, newPath)` 与 `updateNoteTags(id, tags)` 两个按 id 操作的方法，页面层据此派生新值后调用即可，无需直接触碰 `currentProvider`。

### 8.4 vue-note-backend-config（后端配置弹窗）

| 组件 props | 来源 | 组件 emits | 调用（useNotebook） |
| --- | --- | --- | --- |
| `open: boolean` | 页面层 `v-model` | `save(config)` | `nb.createProvider(type, name, config)` |
| `backendType: string` | 当前 provider type |  |  |

> 说明：`bar` 的 `new()` 与 `config()` 都只是触发弹窗显示；真正的「创建 / 更新 Provider」统一在 `backend-config` 的 `save` 事件中通过 `nb.createProvider(type, name, config)` 完成，并自动切换（`createProvider` 内部会 `switchProvider`）。

### 8.5 页面层接线示例（伪代码）

```ts
const nb = useNotebook('默认');
await nb.init();

// bar
@switch="(name) => nb.switchProvider(name)"
@delete="(name) => nb.deleteProvider(name)"
@sync="() => nb.sync('push')"
@manual-save="(content) => nb.saveCurrentNote(content)"
:notebooks="nb.providers.value" :current="nb.currentName.value" :syncing="nb.syncing.value"

// editor
@save="(content) => nb.saveCurrentNote(content)"
@update-tags="(tags) => nb.updateCurrentTags(tags)"
:note="nb.currentNote.value"

// sidebar（页面先过滤）
const filtered = computed(() => searchAndFilter(nb.allNotes.value));
@select="(id) => nb.selectNote(id)"
@create="(path) => nb.createNote(path)"
@delete="(id) => nb.deleteNote(id)"
@move="({id,newPath}) => nb.updateNotePath(id, newPath)"
@add-tag="({id,tag}) => nb.updateNoteTags(id, [...currentTags(id), tag])"
@remove-tag="({id,tag}) => nb.updateNoteTags(id, currentTags(id).filter(t => t !== tag))"
:notes="filtered" :activeId="nb.currentNote.value?._id"

// backend-config
@save="(config) => nb.createProvider(config.type, config.name, config)"
:open="showConfig" :backendType="nb.currentProvider.value?.type"
```

