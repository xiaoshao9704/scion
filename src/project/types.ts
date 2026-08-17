import type { Finding } from '../ir/types.js';

export interface EmittedFile {
  /** 相对输出根的路径 */
  path: string;
  content: string;
}

/** 转换时用户可以调的旋钮。默认值就是不传时的行为，调用方不必每处都写全 */
export interface ProjectionOptions {
  /**
   * 保留插件作者写的环境变量名，不做跨插件消歧改名。
   * 插件自己的运行时代码可能直接读着那个名字，改名会把它断掉。
   */
  keepEnvNames?: boolean;
  /**
   * 用户点名的环境变量改名（旧名 → 新名）。优先于自动消歧，也优先于 keepEnvNames——
   * 变量真正归谁，只有用户知道（例如令牌属于多个插件共用的一台 MCP hub）。
   */
  envNames?: Map<string, string>;
}

export interface ProjectionResult {
  manifest: Record<string, unknown>;
  /** 目标清单应写到的相对路径 */
  manifestPath: string;
  /** 除清单外还需写出的文件（如 .mcp.json、改写过的 frontmatter） */
  files: EmittedFile[];
  findings: Finding[];
}
