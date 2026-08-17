/**
 * `--env-name [<plugin>:]OLD=NEW` 的解析。四个命令（install / doctor / convert /
 * market convert）共用这一份：doctor 报的改名必须和 install 实际做的改名一字不差，
 * 各自解析一遍迟早会漂。
 *
 * 改名是**插件维度**的事实，不是一次调用的全局开关。单插件命令上插件是谁不言自明，
 * 作用域可省；`market convert` 一条命令转一整个市场，同一个 OLD 在不同插件下完全
 * 可以映射到不同的 NEW，所以那里必须写清楚是给谁的。
 */

/** 环境变量名的合法形状。不合法就报用法错误，不做"清洗"——猜出来的名字没人读得懂。 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvNameError extends Error {}

/** 一条 --env-name 拆成：给谁的（没写就是 null）、旧名、新名 */
interface ParsedEnvName {
  scope: string | null;
  from: string;
  to: string;
}

/**
 * 冒号在 `=` 之前才算作用域分隔符。环境变量名里不可能有冒号，所以这条判据没有歧义，
 * 也不必为插件名另立一套字符规则。
 */
function parseOne(raw: string): ParsedEnvName {
  const eq = raw.indexOf('=');
  const colon = raw.indexOf(':');
  const scoped = colon >= 0 && (eq < 0 || colon < eq);
  const scope = scoped ? raw.slice(0, colon) : null;
  const pair = scoped ? raw.slice(colon + 1) : raw;

  if (scoped && scope!.length === 0) {
    throw new EnvNameError(
      `--env-name value "${raw}" starts with ":" but names no plugin; write it <plugin>:OLD=NEW`,
    );
  }

  const at = pair.indexOf('=');
  if (at <= 0) {
    throw new EnvNameError(
      `--env-name value "${raw}" must be written OLD=NEW or <plugin>:OLD=NEW ` +
        '(for example MCP_TOKEN=ACME_HUB_TOKEN)',
    );
  }

  const from = pair.slice(0, at);
  const to = pair.slice(at + 1);
  for (const [label, name] of [['old', from], ['new', to]] as const) {
    if (!ENV_NAME.test(name)) {
      throw new EnvNameError(
        `--env-name ${label} name "${name}" is not a valid environment variable name ` +
          '(letters, digits and "_", not starting with a digit)',
      );
    }
  }
  return { scope, from, to };
}

/** 同一个旧名被指了两个不同的新名——必须让用户自己挑，猜哪个都是错的 */
function set(map: Map<string, string>, { from, to }: ParsedEnvName, plugin: string | null): void {
  const previous = map.get(from);
  if (previous !== undefined && previous !== to) {
    const who = plugin ? ` for ${plugin}` : '';
    throw new EnvNameError(
      `--env-name gives ${from}${who} two different new names ("${previous}" and "${to}"); pick one`,
    );
  }
  map.set(from, to);
}

/**
 * 单插件命令用。`plugin` 是这次在装/转的那个插件的名字。
 *
 * 允许 OLD === NEW：那是"这个变量别动"的明确表达，也是从账本里记着的旧映射退回作者
 * 原名的唯一说法（不写就会沿用账本）。
 *
 * 作用域写了就必须对得上：`--env-name other:MCP_TOKEN=X` 在装 demo 时一条也应用不到，
 * 静默忽略等于让用户以为自己改了名，而产物里其实一个字没动。
 */
export function parseEnvNames(values: string[] | undefined, plugin?: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of values ?? []) {
    const parsed = parseOne(raw);
    if (parsed.scope !== null && plugin !== undefined && parsed.scope !== plugin) {
      throw new EnvNameError(
        `--env-name value "${raw}" is scoped to plugin "${parsed.scope}", but this command is ` +
          `working on "${plugin}"; drop the scope or name the right plugin`,
      );
    }
    set(map, parsed, plugin ?? null);
  }
  return map;
}

/**
 * 一条命令覆盖多个插件时（`market convert`）用：按插件分开。
 *
 * 这里**要求**写作用域。不写就套到所有插件上是个看着方便、实则危险的默认：一个市场里
 * 几十个插件，谁都可能恰好也读一个叫 MCP_TOKEN 的变量，而它们背后未必是同一个令牌。
 */
export function parseEnvNamesByPlugin(values: string[] | undefined): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const raw of values ?? []) {
    const parsed = parseOne(raw);
    if (parsed.scope === null) {
      throw new EnvNameError(
        `--env-name value "${raw}" must say which plugin it applies to here: write it ` +
          '<plugin>:OLD=NEW. One marketplace holds many plugins, and the same variable name ' +
          'in two of them is not necessarily the same secret.',
      );
    }
    const map = out.get(parsed.scope) ?? new Map<string, string>();
    set(map, parsed, parsed.scope);
    out.set(parsed.scope, map);
  }
  return out;
}
