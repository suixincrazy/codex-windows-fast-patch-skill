'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const manifest = require('./desktop-261029-profiles.json');
const project = require('./patch-project-archive-state.cjs');
const reopen = require('./patch-windows-reopen.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, 'Expected one complete patch anchor');
  return source.replace(before, () => after);
}

// Later 26.1029 builds rename hashed bundles while keeping every anchor; each
// variant pins the renamed file and its complete original hash.
function layouts() {
  return [{version: manifest.version, files: manifest.files, native: manifest.native},
    ...(manifest.variants ?? []).map(variant => {
      const swap = profile => variant.files[profile.file] ? {...profile, ...variant.files[profile.file]} : profile;
      return {version: variant.version, files: manifest.files.map(swap), native: manifest.native.map(swap)};
    })];
}

function resolveManifest(hasFile) {
  const renamed = new Set((manifest.variants ?? []).flatMap(variant =>
    Object.entries(variant.files).filter(([from, to]) => from !== to.file).flatMap(([from, to]) => [from, to.file])));
  const matches = layouts().filter(layout => layout.files.every(profile => !renamed.has(profile.file) || hasFile(profile.file)));
  if (matches.length !== 1) throw new Error(`Expected one complete 26.1029 desktop layout, found ${matches.length}`);
  return matches[0];
}

function validateModels(models) {
  assert(Array.isArray(models) && models.length > 0 && models.every(model =>
    typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)), 'Pass nonempty model identifiers');
  return [...new Set(models)];
}

function restore(source, profile) {
  if (hash(source) === profile.sha256) return source;
  const legacyEdits = profile.edits.filter(edit => !edit.kind?.startsWith('startup-'));
  if (legacyEdits.length !== profile.edits.length) {
    try { return restore(source, {...profile, edits: legacyEdits}); } catch {}
  }
  let original = source;
  try {
    for (const edit of [...profile.edits].reverse()) {
      if (edit.after.includes('__MODELS_JSON__')) {
        const [prefix, suffix] = edit.after.split('__MODELS_JSON__');
        const matches = [...original.matchAll(new RegExp(escape(prefix) + '(\\[[^\\r\\n]*?\\])' + escape(suffix), 'g'))];
        assert.equal(matches.length, 1, 'Expected one pinned model override');
        validateModels(JSON.parse(matches[0][1]));
        original = replaceOnce(original, matches[0][0], edit.before);
      } else {
        original = replaceOnce(original, edit.after, edit.before);
      }
    }
    assert.equal(hash(original), profile.sha256, 'Restored file hash differs');
    return original;
  } catch {
    throw new Error(`Unsupported or partial 26.1029 asset ${profile.file}: ${hash(source)}`);
  }
}

function transform(source, profile, models) {
  const original = restore(source, profile);
  const output = profile.edits.reduce((text, edit) => replaceOnce(text, edit.before,
    edit.after.replace('__MODELS_JSON__', () => JSON.stringify(models))), original);
  return { original, source: output, status: source === output ? 'already-patched' : 'patched' };
}

function planFiles(root, models) {
  models = validateModels(models);
  const hasFile = rel => fs.existsSync(path.join(root, rel));
  const layout = resolveManifest(hasFile);
  const selected = project.selectProfiles(hasFile);
  assert(selected[0].file === 'early-bootstrap-133-485dbc70b8296756.js', 'Expected the complete 26.1029 project layout');
  const overlapping = layout.files.find(profile => selected.some(state => project.relativePath(state) === profile.file));
  const targets = new Map();
  for (const profile of selected) {
    const file = project.relativePath(profile);
    const input = fs.readFileSync(path.join(root, file), 'utf8');
    if (file === overlapping?.file) {
      assert(profile.sha256.includes(overlapping.sha256), 'Overlapping source hashes differ');
      const combined = {...overlapping, edits: [...profile.edits.map(([before, after]) => ({before, after})), ...overlapping.edits]};
      let normalized = input;
      // Accept the exact older project-only patch when adding the bundled gate.
      try {
        const legacy = project.transform(input, profile);
        if (legacy.status === 'already-patched') {
          const restored = profile.edits.slice().reverse().reduce((text, [before, after]) => replaceOnce(text, after, before), input);
          if (hash(restored) === combined.sha256) normalized = restored;
        }
      } catch {}
      const result = transform(normalized, combined, models);
      targets.set(file, {file, input, ...result, kinds: overlapping.edits.map(edit => edit.kind),
        status: input === result.source ? 'already-patched' : 'patched'});
      continue;
    }
    const result = project.transform(input, profile);
    const original = profile.edits.slice().reverse().reduce((text, [before, after]) => replaceOnce(text, after, before), result.source);
    targets.set(file, { file, input, original, ...result });
  }
  for (const profile of layout.files) {
    if (profile === overlapping) continue;
    assert(!targets.has(profile.file), 'Overlapping patch profiles');
    const input = fs.readFileSync(path.join(root, profile.file), 'utf8');
    targets.set(profile.file, { file: profile.file, input, kinds: profile.edits.map(edit => edit.kind),
      ...transform(input, profile, models) });
  }
  const reopenInput = fs.readFileSync(path.join(root, reopen.file), 'utf8');
  const reopenResult = reopen.transform(reopenInput);
  targets.set(reopen.file, {file: reopen.file, input: reopenInput,
    original: reopenInput.replace(reopen.after, reopen.before), ...reopenResult});
  const native = layout.native.map(profile => {
    const source = targets.get(profile.file)?.original ?? fs.readFileSync(path.join(root, profile.file), 'utf8');
    assert.equal(hash(source), profile.sha256, `Unsupported native asset: ${profile.file}`);
    for (const witness of profile.witnesses) assert(source.includes(witness), `Missing native behavior in ${profile.file}`);
    return { file: profile.file, status: 'already-open-native', sha256: profile.sha256 };
  });
  return { version: layout.version, targets: [...targets.values()], native };
}

function patchFiles(root, backupRoot, models, checkOnly = false) {
  const plan = planFiles(root, models);
  if (!checkOnly) {
    for (const target of plan.targets) {
      assert.equal(fs.readFileSync(path.join(root, target.file), 'utf8'), target.input, 'Target changed during preflight');
      const backup = path.join(backupRoot, target.file);
      if (fs.existsSync(backup)) assert.equal(hash(fs.readFileSync(backup)), hash(target.original), 'Existing original backup differs');
    }
    for (const target of plan.targets.filter(target => target.status === 'patched')) {
      const backup = path.join(backupRoot, target.file);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, target.original, { flag: 'wx', flush: true });
    }
    for (const target of plan.targets.filter(target => target.status === 'patched')) {
      fs.writeFileSync(path.join(root, target.file), target.source, { encoding: 'utf8', flush: true });
    }
  }
  return { version: plan.version, files: plan.targets.map(target => ({ file: target.file,
    status: target.status, kinds: target.kinds ?? [], sha256: hash(target.source) })), native: plan.native };
}

module.exports = { manifest, layouts, resolveManifest, validateModels, restore, transform, planFiles, patchFiles };
if (require.main === module) {
  const [root, backupRoot, modelsJson, flag] = process.argv.slice(2);
  assert(root && backupRoot && modelsJson && (!flag || flag === '--check'),
    'Usage: patch-desktop-261029.cjs <extracted-asar> <backup-root> <models.json> [--check]');
  console.log(JSON.stringify(patchFiles(root, backupRoot, JSON.parse(fs.readFileSync(modelsJson, 'utf8').replace(/^\uFEFF/, '')), flag === '--check')));
}
