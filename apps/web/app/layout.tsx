import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { THEME_SCRIPT } from "@retail/ui/theme-script";
import "@retail/ui/styles.css";

// The admin app is never indexed. Public storefronts are a separate, opt-in surface (D10).
// Every page has a title, in the person's language (screen readers announce it first).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home");
  return { title: t("title"), robots: { index: false, follow: false } };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    // The script below sets data-theme before the first paint, so the server cannot know it.
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
