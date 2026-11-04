import { expect, test } from './fixtures.ts';
import { APP_URL, HARNESS_URL } from './urls.ts';
import { fakeSupabase, person, signedIn } from './fake-supabase.ts';
import { showView } from './views.ts';
import { point, selection } from './rendered-support.ts';
import { imageDigest, imageObjectKeys } from '../../src/features/images/types.ts';

const PREVIEW = 'iframe[title="Isolated document preview"]';
const SOURCE = 'import { Slow } from "workspace:slow.mdx"\n\n# Read while loading\n\nIndependent prose remains readable.\n\n<Slow />\n';
const MODULE = 'export const Slow = () => <p className="loaded-component">Component finished.</p>\n';

test.describe.configure({timeout:60_000});

for (const failure of [false, true]) {
  test(`MDX prose is readable before ${failure ? 'failed' : 'delayed'} modules settle`, async ({page, appErrors}) => {
    if (failure) appErrors.expect('Unavailable component slow.mdx');
    await page.goto(new URL('rendered.html', HARNESS_URL).href);
    await page.evaluate(({source, module, failure}) => {
      window.renderedHarness.prepareModules(failure ? {} : {'slow.mdx': module});
      window.renderedHarness.load(source, 'mdx');
    }, {source:SOURCE,module:MODULE,failure});
    const frame = page.frameLocator(PREVIEW);
    await expect(frame.getByRole('heading', {name:'Read while loading'})).toBeVisible();
    await expect(frame.getByRole('status').filter({hasText:'Loading component.'})).toBeVisible();
    await expect(frame.locator('[contenteditable="true"]')).toHaveCount(0);
    // The Source view remains authoritative and can change while modules wait.
    await page.evaluate(source => window.renderedHarness.edit(source.replace('Independent prose', 'Updated prose')), SOURCE);
    await expect(frame.getByText('Updated prose remains readable.', {exact:true})).toBeVisible();
    if (!failure) {
      await page.locator(PREVIEW).evaluate(element => {element.setAttribute('data-instance','kept');});
      await frame.getByText('Updated prose remains readable.',{exact:true}).evaluate(element => {element.setAttribute('data-instance','kept-prose');});
      const from = await point(page,'Updated prose remains readable.',0);
      const to = await point(page,'Updated prose remains readable.',13);
      await page.mouse.move(from.x,from.y);
      await page.mouse.down();
      await page.mouse.move(to.x,to.y,{steps:6});
      await page.mouse.up();
      await expect.poll(async () => (await selection(page)).text).toContain('Updated prose');
    }
    await page.evaluate(() => window.renderedHarness.releaseModules());
    if (failure) {
      await expect(frame.getByRole('status').filter({hasText:'Component unavailable.'})).toBeVisible();
      await expect(frame.getByText('Updated prose remains readable.', {exact:true})).toBeVisible();
    } else {
      await expect(frame.locator('.loaded-component')).toHaveText('Component finished.');
      await expect(frame.locator('[contenteditable="true"]')).toBeVisible();
      await expect(page.locator(PREVIEW)).toHaveAttribute('data-instance','kept');
      await expect(frame.locator('p[data-instance="kept-prose"]')).toHaveText('Updated prose remains readable.');
      await expect.poll(async () => (await selection(page)).text).toContain('Updated prose');
    }
  });
}

test('late module results cannot overwrite navigation to another document', async ({page}) => {
  await page.goto(new URL('rendered.html', HARNESS_URL).href);
  await page.evaluate(({source, module}) => {
    window.renderedHarness.prepareModules({'slow.mdx':module});
    window.renderedHarness.load(source, 'mdx');
  }, {source:SOURCE,module:MODULE});
  await expect(page.frameLocator(PREVIEW).getByRole('heading', {name:'Read while loading'})).toBeVisible();
  await page.evaluate(() => window.renderedHarness.load('# Another document\n\nCurrent prose.', 'md'));
  await expect(page.frameLocator(PREVIEW).getByRole('heading', {name:'Another document'})).toBeVisible();
  await page.evaluate(() => window.renderedHarness.releaseModules());
  await expect(page.frameLocator(PREVIEW).locator('.loaded-component')).toHaveCount(0);
  await expect(page.frameLocator(PREVIEW).getByText('Current prose.', {exact:true})).toBeVisible();
});

test('invalid MDX reports the complete-source error during module preparation', async ({page, appErrors}) => {
  appErrors.expect('Invalid MDX:');
  await page.goto(new URL('rendered.html', HARNESS_URL).href);
  await page.evaluate(() => {
    window.renderedHarness.prepareModules({});
    window.renderedHarness.load('# Earlier text\n\n<Broken', 'mdx');
  });
  await expect(page.getByRole('alert').filter({hasText:'Invalid MDX:'})).toBeVisible();
  await expect(page.frameLocator(PREVIEW).getByRole('heading', {name:'Earlier text'})).toHaveCount(0);
});


declare global {
  interface Window {
    previewDecode: {calls:number; blocked:boolean; release:() => void};
  }
}

test('Source does no preview decoding or diagram work, and a ready image appears while another decode is blocked', async ({page}) => {
  await page.setViewportSize({width:1280,height:900});
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const decode = HTMLImageElement.prototype.decode;
    const createObjectURL = URL.createObjectURL.bind(URL);
    const sources = new Map<string,Promise<string>>();
    URL.createObjectURL = object => {
      const url = createObjectURL(object);
      if (object instanceof Blob && object.type === 'image/svg+xml') sources.set(url,object.text());
      return url;
    };
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    window.previewDecode = {calls:0,blocked:false,release};
    HTMLImageElement.prototype.decode = async function () {
      ++window.previewDecode.calls;
      const decoded = decode.call(this);
      const source = await sources.get(this.src);
      if (source?.includes('fill="red"')) {
        window.previewDecode.blocked = true;
        await Promise.all([decoded,gate]);
      } else await decoded;
    };
  });
  const engines: string[] = [];
  page.on('request', request => {
    if (/\/assets\/(?:diagramEmbed|d2|diagramEngine|excalidraw)[^/]*\.js$/.test(new URL(request.url()).pathname)) engines.push(request.url());
  });
  const fake = await fakeSupabase(page);
  const remote = fake.server.remote(person.id);
  const projectId = crypto.randomUUID();
  await remote.createProject(projectId, 'Progressive previews');
  const previewBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
  const changes: Array<{op:'asset';path:string;asset_id:string}> = [];
  for (const [name,color] of [['first','red'],['second','blue'],['third','green']]) {
    const bytes = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="${color}"/></svg>`);
    const assetId = crypto.randomUUID();
    const asset = {id:assetId,...imageObjectKeys(projectId,assetId),media_type:'image/svg+xml' as const,byte_length:bytes.length,width:2,height:2,sha256:await imageDigest(bytes),preview_type:'image/png' as const,preview_byte_length:previewBytes.length,preview_width:1,preview_height:1};
    await remote.uploadImage!(projectId,asset,new Blob([bytes],{type:'image/svg+xml'}));
    fake.server.assets.get(`${projectId}/${assetId}`)!.preview = new Blob([previewBytes],{type:'image/png'});
    changes.push({op:'asset',path:`${name}.svg`,asset_id:assetId});
  }
  await remote.saveFiles(projectId,crypto.randomUUID(),[
    ...changes,
    {op:'put',path:'note.mdx',content:'# Visible text\n\n![First image](first.svg)\n\n![Second image](second.svg)\n\n<Diagram src="flow.d2" />\n'},
    {op:'put',path:'flow.d2',content:'a -> b\n'},
    {op:'put',path:'child.mdx',content:'# Deferred child\n\n![Child image](third.svg)\n'},
  ]);
  await signedIn(page);
  await page.goto(new URL(`projects/${projectId}/note.mdx`,APP_URL).href);
  await expect(page.locator('.monaco-editor:visible')).toBeVisible();
  await expect(page.getByRole('status').filter({hasText:'Synced'})).toBeVisible();
  // A settled event boundary, not a sleep, proves background sync itself
  // never starts the rendering work that only Rendered needs.
  await page.waitForLoadState('networkidle');
  expect(await page.evaluate(() => window.previewDecode.calls)).toBe(0);
  expect(engines).toEqual([]);
  await showView(page,'Rendered');
  const frame = page.frameLocator(PREVIEW);
  await expect(frame.getByRole('heading',{name:'Visible text'})).toBeVisible();
  await expect(frame.locator('img[alt="Second image"][src^="data:"]:visible')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.previewDecode.blocked)).toBe(true);
  await expect(frame.locator('img[alt="First image"][src^="data:"]:visible')).toHaveCount(0);
  // A genuine store update must retain the ready sibling's pixels and DOM
  // while the other decode is still waiting, rather than clear and reload it.
  const second = await frame.locator('img[alt="Second image"][src^="data:"]:visible').elementHandle();
  expect(second).not.toBeNull();
  const beforeStoreChange = await page.evaluate(() => window.previewDecode.calls);
  const saved = await remote.saveFiles(projectId,crypto.randomUUID(),[{op:'put',path:'unrelated.md',content:'Another file arrived.\n'}]);
  fake.signal(projectId,saved.project.revision);
  await expect(page.getByRole('button',{name:'unrelated.md',exact:true})).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.previewDecode.calls)).toBeGreaterThan(beforeStoreChange);
  await page.waitForLoadState('networkidle');
  await expect(frame.locator('img[alt="Second image"][src^="data:"]:visible')).toBeVisible();
  expect(await second!.evaluate(element => element.isConnected)).toBe(true);
  const placeholder = frame.locator('.project-image-missing[aria-label="First image"]');
  await expect(placeholder).toHaveCSS('aspect-ratio','2 / 2');
  const before = await placeholder.boundingBox();
  const secondBefore = await frame.locator('img[alt="Second image"][src^="data:"]:visible').boundingBox();
  expect(before?.width).toBe(2);
  expect(before?.height).toBe(2);
  await page.evaluate(() => window.previewDecode.release());
  const first = frame.locator('img[alt="First image"][src^="data:"]:visible');
  await expect(first).toBeVisible();
  const after = await first.boundingBox();
  const secondAfter = await frame.locator('img[alt="Second image"][src^="data:"]:visible').boundingBox();
  expect(after?.width).toBe(before?.width);
  expect(after?.height).toBe(before?.height);
  expect(secondAfter?.y).toBe(secondBefore?.y);
  // A previously opened Rendered pane stays mounted behind Source. New
  // source must not expand a child or decode its image in that hidden pane.
  await showView(page,'Source');
  const decodes = await page.evaluate(() => window.previewDecode.calls);
  await page.locator('.monaco-editor:visible .view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\n<Document src="child.mdx" />\n');
  await expect.poll(async () => (await page.locator('.monaco-editor:visible .view-lines').innerText()).match(/<Document\s+src="child\.mdx"\s*\/>/g)?.length ?? 0).toBe(1);
  await page.waitForLoadState('networkidle');
  expect(await page.evaluate(() => window.previewDecode.calls)).toBe(decodes);
  await expect(frame.locator('iframe')).toHaveCount(0);
  await showView(page,'Rendered');
  await expect(frame.locator('iframe[title="Embedded document: child.mdx"]')).toHaveCount(1);
  const child = frame.frameLocator('iframe[title="Embedded document: child.mdx"]');
  await expect(child.locator('img[alt="Child image"][src^="data:"]:visible')).toBeVisible();
  expect(await page.evaluate(() => window.previewDecode.calls)).toBeGreaterThan(decodes);
});


test('collapsed child preparation is deferred and expanded child prose remains readable while its module waits', async ({page}) => {
  await page.goto(new URL('rendered.html',HARNESS_URL).href);
  await page.evaluate(({source,module}) => {
    window.renderedHarness.prepareModules({'slow.mdx':module});
    window.renderedHarness.setEmbeddedDocuments({'child.mdx':source});
    window.renderedHarness.load('# Parent\n\n<Document src="child.mdx" title="Details" defaultCollapsed />\n','mdx');
  },{source:SOURCE,module:MODULE});
  const parent = page.frameLocator(PREVIEW);
  const toggle = parent.getByRole('button',{name:'Details',exact:true});
  await expect(toggle).toHaveAttribute('aria-expanded','false');
  await expect(parent.locator('iframe')).toHaveCount(0);
  await toggle.click();
  const child = parent.frameLocator('iframe[title="Embedded document: Details"]');
  await expect(child.getByRole('heading',{name:'Read while loading'})).toBeVisible();
  await expect(child.getByRole('status').filter({hasText:'Loading component.'})).toBeVisible();
  await toggle.click();
  await expect(parent.locator('iframe')).toHaveCount(1);
  await page.evaluate(() => window.renderedHarness.releaseModules());
  await toggle.click();
  await expect(child.locator('.loaded-component')).toHaveText('Component finished.');
});


test('a collapsed retained child defers new projection until expansion and keeps its frame', async ({page}) => {
  await page.goto(new URL('rendered.html',HARNESS_URL).href);
  await page.evaluate(() => {
    window.renderedHarness.setEmbeddedDocuments({'child.md':'# Original child\n\nBefore change.'});
    window.renderedHarness.load('# Parent\n\n<Document src="child.md" title="Details" />\n','mdx');
  });
  const parent = page.frameLocator(PREVIEW);
  const child = parent.frameLocator('iframe[title="Embedded document: Details"]');
  await expect(child.getByRole('heading',{name:'Original child'})).toBeVisible();
  await parent.locator('iframe').evaluate(element => {element.setAttribute('data-instance','retained');});
  const toggle = parent.getByRole('button',{name:'Details',exact:true});
  await toggle.click();
  await page.evaluate(() => window.renderedHarness.editEmbedded('child.md','# Updated child\n\nAfter change.'));
  // The trusted owner activity update has committed; a hidden frame still
  // holds its last projection rather than running new document source.
  await expect(toggle).toHaveAttribute('aria-expanded','false');
  await expect(child.getByRole('heading',{name:'Updated child'})).toHaveCount(0);
  await toggle.click();
  await expect(child.getByRole('heading',{name:'Updated child'})).toBeVisible();
  await expect(parent.locator('iframe')).toHaveAttribute('data-instance','retained');
});


test('late validated modules still supply Source completion metadata after an incomplete tag without executing old source', async ({page,appErrors}) => {
  appErrors.expect('Invalid MDX:');
  appErrors.expect('Unexpected end of file in name');
  await page.goto(new URL('rendered.html',HARNESS_URL).href);
  await page.evaluate(({source,module}) => {
    window.renderedHarness.prepareModules({'slow.mdx':module});
    window.renderedHarness.load(source,'mdx');
  },{source:SOURCE,module:MODULE});
  await expect.poll(() => page.evaluate(() => window.renderedHarness.componentPreparation().moduleReads)).toBeGreaterThan(0);
  await expect(page.frameLocator(PREVIEW).getByRole('heading',{name:'Read while loading'})).toBeVisible();
  await page.evaluate(source => {
    window.renderedHarness.setActive(false);
    window.renderedHarness.edit(source+'\n<Slo');
  },SOURCE);
  await expect.poll(() => page.evaluate(() => window.renderedHarness.componentPreparation().error !== null)).toBe(true);
  await page.evaluate(() => window.renderedHarness.releaseModules());
  await expect.poll(() => page.evaluate(() => window.renderedHarness.componentPreparation().catalog)).toContain('Slow');
  const prepared = await page.evaluate(() => window.renderedHarness.componentPreparation());
  expect(prepared.error).not.toBeNull();
  expect(prepared.pending).toBe(false);
  expect(prepared.hasEnvironment).toBe(false);
  expect(prepared.currentEnvironment).toBe(false);
  await expect(page.frameLocator(PREVIEW).locator('.loaded-component')).toHaveCount(0);
  await expect(page.frameLocator(PREVIEW).locator('[contenteditable="true"]')).toHaveCount(0);
});

test('an expanded pending child reports its full safe prose height before its module is ready', async ({page}) => {
  await page.goto(new URL('rendered.html',HARNESS_URL).href);
  await page.evaluate(({module}) => {
    const child = 'import { Slow } from "workspace:slow.mdx"\n\n# Long pending child\n\n' +
      Array.from({length:35},(_,index) => `Pending child paragraph ${index + 1}.`).join('\n\n') + '\n\n<Slow />\n';
    window.renderedHarness.setEmbeddedDocuments({'child.mdx':child});
    window.renderedHarness.prepareModules({'slow.mdx':module});
    window.renderedHarness.load('# Parent\n\n<Document src="child.mdx" title="Expanded child" />\n','mdx');
  },{module:MODULE});
  const shell = page.frameLocator(PREVIEW).locator('[data-document-embed="child.mdx"]');
  const child = shell.frameLocator('iframe');
  await expect(child.getByRole('heading',{name:'Long pending child'})).toBeVisible();
  await expect(child.getByRole('status').filter({hasText:'Loading component.'})).toBeVisible();
  await expect(child.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect.poll(() => child.locator('html').evaluate(() => innerHeight)).toBeGreaterThan(1_000);
  await expect.poll(() => child.locator('html').evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(2);
  await expect(child.locator('.loaded-component')).toHaveCount(0);
  await page.evaluate(() => window.renderedHarness.releaseModules());
  await expect(child.locator('.loaded-component')).toHaveText('Component finished.');
});

test('a current provisional image can inspect its validated original without gaining edit authority', async ({page}) => {
  await page.goto(new URL('rendered.html',HARNESS_URL).href);
  const original = await page.evaluate(({module}) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="red"/></svg>';
    const original = {dataURL:`data:image/svg+xml;base64,${btoa(svg)}`,width:640,height:480};
    const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=480;
    const context = canvas.getContext('2d')!; context.fillStyle='red'; context.fillRect(0,0,640,480);
    window.renderedHarness.setImageOriginals({'image.svg':original});
    window.renderedHarness.prepareModules({'slow.mdx':module});
    window.renderedHarness.load('import { Slow } from "workspace:slow.mdx"\n\n# Pending image\n\n![Original vector](image.svg)\n\n<Slow />\n','mdx',
      {'image.svg':{dataURL:canvas.toDataURL('image/png'),width:640,height:480}});
    return original.dataURL;
  },{module:MODULE});
  const frame = page.frameLocator(PREVIEW);
  await expect(frame.getByRole('heading',{name:'Pending image'})).toBeVisible();
  await expect(frame.getByRole('status').filter({hasText:'Loading component.'})).toBeVisible();
  await frame.getByRole('button',{name:'View image: Original vector',exact:true}).click();
  const dialog = frame.getByRole('dialog',{name:'Original vector',exact:true});
  await expect(dialog.getByRole('img')).toHaveAttribute('src',original);
  await expect.poll(() => page.evaluate(() => window.renderedHarness.imageOriginalReads())).toBe(1);
  await dialog.getByRole('button',{name:'Close image',exact:true}).click();
  await expect(frame.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(frame.locator('.loaded-component')).toHaveCount(0);
  expect(await page.evaluate(() => window.renderedHarness.source())).toContain('![Original vector](image.svg)');
  await page.evaluate(() => window.renderedHarness.releaseModules());
  await expect(frame.locator('.loaded-component')).toHaveText('Component finished.');
});

test('a blocked old original read neither blocks a newer source nor clears its in-flight read', async ({page}) => {
  await page.goto(new URL('rendered.html',HARNESS_URL).href);
  const originals = await page.evaluate(({module}) => {
    const original = (color: string) => ({dataURL:`data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${color}"/></svg>`)}`,width:640,height:480});
    const red = original('red'), blue = original('blue');
    const canvas = document.createElement('canvas');canvas.width=640;canvas.height=480;
    window.renderedHarness.setImageOriginals({'image.svg':red});
    window.renderedHarness.holdImageOriginals('old');
    window.renderedHarness.prepareModules({'slow.mdx':module});
    window.renderedHarness.load('import { Slow } from "workspace:slow.mdx"\n\n# Before source change\n\n![Original vector](image.svg)\n\n<Slow />\n','mdx',
      {'image.svg':{dataURL:canvas.toDataURL('image/png'),width:640,height:480}});
    return {blue};
  },{module:MODULE});
  const frame = page.frameLocator(PREVIEW);
  const open = frame.getByRole('button',{name:'View image: Original vector',exact:true});
  const dialog = frame.getByRole('dialog',{name:'Original vector',exact:true});
  await open.click();
  await expect.poll(() => page.evaluate(() => window.renderedHarness.imageOriginalReads())).toBe(1);
  await dialog.getByRole('button',{name:'Close image',exact:true}).click();
  await page.evaluate(({blue}) => {
    window.renderedHarness.setImageOriginals({'image.svg':blue},false);
    window.renderedHarness.holdImageOriginals('new');
    window.renderedHarness.edit(window.renderedHarness.source().replace('Before source change','After source change'));
  },originals);
  await expect(frame.getByRole('heading',{name:'After source change'})).toBeVisible();
  await open.click();
  await expect.poll(() => page.evaluate(() => window.renderedHarness.imageOriginalReads())).toBe(2);
  await page.evaluate(() => window.renderedHarness.releaseImageOriginals('old'));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await dialog.getByRole('button',{name:'Close image',exact:true}).click();
  await open.click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => window.renderedHarness.imageOriginalReads())).toBe(2);
  await page.evaluate(() => window.renderedHarness.releaseImageOriginals('new'));
  await expect(dialog.getByRole('img')).toHaveAttribute('src',originals.blue.dataURL);
  await dialog.getByRole('button',{name:'Close image',exact:true}).click();
  await expect(frame.locator('[contenteditable="true"]')).toHaveCount(0);
  await page.evaluate(() => window.renderedHarness.releaseModules());
  await expect(frame.locator('.loaded-component')).toHaveText('Component finished.');
});
