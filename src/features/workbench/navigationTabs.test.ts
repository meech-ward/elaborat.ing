import { expect, test } from "bun:test";
import { emptyNavigationTabs, navigationTabTransition as transition } from "./navigationTabs";

const file = (path: string) => ({ path, content: `# ${path}`, revision: "saved" });
test("reordering emits no location command or active-file change", () => {
  const state = transition(emptyNavigationTabs, { type: "restored", files: [file("a.md"), file("b.md")], activePath: "a.md", fromLocation: true });
  const next = transition(state, { type: "reorder", path: "b.md", target: "a.md", side: "before" });
  expect(next.tabs.map(tab => tab.path)).toEqual(["b.md", "a.md"]);
  expect(next.active).toBe("a.md");
  expect(next.locationCommand).toBeNull();
  expect(next.locationVersion).toBe(state.locationVersion);
});
test("location requests cannot echo a URL command or revive stale reads", () => {
  let state = transition(emptyNavigationTabs, { type: "request", sequence: 1, fromLocation: true });
  state = transition(state, { type: "request", sequence: 2, fromLocation: true });
  state = transition(state, { type: "opened", sequence: 1, file: file("stale.mdx"), fromLocation: true });
  expect(state.tabs).toHaveLength(0);
  state = transition(state, { type: "opened", sequence: 2, file: file("new.mdx"), fromLocation: true });
  expect(state.active).toBe("new.mdx");
  expect(state.locationCommand).toBeNull();
});
test("restoration retains files without overriding an explicit missing target", () => {
  const state = transition(emptyNavigationTabs, { type: "restored", files: [file("remembered.mdx")], activePath: "remembered.mdx", activate: false });
  expect(state.tabs.map(tab => tab.path)).toEqual(["remembered.mdx"]);
  expect(state.active).toBeNull();
  expect(state.locationCommand).toBeNull();
});
test("direct target opened during restoration retains remembered tab order and session identity", () => {
  let state = transition(emptyNavigationTabs, {type:"opened",sequence:0,file:file("target.mdx"),fromLocation:true});
  const target = state.tabs[0];
  state = transition(state, {type:"restored",files:[file("first.mdx"),file("target.mdx")],activePath:"first.mdx",activate:false,order:["first.mdx","target.mdx"]});
  expect(state.tabs.map(tab=>tab.path)).toEqual(["first.mdx","target.mdx"]);
  expect(state.active).toBe("target.mdx");
  expect(state.tabs[1]).toBe(target);
  expect(state.locationCommand).toBeNull();
});
test("open pushes; close, rename and move replace; restored identities deduplicate", () => {
  let state = transition(emptyNavigationTabs, {type:"restored",files:[file("first.mdx"),file("next.mdx")],activePath:"first.mdx"});
  expect(state.locationCommand?.replace).toBe(true);
  state = transition(state, {type:"select",path:"next.mdx"});
  expect(state.locationCommand?.replace).toBe(false);
  state = transition(state, {type:"restored",files:[file("next.mdx")],activePath:"first.mdx"});
  expect(state.tabs).toHaveLength(2);
  state = transition(state, {type:"renamed",from:"next.mdx",to:"renamed.mdx",content:"# fresh",revision:"new"});
  expect(state.locationCommand).toMatchObject({replace:true,path:"renamed.mdx"});
  state = transition(state, {type:"move-reconciled",files:[{...file("folder/renamed.mdx"),from:"renamed.mdx"}]});
  expect(state.locationCommand).toMatchObject({replace:true,path:"folder/renamed.mdx"});
  state = transition(state, {type:"close",path:"folder/renamed.mdx",discard:true});
  expect(state.locationCommand).toMatchObject({replace:true,path:"first.mdx"});
});
