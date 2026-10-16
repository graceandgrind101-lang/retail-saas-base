import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Gallery } from "./gallery";

// A developer page that shows every component in one place (and is what the browser tests look at).
// It is not part of the product, so a production server hides it unless ENABLE_UI_GALLERY=1.
export const metadata: Metadata = { title: "Components (developer page)" };

export default function UiGalleryPage() {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_UI_GALLERY !== "1") notFound();
  return <Gallery />;
}
