import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// 外部化运行时的“浏览器原生可解析”依赖：库本身不打包它们，
// 既保持包体小，又让浏览器可通过 esm.sh / importmap 直接解析（"被网页直接调用"）。
//
// 注意：pouchdb-browser 及其内部 pouchdb-* 子依赖【不再】列为 external，
// 而是直接打包进 dist。原因：pouchdb-browser 经 esm.sh 二次 CJS→ESM 转译时，
// 在模块求值阶段即抛 `e.on is not a function`，导致 import 该库整脚本崩溃。
// 把它打进 dist 后，esm.sh 不再单独转译 pouchdb，崩溃消失（已验证）。
//
// @zenfs/core / zen-fs-gitee 同样保持【外置】：这两个包在 esm.sh 上二次转译即崩溃
// （重复注册 / kerium 解析错误）。由消费端在 import map 中指向已验证的自包含 bundle
// （如本仓库说明的 vendor/zenfs-gitee.bundle.js），并以
// `?external=@zenfs/core,zen-fs-gitee` 告知 esm.sh 不要解析它们。
// 类型方面由 src/types-external.d.ts 的 declare module 兜底，无需安装其类型包。
const external = [
  'vue',
  'isomorphic-git',
  '@isomorphic-git/lightning-fs',
  'webdav',
  '@zenfs/core',
  'zen-fs-gitee',
  // zen-fs-cache 是 zen-fs-gitee 的依赖（其 IdbKVStore 用于内容持久化）。
  // 保持外置 + 由 import map 提供，才能和 zen-fs-gitee 内部那份共用同一个实例/数据库。
  'zen-fs-cache',
  /^isomorphic-git\//,
];

export default defineConfig({
  plugins: [
    dts({
      rollupTypes: false,
      insertTypesEntry: true,
      tsconfigPath: './tsconfig.json',
    }),
  ],
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        useNotebook: 'src/useNotebook.ts',
        providers: 'src/providers/index.ts',
        sync: 'src/sync/index.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external,
      output: {
        entryFileNames: '[name].mjs',
        chunkFileNames: '[name]-[hash].mjs',
        assetFileNames: 'style.css',
      },
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
