import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setMarketplaceVersion, setSkillStamp } from './stamp.js';

interface Target {
  path: string;
  read(): string;
  rewrite(content: string, version: string): string;
}

function targets(root: string): Target[] {
  const out: Target[] = [
    {
      path: join(root, '.claude-plugin/marketplace.json'),
      read() {
        return readFileSync(this.path, 'utf8');
      },
      rewrite: setMarketplaceVersion,
    },
    {
      path: join(root, 'packages/cli/src/version.ts'),
      read() {
        return readFileSync(this.path, 'utf8');
      },
      rewrite: (_content, version) =>
        `// Generated from .claude-plugin/plugin.json by packages/plugin-guard/src/version-sync.ts.\nexport const SYNERGY_VERSION = '${version}';\n`,
    },
  ];
  const skillsDir = join(root, 'skills');
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const p = join(skillsDir, entry.name, 'SKILL.md');
    let content: string;
    try {
      content = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    // Only stamp skills that already opt in (carry the marker).
    if (!content.includes('synergy-version:')) continue;
    out.push({ path: p, read: () => readFileSync(p, 'utf8'), rewrite: setSkillStamp });
  }
  return out;
}

/** Returns a process exit code. `--check` never writes; non-zero means drift. */
export function run(argv: string[], root: string = process.cwd()): number {
  const check = argv.includes('--check');
  const version = (
    JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  let drift = false;
  for (const t of targets(root)) {
    const current = t.read();
    const next = t.rewrite(current, version);
    if (next !== current) {
      drift = true;
      if (!check) writeFileSync(t.path, next);
    }
  }
  if (check && drift) {
    process.stderr.write(
      `version-sync: files are out of sync with plugin.json (${version}). Run version-sync.\n`,
    );
    return 1;
  }
  return 0;
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(run(process.argv.slice(2)));
}
