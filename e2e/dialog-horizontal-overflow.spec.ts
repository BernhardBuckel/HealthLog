import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * An add / edit dialog must not pan sideways, and nothing you have to operate
 * may sit outside its visible box.
 *
 * A report named four surfaces — measurements add, mood add, the medication
 * intake editor, the cycle log sheet — and four surfaces sharing one symptom
 * is one defect in something shared, not four. Two shared mechanisms were
 * behind it, and this spec pins the outcome of both rather than either
 * implementation:
 *
 *   1. `<DateField>` / `<TimeField>` wrap a text `<input>`. A flex item's
 *      `min-width: auto` resolves to a content-based minimum, and for a text
 *      input that minimum is its intrinsic `size` (20 characters, ~180 px).
 *      The date + time row therefore demanded ~470 px inside a 400 px dialog
 *      body and put the clock button ~58 px past the right edge — the picker
 *      was not merely ugly, it was unreachable without scrolling sideways.
 *
 *   2. The body scrolls (`overflow-y-auto`), and CSS promotes the OTHER axis
 *      from `visible` to `auto`. So every intentional outward bleed in the
 *      tree — `<SheetSection>`'s trigger row, `<Switch>`'s `inset-[-13px]`
 *      hit-target pseudo — turned the whole form into a horizontally
 *      scrollable surface. That is why the desktop dialog showed two
 *      scrollbars while the phone sheet, whose body has padding, looked fine.
 *
 * The two assertions map onto the two harms and neither is a restatement of a
 * class name:
 *
 *   - `expectNoSidewaysScroll` — the surface is not a horizontal scroll
 *     container. Fails against mechanism 2 (the axis was promoted to `auto`).
 *   - `expectControlsInsideBox` — every focusable control is within the
 *     surface's visible content box. Fails against mechanism 1 (the clock
 *     button was outside it), and keeps failing if a future change clips a
 *     control out of sight instead of fitting it.
 *
 * Both widths run: the defect was desktop-only for the date/time row, and the
 * phone sheet is the branch where a regression would be least visible.
 *
 * NOT covered here: the medication intake editor and the cycle log sheet, the
 * other two reported surfaces. Both need account state the shared fixture does
 * not carry (a medication with a logged dose; a profile with cycle tracking
 * on), and a spec that silently measures an empty page proves nothing. They
 * share the primitives asserted below — `<ResponsiveSheet>` + `<DateTimeField>`
 * for the editor, `<ResponsiveSheet>` + `<SheetSection>` for the log sheet —
 * so a regression in either mechanism surfaces here first.
 */

const SURFACE =
  '[data-slot="responsive-sheet-content"], [data-slot="dialog-content"]';
const BODY = '[data-slot="responsive-sheet-body"]';

interface DialogCase {
  name: string;
  path: string;
  /** Accessible name of the control that opens the dialog. */
  trigger: RegExp;
  /** Reach the state the report describes, when the form does not open in it. */
  prepare?: (page: import("@playwright/test").Page) => Promise<void>;
  /** Something inside the dialog that proves it rendered its form, not a shell. */
  ready: string;
  /** Render in this locale instead of the suite's pinned English. */
  locale?: "de";
}

const DIALOGS: DialogCase[] = [
  {
    name: "measurements add",
    path: "/measurements",
    trigger: /^add$/i,
    ready: '[data-slot="date-time-field"]',
  },
  {
    name: "mood add",
    path: "/mood",
    trigger: /^add$/i,
    // The mood sheet opens on the five-face quick check; the timestamp row
    // (and everything else) appears once a face is picked. Measuring the
    // quick check alone would measure a sheet that has almost nothing in it.
    prepare: async (page) => {
      await page.locator('[data-slot="mood-face"]').first().click();
      await page
        .locator('[data-slot="mood-annotate-panel"]')
        .first()
        .waitFor({ state: "visible" });
    },
    ready: '[data-slot="date-time-field"]',
  },
  {
    name: "labs add",
    path: "/labs",
    trigger: /^add$/i,
    ready: '[data-slot="date-time-field"]',
  },
  // The labs sheet's footer holds three buttons (Cancel, Save & add another,
  // Save). They fit a phone row in English; the German labels are ~100px
  // wider and pushed Cancel off the sheet's left edge, at every width.
  {
    name: "labs add (German)",
    path: "/labs",
    trigger: /^hinzufügen$/i,
    ready: '[data-slot="date-time-field"]',
    locale: "de",
  },
];

const VIEWPORTS = [
  { label: "desktop 1280", width: 1280, height: 800 },
  { label: "phone 390", width: 390, height: 844 },
  // The narrowest common Android width.
  { label: "phone 360", width: 360, height: 780 },
];

/**
 * The surface and its scrolling body must not be horizontal scroll
 * containers. Read from the COMPUTED style, because the promotion that caused
 * the defect happens in the cascade and is invisible in the class list.
 */
async function expectNoSidewaysScroll(
  page: import("@playwright/test").Page,
  label: string,
): Promise<void> {
  const boxes = await page.evaluate(
    ([surfaceSel, bodySel]) => {
      const nodes = [
        ...document.querySelectorAll<HTMLElement>(surfaceSel),
        ...document.querySelectorAll<HTMLElement>(bodySel),
      ];
      return nodes.map((el) => ({
        slot: el.dataset.slot ?? el.tagName.toLowerCase(),
        overflowX: getComputedStyle(el).overflowX,
      }));
    },
    [SURFACE, BODY] as const,
  );

  expect(
    boxes.length,
    `${label}: no dialog surface found to measure`,
  ).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(
      ["auto", "scroll"].includes(box.overflowX),
      `${label}: ${box.slot} computes overflow-x:${box.overflowX} — the surface can be panned sideways`,
    ).toBe(false);
  }
}

/**
 * No focusable control may lie outside the surface's visible content box.
 * This is the reachability claim: a picker pushed past the edge (or clipped
 * out of sight by a later "fix") fails here regardless of how the layout got
 * there.
 */
async function expectControlsInsideBox(
  page: import("@playwright/test").Page,
  label: string,
): Promise<void> {
  const result = await page.evaluate((surfaceSel) => {
    const surface = document.querySelector<HTMLElement>(surfaceSel);
    if (!surface) return null;
    const box = surface.getBoundingClientRect();
    // The visible content box: `clientWidth` excludes a vertical scrollbar,
    // so a control hidden behind one counts as outside.
    const visibleRight = box.left + surface.clientWidth;
    const controls = [
      ...surface.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ];
    const outside = controls
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, r };
      })
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .filter(({ r }) => r.right > visibleRight + 1 || r.left < box.left - 1)
      .map(({ el, r }) => ({
        tag: el.tagName.toLowerCase(),
        slot: el.dataset.slot ?? null,
        label:
          el.getAttribute("aria-label") ??
          el.textContent?.trim().slice(0, 30) ??
          "",
        left: Math.round(r.left),
        right: Math.round(r.right),
      }));
    return {
      controlCount: controls.length,
      surfaceLeft: Math.round(box.left),
      visibleRight: Math.round(visibleRight),
      outside,
    };
  }, SURFACE);

  expect(result, `${label}: dialog surface not found`).not.toBeNull();
  // Guard the guard: a dialog with no controls would pass vacuously.
  expect(
    result!.controlCount,
    `${label}: the dialog rendered no focusable controls, so this assertion proves nothing`,
  ).toBeGreaterThan(2);
  expect(
    result!.outside,
    `${label}: control(s) outside the dialog's visible box [${result!.surfaceLeft}..${result!.visibleRight}]`,
  ).toEqual([]);
}

test.describe("add/edit dialogs do not scroll sideways", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  for (const vp of VIEWPORTS) {
    for (const dialog of DIALOGS) {
      test(`${dialog.name} fits its surface at ${vp.label}`, async ({
        page,
        context,
      }, testInfo) => {
        if (dialog.locale) {
          await context.addCookies([
            {
              name: "healthlog-locale",
              value: dialog.locale,
              url: testInfo.project.use.baseURL ?? "http://localhost:3000",
            },
          ]);
        }
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(dialog.path, { waitUntil: "domcontentloaded" });

        await page
          .getByRole("button", { name: dialog.trigger })
          .first()
          .click();

        const surface = page.locator(SURFACE).first();
        await expect(surface).toBeVisible();
        await dialog.prepare?.(page);
        // Gate on the form's own content, not the shell: the surface mounts
        // before the fields do, and measuring the empty frame would pass
        // against exactly the layout this spec exists to catch.
        await expect(surface.locator(dialog.ready).first()).toBeVisible();

        const label = `${dialog.name} @${vp.label}`;
        await expectNoSidewaysScroll(page, label);
        await expectControlsInsideBox(page, label);
      });
    }
  }

  /**
   * The reachability assertion has to be able to FAIL, or the six tests above
   * are decoration. Inject a control that deliberately sits past the right
   * edge and assert the helper reports it — the same shape the time-field
   * button had before the fix.
   */
  test("the reachability check detects a control pushed past the edge", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/measurements", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^add$/i }).first().click();

    const surface = page.locator(SURFACE).first();
    await expect(surface).toBeVisible();
    await expect(
      surface.locator('[data-slot="date-time-field"]').first(),
    ).toBeVisible();

    await page.evaluate((surfaceSel) => {
      const el = document.querySelector<HTMLElement>(surfaceSel)!;
      const probe = document.createElement("button");
      probe.id = "reach-canary";
      probe.textContent = "canary";
      probe.style.position = "absolute";
      probe.style.left = `${el.clientWidth + 40}px`;
      probe.style.top = "0";
      probe.style.width = "30px";
      probe.style.height = "30px";
      el.appendChild(probe);
    }, SURFACE);

    await expect(
      page.locator(`${SURFACE} #reach-canary`).first(),
      "the canary is not inside the dialog — the fixture failed, not the helper",
    ).toBeAttached();

    await expect(expectControlsInsideBox(page, "canary probe")).rejects.toThrow(
      /outside the dialog's visible box/,
    );
  });
});
