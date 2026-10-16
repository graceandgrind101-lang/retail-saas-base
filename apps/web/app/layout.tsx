import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { ToastProvider } from "@retail/ui";
import { THEME_SCRIPT } from "@retail/ui/theme-script";
import "@retail/ui/styles.css";
import "./shell.css";

// The admin app is never indexed. Public storefronts are a separate, opt-in surface (D10).
// Every page has a title, in the person's language (screen readers announce it first).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home");
  return { title: t("title"), robots: { index: false, follow: false } };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations("common");
  return (
    // The script below sets data-theme before the first paint, so the server cannot know it.
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <NextIntlClientProvider>
          <ToastProvider dismissLabel={t("close")}>{children}</ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
