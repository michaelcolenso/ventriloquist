/** POSIX single-quote a value so the shell treats it as one literal word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Fill the RENDER_COMMAND template. `{story}` comes from the MCP caller (an
 * agent), so every substitution is quoted: the template is trusted operator
 * config, the values are not.
 */
export function renderCommandLine(template: string, values: { story: string; out: string }): string {
  return template
    .replaceAll("{story}", shellQuote(values.story))
    .replaceAll("{out}", shellQuote(values.out));
}
