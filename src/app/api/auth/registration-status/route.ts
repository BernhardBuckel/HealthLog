import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
    });

    annotate({ action: { name: "auth.registration-status" } });

    return apiSuccess({
      registrationEnabled: settings?.registrationEnabled ?? true,
      // Whether this server issues `Secure` session cookies. The login page
      // compares it with its own scheme before any credential is sent.
      sessionCookieSecure: shouldEmitSecureCookie(),
    });
  } catch {
    // Fail closed on backend errors.
    annotate({ action: { name: "auth.registration-status" } });
    return apiSuccess({
      registrationEnabled: false,
      sessionCookieSecure: shouldEmitSecureCookie(),
    });
  }
});
