import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ProductAnalytics } from "@/components/ProductAnalytics";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Building Editor",
  description:
    "Separate buildings into parts, set heights and roofs, preview them in 3D, and submit changes to OpenStreetMap.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
        <ProductAnalytics />
      </body>
    </html>
  );
}
