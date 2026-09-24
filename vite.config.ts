import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// 外部化所有运行时依赖：库本身不打包它们，既保持包体小，
// 又让浏览器可通过 esm.sh / importmap 直接解析（"被网页直接调用"）。
const external = [
  'vue',
  'pouchdb-browser',
  'isomorphic-git',
  '@isomorphic-git/lightning-fs',
  'webdav',
  /^isomorphic-git\//,
  /^pouchdb-/, // pouchdb-browser 的内部子依赖
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
