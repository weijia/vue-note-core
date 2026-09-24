# @richard432/note-core

Vue 3 组合式函数 + TypeScript 的**笔记核心库**。内置三种存储后端（PouchDB / Git / WebDAV）与一个本地↔远端双向同步引擎 `SyncEngine`，以 ESM 构建发布到 npm，并**可被网页直接调用**。

- 纯 TypeScript，组合式函数仅依赖 `vue` 的 `ref/reactive`，不引入任何 UI 框架
- 统一 `NotebookProvider` 接口：PouchDB / Git / WebDAV
- `SyncEngine`：last-write-wins 冲突策略，失败不阻塞本地
- `useNotebook()`：管理 Provider 列表（localStorage）、当前笔记、编辑器联动、同步状态
- 提供 `.d.ts` 类型声明与多子路径导出

## 安装

```bash
npm install @richard432/note-core
# 对等依赖
npm install vue
```

> 运行期依赖 `pouchdb-browser`、`isomorphic-git`、`@isomorphic-git/lightning-fs`、`webdav` 会随包自动安装（已声明为 dependencies）。

## 在 Vue 中使用

```ts
import { defineComponent, onMounted } from 'vue';
import { useNotebook } from '@richard432/note-core';

export default defineComponent({
  setup() {
    const nb = useNotebook('我的笔记本');

    onMounted(async () => {
      // 初始化：读取 localStorage 中的 providers 并连接
      await nb.init();
      // 若还没有 provider，创建一个本地 PouchDB provider
      if (nb.providers.value.length === 0) {
        await nb.createProvider('pouchdb', '本地', { pouchdb: { prefix: 'nb-' } });
      }
    });

    async function onInput(content: string) {
      await nb.saveCurrentNote(content);
    }

    return { nb, onInput };
  },
});
```

### 子路径按需导入

```ts
import { createProvider } from '@richard432/note-core/providers';
import { SyncEngine } from '@richard432/note-core/sync';
import { useNotebook } from '@richard432/note-core/useNotebook';
import '@richard432/note-core/style.css'; // 可选默认样式
```

## 网页直接调用（无需打包器）

通过 [esm.sh](https://esm.sh) 自动解析依赖，直接在 `<script type="module">` 中使用：

```html
<script type="module">
  import { useNotebook } from 'https://esm.sh/@richard432/note-core';
  const nb = useNotebook('demo');
  await nb.init();
  // ...
</script>
```

若需固定 Vue 版本、避免页面中存在多个 Vue 实例，可使用 import map：

```html
<script type="importmap">
{
  "imports": {
    "vue": "https://esm.sh/vue@3",
    "@richard432/note-core": "https://esm.sh/@richard432/note-core?external=vue"
  }
}
</script>
<script type="module">
  import { useNotebook } from '@richard432/note-core';
</script>
```

完整演示见 [`playground/index.html`](./playground/index.html)。

## API 速览

### 接口（类型）
`SidebarNote` · `ProviderConfig` · `ProviderInfo` · `NoteChange` · `SyncResult` · `NotebookProvider`

### 工厂
```ts
const provider = createProvider('pouchdb' | 'git' | 'webdav', name, config);
```

### Provider 配置示例
```ts
// PouchDB（浏览器本地）
{ pouchdb: { prefix: 'nb-' } }

// Git（浏览器内 isomorphic-git + lightning-fs）
{ git: { repoUrl: 'https://github.com/me/notes.git', branch: 'main', token: 'ghp_xxx' } }

// WebDAV
{ webdav: { url: 'https://dav.example.com', username: 'u', password: 'p', rootPath: '/notes' } }
```

### SyncEngine
```ts
const engine = new SyncEngine(localPouchProvider, remoteConfig, (cur, total, msg) => {
  console.log(msg);
});
const result = await engine.sync('both'); // { pushed, pulled, conflicts, errors }
```

### useNotebook 返回
| 状态 | 类型 |
| --- | --- |
| `providers` | `Ref<ProviderInfo[]>` |
| `currentName` | `Ref<string>` |
| `currentProvider` | `Ref<NotebookProvider \| null>` |
| `allNotes` | `Ref<SidebarNote[]>` |
| `currentNote` | `Ref<SidebarNote \| null>` |
| `loading` / `error` | `Ref<boolean>` / `Ref<string>` |
| `syncing` / `syncProgress` / `syncError` | `Ref<boolean>` / `Ref<string>` / `Ref<string \| null>` |

方法：`init()` · `switchProvider(name)` · `createProvider(type,name,config)` · `deleteProvider(name)` · `selectNote(id)` · `saveCurrentNote(content)` · `createNote(path?)` · `updateCurrentTags(tags)` · `deleteNote(id)` · `updateNotePath(id,newPath)` · `updateNoteTags(id,tags)` · `sync(direction?)`。

> 其中 `deleteNote` / `updateNotePath` / `updateNoteTags` 为按 id 操作的方法，用于对接 `vue-note-sidebar` 的 `delete` / `move` / `add-tag` / `remove-tag` 事件（详见 `docs/design.md` 第 8 节「组件对接契约」）。

## 开发

```bash
npm install
npm run build      # 输出 dist/*.mjs + *.d.ts
npm run typecheck  # tsc --noEmit
```

## 发布

打 tag 推送即可触发 CI 自动发布：

```bash
npm version patch
git push --follow-tags
```

CI 会在 `v*` tag 或 GitHub Release 时执行 `npm ci → npm run build → npm publish`，需在仓库 `Settings → Secrets` 配置 `NPM_TOKEN`（npm 账号的 Automation Token）。

## License

MIT
