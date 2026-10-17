import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// 外部化运行时的“浏览器原生可解析”依赖：库本身不打包它们，
// 既保持包体小，又让浏览器可通过 esm.sh / importmap 直接解析（"被网页直接调用"）。
//
// 注意：pouchdb-browser 及其内部 pouchdb-* 子依赖【不再】列为 external，
// 而是直接打包进 dist。原因：pouchdb-browser 经 esm.sh 二次 CJS→ESM 转译时，
// 在模块求值阶段即抛 `e.on is not a function`，导致 import 该库整脚本崩溃。
// 把它打进 dist 后，esm.sh 不再单独转译 pouchdb，崩溃消失（已验证）。
const external = [
  'vue',
  'isomorphic-git',
  '@isomorphic-git/lightning-fs',
  'webdav',
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
