/**
 * `--env-name OLD=NEW` 的解析。三个命令（install / doctor / convert）共用这一份：
 * doctor 报的改名必须和 install 实际做的改名一字不差，各自解析一遍迟早会漂。
 */

/** 环境变量名的合法形状。不合法就报用法错误，不做"清洗"——猜出来的名字没人读得懂。 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvNameError extends Error {}

/**
 * 解析成 旧名 → 新名。`--env-name` 可以重复给。
 *
 * 允许 OLD === NEW：那是"这个变量别动"的明确表达，比 --keep-env-names 精确
 * （后者一刀切关掉所有改名）。
 */
export function parseEnvNames(values: string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of values ?? []) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      throw new EnvNameError(
        `--env-name value "${raw}" must be written OLD=NEW (for example MCP_TOKEN=ACME_HUB_TOKEN)`,
      );
    }
    const from = raw.slice(0, eq);
    const to = raw.slice(eq + 1);
    for (const [label, name] of [['old', from], ['new', to]] as const) {
      if (!ENV_NAME.test(name)) {
        throw new EnvNameError(
          `--env-name ${label} name "${name}" is not a valid environment variable name ` +
            '(letters, digits and "_", not starting with a digit)',
        );
      }
    }
    const previous = map.get(from);
    if (previous !== undefined && previous !== to) {
      throw new EnvNameError(
        `--env-name gives ${from} two different new names ("${previous}" and "${to}"); pick one`,
      );
    }
    map.set(from, to);
  }
  return map;
}
