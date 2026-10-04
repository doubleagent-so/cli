import { FINGERPRINTS } from '@doubleagent-so/agent-detector';

export type Fixture = { id: string; catalogId: string; kind: 'marker' | 'global'; value: string; reason: string };
const globals: Record<string, string> = {
  'global.browser_use': '__browserUseDemoPanelLoaded', 'global.stagehand': '__stagehand_simulation',
  'global.skyvern': 'GlobalSkyvernFrameIndex', 'global.chromedriver': '$cdc_simulation',
  'global.selenium': '_Selenium_IDE_Recorder', 'global.playwright': '__playwright_simulation',
  'global.puppeteer': '__puppeteer_simulation', 'global.legacy_automation': '__nightmare',
};
export const FIXTURES: Fixture[] = FINGERPRINTS.flatMap((entry) => [
  ...(entry.markers ?? []).flatMap((rule, i) => rule.selector.split(',').map((selector, j) => ({
    id: `${entry.id}:marker:${i}:${j}`, catalogId: entry.id, kind: 'marker' as const, value: selector.trim(), reason: rule.code,
  }))),
  ...(entry.globals ?? []).filter((rule) => globals[rule.code]).map((rule, i) => ({
    id: `${entry.id}:global:${i}`, catalogId: entry.id, kind: 'global' as const, value: globals[rule.code], reason: rule.code,
  })),
]);
export function applyFixture(doc: Document, win: Window, fixture: Fixture) {
  if (fixture.kind === 'global') { Object.defineProperty(win, fixture.value, { value: true, configurable: true }); return; }
  const element = doc.createElement('div');
  const id = /^#([\w-]+)$/.exec(fixture.value);
  const attr = /^\[([\w-]+)(?:\^="([^"]+)")?\]$/.exec(fixture.value);
  if (id) element.id = id[1];
  else if (attr) element.setAttribute(attr[1], attr[2] ? `${attr[2]}simulation` : 'simulation');
  else throw new Error(`Unsupported fixture selector: ${fixture.value}`);
  element.hidden = true;
  doc.body.appendChild(element);
}
