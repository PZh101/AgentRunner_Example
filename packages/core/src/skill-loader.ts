import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { LoadedSkill } from './types.js';
import { SKILLS_DIR } from './config.js';

/**
 * File-based skills: skills/<name>/SKILL.md with YAML-ish frontmatter
 * (name, description). The body is injected into the system prompt so
 * the agent follows the skill's instructions.
 */

/** Parse simple `key: value` frontmatter between --- fences. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: match[2] ?? '' };
}

/** Load a single skill by directory name. Throws if missing. */
export function loadSkill(name: string): LoadedSkill {
  const dir = path.join(SKILLS_DIR, name);
  const file = path.join(dir, 'SKILL.md');
  if (!existsSync(file)) {
    throw new Error(`Skill not found: ${file}`);
  }
  const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
  return {
    name: meta.name ?? name,
    description: meta.description ?? '',
    promptFragment: `## Skill: ${meta.name ?? name}\n\n${body.trim()}`,
  };
}

/** Load all configured skills, in order. */
export function loadSkills(names: string[]): LoadedSkill[] {
  return names.map(loadSkill);
}
