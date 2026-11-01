import { NotebookProvider, ProviderConfig } from '../types';
import { logProvider } from '../debug';
import { PouchDBProvider } from './PouchDBProvider';
import { GitProvider } from './GitProvider';
import { WebDAVProvider } from './WebDAVProvider';
import { GiteeProvider } from './GiteeProvider';
import { AppDataProvider } from './AppDataProvider';

/**
 * 工厂函数：根据 type 创建对应 Provider 实例。
 */
export function createProvider(
  type: string,
  name: string,
  config: ProviderConfig,
): NotebookProvider {
  logProvider.log('createProvider', { type, name });

  switch (type) {
    case 'pouchdb':
      return new PouchDBProvider(name);
    case 'git':
      return new GitProvider(name);
    case 'gitee':
      return new GiteeProvider(name);
    case 'webdav':
      return new WebDAVProvider(name);
    case 'appdata':
      return new AppDataProvider(name);
    default: {
      const message = '未知的 Provider 类型: ' + type;
      logProvider.error('createProvider FAIL', message);
      throw new Error(message);
    }
  }
}
