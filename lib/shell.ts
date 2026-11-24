/**
 * Shell command construction.
 *
 * Every command HAPM runs is built here. The API takes argv arrays, never a
 * pre-built string, because a `command: string` parameter invites callers to
 * concatenate untrusted input into it — and a domain or path typed into a form
 * then ends up as shell syntax in a command running as root.
 *
 * There is no exported function that accepts an unescaped command line.
 */

/** Wrap a value in single quotes, escaping any embedded single quote. */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a command line from argv. Every element is escaped, including the
 * binary name — so `argv[0]` may come from the database (e.g. a configured path).
 */
export function buildCommand(argv: string[]): string {
  if (argv.length === 0) throw new Error('buildCommand: leeres argv');
  return argv.map(shellEscape).join(' ');
}

/**
 * Build a command line with an environment prefix: `KEY='value' KEY2='v2' cmd arg`.
 * Keys must be valid shell identifiers; values are escaped like any other argument.
 */
export function withEnv(env: Record<string, string>, argv: string[]): string {
  const prefix = Object.entries(env)
    .map(([k, v]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`Ungültiger Env-Key: ${k}`);
      return `${k}=${shellEscape(v)}`;
    })
    .join(' ');
  const cmd = buildCommand(argv);
  return prefix ? `${prefix} ${cmd}` : cmd;
}

/**
 * Join independent command lines with `; ` and a separator marker between them,
 * so several probes travel in one SSH connection and can be split apart again.
 *
 * The marker is echoed through a quoted argument, so it cannot be forged by
 * command output that happens to contain the same text on its own line —
 * splitting on it is only safe because we control every command in the batch.
 */
export const SECTION_SEP = '---HAPM_SEP---';

export function batchCommands(commands: string[]): string {
  return commands.join(`; echo ${shellEscape(SECTION_SEP)}; `);
}

/** Split batched output back into one entry per command. Always returns `commands.length` entries. */
export function splitSections(stdout: string, expected: number): string[] {
  const parts = stdout.split(SECTION_SEP).map((p) => p.trim());
  while (parts.length < expected) parts.push('');
  return parts.slice(0, expected);
}

/** Marker for a heredoc body. Quoted at the `<<`, so nothing inside is expanded. */
export const HEREDOC_DELIMITER = 'HAPM_STDIN_EOF';

/**
 * Feed `body` to a command on stdin instead of passing it as an argument.
 *
 * The reason is `ps`. An argument is visible to every user on the remote
 * machine for as long as the process runs, so `psql -c "CREATE ROLE … PASSWORD
 * 'secret'"` publishes the password it is in the middle of setting. A heredoc
 * does not appear in the argument list — the shell writes it to a private
 * temporary file, unlinks it immediately and hands over the descriptor.
 *
 * The delimiter is quoted (`<<'X'`), so `$`, backticks and backslashes inside
 * the body stay literal — a generated password containing `$(` must not become
 * a command substitution.
 *
 * What quoting cannot solve is a body that contains the delimiter on a line of
 * its own: the heredoc would end early and the rest would be read as shell
 * commands. That is not escapable, only detectable, so it throws. Same shape as
 * `buildCommand` refusing an empty argv — the guarantee has to be structural.
 */
export function withStdin(argv: string[], body: string): string {
  const lines = body.split('\n');
  if (lines.some((line) => line.trimEnd() === HEREDOC_DELIMITER)) {
    throw new Error(`withStdin: Inhalt enthält die Marke ${HEREDOC_DELIMITER} auf eigener Zeile.`);
  }
  // The trailing newline before the closing delimiter is required by the shell;
  // a body that already ends in one must not produce a blank line, because a
  // heredoc is terminated by the delimiter alone on its line, not by position.
  const content = body.endsWith('\n') ? body : `${body}\n`;
  return `${buildCommand(argv)} <<'${HEREDOC_DELIMITER}'\n${content}${HEREDOC_DELIMITER}`;
}
