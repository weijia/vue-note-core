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
