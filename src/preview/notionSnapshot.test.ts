import {describe, expect, test} from 'bun:test';
import {DOMParser} from '@xmldom/xmldom';
import {serializeNotionSnapshot} from './notionSnapshot';
import {MAX_NOTION_SNAPSHOT_HTML_BYTES} from '../features/rendered/protocol';

function root(html: string): Element {
  return new DOMParser().parseFromString(`<div>${html}</div>`, 'text/xml').documentElement as unknown as Element;
}
const PNG = 'data:image/png;base64,AAAA';

describe('static component snapshots', () => {
  test('keeps rendered structure and escapes text without changing its live source DOM', () => {
    const node = root('<section><h2>Totals &amp; results</h2><p><strong>Ready</strong> &lt; next</p><table><tbody><tr><td colspan="2">7</td></tr></tbody></table></section>');
    const before = node.toString();
    expect(serializeNotionSnapshot(node)).toBe('<section><h2>Totals &amp; results</h2><p><strong>Ready</strong> &lt; next</p><table><tbody><tr><td colspan="2">7</td></tr></tbody></table></section>');
    expect(node.toString()).toBe(before);
  });

  test('passwords, other input values, menus, dialogs and executable markup cannot leave the frame', () => {
    const node = root('<p>Keep this result</p><form><label>Name</label><input value="private name"/><input type="password" value="password-secret"/><textarea>textarea-secret</textarea><select><option>selection-secret</option></select><button>Send</button></form><div role="dialog">modal-secret</div><div role="menu">menu-secret</div><script>script-secret</script><iframe src="https://external.example">frame-secret</iframe>');
    const html = serializeNotionSnapshot(node);
    expect(html).toBe('<p>Keep this result</p>Name<span>Send</span>');
    expect(html).not.toMatch(/secret|private name|input|textarea|select|script|iframe|form/);
  });

  test('keeps button labels as inert text while excluding authoring and menu actions', () => {
    const html = serializeNotionSnapshot(root('<button type="submit" onclick="submitSecret()" value="secret">Create account</button><button>Use a passkey</button><span class="document-code-actions"><button>Copy code</button><button>Edit code</button></span><div role="menu"><button>Private menu action</button></div>'));
    expect(html).toBe('<span>Create account</span><span>Use a passkey</span>');
    expect(html).not.toMatch(/button|onclick|secret|Copy code|Edit code|menu/);
  });

  test('live nested images keep their pixels but exclude image editing actions and dialogs', () => {
    const html = serializeNotionSnapshot(root(`<section><h2>Component result</h2><span class="project-image"><button class="project-image-open"><img src="${PNG}" alt="Result image" width="1" height="1"/></button><span class="project-image-actions"><button>Edit description</button><button>Edit caption</button><button>Replace image</button><button>Remove image</button></span><dialog class="project-image-description"><label>Image description<input value="private draft"/></label><button>Apply description</button></dialog></span><button>Create account</button></section>`));
    expect(html).toContain(`<img src="${PNG}" alt="Result image" width="1" height="1">`);
    expect(html).toContain('<h2>Component result</h2>');
    expect(html).toContain('<span>Create account</span>');
    expect(html).not.toMatch(/Edit description|Edit caption|Replace image|Remove image|Apply description|private draft|<dialog|<input/);
  });

  test('built-in authoring controls do not leak labels while rendered content and ordinary labels remain', () => {
    const html = serializeNotionSnapshot(root('<section><aside><strong>Callout title</strong><p>Callout content</p></aside><span class="callout-controls"><label class="authoring-prop-control">title<input value="draft title"/></label><label>tone<select><option>info</option></select></label></span><span><button>Count: 7</button><label class="authoring-prop-control">initial<input value="7"/></label><label class="authoring-prop-control">step<input value="2"/></label></span><form><label>Account name<input value="private name"/></label><button>Create account</button></form></section>'));
    expect(html).toBe('<section><aside><strong>Callout title</strong><p>Callout content</p></aside><span><span>Count: 7</span></span>Account name<span>Create account</span></section>');
    expect(html).not.toMatch(/draft title|private name|initial|step|tone|<input|<select/);
  });

  test('URL attributes and CSS cannot carry executable code or external requests', () => {
    const html = serializeNotionSnapshot(root(`<a href="javascript:alert(1)" onclick="bad()">Bad</a><a href="https://example.com/path" target="_blank">Web</a><img src="https://external.example/pixel" onerror="bad()" alt="Remote"/><img src="${PNG}" alt="Local"/><p style="color:red;background:url(https://external.example/x);position:fixed;--private:secret">Styled</p>`));
    expect(html).toContain('<a>Bad</a><a href="https://example.com/path">Web</a>');
    expect(html).toContain(`<img alt="Remote"><img src="${PNG}" alt="Local">`);
    expect(html).toContain('<p style="color:red">Styled</p>');
    expect(html).not.toMatch(/onclick|onerror|javascript|external.example|position:|target=|secret/);
  });

  test('SVG is finite static markup with local references only', () => {
    const html = serializeNotionSnapshot(root('<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><path d="M0 0L10 10" clip-path="url(#clip)" onclick="bad()"/><use href="https://external.example/a.svg#x"/><use href="#clip"/></svg>'));
    expect(html).toContain('viewBox="0 0 10 10"');
    expect(html).toContain('clip-path="url(#clip)"');
    expect(html).toContain('<use href="#clip"></use>');
    expect(html).not.toMatch(/onclick|external.example/);
  });

  test('canvases become bounded data raster images and failures are explicit', () => {
    expect(serializeNotionSnapshot(root('<canvas>fallback</canvas>'), {canvas: () => PNG})).toBe(`<img alt="Component canvas" src="${PNG}">`);
    expect(() => serializeNotionSnapshot(root('<canvas/>'), {canvas: () => 'https://external.example/image'})).toThrow('image limit');
    expect(() => serializeNotionSnapshot(root('<canvas/>'), {canvas: () => {throw new Error('No raster available');}})).toThrow('No raster available');
  });

  test('rejects excessive byte size, nesting and DOM node count', () => {
    expect(() => serializeNotionSnapshot(root(`<p>${'😀'.repeat(MAX_NOTION_SNAPSHOT_HTML_BYTES / 3)}</p>`))).toThrow('too large');
    expect(() => serializeNotionSnapshot(root('<div>'.repeat(66) + 'Deep' + '</div>'.repeat(66)))).toThrow('too complex');
    expect(() => serializeNotionSnapshot(root('<span/>'.repeat(20_001)))).toThrow('too complex');
  });

  test('hidden controls and editor metadata are excluded without discarding ordinary prose', () => {
    const node = root('<p data-authoring-from="12" contenteditable="true">Prose</p><section hidden="hidden">Hidden</section><span data-private="no" style="color:blue">Shown</span><fieldset class="custom-component-controls"><legend>Property controls</legend><input value="secret"/></fieldset>');
    expect(serializeNotionSnapshot(node)).toBe('<p>Prose</p><span style="color:blue">Shown</span>');
  });
});
