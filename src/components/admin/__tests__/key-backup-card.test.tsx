/**
 * The key backup step and its dashboard banner.
 *
 *   1. the card shows the key id and fingerprint and never anything shaped
 *      like key material; the platform hint picks the open tab;
 *   2. a due step offers the confirmation, a done step does not;
 *   3. the banner renders only for an admin and only while the step is due;
 *   4. the copy resolves in German too.
 *
 * Mutation check: drop the `isAdmin` guard in the banner and case 3 goes red;
 * render the confirm button unconditionally and case 2 goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { KeyBackupCard } from "@/components/admin/key-backup-card";
import { KeyBackupBanner } from "@/components/dashboard/key-backup-banner";
import type { KeyBackupStatus } from "@/components/admin/use-key-backup-status";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/encryption",
}));

const DUE: KeyBackupStatus = {
  due: true,
  activeKeyId: "v1",
  fingerprint: "a1b2c3d4e5f6",
  confirmedAt: null,
  confirmedKeyId: null,
  confirmedFingerprint: null,
  confirmedBy: null,
  platformHint: "truenas",
};

const DONE: KeyBackupStatus = {
  ...DUE,
  due: false,
  confirmedAt: "2026-10-03T10:00:00.000Z",
  confirmedKeyId: "v1",
  confirmedFingerprint: "a1b2c3d4e5f6",
  confirmedBy: { id: "u1", email: "admin@example.test" },
};

function render(
  node: React.ReactNode,
  status: KeyBackupStatus | null,
  locale: "en" | "de" = "en",
): string {
  const client = new QueryClient();
  if (status) client.setQueryData(queryKeys.adminEncryptionKeyBackup(), status);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("KeyBackupCard", () => {
  it("shows the key id and fingerprint, opens the hinted platform, and no key material", () => {
    const html = render(<KeyBackupCard />, DUE);
    expect(html).toContain("a1b2c3d4e5f6");
    expect(html).toContain(">v1<");
    expect(html).toContain("Apps, select HealthLog");
    expect(html).not.toMatch(/[0-9a-f]{64}/);
  });

  it("offers the confirmation only while the step is due", () => {
    expect(render(<KeyBackupCard />, DUE)).toContain(
      "I have backed up this key",
    );
    const done = render(<KeyBackupCard />, DONE);
    expect(done).not.toContain("I have backed up this key");
    expect(done).toContain("admin@example.test");
  });

  it("speaks German", () => {
    expect(render(<KeyBackupCard />, DUE, "de")).toContain(
      "Sichere deinen Verschlüsselungsschlüssel",
    );
  });
});

describe("KeyBackupBanner", () => {
  it("renders for an admin while the step is due", () => {
    expect(render(<KeyBackupBanner isAdmin />, DUE)).toContain(
      'data-testid="key-backup-banner"',
    );
  });

  it("renders nothing for a non-admin, or once the step is done", () => {
    expect(render(<KeyBackupBanner isAdmin={false} />, DUE)).toBe("");
    expect(render(<KeyBackupBanner isAdmin />, DONE)).toBe("");
  });
});
