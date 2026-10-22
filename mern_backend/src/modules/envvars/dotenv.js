// Parser for pasted .env files. Deliberately not a dependency: we need to
// report *which* lines were rejected and why, so the UI can show the user what
// it skipped instead of silently dropping half their file.

// POSIX-ish shell variable names — what every runtime and Vercel accept.
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @returns {{ vars: {key: string, value: string}[], skipped: {line: number, text: string, reason: string}[] }}
 * Later duplicates of a key win, matching how a shell sourcing the file behaves.
 */
export function parseDotenv(text) {
  const byKey = new Map();
  const skipped = [];
  const lines = String(text ?? '').split(/\r?\n/);

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;

    // `export FOO=bar` is common in pasted shell snippets.
    const withoutExport = line.replace(/^export\s+/, '');
    const eq = withoutExport.indexOf('=');
    if (eq === -1) {
      skipped.push({ line: lineNo, text: truncate(line), reason: 'no "=" found' });
      return;
    }

    const key = withoutExport.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      skipped.push({
        line: lineNo,
        text: truncate(key || line),
        reason: 'key must start with a letter or _ and contain only letters, digits and _',
      });
      return;
    }

    let value = withoutExport.slice(eq + 1).trim();

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // Double quotes: honour the usual escapes.
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      // Single quotes are literal.
      value = value.slice(1, -1);
    } else {
      // Unquoted: a ` #` starts a trailing comment.
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }

    if (value.length > 65_536) {
      skipped.push({ line: lineNo, text: truncate(key), reason: 'value longer than 64KB' });
      return;
    }

    byKey.set(key, value);
  });

  return {
    vars: [...byKey.entries()].map(([key, value]) => ({ key, value })),
    skipped,
  };
}

function truncate(s) {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}
