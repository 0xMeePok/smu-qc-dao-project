import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cp, mkdtemp, readFile, writeFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { patchZod } from './patch-zod-security.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(new URL('../firebase/functions/securityDependencies/zod-security-manifest.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);
const versions = ['3.22.4', '3.25.76', '4.6.6', '4.6.7'];
const digest = source => createHash('sha256').update(source).digest('hex');
const fixture = await mkdtemp(join(tmpdir(), 'zod-security-test-'));
after(async () => { await rm(fixture, { recursive: true, force: true }); });
const paths = {};
const originalPaths = {};

// Discover installed packages without downloading fixtures or changing node_modules.
async function installedZodPackages() {
  const found = new Map();
  const visited = new Set();
  async function modules(directory) {
    let canonical;
    try { canonical = await realpath(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    for (const entry of await readdir(canonical, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const candidate = join(canonical, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of await readdir(candidate, { withFileTypes: true })) {
          if (scoped.isDirectory() || scoped.isSymbolicLink()) await inspect(join(candidate, scoped.name));
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) await inspect(candidate);
    }
  }
  async function inspect(directory) {
    let pkg;
    try { pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (pkg.name === 'zod' && versions.includes(pkg.version) && !found.has(pkg.version)) {
      found.set(pkg.version, await realpath(directory));
    }
    await modules(join(directory, 'node_modules'));
  }
  for (const project of ['frontend', 'firebase', 'firebase/functions', 'contracts/audit-registry', 'contracts/qft-tokens', 'contracts/stable-faucet', 'contracts/stable-faucet/site', 'contracts/funding-escrow']) await modules(join(repository, project, 'node_modules'));
  for (const version of versions) {
    assert.ok(found.has(version), `Required installed official Zod ${version} fixture is missing; install the repository dependencies first`);
  }
  return found;
}

async function packageHashes(directory) {
  const hashes = {};
  async function visit(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const filename = join(relative, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else hashes[filename] = digest(await readFile(join(directory, filename)));
    }
  }
  await visit();
  return hashes;
}

async function assertManifestHashes(directory, version, state) {
  for (const [relative, entry] of Object.entries(manifest[version])) {
    assert.equal(digest(await readFile(join(directory, relative))), entry[state], `${version}/${relative}: expected complete ${state} source hash`);
  }
}

// A local install may already have the backport. Recover the exact known official
// source in a scratch copy, validating both full-file hashes around every reversal.
async function restoreOfficialSources(directory, version) {
  for (const [relative, entry] of Object.entries(manifest[version])) {
    const filename = join(directory, relative);
    let source = await readFile(filename, 'utf8');
    const hash = digest(source);
    assert.ok(hash === entry.before || hash === entry.after, `${version}/${relative}: installed source does not match either approved complete hash`);
    if (hash === entry.after) {
      let shift = 0;
      const edits = entry.edits.map(edit => {
        const applied = { ...edit, offset: edit.offset + shift };
        shift += edit.after.length - edit.before.length;
        return applied;
      });
      for (const edit of edits.reverse()) {
        assert.equal(source.slice(edit.offset, edit.offset + edit.after.length), edit.after, `${relative}: reverse patch context`);
        source = source.slice(0, edit.offset) + edit.before + source.slice(edit.offset + edit.after.length);
      }
      assert.equal(digest(source), entry.before, `${relative}: recovered official complete source hash`);
      await writeFile(filename, source);
    }
  }
  await assertManifestHashes(directory, version, 'before');
}

try {
  const installed = await installedZodPackages();
  for (const version of versions) {
    originalPaths[version] = join(fixture, 'original', version);
    paths[version] = join(fixture, 'patched', version);
    await cp(installed.get(version), originalPaths[version], { recursive: true, dereference: true });
    await restoreOfficialSources(originalPaths[version], version);
    await cp(originalPaths[version], paths[version], { recursive: true });
  }
  const beforeHashes = Object.fromEntries(await Promise.all(versions.map(async version => [version, await packageHashes(paths[version])])));
  const result = await patchZod(Object.values(paths));
  assert.equal(result.packages, versions.length);
  assert.equal(result.filesPatched, versions.reduce((total, version) => total + Object.keys(manifest[version]).length, 0));
  for (const version of versions) {
    await assertManifestHashes(paths[version], version, 'after');
    const expected = { ...beforeHashes[version] };
    for (const [relative, entry] of Object.entries(manifest[version])) expected[relative] = entry.after;
    assert.deepEqual(await packageHashes(paths[version]), expected, `${version}: only manifest-approved complete files may change`);
  }
  await patchZod(Object.values(paths), { verify: true });
} catch (error) {
  await rm(fixture, { recursive: true, force: true });
  throw error;
}

async function importFile(path) { return import(pathToFileURL(path)); }
async function compileSource(dir) {
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const filename = join(dir,entry.name);
    if (entry.isDirectory()) await compileSource(filename);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const output = stripTypeScriptTypes(await readFile(filename,'utf8'), {mode:'transform',sourceMap:false});
      await writeFile(filename.slice(0,-3)+'.js',output);
    }
  }
}
await compileSource(join(paths['3.25.76'],'src'));
for (const version of ['4.6.6', '4.6.7']) await compileSource(join(paths[version], 'src/v3'));
const v3Surfaces = [
  ['3.22.4 require', require(join(paths['3.22.4'],'lib/index.js'))],
  ['3.22.4 import', await importFile(join(paths['3.22.4'],'lib/index.mjs'))],
  ['3.22.4 UMD', require(join(paths['3.22.4'],'lib/index.umd.js'))],
  ['3.25.76 require', require(join(paths['3.25.76'],'index.cjs'))],
  ['3.25.76 import', await importFile(join(paths['3.25.76'],'index.js'))],
  ['3.25.76 /v3 require', require(join(paths['3.25.76'],'v3/index.cjs'))],
  ['3.25.76 /v3 import', await importFile(join(paths['3.25.76'],'v3/index.js'))],
  ['3.25.76 source root', await importFile(join(paths['3.25.76'],'src/index.js'))],
  ['3.25.76 source /v3', await importFile(join(paths['3.25.76'],'src/v3/index.js'))],
];
for (const version of ['4.6.6', '4.6.7']) {
  v3Surfaces.push([`${version} /v3 require`, require(join(paths[version], 'v3/index.cjs'))]);
  v3Surfaces.push([`${version} /v3 import`, await importFile(join(paths[version], 'v3/index.js'))]);
  v3Surfaces.push([`${version} source /v3`, await importFile(join(paths[version], 'src/v3/index.js'))]);
}
function issue(result, code='too_big') {assert.equal(result.success,false);assert.equal(result.error.issues[0].code,code);}
for (const [name,z] of v3Surfaces) test(name,async()=>{
  assert.deepEqual(z.record(z.string()).parse({a:'x'}),{a:'x'});
  assert.ok(Array.isArray(z.string().safeParse(1).error.errors));
  for (const [kind,cap] of [['array','max'],['array','length'],['set','max'],['set','size']]) {
    for (const async of [false,true]) {
      let elements=0, outer=0;
      const value = async ? z.any().refine(async()=>{elements++;return true}) : z.any().refine(()=>{elements++;return true});
      const inner=z[kind](value)[cap](1,'limited');
      const schema=inner.superRefine(()=>{outer++});
      const over=kind==='array'?[1,2]:new Set([1,2]);
      const result=async ? await schema.safeParseAsync(over) : schema.safeParse(over);
      issue(result); assert.equal(result.error.issues[0].message,'limited');
      assert.equal(elements,0); assert.equal(outer,0);
      const nested=z.object({nested:inner}).safeParseAsync({nested:over});
      const nestedResult=await nested;issue(nestedResult);assert.deepEqual(nestedResult.error.issues[0].path,['nested']);assert.equal(elements,0);
      const good=kind==='array'?[1]:new Set([1]);
      const valid=async ? await schema.safeParseAsync(good) : schema.safeParse(good);
      assert.equal(valid.success,true); assert.equal(elements,1);assert.equal(outer,1);
      if(cap==='length'||cap==='size') issue(await inner.safeParseAsync(kind==='array'?[]:new Set()),'too_small');
      const tooBig=kind==='array'?[1,2]:new Set([1,2]);
      if(kind==='array') Object.defineProperty(tooBig,0,{get(){throw new Error('element getter accessed')}});
      else {tooBig.values=()=>{throw new Error('set traversed')};tooBig[Symbol.iterator]=()=>{throw new Error('set traversed')};}
      issue(await inner.safeParseAsync(tooBig));
    }
  }
  const failed=z.array(z.number()).max(1).safeParse([1,2]);assert.equal(failed.error.issues[0].maximum,1);
  assert.deepEqual(z.array(z.string()).max(0).parse([]),[]);
  issue(z.array(z.string()).max(0).safeParse(['x']));
  let negativeLimitElements = 0;
  issue(z.array(z.any().refine(() => { negativeLimitElements++; return true; })).max(-1).safeParse([1]));
  assert.equal(negativeLimitElements, 0);
  issue(z.set(z.any().refine(() => { negativeLimitElements++; return true; })).max(-1).safeParse(new Set([1])));
  assert.equal(negativeLimitElements, 0);
  assert.equal(z.union([z.array(z.string()).max(0),z.literal('ok')]).safeParse([1]).success,false);
});
const classicSurfaces=[];
for(const extension of ['cjs','js']) classicSurfaces.push([`v4 ${extension}`,extension==='cjs'?require(join(paths['3.25.76'],`v4/index.${extension}`)):await importFile(join(paths['3.25.76'],`v4/index.${extension}`))]);
classicSurfaces.push(['v4 source',await importFile(join(paths['3.25.76'],'src/v4/index.js'))]);
for (const extension of ['cjs', 'js']) classicSurfaces.push([`v4/classic ${extension}`, extension === 'cjs' ? require(join(paths['3.25.76'], `v4/classic/index.${extension}`)) : await importFile(join(paths['3.25.76'], `v4/classic/index.${extension}`))]);
classicSurfaces.push(['v4/classic source', await importFile(join(paths['3.25.76'], 'src/v4/classic/index.js'))]);
for(const [name,z] of classicSurfaces) test(name,async()=>{
  for(const [kind,cap] of [['array','max'],['array','length'],['set','max'],['set','size'],['map','max'],['map','size']]) {
    for(const async of [false,true]) {
      let elements=0,outer=0;
      const element=async?z.any().refine(async()=>{elements++;return true}):z.any().refine(()=>{elements++;return true});
      const base=kind==='map'?z.map(element,element):z[kind](element);
      const bound=()=>kind==='map'?base.check(cap==='max'?z.maxSize(1,{error:'limited'}):z.size(1,{error:'limited'})):base[cap](1,{error:'limited'});
      const schema=bound().refine(()=>{outer++;return true});
      const value=n=>kind==='array'?Array.from({length:n},(_,i)=>i):kind==='set'?new Set(Array.from({length:n},(_,i)=>i)):new Map(Array.from({length:n},(_,i)=>[i,i]));
      issue(async?await schema.safeParseAsync(value(2)):schema.safeParse(value(2)));
      assert.equal(elements,0);assert.equal(outer,0);
      issue(await z.object({nested:schema}).safeParseAsync({nested:value(2)}));assert.equal(elements,0);
      assert.equal((async?await schema.safeParseAsync(value(1)):schema.safeParse(value(1))).success,true);
      assert.equal(elements,kind==='map'?2:1);assert.equal(outer,1);
      if(cap==='length'||cap==='size')issue(await bound().safeParseAsync(value(0)),'too_small');
    }
  }
  let visited=0,refined=0;
  const ordered=z.array(z.any().refine(()=>{visited++;return true})).refine(()=>{refined++;return true}).max(1);
  issue(ordered.safeParse([1,2]));assert.equal(visited,2);assert.equal(refined,1);
  visited=0;
  const skipped=z.array(z.any().refine(()=>{visited++;return true})).max(1);
  skipped._zod.def.checks[0]._zod.def.when=()=>false;
  assert.equal(skipped.safeParse([1,2]).success,true);assert.equal(visited,2);
});
for(const prefix of ['v4-mini','v4/mini']) for(const extension of ['cjs','js']) test(`${prefix} ${extension}`,async()=>{
  const z=extension==='cjs'?require(join(paths['3.25.76'],prefix,`index.${extension}`)):await importFile(join(paths['3.25.76'],prefix,`index.${extension}`));
  let count=0;
  const element=z.any().check(z.refine(()=>{count++;return true}));
  for(const [base,check,input] of [[z.array(element),z.maxLength(1),[1,2]],[z.set(element),z.maxSize(1),new Set([1,2])],[z.map(element,element),z.maxSize(1),new Map([[1,1],[2,2]])]]) {
    issue(z.safeParse(base.check(check),input));issue(await z.safeParseAsync(base.check(check),input));assert.equal(count,0);
  }
});
for(const prefix of ['v4-mini','v4/mini']) test(`${prefix} source`,async()=>{
  const z=await importFile(join(paths['3.25.76'],'src',prefix,'index.js'));
  let count=0; const element=z.any().check(z.refine(()=>{count++;return true}));
  for(const [base,check,input] of [[z.array(element),z.maxLength(1),[1,2]],[z.set(element),z.maxSize(1),new Set([1,2])],[z.map(element,element),z.maxSize(1),new Map([[1,1],[2,2]])]]) {
    issue(z.safeParse(base.check(check),input));issue(await z.safeParseAsync(base.check(check),input));assert.equal(count,0);
  }
});
for(const variant of ['cjs','js','source']) test(`v4/core ${variant}`,async()=>{
  const c=variant==='cjs'?require(join(paths['3.25.76'],'v4/core/index.cjs')):await importFile(join(paths['3.25.76'],variant==='source'?'src/v4/core/index.js':'v4/core/index.js'));
  let count=0; const element=new c.$ZodAny({type:'any'});const parse=element._zod.parse;element._zod.parse=(...args)=>{count++;return parse(...args)};element._zod.run=element._zod.parse;
  for(const [Ctor,def,input,check] of [[c.$ZodArray,{type:'array',element},[1,2],new c.$ZodCheckMaxLength({check:'max_length',maximum:1})],[c.$ZodSet,{type:'set',valueType:element},new Set([1,2]),new c.$ZodCheckMaxSize({check:'max_size',maximum:1})],[c.$ZodMap,{type:'map',keyType:element,valueType:element},new Map([[1,1],[2,2]]),new c.$ZodCheckMaxSize({check:'max_size',maximum:1})]]) {
    const schema=new Ctor({...def,checks:[check]});issue(c.safeParse(schema,input));issue(await c.safeParseAsync(schema,input));assert.equal(count,0);
  }
});
test('regression reproduces on untouched official releases',()=>{
  for(const version of ['3.22.4','3.25.76']) {
    const root=originalPaths[version]; const z=require(join(root,version==='3.22.4'?'lib/index.js':'index.cjs'));
    let count=0;issue(z.array(z.any().refine(()=>{count++;return true})).max(1).safeParse([1,2]));assert.equal(count,2);
  }
  const z=require(join(originalPaths['3.25.76'],'v4/index.cjs'));let count=0;issue(z.array(z.any().refine(()=>{count++;return true})).max(1).safeParse([1,2]));assert.equal(count,2);
});
test('v4 leading cap suppresses even later conditional refinements',()=>{
  const z=require(join(paths['3.25.76'],'v4/index.cjs'));
  let elements=0,later=0;
  const schema=z.array(z.string().transform(x=>{elements++;return x.toUpperCase()})).max(1).refine(value=>{later++;return value.every(x=>x===x.toUpperCase())},{when:()=>true});
  issue(schema.safeParse(['a','b']));assert.equal(elements,0);assert.equal(later,0);
  assert.deepEqual(schema.parse(['a']),['A']);assert.equal(elements,1);assert.equal(later,1);
});
test('v4 internal skipChecks/backward contexts retain upstream traversal behavior',()=>{
  const c=require(join(paths['3.25.76'],'v4/core/index.cjs'));
  for(const ctx of [{skipChecks:true},{direction:'backward'}]) {
    let count=0;const element=new c.$ZodAny({type:'any'});element._zod.run=payload=>{count++;return payload};
    const schema=new c.$ZodArray({type:'array',element,checks:[new c.$ZodCheckMaxLength({check:'max_length',maximum:1})]});
    schema._zod.run({value:[1,2],issues:[]},ctx);assert.equal(count,2);
  }
});
// A catch fallback replaces the raw input and clears the cap issue. Its own
// refinements must execute, including on the same payload object.
for (const [name,z] of v3Surfaces) test(`${name} catch fallback refinements`,async()=>{
  for(const async of [false,true]) for(const valid of [false,true]) {
    let calls=0;
    const predicate=value=>{calls++;assert.deepEqual(value,[]);return valid};
    const schema=z.array(z.number()).max(1).catch([]).refine(async?async value=>predicate(value):predicate);
    const result=async?await schema.safeParseAsync([1,2]):schema.safeParse([1,2]);
    assert.equal(result.success,valid);if(valid)assert.deepEqual(result.data,[]);else issue(result,'custom');assert.equal(calls,1);
    calls=0;const nested=await z.object({items:schema}).safeParseAsync({items:[1,2]});assert.equal(nested.success,valid);assert.equal(calls,1);
    if(!valid)assert.deepEqual(nested.error.issues[0].path,['items']);
  }
});
const v4CatchSurfaces=[...classicSurfaces];
for(const prefix of ['v4-mini','v4/mini']) for(const variant of ['cjs','js','source']) {
  const z=variant==='cjs'?require(join(paths['3.25.76'],prefix,'index.cjs')):await importFile(join(paths['3.25.76'],variant==='source'?'src':'',prefix,'index.js'));
  v4CatchSurfaces.push([`${prefix} ${variant}`,z]);
}
for(const [name,z] of v4CatchSurfaces) test(`${name} catch fallback refinements`,async()=>{
  for(const async of [false,true]) for(const valid of [false,true]) for(const conditional of [false,true]) {
    let elements=0,calls=0;
    const bounded=z.array(z.number().check(z.refine(()=>{elements++;return true}))).check(z.maxLength(1));
    // Exercise both the immediate and Promise-returning $ZodCatch branches.
    const inputSchema=async?z.pipe(z.transform(async value=>value),bounded):bounded;
    const predicate=value=>{calls++;assert.deepEqual(value,[]);return valid};
    const fallback=z.catch(inputSchema,[]);
    const schema=fallback.check(z.refine(async?async value=>predicate(value):predicate,conditional?{when:()=>true}:{}));
    const result=async?await z.safeParseAsync(schema,[1,2]):z.safeParse(schema,[1,2]);
    assert.equal(result.success,valid);if(valid)assert.deepEqual(result.data,[]);else issue(result,'custom');assert.equal(calls,1);assert.equal(elements,0);
    calls=0;const nested=await z.safeParseAsync(z.object({items:schema}),{items:[1,2]});assert.equal(nested.success,valid);assert.equal(calls,1);assert.equal(elements,0);
    if(!valid)assert.deepEqual(nested.error.issues[0].path,['items']);
  }
});
for(const variant of ['cjs','js','source']) test(`v4/core ${variant} catch fallback refinements`,async()=>{
  const c=variant==='cjs'?require(join(paths['3.25.76'],'v4/core/index.cjs')):await importFile(join(paths['3.25.76'],variant==='source'?'src/v4/core/index.js':'v4/core/index.js'));
  for(const async of [false,true]) for(const valid of [false,true]) {
    let calls=0;
    const custom=new c.$ZodCheck({check:'custom'});
    const inspect=payload=>{calls++;assert.deepEqual(payload.value,[]);if(!valid)payload.issues.push({code:'custom',input:payload.value,inst:custom,continue:true})};
    custom._zod.check=async?async payload=>inspect(payload):inspect;
    const bounded=new c.$ZodArray({type:'array',element:new c.$ZodNumber({type:'number'}),checks:[new c.$ZodCheckMaxLength({check:'max_length',maximum:1})]});
    const schema=new c.$ZodCatch({type:'catch',innerType:bounded,catchValue:()=>[],checks:[custom]});
    const result=async?await c.safeParseAsync(schema,[1,2]):c.safeParse(schema,[1,2]);
    assert.equal(result.success,valid);if(valid)assert.deepEqual(result.data,[]);else issue(result,'custom');assert.equal(calls,1);
    calls=0;const nested=new c.$ZodObject({type:'object',shape:{items:schema}});const nestedResult=await c.safeParseAsync(nested,{items:[1,2]});assert.equal(nestedResult.success,valid);assert.equal(calls,1);
    if(!valid)assert.deepEqual(nestedResult.error.issues[0].path,['items']);
  }
});

// Lifecycle mutations use their own packages, leaving all runtime surfaces pristine.
async function isolatedOriginals(t) {
  const directory = await mkdtemp(join(fixture, 'lifecycle-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const roots = {};
  for (const version of versions) {
    roots[version] = join(directory, version);
    await cp(originalPaths[version], roots[version], { recursive: true });
  }
  return { directory, roots };
}
async function snapshot(roots) {
  const contents = {};
  for (const [version, root] of Object.entries(roots)) {
    contents[`${version}/package.json`] = await readFile(join(root, 'package.json'), 'utf8');
    for (const relative of Object.keys(manifest[version])) contents[`${version}/${relative}`] = await readFile(join(root, relative), 'utf8');
  }
  return contents;
}

test('installer is idempotent and verifies every full-file hash', async () => {
  assert.deepEqual(await patchZod(Object.values(paths)), { packages: versions.length, filesPatched: 0, verified: false });
  assert.deepEqual(await patchZod(Object.values(paths), { verify: true }), { packages: versions.length, filesPatched: 0, verified: true });
  for (const version of versions) {
    await assertManifestHashes(originalPaths[version], version, 'before');
    await assertManifestHashes(paths[version], version, 'after');
  }
});

test('installer requires explicit package roots', async () => {
  await assert.rejects(patchZod([]), /Explicit Zod package directories are required/);
});

test('verification rejects untouched releases without writing', async t => {
  const { roots } = await isolatedOriginals(t);
  const before = await snapshot(roots);
  await assert.rejects(patchZod(Object.values(roots), { verify: true }), /patch missing or changed/i);
  assert.deepEqual(await snapshot(roots), before);
});

for (const change of ['unknown version', 'wrong package name', 'source drift', 'symlink target']) {
  test(`installer checks all packages before writing: ${change}`, async t => {
    const { directory, roots } = await isolatedOriginals(t);
    const root = roots['3.25.76'];
    let expected;
    if (change === 'unknown version' || change === 'wrong package name') {
      const filename = join(root, 'package.json');
      const pkg = JSON.parse(await readFile(filename, 'utf8'));
      if (change === 'unknown version') pkg.version = '3.25.77';
      else pkg.name = 'not-zod';
      await writeFile(filename, JSON.stringify(pkg));
      expected = /Unsupported Zod package\/version/;
    } else {
      const relative = Object.keys(manifest['3.25.76']).at(-1);
      const filename = join(root, relative);
      if (change === 'source drift') {
        await writeFile(filename, `${await readFile(filename, 'utf8')}\n// fixture drift\n`);
        expected = /Unexpected package content/;
      } else {
        const target = join(directory, 'external-target');
        await cp(filename, target);
        await rm(filename);
        await symlink(target, filename);
        expected = /Refusing symlinked patch target/;
      }
    }
    const before = await snapshot(roots);
    await assert.rejects(patchZod(Object.values(roots)), expected);
    assert.deepEqual(await snapshot(roots), before, 'no earlier valid package or file may be written');
  });
}

test('installer rejects drift after patching in apply and verify modes', async t => {
  const { roots } = await isolatedOriginals(t);
  await patchZod(Object.values(roots));
  const filename = join(roots['3.22.4'], Object.keys(manifest['3.22.4'])[0]);
  await writeFile(filename, `${await readFile(filename, 'utf8')}\n// fixture drift\n`);
  const before = await snapshot(roots);
  await assert.rejects(patchZod(Object.values(roots)), /Unexpected package content/);
  await assert.rejects(patchZod(Object.values(roots), { verify: true }), /patch missing or changed/i);
  assert.deepEqual(await snapshot(roots), before);
});

test('installer resolves package aliases and patches each real directory once', async t => {
  const { directory, roots } = await isolatedOriginals(t);
  const alias = join(directory, 'alias');
  await symlink(roots['3.22.4'], alias, 'dir');
  assert.deepEqual(await patchZod([roots['3.22.4'], alias, roots['3.22.4']]), {
    packages: 1,
    filesPatched: Object.keys(manifest['3.22.4']).length,
    verified: false,
  });
  await assertManifestHashes(roots['3.22.4'], '3.22.4', 'after');
  await assertManifestHashes(roots['3.25.76'], '3.25.76', 'before');
});

for (const version of ['4.6.6', '4.6.7']) {
  test(`${version} untouched v3 demonstrates the regression`, () => {
    const z = require(join(originalPaths[version], 'v3/index.cjs'));
    let calls = 0;
    issue(z.array(z.any().refine(() => { calls++; return true; })).max(1).safeParse([1, 2]));
    assert.equal(calls, 2);
  });
  for (const extension of ['cjs', 'js']) test(`${version} root v4 preserves upstream behavior (${extension})`, async () => {
    const modules = [];
    for (const root of [originalPaths[version], paths[version]]) {
      modules.push(extension === 'cjs' ? require(join(root, 'index.cjs')) : await importFile(join(root, 'index.js')));
    }
    const outcomes = modules.map(z => {
      let elements = 0;
      let refinements = 0;
      const bounded = z.array(z.number().refine(() => { elements++; return true; })).max(1);
      const rejected = bounded.safeParse([1, 2]);
      const schema = bounded.catch([]).refine(value => { refinements++; assert.deepEqual(value, []); return false; });
      const caught = schema.safeParse([1, 2]);
      return { rejected: rejected.error.issues, caught: caught.error.issues, elements, refinements, valid: bounded.parse([1]) };
    });
    assert.deepEqual(outcomes[1], outcomes[0]);
    assert.equal(outcomes[1].refinements, 1);
  });
}

test('fixture loader recovers hash-identical official sources from already patched copies', async t => {
  const { roots } = await isolatedOriginals(t);
  await patchZod(Object.values(roots));
  for (const version of versions) {
    await assertManifestHashes(roots[version], version, 'after');
    await restoreOfficialSources(roots[version], version);
    assert.deepEqual(await packageHashes(roots[version]), await packageHashes(originalPaths[version]));
  }
});
