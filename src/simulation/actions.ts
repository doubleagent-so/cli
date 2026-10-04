import type { Page } from 'playwright';
import type { SiteOptions } from './options';

/** Real browser input on temporary, inert controls. Never target the website's forms or buttons. */
export async function behaviorActions(page: Page, options: SiteOptions) {
  if (options.evidence !== 'behavior' || options.scenario === 'observe') return null;
  const id = `da-simulation-${crypto.randomUUID()}`;
  await page.evaluate((panelId) => {
    const panel = document.createElement('section'); panel.id = panelId;
    panel.setAttribute('aria-label', 'Double Agent simulation controls');
    panel.style.cssText = 'position:fixed;inset:20px 20px auto auto;z-index:2147483647;width:300px;padding:16px;background:#fff;color:#111;border:2px solid #111;font:14px system-ui';
    panel.innerHTML = '<b>Double Agent behavior simulation</b><p>Temporary test controls. No site forms are submitted.</p><p role="status">Waiting for the first action…</p><label>Test name<input autocomplete="off" type="text"></label><label>Test note<input autocomplete="off" type="text"></label><button type="button">Inspect sample</button><button type="button">Choose sample</button><button type="button">Complete sample</button>';
    panel.querySelectorAll<HTMLElement>('input,button').forEach((el) => { el.style.cssText = 'display:block;box-sizing:border-box;width:260px;height:36px;margin:12px 0'; });
    // Keep interaction local while document capture listeners still receive trusted events.
    panel.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); });
    document.body.appendChild(panel);
  }, id);
  const fields = page.locator(`#${id} input`), buttons = page.locator(`#${id} button`);
  let step = 0;
  return {
    async next() {
      const description = step < 2 ? `Entered text in ${step ? 'Test note' : 'Test name'}` : `Clicked ${['Inspect sample', 'Choose sample', 'Complete sample'][(step - 2) % 3]}`;
      if (step < 2) {
        await fields.nth(step).click({ timeout: 2000 });
        if (options.scenario === 'agent') await page.keyboard.insertText(step ? 'Review sample' : 'Example visitor');
        else await fields.nth(step).fill(step ? 'Review sample' : 'Example visitor', { timeout: 2000 });
      } else await buttons.nth((step - 2) % 3).click({ timeout: 2000 });
      step++;
      await page.locator(`#${id} [role="status"]`).evaluate((node, text) => { node.textContent = text; }, `Action ${step}: ${description}`);
      return description;
    },
    get count() { return step; },
  };
}
