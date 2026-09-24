# 需求文档 — @richard432/note-core

## 1. 目标

提供一个 **Vue 3 组合式函数 + TypeScript** 的笔记核心库，支持多后端存储（PouchDB / Git / WebDAV），并内置本地-远端双向同步引擎。库以 ESM 形式构建发布到 npm，且可被网页直接调用（通过 CDN / import map）。

## 2. 范围

- 纯 TypeScript 实现，组合式函数仅依赖 `vue` 的 `ref/reactive`，不引入 UI 框架。
- 提供统一 `NotebookProvider` 接口，三种实现：`PouchDBProvider`、`GitProvider`、`WebDAVProvider`。
- 提供 `SyncEngine` 做本地(PouchDB) 与远端(git/webdav) 的双向同步（last-write-wins）。
- 提供 `useNotebook()` 组合式函数，管理 Provider 列表（localStorage 持久化）、当前笔记、编辑器联动、同步状态。
- 所有 I/O 错误必须被 catch 并写入 `error` / `syncError`，不得抛出到编辑器主流程。
- 同步操作不得阻塞编辑器正常使用。

## 3. 核心接口（节选）

见 `src/types.ts`：`SidebarNote`、`ProviderConfig`、`ProviderInfo`、`NoteChange`、`SyncResult`、`NotebookProvider`。

## 4. 各 Provider 行为要求

### 4.1 PouchDBProvider
- 每笔记本一库：`prefix + encodeURIComponent(name)`；名称含特殊字符时必须 `encodeURIComponent`，防止静默失败。
- `listNotes()`：`allDocs({include_docs:true})` → `SidebarNote[]`。
- `saveNote()`：`put(doc)`，自动更新 `updatedAt`。
- `createNote()`：生成 uuid，`path` 默认 `/未分类`，`title` 默认 `无标题笔记`。
- `watchChanges()`：`db.changes({live:true, include_docs:true})`，返回取消订阅函数。
- `destroy()`：先 `cancel` changesFeed，再 `await db.close()`，再清理引用。
- `switchProvider`：旧 `destroy()` 完成后再建新实例，不可并行。

### 4.2 GitProvider
- 浏览器内 `isomorphic-git` + `lightning-fs`。
- `init()`：目录不存在则 `clone`（或 `init` + `remote add`）。
- `listNotes()`：遍历 `.md` → 解析 frontmatter → `SidebarNote[]`。
- `saveNote()` / `createNote()`：写 `.md` → `git add` → `git commit`。
- `watchChanges()`：轮询对比（3s）。
- `sync()`：`fetch` → 比较 → `push/pull`；冲突 last-write-wins。

### 4.3 WebDAVProvider
- 使用 `webdav` 客户端。
- `init()`：`PROPFIND /` 连接测试。
- `listNotes()`：`PROPFIND rootPath` 遍历 `.md` → `GET` → 解析。
- `saveNote()`：`PUT rootPath/_id.md`；`createNote()`：`PUT` 新文件；`deleteNote()`：`DELETE`。
- `watchChanges()`：定时 `PROPFIND` 对比 etag/lastmod。
- `sync()`：`PROPFIND` 远端列表 → 对比 `updatedAt` → `PUT` 更新 → `GET` 新增写回。

## 5. SyncEngine
- 构造：`(localProvider: PouchDBProvider, config: ProviderConfig, onProgress?)`。
- `push()` / `pull()` / `sync(direction?)`。
- 失败不阻塞本地，错误收集到 `SyncResult.errors`。

## 6. useNotebook()
状态：`providers / currentName / currentProvider / allNotes / currentNote / loading / error / syncing / syncProgress / syncError`。
方法：`init / switchProvider / createProvider / deleteProvider / selectNote / saveCurrentNote / createNote / updateCurrentTags / sync`。
localStorage：`notebook_providers`（ProviderInfo[]）、`notebook_current`（当前 name）。

## 7. 导出与构建
- ESM default + named exports，导出自所有接口类型。
- `package.json` exports：`.`、`./useNotebook`、`./providers`、`./sync`、`./style.css`。
- 提供 `.d.ts` 类型声明。

## 8. 已知 Bug 修复
1. PouchDB 名称含 `/` 或特殊字符时 `encodeURIComponent` 处理。
2. `switchProvider` 时旧 `changesFeed.cancel()` 后 `await db.close()` 完成再建新连接。
3. 防止并行初始化导致多个 changesFeed 同时运行。

## 9. 约束
- 不依赖 Vue（纯 TS，composable 仅依赖 `ref/reactive`）。
- 不引入 UI 框架。
- 所有 I/O 错误 catch 并写入 `error/syncError`。
- 同步操作不阻塞编辑器。

## 10. 组件对接契约（新增）

`useNotebook()` 的返回值必须与下列 UI 组件的 `props / emits` 对齐（详细映射见表与示例，见 `docs/design.md` 第 8 节）：

- **vue-note-bar**：`notebooks←providers`、`current←currentName`、`syncing←syncing`；`switch→switchProvider`、`delete→deleteProvider`、`sync→sync('push')`、`manual-save→saveCurrentNote`、`new/config` 由页面层打开 BackendConfig。
- **vue-note-editor**：`note←currentNote`、`autoSaveDelay`（组件内，默认 1000）、`saveStatus`（页面派生）；`save→saveCurrentNote`、`update-tags→updateCurrentTags`。
- **@richard432/vue-note-sidebar**：`notes←allNotes`（页面先 searchAndFilter）、`activeId←currentNote?._id`；`select→selectNote`、`create→createNote`、`delete→deleteNote`、`move→updateNotePath`、`add-tag/remove-tag→updateNoteTags`。
- **vue-note-backend-config**：`open`（v-model）、`backendType`；`save→createProvider(type, name, config)`。

> 说明：`useNotebook` 新增了 `deleteNote(id)`、`updateNotePath(id, newPath)`、`updateNoteTags(id, tags)` 三个按 id 操作的方法，专门用于满足侧边栏的 `delete / move / add-tag / remove-tag` 契约；`saveStatus` 不在库内，由页面层根据编辑器状态派生。
