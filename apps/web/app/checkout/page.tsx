import type { Metadata } from "next";
import { StorefrontCheckout } from "@/components/storefront/storefront-checkout";
import { checkoutAvailability } from "@/lib/server/order-requests";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Votre demande — ByLiliDeco",
  description:
    "Transmettez votre sélection à ByLiliDeco pour confirmer les articles et les modalités.",
  robots: { index: false, follow: false },
};

export default function CheckoutPage() {
  return <StorefrontCheckout availability={checkoutAvailability()} />;
}
