import type { Metadata } from "next";

// The admin app is never indexed. Public storefronts are a separate, opt-in surface (D10).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
