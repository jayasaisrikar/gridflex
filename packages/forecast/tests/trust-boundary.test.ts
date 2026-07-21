/**
 * Architectural tests for the trust boundary.
 *
 * The rule "AI must never compute the official result" is only real if it is
 * enforced mechanically. These tests read the source tree and fail if the
 * dependency direction is ever reversed — a design decision that would
 * otherwise erode quietly, one plausible-looking import at a time.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FORECAST_SRC = join(HERE, '..', 'src');
const ENGINE_SRC = join(HERE, '..', '..', 'engine', 'src');

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strips block and line comments. Without this, ordinary prose in a doc comment
 * ("... tell 500 kW from 'we guessed 500 kW' ...") parses as an import and the
 * boundary tests report phantom violations.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function importsOf(file: string): string[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  const specifiers: string[] = [];
  const pattern = /(?:from|import)\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    specifiers.push(match[1] as string);
  }
  return specifiers;
}

describe('trust boundary', () => {
  it('the engine NEVER imports the forecast package', () => {
    // If this fails, a statistical model has entered the certified path that
    // produces Passports.
    for (const file of sourceFiles(ENGINE_SRC)) {
      for (const specifier of importsOf(file)) {
        expect(specifier).not.toMatch(/@gridflex\/forecast/);
        expect(specifier).not.toMatch(/\.\.\/.*forecast/);
      }
    }
  });

  it('the forecast package NEVER imports MRV, Passport or evidence modules', () => {
    // The forecaster may use units and shared helpers, but must not be able to
    // reach the modules that compute certified outcomes.
    const forbidden = /(mrv|passport|evidence|canonical-json)/i;
    for (const file of sourceFiles(FORECAST_SRC)) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(forbidden);
      }
    }
  });

  it('the forecast package depends on no third-party runtime library', () => {
    // Keeps the model layer auditable and deterministic. Only workspace
    // packages and node: builtins are permitted.
    for (const file of sourceFiles(FORECAST_SRC)) {
      for (const specifier of importsOf(file)) {
        const isRelative = specifier.startsWith('.');
        const isWorkspace = specifier.startsWith('@gridflex/');
        const isBuiltin = specifier.startsWith('node:');
        expect(
          isRelative || isWorkspace || isBuiltin,
          `${file} imports third-party ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('only the clamp module is permitted to PRODUCE a user-facing claim', () => {
    // `claimed*` fields are the display contract. If another module started
    // emitting them, the clamp could be bypassed.
    //
    // Reading a clamped claim is not the hazard and must stay allowed — the
    // explainer, the planner's caller and the UI all legitimately consume one.
    // The hazard is a second module ASSIGNING these fields, so the check targets
    // declaration (`claimedConfidence:` / `= `) and deliberately excludes
    // property access (`claim.claimedConfidence`).
    const producesClaim = /(?<!\.)\b(claimedReducibleKw|claimedReducibleMkw|claimedConfidence)\s*[:=][^=]/;

    for (const file of sourceFiles(FORECAST_SRC)) {
      if (file.endsWith(join('forecast', 'clamp.ts'))) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(source, `${file} produces a claimed* field`).not.toMatch(producesClaim);
    }
  });
});

describe('trust boundary — the claim-production rule is itself correct', () => {
  it('catches a module that assigns a claimed* field', () => {
    const producesClaim = /(?<!\.)\b(claimedReducibleKw|claimedReducibleMkw|claimedConfidence)\s*[:=][^=]/;
    expect('return { claimedReducibleKw: "999.000" };').toMatch(producesClaim);
    expect('const claimedConfidence = 0.99;').toMatch(producesClaim);
  });

  it('permits a module that merely reads one', () => {
    const producesClaim = /(?<!\.)\b(claimedReducibleKw|claimedReducibleMkw|claimedConfidence)\s*[:=][^=]/;
    expect('const kw = claim.claimedReducibleKw;').not.toMatch(producesClaim);
    expect('if (claim.claimedConfidence < 0.5) {}').not.toMatch(producesClaim);
  });
});
